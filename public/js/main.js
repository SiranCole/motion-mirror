import { CameraController } from './camera.js';
import { DelayEngine } from './delayEngine.js';
import { RecordingController, fileExtensionFor } from './recorder.js';
import { formatMMSS, formatBytes, isSecureContextOk } from './utils.js';

const $ = (id) => document.getElementById(id);

const app = $('app');
const videoWrap = $('videoWrap');
const liveVideo = $('liveVideo');
const delayCanvas = $('delayCanvas');
const startOverlay = $('startOverlay');
const startBtn = $('startBtn');
const startError = $('startError');
const recIndicator = $('recIndicator');
const recTimer = $('recTimer');
const statsText = $('statsText');
const toast = $('toast');

const deviceSelect = $('deviceSelect');
const resolutionSelect = $('resolutionSelect');
const fpsSelect = $('fpsSelect');
const mirrorToggle = $('mirrorToggle');

const modeSegmented = $('modeSegmented');
const modeButtons = Array.from(modeSegmented.querySelectorAll('.seg-btn'));
const delayField = $('delayField');
const delaySlider = $('delaySlider');
const delayValueLabel = $('delayValueLabel');
const delayMaxHint = $('delayMaxHint');

const recordBtn = $('recordBtn');
const recordingsList = $('recordingsList');

const debugToggle = $('debugToggle');
const debugPanel = $('debugPanel');

const focusToggle = $('focusToggle');
const focusToggleLabel = $('focusToggleLabel');

const camera = new CameraController(liveVideo);
const delayEngine = new DelayEngine(liveVideo, delayCanvas);
const recorder = new RecordingController();

let currentMode = 'live';
let wakeLockSentinel = null;
let recordTimerInterval = null;
let recordStartedAt = 0;

// ---------- Toast ----------

let toastTimer = null;
function showToast(message, ms = 3500) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

// ---------- Start ----------

startBtn.addEventListener('click', startCamera);

async function startCamera() {
  startBtn.disabled = true;
  startError.classList.add('hidden');
  try {
    if (!isSecureContextOk()) {
      throw new Error('Se requiere una conexión segura (HTTPS). Revisa la URL.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Este navegador no soporta acceso a la cámara.');
    }
    await camera.init();
    startOverlay.classList.add('hidden');
    recordBtn.disabled = false;
    videoWrap.classList.toggle('mirrored', mirrorToggle.checked);
    populateDeviceSelect();
    populateQualitySelects();
    updateAspectRatio();
    updateDelayBounds();
    applyMode();
    requestWakeLock();
    startStatsLoop();
    // Pay the WebCodecs warm-up cost now, while the user is still looking at
    // the "activate camera" moment, instead of on the first frame after they
    // switch to delay mode.
    delayEngine.prewarm().catch((err) => console.warn('[MotionMirror] prewarm failed', err));
  } catch (err) {
    startError.textContent = describeError(err);
    startError.classList.remove('hidden');
    startBtn.disabled = false;
  }
}

function describeError(err) {
  if (err && err.name === 'NotAllowedError') return 'Permiso de cámara denegado. Revisa los permisos del sitio.';
  if (err && err.name === 'NotFoundError') return 'No se encontró ninguna cámara.';
  if (err && err.name === 'NotReadableError') return 'La cámara está en uso por otra aplicación.';
  return (err && err.message) || String(err);
}

camera.addEventListener('trackended', () => {
  showToast('La cámara se desconectó o el permiso fue revocado.');
  startOverlay.classList.remove('hidden');
  startBtn.disabled = false;
  recordBtn.disabled = true;
  delayEngine.stop();
});

// ---------- Device / quality selection ----------

