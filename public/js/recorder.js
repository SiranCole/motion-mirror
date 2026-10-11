import { alignDown, isAligned } from './utils.js';

// Mediabunny (MPL-2.0) is vendored under public/vendor/ rather than loaded
// from a CDN so the page's `script-src 'self'` CSP stays intact. It's only
// imported on demand (and pre-fetched via preload()) so the ~700KB bundle
// never delays the camera from starting.
const MEDIABUNNY_URL = '../vendor/mediabunny.min.mjs';
// WASM build of FFmpeg's AAC encoder, only loaded when the browser's own
// WebCodecs can't encode AAC (e.g. Firefox) and the audio must be transcoded.
const AAC_ENCODER_URL = '../vendor/mediabunny-aac-encoder.min.mjs';

const AUDIO_BITRATE = 192000; // music-friendly; voice alone would be fine at 96k
// Target video bits per pixel per frame — about what phone camera apps use
// (720p30 ≈ 4 Mbps, 1080p30 ≈ 9 Mbps).
const VIDEO_BITS_PER_PIXEL = 0.15;
const VIDEO_BITRATE_MIN = 1500000;
const VIDEO_BITRATE_MAX = 12000000;
// Milliseconds between keyframes. Players can only start decoding at a
// keyframe, so this bounds how quickly scrubbing lands. Only Chromium
// honors the hint; other browsers ignore unknown options.
const KEYFRAME_INTERVAL_MS = 1000;
// A probe records this long, then must have produced data with no error.
// (Encoder setup errors can arrive after the first, header-only chunk.)
const PROBE_DURATION_MS = 800;
const PROBE_TIMEOUT_MS = 3000;
// An encoder error this soon after starting is treated as "this format
// doesn't work here": the take restarts on the next format, dropping the
// fraction of a second recorded so far.
const SETUP_FAILURE_WINDOW_MS = 3000;

// In preference order. H.264 + AAC in MP4 (Chrome 126+, Safari) can be
// copied into the final file untouched, which is near-instant. The rest
// need some transcoding afterwards (Opus -> AAC is quick; VP8/VP9 -> H.264
// takes a while). isTypeSupported() isn't enough to choose: it ignores the
// actual tracks, and e.g. Chrome's AAC encoder rejects 16 kHz microphones
// (common on webcams) at runtime — hence probe() and the runtime fallback.
const RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=h264,opus',
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
async function ensureAacEncoder(mb) {
  if (aacEncoderRegistered || await mb.canEncodeAudio('aac', { sampleRate: 48000, bitrate: AUDIO_BITRATE })) return;
  const { registerAacEncoder } = await import(AAC_ENCODER_URL);
  registerAacEncoder();
  aacEncoderRegistered = true;
}

function supportedMimeTypes() {
  if (!window.MediaRecorder) return [];
  return RECORDER_MIME_CANDIDATES.filter((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch (_) {
      return false;
    }
  });
}

function recorderOptions(mimeType, videoTrack) {
  const { width = 1280, height = 720, frameRate = 30 } = videoTrack.getSettings();
  const bps = width * height * (frameRate || 30) * VIDEO_BITS_PER_PIXEL;
  return {
    mimeType,
    videoBitsPerSecond: Math.round(Math.min(VIDEO_BITRATE_MAX, Math.max(VIDEO_BITRATE_MIN, bps))),
    audioBitsPerSecond: AUDIO_BITRATE,
    videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
  };
}

/**
 * Records the live camera + microphone into a regular, non-fragmented MP4
 * (H.264 + AAC, `moov` index at the front) — the shape a phone's camera app
 * produces: real duration, instant seeking, plays in any gallery app.
 *
 * Capture uses the browser's native MediaRecorder: it's the one recording
 * API every engine (Chrome, Firefox, Safari/iOS) implements for camera +
 * mic, and it captures and syncs audio internally — no Web Audio graph or
 * user-gesture rules in the way (an earlier WebCodecs-based capture lost
 * the audio on iOS/Firefox for exactly that reason). Its raw output isn't
 * good enough to hand out (WebM has no duration/index; MediaRecorder MP4 is
 * fragmented), so on stop a Mediabunny pass rewrites it: a plain copy when
 * the codecs are already H.264/AAC, a transcode otherwise.
 *
 * Which container/codec combo a device can actually encode is only known by
 * trying, so probe() makes a tiny throwaway recording with the real tracks
 * ahead of time, and start() still falls through to the next candidate if
 * the encoder fails before producing any data.
 *
 * The controller takes ownership of the tracks passed to start() and stops
 * them once the recording ends, so callers should hand it clones.
 *
 * Events: 'start', 'processing' (stopped, file being finalized),
 * 'progress' (detail: { progress: 0..1 }), 'recording' (detail: the
 * finished file), 'error' (detail: Error).
 */
