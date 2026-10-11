// Mediabunny (MPL-2.0) is vendored under public/vendor/ rather than loaded
// from a CDN so the page's `script-src 'self'` CSP stays intact. It's only
// imported on demand (and pre-fetched via preload()) so the ~700KB bundle
// never delays the camera from starting.
import { alignDown, isAligned } from './utils.js';

const MEDIABUNNY_URL = '../vendor/mediabunny.min.mjs';
// WASM build of FFmpeg's AAC encoder, only loaded on browsers whose
// WebCodecs can't encode AAC natively (e.g. Firefox).
const AAC_ENCODER_URL = '../vendor/mediabunny-aac-encoder.min.mjs';

const AUDIO_BITRATE = 192000; // music-friendly; voice alone would be fine at 96k
// Microphones report anything from 8 to 48 kHz (many webcam/headset mics are
// 16 kHz). Mediabunny picks the AAC profile from the sample rate, and at
// <= 24 kHz that's HE-AAC (v2 for stereo), which most WebCodecs builds can't
// encode and some players handle poorly. Always resampling to 48 kHz keeps
// the output plain AAC-LC — what phones record and every player supports.
const AUDIO_SAMPLE_RATE = 48000;
// Seconds between keyframes. Players can only start decoding at a keyframe,
// so this bounds how precisely (and how quickly) scrubbing lands, at a
// modest size cost. Default encoder intervals are ~5s, which feels sticky
// when scrubbing back and forth through a short practice clip.
const KEYFRAME_INTERVAL = 1;

// Fallback path only (no WebCodecs encoder for H.264/HEVC). MP4 first since
// that's what phones play natively; the result is remuxed afterwards either way.
const RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

let mediabunnyPromise = null;
function loadMediabunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import(MEDIABUNNY_URL).catch((err) => {
      mediabunnyPromise = null; // allow a retry on the next attempt
      throw err;
    });
  }
  return mediabunnyPromise;
}

let aacEncoderRegistered = false;
/**
 * Makes sure AAC-LC can be encoded with the given channel count, registering
 * the WASM encoder when the browser's own WebCodecs can't do it.
 */
