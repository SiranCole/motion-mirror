/**
 * Owns the microphone for the whole session, so the app can show — before a
 * take, not after — whether audio will actually be recorded:
 *
 * - The mic is requested together with the camera (one permission prompt),
 *   or on its own via connect() from a button tap.
 * - A live level meter (AnalyserNode) proves sound is reaching the page,
 *   like the green bars in Loom/Meet device checks.
 * - Track `mute`/`ended` events (another app grabbed the mic, it was
 *   unplugged, permission revoked) are reflected immediately.
 *
 * The meter is display-only; recording reads the track through
 * MediaRecorder, which captures audio natively in every browser. The
 * AudioContext behind the meter must be created/resumed inside a user
 * gesture (iOS Safari keeps it suspended otherwise), hence prepareMeter().
 *
 * Events: 'change' whenever `status` (or the device list) changes.
 */

// Browser speech processing (noise suppression, echo cancellation, AGC) is
// tuned for calls and audibly mangles music, which is what most practice
// sessions have playing — so it's off unless the user turns it on.
export function micConstraints({ processing = false, deviceId = null } = {}) {
  return {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export class MicController extends EventTarget {
  constructor() {
    super();
    this.track = null;
    this.devices = [];
    this.processing = false;
    // 'off' (not requested yet) | 'ready' | 'muted' | 'denied' | 'notfound' | 'busy' | 'error'
    this.status = 'off';
    this.audioContext = null;
    this._analyser = null;
    this._sourceNode = null;
    this._samples = null;
    this._onTrackChange = () => this._refreshStatus();
  }

  get isReady() {
    return this.status === 'ready';
  }

  get label() {
    return (this.track && this.track.label) || '';
  }

  get deviceId() {
    if (!this.track) return null;
    try {
      return this.track.getSettings().deviceId || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Must run synchronously inside a click/tap handler, before any await, so
   * the meter's AudioContext is allowed to run (autoplay policies).
   */
  prepareMeter() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.audioContext) {
      try {
        this.audioContext = new Ctx();
      } catch (_) {
        return;
      }
      // If it still couldn't start (no activation), retry on the next tap.
      const retry = () => {
        if (this.audioContext.state === 'running') {
          document.removeEventListener('pointerdown', retry, true);
          return;
        }
        this.audioContext.resume().catch(() => {});
      };
      document.addEventListener('pointerdown', retry, true);
    }
    if (this.audioContext.state !== 'running') this.audioContext.resume().catch(() => {});
  }

  get meterRunning() {
    return !!(this.audioContext && this.audioContext.state === 'running' && this._analyser);
  }

  /** Adopts a track from a combined camera+mic getUserMedia call. */
  async adopt(track) {
    this._setTrack(track);
    await this._refreshDevices();
  }

  /** Records why the mic couldn't be obtained alongside the camera. */
  fail(err) {
    this._setTrack(null);
    this._setStatus(statusForError(err));
  }

  /** Asks for the mic on its own (e.g. "Permitir micrófono"). Call from a tap. */
  async connect(deviceId = this.deviceId) {
    this.prepareMeter();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints({ processing: this.processing, deviceId }),
      });
      this._setTrack(stream.getAudioTracks()[0] || null);
      await this._refreshDevices();
    } catch (err) {
      console.warn('[MotionMirror] microphone request failed', err);
      this._setTrack(null);
      this._setStatus(statusForError(err));
    }
    return this.isReady;
  }

  async setProcessing(processing) {
    this.processing = processing;
    if (!this.track) return;
    try {
      await this.track.applyConstraints(micConstraints({ processing }));
    } catch (_) {
      // Some browsers refuse changing these on a live track; reopen instead.
      await this.connect(this.deviceId);
    }
  }

  /** Current input level, 0..1 (RMS, scaled so normal speech reads ~0.3-0.7). */
  getLevel() {
    if (!this.meterRunning || !this.isReady) return 0;
    this._analyser.getFloatTimeDomainData(this._samples);
    let sum = 0;
    for (let i = 0; i < this._samples.length; i++) sum += this._samples[i] * this._samples[i];
    const rms = Math.sqrt(sum / this._samples.length);
    return Math.min(1, rms * 4);
  }

  stop() {
    this._setTrack(null);
    this._setStatus('off');
  }

  _setTrack(track) {
    if (this.track) {
      this.track.removeEventListener('mute', this._onTrackChange);
      this.track.removeEventListener('unmute', this._onTrackChange);
      this.track.removeEventListener('ended', this._onTrackChange);
      this.track.stop();
    }
    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
    this.track = track;
    if (track) {
      track.addEventListener('mute', this._onTrackChange);
      track.addEventListener('unmute', this._onTrackChange);
      track.addEventListener('ended', this._onTrackChange);
      this._attachMeter();
    }
    this._refreshStatus();
  }

  _attachMeter() {
    if (!this.audioContext || !this.track) return;
    try {
      if (!this._analyser) {
        this._analyser = this.audioContext.createAnalyser();
        this._analyser.fftSize = 1024;
        this._samples = new Float32Array(this._analyser.fftSize);
      }
      // Analyser only, never routed to the speakers (no feedback loop).
      this._sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([this.track]));
      this._sourceNode.connect(this._analyser);
    } catch (err) {
      console.warn('[MotionMirror] mic meter unavailable', err);
    }
  }

  _refreshStatus() {
    if (!this.track) {
      if (this.status === 'ready' || this.status === 'muted') this._setStatus('off');
      return;
    }
    if (this.track.readyState === 'ended') this._setStatus('error');
    else if (this.track.muted) this._setStatus('muted');
    else this._setStatus('ready');
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('change'));
  }

  async _refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    } catch (_) {
      this.devices = [];
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

function statusForError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notfound';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'error';
}