export class RecordingController extends EventTarget {
  constructor() {
    super();
    this.state = 'idle'; // 'idle' | 'recording' | 'processing'
    this.candidates = supportedMimeTypes();
    this.mimeType = this.candidates[0] || ''; // currently preferred; refined by probe()
    this.lastFinalize = null; // 'copy' | 'transcode' | 'raw', for the debug panel
    this._session = null;
    this._probeToken = 0;
  }

  get isRecording() {
    return this.state === 'recording';
  }

  get isBusy() {
    return this.state !== 'idle';
  }

  /** Fetches the muxer ahead of time so finishing a take has no load delay. */
  preload() {
    return loadMediabunny();
  }

  /**
   * Finds the first candidate format this device can really record with
   * these tracks (clones are used and stopped). Cheap: ~0.3-1 s in the
   * background. A newer call supersedes an older one still running.
   */
  async probe(videoTrack, audioTrack = null) {
    const token = ++this._probeToken;
    for (const mimeType of this.candidates) {
      if (token !== this._probeToken || this.isBusy) return this.mimeType;
      const tracks = [videoTrack.clone(), audioTrack && audioTrack.clone()].filter(Boolean);
      const ok = await probeOnce(mimeType, tracks, videoTrack);
      tracks.forEach((t) => t.stop());
      if (ok) {
        if (token === this._probeToken) this.mimeType = mimeType;
        return mimeType;
      }
      console.warn('[MotionMirror] recording format rejected by this device:', mimeType);
    }
    return this.mimeType;
  }

  start({ videoTrack, audioTrack = null, meta = {} }) {
    if (this.isBusy) return;
    const tracks = [videoTrack, audioTrack].filter(Boolean);
    if (!this.candidates.length) {
      tracks.forEach((t) => t.stop());
      throw new Error('Este navegador no puede grabar video.');
    }
    this._probeToken++; // cancel any probe still running
    this._session = {
      tracks,
      videoTrack,
      meta,
      chunks: [],
      recorder: null,
      mimeType: '',
      startedAt: performance.now(),
    };
    this.state = 'recording';
    const startIndex = Math.max(0, this.candidates.indexOf(this.mimeType));
    if (!this._launch(startIndex)) {
      this._session = null;
      this.state = 'idle';
      tracks.forEach((t) => t.stop());
      throw new Error('No se pudo iniciar la grabación en este dispositivo.');
    }
    this.dispatchEvent(new CustomEvent('start'));
  }

  /**
   * Starts a MediaRecorder with the candidate at `index` (or the next one
   * that can be constructed). If the encoder rejects the configuration before
   * any data comes out, the next candidate takes over transparently.
   */
  _launch(index) {
    const session = this._session;
    for (let i = index; i < this.candidates.length; i++) {
      const mimeType = this.candidates[i];
      let recorder;
      try {
        recorder = new MediaRecorder(new MediaStream(session.tracks), recorderOptions(mimeType, session.videoTrack));
      } catch (err) {
        console.warn('[MotionMirror] MediaRecorder rejected', mimeType, err);
        continue;
      }
      const launchedAt = performance.now();
      recorder.addEventListener('dataavailable', (e) => {
        if (session.recorder !== recorder || !e.data || e.data.size === 0) return;
        session.chunks.push(e.data);
      });
      recorder.addEventListener('error', (e) => {
        if (session.recorder !== recorder) return;
        console.error('[MotionMirror] MediaRecorder error', mimeType, e.error || e);
        if (performance.now() - launchedAt < SETUP_FAILURE_WINDOW_MS && this.isRecording) {
          // Failed during encoder setup: switch formats without the user noticing.
          session.recorder = null;
          try { recorder.stop(); } catch (_) { /* already inactive */ }
          session.chunks = [];
          if (this._launch(i + 1)) return;
        }
        if (this.isRecording) this.stop();
      });
      try {
        recorder.start(1000); // 1s timeslices: bounded chunks, partial data survives a crash
      } catch (err) {
        console.warn('[MotionMirror] MediaRecorder failed to start', mimeType, err);
        continue;
      }
      session.recorder = recorder;
      session.mimeType = mimeType;
      this.mimeType = mimeType; // remember what worked for the next take
      return true;
    }
    return false;
  }

