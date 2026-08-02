import { computeFrameBufferBudgetBytes, computeMaxDelaySeconds } from './utils.js';

/**
 * Fallback delay engine for browsers without WebCodecs (VideoEncoder/
 * VideoDecoder). Buffers raw, uncompressed ImageBitmaps — simple and
 * universally supported, but memory-bound: see computeMaxDelaySeconds in
 * utils.js for why the achievable delay is only a few seconds at 1080p.
 * Prefer WebCodecsDelayEngine (delayEngineWebCodecs.js) whenever available;
 * DelayEngine (delayEngine.js) picks between the two automatically.
 */
export class RawBitmapDelayEngine {
  constructor(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.ctx = canvasEl.getContext('2d', { alpha: false });
    this.buffer = []; // { bitmap, t }
    this.delaySeconds = 5;
    this.running = false;
    this._captureHandle = null;
    this._renderHandle = null;
    this._usingRVFC = typeof this.videoEl.requestVideoFrameCallback === 'function';
    this._lastCapturedTime = -1;
    this._captureInFlight = false;
    this.hasRenderedFrame = false; // false until the canvas has been painted at least once this session

    this.stats = { captureFps: 0, renderFps: 0, bufferFrames: 0, bufferBytes: 0, mode: 'raw' };
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
    const fps = 30;
    return computeMaxDelaySeconds(w, h, fps);
  }

  /** No-op: the raw path has no codec to warm up. Exists for interface parity with WebCodecsDelayEngine. */
  async prewarm() {}

  _syncCanvasSize() {
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (w && h && (this.canvasEl.width !== w || this.canvasEl.height !== h)) {
      this.canvasEl.width = w;
      this.canvasEl.height = h;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.hasRenderedFrame = false;
    this._syncCanvasSize();

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

  stop() {
    this.running = false;
    if (this._usingRVFC && this._captureHandle && this.videoEl.cancelVideoFrameCallback) {
      this.videoEl.cancelVideoFrameCallback(this._captureHandle);
    } else if (this._captureHandle) {
      cancelAnimationFrame(this._captureHandle);
    }
    if (this._renderHandle) cancelAnimationFrame(this._renderHandle);
    this._drainBuffer();
  }

  _drainBuffer() {
    for (const f of this.buffer) f.bitmap.close();
    this.buffer.length = 0;
  }

  async _captureFrame() {
    // createImageBitmap() is async and its cost grows with resolution. The
    // capture loop fires on every decoded video frame regardless of whether
    // the previous capture finished, so without this guard, at high
    // resolutions calls start overlapping faster than they resolve: dozens
    // of multi-MB bitmap allocations pile up concurrently, starving the
    // GPU/main thread. Dropping ticks while one is still in flight caps
    // concurrency at 1 and lets capture rate self-throttle to whatever the
    // device can sustain.
    if (this._captureInFlight) return;
    this._captureInFlight = true;
    try {
      this._syncCanvasSize();
      if (!this.canvasEl.width || !this.canvasEl.height) return;
      let bitmap;
      try {
        bitmap = await createImageBitmap(this.videoEl);
      } catch (_) {
        return; // video not ready yet
      }
      if (!this.running) {
        bitmap.close();
        return;
      }
      this.buffer.push({ bitmap, t: performance.now() });
      this._captureCount++;
      this._enforceBudget();
    } finally {
      this._captureInFlight = false;
    }
  }

  _enforceBudget() {
    const bytesPerFrame = this.canvasEl.width * this.canvasEl.height * 4;
    const budget = computeFrameBufferBudgetBytes();
    const maxFrames = Math.max(1, Math.floor(budget / bytesPerFrame));
    while (this.buffer.length > maxFrames) {
      this.buffer.shift().bitmap.close();
    }
  }

  _renderFrame() {
    const targetTime = performance.now() - this.delaySeconds * 1000;
    let chosen = null;
    while (this.buffer.length && this.buffer[0].t <= targetTime) {
      const f = this.buffer.shift();
      if (chosen) chosen.bitmap.close();
      chosen = f;
    }
    if (chosen) {
      this.ctx.drawImage(chosen.bitmap, 0, 0, this.canvasEl.width, this.canvasEl.height);
      chosen.bitmap.close();
      this._renderCount++;
      this.hasRenderedFrame = true;
    }

    const now = performance.now();
    const elapsed = now - this._statsWindowStart;
    if (elapsed >= 500) {
      this.stats.captureFps = (this._captureCount * 1000) / elapsed;
      this.stats.renderFps = (this._renderCount * 1000) / elapsed;
      this.stats.bufferFrames = this.buffer.length;
      this.stats.bufferBytes = this.buffer.length * this.canvasEl.width * this.canvasEl.height * 4;
      this._captureCount = 0;
      this._renderCount = 0;
      this._statsWindowStart = now;
    }
  }
}