async function ensureAacEncoder(mb, numberOfChannels) {
  const config = { numberOfChannels, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  if (aacEncoderRegistered || await mb.canEncodeAudio('aac', config)) return;
  const { registerAacEncoder } = await import(AAC_ENCODER_URL);
  registerAacEncoder();
  aacEncoderRegistered = true;
}

function pickRecorderMimeType() {
  if (!window.MediaRecorder) return '';
  return RECORDER_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Records the live camera (+ optional microphone) into a regular,
 * non-fragmented MP4 (H.264 + AAC, `moov` index at the front) — the same
 * shape a phone's own camera app produces, so the file has a real duration,
 * seeks instantly and plays in any gallery app or desktop player.
 *
 * Plain MediaRecorder output can't be used as-is for that: Chrome/Firefox
 * WebM has no duration or seek index, and MediaRecorder MP4 is fragmented
 * (also unseekable in many players). So the primary path encodes the tracks
 * with WebCodecs and muxes them directly via Mediabunny; browsers without a
 * usable H.264/HEVC encoder fall back to MediaRecorder followed by a remux
 * pass through Mediabunny, which writes the missing index.
 *
 * The controller takes ownership of the tracks passed to start() and stops
 * them once the recording ends, so callers should hand it clones.
 *
 * Events: 'start', 'processing' (stopped, file being finalized),
 * 'recording' (detail: the finished file), 'error' (detail: Error).
 */
export class RecordingController extends EventTarget {
  constructor() {
    super();
    this.state = 'idle'; // 'idle' | 'starting' | 'recording' | 'processing'
    this.backend = null; // 'webcodecs' | 'mediarecorder', for the debug panel
    this.codecs = null; // e.g. 'avc + aac', for the debug panel
    this._session = null;
  }

  get isRecording() {
    return this.state === 'recording';
  }

  get isBusy() {
    return this.state !== 'idle';
  }

  /** Fetches the muxer ahead of time so pressing record has no load delay. */
  preload() {
    return loadMediabunny();
  }

  async start({ videoTrack, audioTrack = null, meta = {} }) {
    if (this.isBusy) return;
    this.state = 'starting';
    const tracks = [videoTrack, audioTrack].filter(Boolean);
    try {
      const mb = await loadMediabunny();
      this._session = (await this._startWebCodecs(mb, videoTrack, audioTrack))
        || this._startMediaRecorder(tracks);
      this._session.tracks = tracks;
      this._session.meta = meta;
      this._session.startedAt = performance.now();
      this.state = 'recording';
      this.dispatchEvent(new CustomEvent('start'));
    } catch (err) {
      tracks.forEach((t) => t.stop());
      this._session = null;
      this.state = 'idle';
      throw err;
    }
  }

  async stop() {
    if (!this.isRecording) return;
    const session = this._session;
    this.state = 'processing';
    this.dispatchEvent(new CustomEvent('processing'));
    const durationMs = performance.now() - session.startedAt;
    try {
      const blob = await session.finish();
      this.dispatchEvent(new CustomEvent('recording', {
        detail: {
          blob,
          url: URL.createObjectURL(blob),
          durationMs,
          mimeType: blob.type,
          hasAudio: session.tracks.some((t) => t.kind === 'audio'),
          meta: session.meta,
        },
      }));
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    } finally {
      session.tracks.forEach((t) => t.stop());
      this._session = null;
      this.state = 'idle';
    }
  }

  async _startWebCodecs(mb, videoTrack, audioTrack) {
    const { width = 1280, height = 720, frameRate = 30 } = videoTrack.getSettings();
    // Encode at a 16-aligned size (see alignDown in utils.js) — otherwise some
    // Android hardware encoders produce striped/sheared video.
    const encodeWidth = alignDown(width);
    const encodeHeight = alignDown(height);
    const videoCodec = await mb.getFirstEncodableVideoCodec(['avc', 'hevc'], { width: encodeWidth, height: encodeHeight });
    if (!videoCodec) return null;

    let audioCodec = null;
    // Mono mics stay mono; anything with more channels is downmixed to stereo.
    const audioChannels = audioTrack
      ? Math.min(2, Math.max(1, audioTrack.getSettings().channelCount || 2))
      : 0;
    if (audioTrack) {
      await ensureAacEncoder(mb, audioChannels);
      audioCodec = 'aac';
    }

    const target = new mb.BufferTarget();
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });

    const sources = [];
    const videoSource = new mb.MediaStreamVideoTrackSource(videoTrack, {
      codec: videoCodec,
      bitrate: mb.QUALITY_HIGH,
      keyFrameInterval: KEYFRAME_INTERVAL,
      // A phone rotating mid-take changes the track's dimensions; letterbox
      // into the original frame instead of aborting the recording. When the
      // camera size isn't aligned, 'cover' instead, so the few excess pixels
      // are center-cropped rather than shown as thin black bars (Mediabunny
      // uses the same fit for both the resize and size changes).
      ...(isAligned(width, height)
        ? { sizeChangeBehavior: 'contain' }
        : { sizeChangeBehavior: 'cover', transform: { width: encodeWidth, height: encodeHeight } }),
    }, {
      // Passing it explicitly lets Mediabunny fall back to sampling a <video>
      // element on browsers without MediaStreamTrackProcessor.
      frameRate,
    });
    output.addVideoTrack(videoSource, { frameRate });
    sources.push(videoSource);

    if (audioTrack) {
      const audioSource = new mb.MediaStreamAudioTrackSource(audioTrack, {
        codec: audioCodec,
        bitrate: AUDIO_BITRATE,
        transform: { sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: audioChannels },
      });
      output.addAudioTrack(audioSource);
      sources.push(audioSource);
    }

    let failure = null;
    sources.forEach((s) => s.errorPromise.catch((err) => {
      if (failure) return;
      failure = err;
      console.error('[MotionMirror] recording source failed', err);
      // Surface it right away instead of only when the user presses stop.
      if (this.isRecording) this.stop();
    }));

    try {
      await output.start();
    } catch (err) {
      console.warn('[MotionMirror] WebCodecs recording failed to start, falling back to MediaRecorder', err);
      await output.cancel().catch(() => {});
      return null;
    }

    this.backend = 'webcodecs';
    this.codecs = [videoCodec, audioCodec].filter(Boolean).join(' + ');
    return {
      finish: async () => {
        if (failure) {
          await output.cancel().catch(() => {});
          throw failure;
        }
        await output.finalize();
        return new Blob([target.buffer], { type: 'video/mp4' });
      },
    };
  }

  _startMediaRecorder(tracks) {
    const mimeType = pickRecorderMimeType();
    if (!mimeType) throw new Error('Este navegador no puede grabar video.');
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      audioBitsPerSecond: AUDIO_BITRATE,
    });
    const chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.start(1000); // 1s timeslices bound memory per chunk

    this.backend = 'mediarecorder';
    this.codecs = mimeType;
    return {
      finish: async () => {
        await new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true });
          recorder.stop();
        });
        const raw = new Blob(chunks, { type: mimeType.split(';')[0] });
        return remuxForPlayback(raw);
      },
    };
  }
}

/**
 * Rewrites a MediaRecorder file into a container with a proper duration and
 * seek index: MP4 when the codecs allow it (copied, or transcoded if WebCodecs
 * can), otherwise a cued WebM. Returns the original blob if neither works so
 * the take is never lost.
 */
async function remuxForPlayback(raw) {
  const mb = await loadMediabunny();
  const formats = [
    () => new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    () => new mb.WebMOutputFormat(),
  ];
  for (const makeFormat of formats) {
    try {
      const input = new mb.Input({ source: new mb.BlobSource(raw), formats: mb.ALL_FORMATS });
      const target = new mb.BufferTarget();
      const format = makeFormat();
      const output = new mb.Output({ format, target });
      const conversion = await mb.Conversion.init({ input, output });
      if (!conversion.isValid || conversion.discardedTracks.length > 0) continue;
      await conversion.execute();
      return new Blob([target.buffer], { type: format.mimeType });
    } catch (err) {
      console.warn('[MotionMirror] remux attempt failed', err);
    }
  }
  return raw;
}

export function fileExtensionFor(mimeType) {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}