  async stop() {
    if (!this.isRecording) return;
    const session = this._session;
    this.state = 'processing';
    this.dispatchEvent(new CustomEvent('processing'));
    const durationMs = performance.now() - session.startedAt;
    try {
      const recorder = session.recorder;
      if (recorder && recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true });
          recorder.stop();
        });
      }
      session.tracks.forEach((t) => t.stop());
      const size = session.chunks.reduce((sum, c) => sum + c.size, 0);
      if (!size) throw new Error('El dispositivo no produjo video. Intenta de nuevo o cambia la resolución.');
      const raw = new Blob(session.chunks, { type: session.mimeType.split(';')[0] });
      const blob = await this._finalize(raw, (progress) => {
        this.dispatchEvent(new CustomEvent('progress', { detail: { progress } }));
      });
      this.dispatchEvent(new CustomEvent('recording', {
        detail: {
          blob,
          url: URL.createObjectURL(blob),
          durationMs,
          mimeType: blob.type,
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

  /**
   * Rewrites the MediaRecorder file into a fast-start MP4 (H.264 + AAC):
   * copied when the codecs already match, transcoded otherwise. Falls back to
   * a cued WebM, and finally to the raw file, so a take is never lost.
   */
  async _finalize(raw, onProgress) {
    let mb;
    try {
      mb = await loadMediabunny();
    } catch (err) {
      console.warn('[MotionMirror] muxer unavailable, keeping raw recording', err);
      this.lastFinalize = 'raw';
      return raw;
    }

    const attempts = [
      { format: () => new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), toMp4: true },
      { format: () => new mb.WebMOutputFormat(), toMp4: false },
    ];
    for (const attempt of attempts) {
      try {
        const input = new mb.Input({ source: new mb.BlobSource(raw), formats: mb.ALL_FORMATS });
        const target = new mb.BufferTarget();
        const format = attempt.format();
        const output = new mb.Output({ format, target });
        let transcoding = false;

        const conversion = await mb.Conversion.init({
          input,
          output,
          video: attempt.toMp4 ? (track) => {
            if (track.codec === 'avc') return { codec: 'avc' }; // straight copy
            transcoding = true;
            // Re-encoding goes through the device's H.264 encoder, which on
            // some Android phones stripes non-16-aligned sizes (see utils.js).
            const w = track.displayWidth;
            const h = track.displayHeight;
            return isAligned(w, h)
              ? { codec: 'avc', bitrate: mb.QUALITY_HIGH }
              : { codec: 'avc', bitrate: mb.QUALITY_HIGH, width: alignDown(w), height: alignDown(h), fit: 'cover' };
          } : undefined,
          audio: attempt.toMp4 ? async (track) => {
            if (track.codec === 'aac') return { codec: 'aac' }; // straight copy
            transcoding = true;
            await ensureAacEncoder(mb);
            // 48 kHz keeps it plain AAC-LC (at <= 24 kHz the AAC profile
            // would switch to HE-AAC, which encoders and players handle poorly).
            return { codec: 'aac', bitrate: AUDIO_BITRATE, sampleRate: 48000 };
          } : undefined,
        });
        if (!conversion.isValid || conversion.discardedTracks.length > 0) {
          console.warn('[MotionMirror] finalize attempt not possible', conversion.discardedTracks);
          continue;
        }
        conversion.onProgress = (p) => onProgress(Math.min(1, Math.max(0, p)));
        await conversion.execute();
        this.lastFinalize = transcoding ? 'transcode' : 'copy';
        return new Blob([target.buffer], { type: format.mimeType });
      } catch (err) {
        console.warn('[MotionMirror] finalize attempt failed', err);
      }
    }
    this.lastFinalize = 'raw';
    return raw;
  }
}

/** Records a fraction of a second; true if data came out and no error did. */
function probeOnce(mimeType, tracks, videoTrack) {
  return new Promise((resolve) => {
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), recorderOptions(mimeType, videoTrack));
    } catch (_) {
      resolve(false);
      return;
    }
    let bytes = 0;
    let errored = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(stopTimer);
      clearTimeout(timeout);
      resolve(!errored && bytes > 0);
    };
    recorder.addEventListener('dataavailable', (e) => { bytes += (e.data && e.data.size) || 0; });
    recorder.addEventListener('error', () => { errored = true; });
    recorder.addEventListener('stop', finish);
    const stopTimer = setTimeout(() => {
      try { if (recorder.state !== 'inactive') recorder.stop(); else finish(); } catch (_) { finish(); }
    }, PROBE_DURATION_MS);
    const timeout = setTimeout(() => { errored = errored || bytes === 0; finish(); }, PROBE_TIMEOUT_MS);
    try {
      recorder.start(250);
    } catch (_) {
      errored = true;
      finish();
    }
  });
}

export function fileExtensionFor(mimeType) {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}
