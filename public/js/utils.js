export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
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

export function isSecureContextOk() {
  return window.isSecureContext === true;
}
