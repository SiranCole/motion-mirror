export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Player clock: m:ss.t (tenths help when hunting for an exact moment in a
 * move), widening to h:mm:ss.t only when the media is an hour or longer.
 */
export function formatClock(seconds, durationForWidth = seconds) {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const tenths = Math.floor((t % 1) * 10);
  const whole = Math.floor(t);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  if (durationForWidth >= 3600) return `${h}:${String(m).padStart(2, '0')}:${s}.${tenths}`;
  return `${m}:${s}.${tenths}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Rough memory budget (in bytes) we allow the delayed-mirror frame buffer to
 * grow to before we clamp the maximum selectable delay. navigator.deviceMemory
 * is Chrome/Edge-only and only reports an approximate bucket (0.25-8 GB), so
 * this is intentionally conservative rather than precise.
 */
export function computeFrameBufferBudgetBytes() {
  const deviceMemoryGB = navigator.deviceMemory || 4;
  const budgetMB = clamp(deviceMemoryGB * 60, 150, 600);
  return budgetMB * 1024 * 1024;
}

/**
 * The delay engine's own hard cap (see DelayEngine._enforceBudget) evicts the
 * oldest buffered frame whenever the buffer would exceed the memory budget.
 * If the UI let users pick a delay that needs the buffer's *entire* capacity
 * just to hold `delaySeconds` worth of frames, there's zero slack: capture
 * (driven by the camera's frame rate) and render (driven by display refresh)
 * tick independently, so on any given moment capture can be a frame or two
 * ahead of render — and that hard cap would then evict the exact frame
 * render is about to need, forever, freezing the delayed view. Reporting
 * only a fraction of the raw memory-derived capacity as the selectable max
 * keeps a permanent cushion between "how long we promise to hold frames"
 * and "how long the buffer can actually hold them".
 */
const DELAY_SAFETY_MARGIN = 0.7;

/**
 * Given the current capture resolution/fps, how many seconds of delay can we
 * buffer (as raw RGBA ImageBitmaps) before hitting the memory budget.
 */
export function computeMaxDelaySeconds(width, height, fps) {
  const bytesPerFrame = Math.max(1, width) * Math.max(1, height) * 4;
  const budget = computeFrameBufferBudgetBytes();
  const maxFrames = Math.max(1, Math.floor(budget / bytesPerFrame));
  const maxSeconds = (maxFrames * DELAY_SAFETY_MARGIN) / Math.max(1, fps);
  return clamp(maxSeconds, 1, 60);
}

/**
 * Many Android hardware H.264 encoders (reached through WebCodecs) mishandle
 * frames whose width/height isn't a multiple of 16 — the output comes out
 * sheared into diagonal stripes, because the row stride the encoder assumes
 * doesn't match the buffer's. Phones hit this easily: a portrait 360x640
 * stream, or 1080-tall video. Encoding at the largest 16-aligned size that
 * fits (cropping at most 15px off an edge) sidesteps it everywhere.
 */
export const ENCODER_ALIGNMENT = 16;

export function alignDown(value, alignment = ENCODER_ALIGNMENT) {
  return Math.max(alignment, Math.floor(value / alignment) * alignment);
}

export function isAligned(width, height, alignment = ENCODER_ALIGNMENT) {
  return width % alignment === 0 && height % alignment === 0;
}

export function isSecureContextOk() {
  return window.isSecureContext === true;
}