function populateDeviceSelect() {
  const current = camera.settings ? camera.settings.deviceId : null;
  deviceSelect.innerHTML = '';
  camera.devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Cámara ${i + 1}`;
    if (d.deviceId === current) opt.selected = true;
    deviceSelect.appendChild(opt);
  });
}

function populateQualitySelects() {
  const settings = camera.settings || {};

  const resPresets = camera.getResolutionPresets();
  resolutionSelect.innerHTML = '';
  let bestResIdx = 0;
  let bestResDiff = Infinity;
  resPresets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify([p.width, p.height]);
    opt.textContent = p.label;
    resolutionSelect.appendChild(opt);
    const diff = Math.abs((p.width || 0) - (settings.width || 0));
    if (diff < bestResDiff) { bestResDiff = diff; bestResIdx = i; }
  });
  resolutionSelect.selectedIndex = bestResIdx;

  const fpsPresets = camera.getFpsPresets();
  fpsSelect.innerHTML = '';
  let bestFpsIdx = 0;
  let bestFpsDiff = Infinity;
  fpsPresets.forEach((f, i) => {
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = `${f} fps`;
    fpsSelect.appendChild(opt);
    const diff = Math.abs(f - (settings.frameRate || 30));
    if (diff < bestFpsDiff) { bestFpsDiff = diff; bestFpsIdx = i; }
  });
  fpsSelect.selectedIndex = bestFpsIdx;
}

deviceSelect.addEventListener('change', async () => {
  const [w, h] = safeParseRes(resolutionSelect.value) || [1280, 720];
  const fps = Number(fpsSelect.value) || 30;
  try {
    await camera.switchDevice(deviceSelect.value, { width: w, height: h, frameRate: fps });
    populateQualitySelects();
    updateAspectRatio();
    updateDelayBounds();
    delayEngine.prewarm().catch((err) => console.warn('[MotionMirror] prewarm failed', err));
  } catch (err) {
    showToast(describeError(err));
  }
});

async function onQualityChange() {
  const [w, h] = safeParseRes(resolutionSelect.value) || [1280, 720];
  const fps = Number(fpsSelect.value) || 30;
  try {
    await camera.applyQuality({ width: w, height: h, frameRate: fps });
    updateAspectRatio();
    updateDelayBounds();
    delayEngine.prewarm().catch((err) => console.warn('[MotionMirror] prewarm failed', err));
  } catch (err) {
    showToast(describeError(err));
  }
}
resolutionSelect.addEventListener('change', onQualityChange);
fpsSelect.addEventListener('change', onQualityChange);

function safeParseRes(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function updateAspectRatio() {
  const s = camera.settings;
  if (s && s.width && s.height) {
    videoWrap.style.setProperty('--ar', `${s.width} / ${s.height}`);
  }
}

function updateDelayBounds() {
  const maxDelay = delayEngine.getMaxDelaySeconds();
  delaySlider.max = maxDelay.toFixed(1);
  if (Number(delaySlider.value) > maxDelay) delaySlider.value = maxDelay.toFixed(1);
  if (Number(delaySlider.value) < Number(delaySlider.min)) delaySlider.value = delaySlider.min;
  delayEngine.setDelay(Number(delaySlider.value));
  delayValueLabel.textContent = `${Number(delaySlider.value).toFixed(1)} s`;
  delayMaxHint.textContent = `máximo a esta calidad: ${maxDelay.toFixed(1)} s (limitado por memoria disponible)`;
}

// ---------- Mirror ----------

mirrorToggle.addEventListener('change', () => {
  videoWrap.classList.toggle('mirrored', mirrorToggle.checked);
});

// ---------- Mode (live / delay) ----------

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    currentMode = btn.dataset.mode;
    applyMode();
  });
});

function applyMode() {
  if (currentMode === 'live') {
    liveVideo.classList.remove('hidden');
    delayCanvas.classList.add('hidden');
    delayField.classList.add('hidden');
    delayEngine.stop();
  } else {
    liveVideo.classList.add('hidden');
    delayCanvas.classList.remove('hidden');
    delayField.classList.remove('hidden');
    delayEngine.start().catch((err) => console.error('[MotionMirror] delay engine failed to start', err));
  }
}

delaySlider.addEventListener('input', () => {
  delayEngine.setDelay(Number(delaySlider.value));
  delayValueLabel.textContent = `${Number(delaySlider.value).toFixed(1)} s`;
});

// ---------- Recording ----------

recordBtn.addEventListener('click', () => {
  if (recorder.isRecording) {
    recorder.stop();
    return;
  }

  if (currentMode === 'delay' && !delayEngine.hasRenderedFrame) {
    showToast('Espera unos segundos: el retraso todavía está llenando su buffer.');
    return;
  }

  let stream;
  if (currentMode === 'live') {
    if (!camera.track) return;
    stream = new MediaStream([camera.track.clone()]);
  } else {
    stream = delayCanvas.captureStream(30);
  }

  try {
    recorder.start(stream, {
      mode: currentMode,
      delay: currentMode === 'delay' ? Number(delaySlider.value) : 0,
    });
  } catch (err) {
    showToast(describeError(err));
    return;
  }

  recordBtn.textContent = 'Detener grabación';
  recordBtn.classList.add('recording');
  recIndicator.classList.remove('hidden');
  setControlsDisabled(true);
  recordStartedAt = performance.now();
  recordTimerInterval = setInterval(() => {
    recTimer.textContent = formatMMSS((performance.now() - recordStartedAt) / 1000);
  }, 250);
});

recorder.addEventListener('recording', (e) => {
  addRecordingToList(e.detail);
  recordBtn.textContent = 'Grabar lo que veo';
  recordBtn.classList.remove('recording');
  recIndicator.classList.add('hidden');
  setControlsDisabled(false);
  clearInterval(recordTimerInterval);
  recTimer.textContent = '00:00';
});

function setControlsDisabled(disabled) {
  deviceSelect.disabled = disabled;
  resolutionSelect.disabled = disabled;
  fpsSelect.disabled = disabled;
  modeButtons.forEach((b) => { b.disabled = disabled; });
}

function addRecordingToList({ blob, url, durationMs, mimeType, meta }) {
  const ext = fileExtensionFor(mimeType);
  const modeLabel = meta.mode === 'delay' ? `retraso-${meta.delay.toFixed(1)}s` : 'vivo';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `motion-mirror_${modeLabel}_${stamp}.${ext}`;

  const li = document.createElement('li');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'rec-name';
  nameSpan.textContent = `${name} · ${formatMMSS(durationMs / 1000)} · ${formatBytes(blob.size)}`;
  nameSpan.title = name;

  const actions = document.createElement('div');
  actions.className = 'rec-actions';

  const dl = document.createElement('a');
  dl.href = url;
  dl.download = name;
  dl.className = 'btn btn-small';
  dl.textContent = 'Descargar';

  const del = document.createElement('button');
  del.className = 'btn btn-small';
  del.type = 'button';
  del.textContent = 'Eliminar';
  del.addEventListener('click', () => {
    URL.revokeObjectURL(url);
    li.remove();
  });

  actions.append(dl, del);
  li.append(nameSpan, actions);
  recordingsList.prepend(li);
}

// ---------- Focus mode ----------

focusToggle.addEventListener('click', () => {
  const active = app.classList.toggle('focus-mode');
  focusToggleLabel.textContent = active ? 'Mostrar controles' : 'Modo práctica';
});

// ---------- Debug panel ----------

debugToggle.addEventListener('click', () => {
  const nowHidden = debugPanel.classList.toggle('hidden');
  debugToggle.textContent = nowHidden ? 'Mostrar info técnica' : 'Ocultar info técnica';
});

function startStatsLoop() {
  setInterval(updateStats, 500);
}

function updateStats() {
  const s = camera.settings || {};
  const modeLabel = currentMode === 'live' ? 'En vivo' : `Retraso ${Number(delaySlider.value).toFixed(1)}s`;
  statsText.textContent = `${s.width || '?'}x${s.height || '?'} · ${s.frameRate ? s.frameRate.toFixed(0) : '?'}fps · ${modeLabel}`;

  if (!debugPanel.classList.contains('hidden')) {
    const d = delayEngine.stats;
    const lines = [
      `Modo: ${currentMode}`,
      `Resolución aplicada: ${s.width || '?'}x${s.height || '?'} @ ${s.frameRate ? s.frameRate.toFixed(1) : '?'}fps`,
      `Dispositivo: ${s.deviceId ? s.deviceId.slice(0, 16) + '…' : '-'}`,
    ];
    if (currentMode === 'delay') {
      lines.push(
        `Motor de retraso: ${delayEngine.usingWebCodecs ? 'WebCodecs (H.264, comprimido)' : 'buffer crudo (sin compresión)'}`,
        `Captura: ${d.captureFps.toFixed(1)} fps`,
        `Render: ${d.renderFps.toFixed(1)} fps`,
        `Buffer: ${d.bufferFrames} frames (${formatBytes(d.bufferBytes)})`,
        `requestVideoFrameCallback: ${delayEngine.usingRVFC ? 'sí' : 'no (fallback rAF)'}`,
      );
    }
    lines.push(
      `Grabación mimeType: ${recorder.mimeType || 'no soportado'}`,
      `Wake Lock activo: ${wakeLockSentinel ? 'sí' : 'no'}`,
    );
    debugPanel.textContent = lines.join('\n');
  }
}

// ---------- Wake Lock ----------

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch (_) {
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && camera.stream && !wakeLockSentinel) {
    requestWakeLock();
  }
});

// ---------- Cleanup ----------

window.addEventListener('beforeunload', () => {
  delayEngine.stop();
  camera.stop();
  if (wakeLockSentinel) wakeLockSentinel.release().catch(() => {});
});
