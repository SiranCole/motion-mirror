const RESOLUTION_PRESETS = [
  { label: '4K (3840x2160)', width: 3840, height: 2160 },
  { label: '1440p (2560x1440)', width: 2560, height: 1440 },
  { label: '1080p (1920x1080)', width: 1920, height: 1080 },
  { label: '720p (1280x720)', width: 1280, height: 720 },
  { label: '480p (854x480)', width: 854, height: 480 },
  { label: '360p (640x360)', width: 640, height: 360 },
];

const FPS_PRESETS = [60, 30, 24, 15, 10];

/**
 * Wraps getUserMedia device/stream management: enumerating cameras, applying
 * resolution/fps either live (applyConstraints, no re-prompt / no flicker)
 * or via a full restart when the physical device changes.
 */
export class CameraController extends EventTarget {
  constructor(videoEl) {
    super();
    this.videoEl = videoEl;
    this.stream = null;
    this.track = null;
    this.devices = [];
  }

  get capabilities() {
    if (!this.track || typeof this.track.getCapabilities !== 'function') return null;
    try {
      return this.track.getCapabilities();
    } catch (_) {
      return null;
    }
  }

  async init() {
    // A first getUserMedia call is required before enumerateDevices() returns
    // usable labels/deviceIds (privacy restriction until permission is granted).
    await this._openStream({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    await this._refreshDeviceList();
    return this.stream;
  }

  async _refreshDeviceList() {
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === 'videoinput');
    this.dispatchEvent(new CustomEvent('devices', { detail: this.devices }));
  }

  async _openStream(constraints) {
    this._stopCurrent();
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => {
      this.dispatchEvent(new CustomEvent('trackended'));
    });
    this.videoEl.srcObject = stream;
    await this.videoEl.play().catch(() => {});
    this.dispatchEvent(new CustomEvent('streamchanged', { detail: this.settings }));
    return stream;
  }

  _stopCurrent() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.track = null;
  }

  get settings() {
    if (!this.track) return null;
    try {
      return this.track.getSettings();
    } catch (_) {
      return null;
    }
  }

  /** Switch to a specific physical camera (always a full restart). */
  async switchDevice(deviceId, { width, height, frameRate } = {}) {
    await this._openStream({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: width || 1280 },
        height: { ideal: height || 720 },
        frameRate: { ideal: frameRate || 30 },
      },
    });
    await this._refreshDeviceList();
  }

  /** Change resolution/fps on the current device without a full restart when possible. */
  async applyQuality({ width, height, frameRate }) {
    if (!this.track) return;
    try {
      await this.track.applyConstraints({
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate },
      });
      this.dispatchEvent(new CustomEvent('streamchanged', { detail: this.settings }));
    } catch (err) {
      // Some browsers/devices refuse mid-stream constraint changes; fall back
      // to a full restart on the same device.
      const deviceId = this.track.getSettings().deviceId;
      await this._openStream({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: frameRate },
        },
      });
    }
  }

  /** Resolution presets filtered to what the current device claims to support. */
  getResolutionPresets() {
    const caps = this.capabilities;
    if (!caps || !caps.width || !caps.height) return RESOLUTION_PRESETS;
    const maxW = caps.width.max || Infinity;
    const maxH = caps.height.max || Infinity;
    const filtered = RESOLUTION_PRESETS.filter((p) => p.width <= maxW && p.height <= maxH);
    return filtered.length ? filtered : RESOLUTION_PRESETS.slice(-1);
  }

  getFpsPresets() {
    const caps = this.capabilities;
    if (!caps || !caps.frameRate) return FPS_PRESETS;
    const maxFps = caps.frameRate.max || 60;
    const filtered = FPS_PRESETS.filter((f) => f <= maxFps + 1);
    return filtered.length ? filtered : [Math.round(maxFps)];
  }

  stop() {
    this._stopCurrent();
  }
}
