/**
 * Delay engine backed by WebCodecs (VideoEncoder/VideoDecoder). Instead of
 * buffering raw ImageBitmaps (~8 MB/frame at 1080p, memory-bound to a few
 * seconds of delay), every captured frame is compressed as an independent
 * H.264 keyframe (~50-90 KB/frame measured against a real webcam) and
 * decoded back only when it's actually due to be shown. Measured on real
 * hardware (see the project's delay-strategy research note): ~15ms to
 * encode and ~10ms to decode a 1080p frame, both comfortably under the 33ms
 * real-time budget at 30fps — a real video codec is built for continuous
 * real-time throughput in a way per-frame JPEG (canvas.toBlob) is not.
 *
 * Every frame is forced as a keyframe (no inter-frame prediction) because
 * the delay buffer needs random access: whichever frame's turn it is to be
 * shown must be decodable on its own, without first decoding everything
 * captured since the last keyframe.
 */

const BUFFER_BUDGET_BYTES = 150 * 1024 * 1024; // generous: compressed frames are tiny, this is essentially never the binding constraint
const SAFETY_MARGIN = 0.7; // same reasoning as the raw engine: never promise a delay that needs the buffer's full capacity, or capture's eviction races render for the same oldest chunk
const REFERENCE_BYTES_PER_FRAME_1080P = 100 * 1024; // pre-measurement estimate (padded above the ~82KB measured); refined from real output the moment capture starts
const MIN_DELAY_S = 1;
const MAX_DELAY_S = 60; // hard UX cap — memory stops being the limiting factor long before this

// AVC levels by max macroblocks/frame, enough to cover every resolution preset up to 4K.
const AVC_LEVELS = [
  { maxMacroblocks: 3600, hex: '1f' }, // 3.1 -> covers 1280x720
  { maxMacroblocks: 8192, hex: '28' }, // 4.0 -> covers 1920x1080
  { maxMacroblocks: 22080, hex: '32' }, // 5.0 -> covers 2560x1440
  { maxMacroblocks: 36864, hex: '33' }, // 5.1 -> covers 3840x2160
];

function avcCodecFor(width, height) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find((l) => macroblocks <= l.maxMacroblocks) || AVC_LEVELS[AVC_LEVELS.length - 1];
  return `avc1.4200${level.hex}`;
}

export function supportsWebCodecsDelay() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

export class WebCodecsDelayEngine {
  constructor(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.ctx = canvasEl.getContext('2d', { alpha: false });
    this.buffer = []; // { chunk, t, bytes }
    this.bufferedBytes = 0;
    this.delaySeconds = 5;
    this.running = false;

    this.encoder = null;
    this.decoder = null;
    this.decoderDescription = null;
    this._configuredW = 0;
    this._configuredH = 0;
    this._configuringPromise = null;

    this._frameSeq = 0;
    this._pendingCaptureTimes = new Map();
    this._primingSeqs = new Set();
    this._avgBytesPerFrame = null; // null until real (non-priming) output arrives

    this._captureHandle = null;
    this._renderHandle = null;
    this._usingRVFC = typeof this.videoEl.requestVideoFrameCallback === 'function';
    this._lastCapturedTime = -1;
    this.hasRenderedFrame = false; // false while the canvas hasn't been painted yet this session (buffer still filling, or just reconfigured) — recording during this window would capture stale/blank content

    this.stats = { captureFps: 0, renderFps: 0, bufferFrames: 0, bufferBytes: 0, mode: 'webcodecs' };
    this._captureCount = 0;
    this._renderCount = 0;
    this._statsWindowStart = performance.now();
  }

  setDelay(seconds) {
    this.delaySeconds = seconds;
  }

