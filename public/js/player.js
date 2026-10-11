import { formatClock } from './utils.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_SECONDS = 5;
const CONTROLS_HIDE_MS = 2800;
const DOUBLE_TAP_MS = 280;

/**
 * Full-screen overlay player for recorded takes, built on a plain <video> so
 * playback, decoding and audio are the browser's native ones. Custom controls
 * (rather than the native `controls` attribute) so the practice-oriented
 * extras — slow motion, frame stepping, mirroring, looping — look and behave
 * the same on desktop and mobile browsers.
 *
 * Interaction model:
 * - Desktop: click the picture to play/pause; keyboard shortcuts (see onKey).
 * - Touch: tap toggles the controls; double-tap the left/right third to skip
 *   back/forward, the middle to play/pause (like phone video apps).
 *
 * Saving/sending is delegated to a ShareActions instance (share.js) so the
 * player and the recordings list behave identically.
 */
export class Player {
  constructor(root, shareActions) {
    this.root = root;
    this.shareActions = shareActions;
    const q = (sel) => root.querySelector(sel);
    this.video = q('[data-el="video"]');
    this.stage = q('[data-el="stage"]');
    this.title = q('[data-el="title"]');
    this.seek = q('[data-el="seek"]');
    this.current = q('[data-el="current"]');
    this.duration = q('[data-el="duration"]');
    this.playBtn = q('[data-el="play"]');
    this.speedBtn = q('[data-el="speed"]');
    this.loopBtn = q('[data-el="loop"]');
    this.mirrorBtn = q('[data-el="mirror"]');
    this.fullscreenBtn = q('[data-el="fullscreen"]');
    this.saveBtn = q('[data-el="save"]');
    this.sendBtn = q('[data-el="send"]');
    this.flash = q('[data-el="flash"]');

    this.recording = null;
    this.frameDuration = 1 / 30;
    this.speedIndex = SPEEDS.indexOf(1);
    this.scrubbing = false;
    this.wasPlayingBeforeScrub = false;
    this.hideTimer = null;
    this.lastTap = { time: 0, zone: null };
    this.singleTapTimer = null;
    this.rafId = 0;
    this.returnFocusTo = null;

    this._bind();
  }

  open(recording) {
    this.recording = recording;
    this.returnFocusTo = document.activeElement;
    this.frameDuration = 1 / (recording.fps || 30);
    this.title.textContent = recording.name;
    this.title.title = recording.name;
    this.sendBtn.classList.toggle('hidden', !this.shareActions.canSend(recording));

    this.video.src = recording.url;
    this.video.playbackRate = SPEEDS[this.speedIndex];
    this.video.currentTime = 0;
    this._renderTime();
    this.root.classList.remove('hidden');
    document.body.classList.add('player-open');
    this._showControls();
    this.playBtn.focus({ preventScroll: true });
    this.video.play().catch(() => {}); // autoplay can be refused; the play button still works
  }

