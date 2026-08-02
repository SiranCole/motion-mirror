import { RawBitmapDelayEngine } from './delayEngineRaw.js';
import { WebCodecsDelayEngine, supportsWebCodecsDelay } from './delayEngineWebCodecs.js';

/**
 * Picks the WebCodecs-backed delay engine when the browser supports it
 * (dramatically longer delays for the same memory — see
 * delayEngineWebCodecs.js), falling back to the raw ImageBitmap buffer
 * (delayEngineRaw.js) otherwise. Also falls back at runtime if WebCodecs
 * exists but fails to actually start (unsupported config on this specific
 * device/resolution) — feature detection alone can't rule that out.
 */
export class DelayEngine {
  constructor(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.usingWebCodecs = supportsWebCodecsDelay();
    this._impl = this.usingWebCodecs
      ? new WebCodecsDelayEngine(videoEl, canvasEl)
      : new RawBitmapDelayEngine(videoEl, canvasEl);
  }

  get stats() {
    return this._impl.stats;
  }

  get running() {
    return this._impl.running;
  }

  get usingRVFC() {
    return this._impl._usingRVFC;
  }

  get hasRenderedFrame() {
    return this._impl.hasRenderedFrame;
  }

  setDelay(seconds) {
    this._impl.setDelay(seconds);
  }

  getMaxDelaySeconds() {
    return this._impl.getMaxDelaySeconds();
  }

  prewarm() {
    return this._impl.prewarm ? this._impl.prewarm() : Promise.resolve();
  }

  async start() {
    if (this.usingWebCodecs) {
      try {
        await this._impl.start();
        return;
      } catch (err) {
        console.warn('[MotionMirror] WebCodecs delay engine failed, falling back to raw buffer:', err);
        this._impl.stop();
        this.usingWebCodecs = false;
        this._impl = new RawBitmapDelayEngine(this.videoEl, this.canvasEl);
      }
    }
    return this._impl.start();
  }

  stop() {
    this._impl.stop();
  }
}