  getMaxDelaySeconds() {
    const w = this.videoEl.videoWidth || 1280;
    const h = this.videoEl.videoHeight || 720;
    const bytesPerFrame = this._avgBytesPerFrame || (REFERENCE_BYTES_PER_FRAME_1080P * (w * h)) / (1920 * 1080);
    const fps = 30; // encode/decode cost scales with content complexity, not display refresh rate
    const maxFrames = Math.max(1, Math.floor((BUFFER_BUDGET_BYTES * SAFETY_MARGIN) / bytesPerFrame));
    return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, maxFrames / fps));
  }

  /**
   * Configures (or reconfigures) the encoder/decoder for the video's current
   * dimensions and encodes one throwaway keyframe to absorb the codec's
   * one-time internal init cost (measured 190ms-1.2s) before it's needed.
   * Safe to call proactively (e.g. right after the camera starts, or after
   * a quality change) — re-entrant calls while already configuring/warm
   * for the current size are coalesced or skipped.
   */
  async prewarm() {
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (!w || !h) return;
    if (this.encoder && this._configuredW === w && this._configuredH === h) return;
    if (this._configuringPromise) return this._configuringPromise;

    this._configuringPromise = (async () => {
      this._configureCodecs(w, h);
      await this._primeEncoder();
    })();
    try {
      await this._configuringPromise;
    } finally {
      this._configuringPromise = null;
    }
  }

  _configureCodecs(w, h) {
    this._teardownCodecs();
    this.decoderDescription = null;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this._onEncoded(chunk, meta),
      error: (err) => console.error('[MotionMirror] encoder error', err),
    });
    this.encoder.configure({
      codec: avcCodecFor(w, h),
      width: w,
      height: h,
      bitrate: Math.round((6_000_000 * (w * h)) / (1920 * 1080)),
      framerate: 30,
      hardwareAcceleration: 'no-preference', // "no-preference" still uses hardware when the UA has it; "prefer-hardware" hard-fails on devices without one
      latencyMode: 'realtime',
    });

    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecoded(frame),
      error: (err) => console.error('[MotionMirror] decoder error', err),
    });
    // decoder.configure() happens lazily in _onEncoded, once the first
    // chunk hands us the description bytes an AVC decoder requires.

    this._configuredW = w;
    this._configuredH = h;
  }

  _teardownCodecs() {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.encoder = null;
    this.decoder = null;
    this._pendingCaptureTimes.clear();
    this._primingSeqs.clear();
    this.hasRenderedFrame = false;
    this._drainBuffer();
  }

  async _primeEncoder() {
    if (this.videoEl.readyState < 2) return; // no decoded frame available yet to prime with
    const seq = this._frameSeq++;
    this._primingSeqs.add(seq);
    const frame = new VideoFrame(this.videoEl, { timestamp: seq });
    try {
      this.encoder.encode(frame, { keyFrame: true });
    } finally {
      frame.close();
    }
  }

  _onEncoded(chunk, meta) {
    if (meta && meta.decoderConfig && !this.decoderDescription) {
      this.decoderDescription = meta.decoderConfig.description;
      if (this.decoder && this.decoder.state === 'unconfigured') {
        this.decoder.configure({
          codec: avcCodecFor(this._configuredW, this._configuredH),
          description: this.decoderDescription,
          optimizeForLatency: true,
        });
      }
    }

    if (this._primingSeqs.has(chunk.timestamp)) {
      this._primingSeqs.delete(chunk.timestamp);
      return; // throwaway warm-up frame, not real buffered content
    }

    const capturedAt = this._pendingCaptureTimes.get(chunk.timestamp);
    this._pendingCaptureTimes.delete(chunk.timestamp);

    // Refine the bytes/frame estimate getMaxDelaySeconds() uses, from real data.
    this._avgBytesPerFrame =
      this._avgBytesPerFrame == null ? chunk.byteLength : this._avgBytesPerFrame * 0.9 + chunk.byteLength * 0.1;

    this.buffer.push({ chunk, t: capturedAt ?? performance.now(), bytes: chunk.byteLength });
    this.bufferedBytes += chunk.byteLength;
    this._captureCount++;
    this._enforceBudget();
  }

  _onDecoded(frame) {
    this._syncCanvasSize();
    if (this.canvasEl.width && this.canvasEl.height) {
      this.ctx.drawImage(frame, 0, 0, this.canvasEl.width, this.canvasEl.height);
      this._renderCount++;
      this.hasRenderedFrame = true;
    }
    frame.close();
  }

  _enforceBudget() {
    while (this.bufferedBytes > BUFFER_BUDGET_BYTES && this.buffer.length > 1) {
      this.bufferedBytes -= this.buffer.shift().bytes;
    }
  }

  _syncCanvasSize() {
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (w && h && (this.canvasEl.width !== w || this.canvasEl.height !== h)) {
      this.canvasEl.width = w;
      this.canvasEl.height = h;
    }
  }

  async start() {
    if (this.running) return;
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (!this.encoder || this._configuredW !== w || this._configuredH !== h) {
      await this.prewarm();
    }
    this._syncCanvasSize();
    this.running = true;
    this.hasRenderedFrame = false; // buffer starts empty each time delay mode is (re-)entered, even if the codecs stayed warm

    if (this._usingRVFC) {
      const onFrame = () => {
        if (!this.running) return;
        this._captureFrame();
        this._captureHandle = this.videoEl.requestVideoFrameCallback(onFrame);
      };
      this._captureHandle = this.videoEl.requestVideoFrameCallback(onFrame);
    } else {
      const onTick = () => {
        if (!this.running) return;
        if (this.videoEl.currentTime !== this._lastCapturedTime) {
          this._lastCapturedTime = this.videoEl.currentTime;
          this._captureFrame();
        }
        this._captureHandle = requestAnimationFrame(onTick);
      };
      this._captureHandle = requestAnimationFrame(onTick);
    }

    const onRender = () => {
      if (!this.running) return;
      this._renderFrame();
      this._renderHandle = requestAnimationFrame(onRender);
    };
    this._renderHandle = requestAnimationFrame(onRender);
  }

  _captureFrame() {
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (!w || !h) return;

    if (w !== this._configuredW || h !== this._configuredH) {
      // Resolution changed mid-session: chunks already buffered were encoded
      // against the old codec config and can't be decoded against a new
      // one, so reconfigure and let the buffer refill from scratch.
      this.prewarm().catch((err) => console.warn('[MotionMirror] delay engine reconfigure failed', err));
      return;
    }
    if (!this.encoder || this.encoder.state !== 'configured') return;
    if (this.encoder.encodeQueueSize > 2) return; // encoder is behind; drop this tick instead of piling up work

    const seq = this._frameSeq++;
    this._pendingCaptureTimes.set(seq, performance.now());
    const frame = new VideoFrame(this.videoEl, { timestamp: seq });
    try {
      this.encoder.encode(frame, { keyFrame: true });
    } finally {
      frame.close();
    }
  }

  _renderFrame() {
    const targetTime = performance.now() - this.delaySeconds * 1000;
    let chosen = null;
    while (this.buffer.length && this.buffer[0].t <= targetTime) {
      const f = this.buffer.shift();
      this.bufferedBytes -= f.bytes;
      chosen = f; // EncodedVideoChunk has no dispose step, unlike ImageBitmap — just drop the reference
    }
    if (chosen && this.decoder && this.decoder.state === 'configured' && this.decoder.decodeQueueSize < 2) {
      this.decoder.decode(chosen.chunk);
    }

    const now = performance.now();
    const elapsed = now - this._statsWindowStart;
    if (elapsed >= 500) {
      this.stats.captureFps = (this._captureCount * 1000) / elapsed;
      this.stats.renderFps = (this._renderCount * 1000) / elapsed;
      this.stats.bufferFrames = this.buffer.length;
      this.stats.bufferBytes = this.bufferedBytes;
      this._captureCount = 0;
      this._renderCount = 0;
      this._statsWindowStart = now;
    }
  }

  stop() {
    this.running = false;
    if (this._usingRVFC && this._captureHandle && this.videoEl.cancelVideoFrameCallback) {
      this.videoEl.cancelVideoFrameCallback(this._captureHandle);
    } else if (this._captureHandle) {
      cancelAnimationFrame(this._captureHandle);
    }
    if (this._renderHandle) cancelAnimationFrame(this._renderHandle);
    // Deliberately keep the encoder/decoder alive and configured so toggling
    // back into delay mode later doesn't re-pay the warm-up cost — only the
    // pending frame buffer is cleared.
    this._drainBuffer();
  }

  _drainBuffer() {
    this.buffer.length = 0;
    this.bufferedBytes = 0;
  }
}