  close() {
    if (this.root.classList.contains('hidden')) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load(); // releases the decoder
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.hideTimer);
    this.root.classList.add('hidden');
    document.body.classList.remove('player-open');
    this.recording = null;
    if (this.returnFocusTo && this.returnFocusTo.isConnected) this.returnFocusTo.focus({ preventScroll: true });
  }

  /** Called when a recording is deleted from the list while it might be open. */
  closeIfShowing(url) {
    if (this.recording && this.recording.url === url) this.close();
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  // ---------- Playback actions ----------

  togglePlay() {
    if (this.video.paused || this.video.ended) this.video.play().catch(() => {});
    else this.video.pause();
  }

  skip(seconds) {
    const d = this.video.duration || 0;
    this.video.currentTime = clampTime(this.video.currentTime + seconds, d);
    this._flash(seconds < 0 ? `« ${Math.abs(seconds)} s` : `${seconds} s »`);
    this._renderTime();
  }

  stepFrame(direction) {
    this.video.pause();
    const d = this.video.duration || 0;
    this.video.currentTime = clampTime(this.video.currentTime + direction * this.frameDuration, d);
    this._renderTime();
  }

  cycleSpeed(step = 1) {
    this.speedIndex = (this.speedIndex + step + SPEEDS.length) % SPEEDS.length;
    const rate = SPEEDS[this.speedIndex];
    this.video.playbackRate = rate;
    this.speedBtn.textContent = `${rate}×`;
    this.speedBtn.classList.toggle('active', rate !== 1);
    this._flash(`${rate}×`);
  }

  toggleLoop() {
    this.video.loop = !this.video.loop;
    this.loopBtn.classList.toggle('active', this.video.loop);
    this.loopBtn.setAttribute('aria-pressed', String(this.video.loop));
    this._flash(this.video.loop ? 'Repetir: sí' : 'Repetir: no');
  }

  toggleMirror() {
    const on = this.stage.classList.toggle('mirrored');
    this.mirrorBtn.classList.toggle('active', on);
    this.mirrorBtn.setAttribute('aria-pressed', String(on));
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (this.root.requestFullscreen) {
      this.root.requestFullscreen().catch(() => {});
    } else if (this.video.webkitEnterFullscreen) {
      // iPhone Safari only allows fullscreen on the <video> itself (native player).
      this.video.webkitEnterFullscreen();
    }
  }

  // ---------- Wiring ----------

  _bind() {
    const v = this.video;

    this.root.querySelector('[data-el="close"]').addEventListener('click', () => this.close());
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.root.querySelector('[data-el="back"]').addEventListener('click', () => this.skip(-SKIP_SECONDS));
    this.root.querySelector('[data-el="fwd"]').addEventListener('click', () => this.skip(SKIP_SECONDS));
    this.root.querySelector('[data-el="frame-back"]').addEventListener('click', () => this.stepFrame(-1));
    this.root.querySelector('[data-el="frame-fwd"]').addEventListener('click', () => this.stepFrame(1));
    this.speedBtn.addEventListener('click', () => this.cycleSpeed(1));
    this.loopBtn.addEventListener('click', () => this.toggleLoop());
    this.mirrorBtn.addEventListener('click', () => this.toggleMirror());
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.saveBtn.addEventListener('click', () => {
      this.video.pause();
      this.shareActions.save(this.recording);
    });
    this.sendBtn.addEventListener('click', () => {
      this.video.pause();
      this.shareActions.send(this.recording);
    });
    this.fullscreenBtn.classList.toggle('hidden',
      !document.fullscreenEnabled && !('webkitEnterFullscreen' in HTMLVideoElement.prototype));

    v.addEventListener('play', () => { this._renderPlayState(); this._startRaf(); this._scheduleHide(); });
    v.addEventListener('pause', () => { this._renderPlayState(); this._showControls(); });
    v.addEventListener('ended', () => { this._renderPlayState(); this._showControls(); });
    v.addEventListener('loadedmetadata', () => this._renderTime());
    v.addEventListener('durationchange', () => this._renderTime());
    v.addEventListener('timeupdate', () => { if (v.paused) this._renderTime(); });
    v.addEventListener('seeked', () => this._renderTime());

    // Seek bar: pause while dragging so frames follow the thumb, resume after.
    this.seek.addEventListener('pointerdown', () => this._beginScrub());
    this.seek.addEventListener('input', () => {
      if (!this.scrubbing) this._beginScrub();
      v.currentTime = (Number(this.seek.value) / 1000) * (v.duration || 0);
      this._renderTime(v.currentTime);
    });
    this.seek.addEventListener('change', () => this._endScrub());
    this.seek.addEventListener('pointerup', () => this._endScrub());
    this.seek.addEventListener('pointercancel', () => this._endScrub());

    this.stage.addEventListener('pointerup', (e) => this._onStageTap(e));
    this.root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') this._showControls(); });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && !this.shareActions.isSheetOpen) this._onKey(e);
    });
    document.addEventListener('fullscreenchange', () => {
      this.fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
    });
  }

  _onStageTap(e) {
    if (e.button && e.button !== 0) return;
    const rect = this.stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const zone = x < 1 / 3 ? 'back' : x > 2 / 3 ? 'fwd' : 'center';

    if (e.pointerType === 'mouse') {
      this.togglePlay();
      return;
    }

    const now = performance.now();
    const isDouble = now - this.lastTap.time < DOUBLE_TAP_MS && this.lastTap.zone === zone;
    this.lastTap = { time: now, zone };
    if (isDouble) {
      clearTimeout(this.singleTapTimer);
      this.lastTap = { time: 0, zone: null };
      if (zone === 'back') this.skip(-SKIP_SECONDS);
      else if (zone === 'fwd') this.skip(SKIP_SECONDS);
      else this.togglePlay();
      return;
    }
    clearTimeout(this.singleTapTimer);
    this.singleTapTimer = setTimeout(() => {
      if (this.root.classList.contains('controls-hidden')) this._showControls();
      else this._hideControls();
    }, DOUBLE_TAP_MS);
  }

  _onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onSeek = e.target === this.seek;
    let handled = true;
    switch (e.key) {
      case 'Escape': if (!document.fullscreenElement) this.close(); else handled = false; break;
      case ' ':
      case 'k': case 'K':
        if (e.target.tagName === 'BUTTON' && e.key === ' ') { handled = false; break; }
        this.togglePlay(); break;
      case 'ArrowLeft': if (onSeek) { handled = false; break; } this.skip(-SKIP_SECONDS); break;
      case 'ArrowRight': if (onSeek) { handled = false; break; } this.skip(SKIP_SECONDS); break;
      case 'j': case 'J': this.skip(-10); break;
      case 'l': case 'L': this.skip(10); break;
      case ',': this.stepFrame(-1); break;
      case '.': this.stepFrame(1); break;
      case '[': this.cycleSpeed(-1); break;
      case ']': this.cycleSpeed(1); break;
      case 'm': case 'M': this.toggleMirror(); break;
      case 'r': case 'R': this.toggleLoop(); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'Home': this.video.currentTime = 0; break;
      case 'End': this.video.currentTime = this.video.duration || 0; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      this._showControls();
    }
  }

  _beginScrub() {
    if (this.scrubbing) return;
    this.scrubbing = true;
    this.wasPlayingBeforeScrub = !this.video.paused && !this.video.ended;
    this.video.pause();
    this._showControls();
  }

  _endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.wasPlayingBeforeScrub) this.video.play().catch(() => {});
  }

  _startRaf() {
    cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (this.video.paused || !this.isOpen) return;
      if (!this.scrubbing) this._renderTime();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _renderTime(time = this.video.currentTime) {
    const d = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    const fraction = d > 0 ? time / d : 0;
    if (!this.scrubbing) this.seek.value = String(Math.round(fraction * 1000));
    this.seek.style.setProperty('--progress', `${(fraction * 100).toFixed(2)}%`);
    this.current.textContent = formatClock(time, d);
    this.duration.textContent = formatClock(d, d);
  }

  _renderPlayState() {
    const playing = !this.video.paused && !this.video.ended;
    this.playBtn.classList.toggle('is-playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    this.playBtn.title = playing ? 'Pausar (espacio)' : 'Reproducir (espacio)';
  }

  _showControls() {
    this.root.classList.remove('controls-hidden');
    this._scheduleHide();
  }

  _hideControls() {
    if (this.video.paused || this.scrubbing) return;
    this.root.classList.add('controls-hidden');
  }

  _scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this._hideControls(), CONTROLS_HIDE_MS);
  }

  _flash(text) {
    this.flash.textContent = text;
    this.flash.classList.remove('show');
    void this.flash.offsetWidth; // restart the CSS animation
    this.flash.classList.add('show');
  }
}

function clampTime(t, duration) {
  return Math.min(Math.max(0, t), Math.max(0, duration - 0.001));
}
