import { CameraController } from './camera.js';
import { DelayEngine } from './delayEngine.js';
import { RecordingController, fileExtensionFor } from './recorder.js';
import { Player } from './player.js';
import { ShareActions } from './share.js';
import { MicController, micConstraints } from './mic.js';
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
const recordControls = $('recordControls');
const recordUnavailable = $('recordUnavailable');
const audioProcessingToggle = $('audioProcessingToggle');
const micStatus = $('micStatus');
const micText = $('micText');
const micMeterFill = $('micMeterFill');
const micConnectBtn = $('micConnectBtn');
const micDeviceField = $('micDeviceField');
const micDeviceSelect = $('micDeviceSelect');
const recordingsList = $('recordingsList');
const recordingsEmpty = $('recordingsEmpty');

const debugToggle = $('debugToggle');
const debugPanel = $('debugPanel');

const focusToggle = $('focusToggle');
const focusToggleLabel = $('focusToggleLabel');

const camera = new CameraController(liveVideo);
const delayEngine = new DelayEngine(liveVideo, delayCanvas);
const recorder = new RecordingController();
const mic = new MicController();
mic.processing = audioProcessingToggle.checked;
const shareActions = new ShareActions($('sheet'), showToast);
const player = new Player($('player'), shareActions);

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
  // Before any await: the mic level meter's AudioContext may only start
  // inside the tap itself (iOS Safari and autoplay policies).
  mic.prepareMeter();
  startBtn.disabled = true;
  startError.classList.add('hidden');
  try {
    if (!isSecureContextOk()) {
      throw new Error('Se requiere una conexión segura (HTTPS). Revisa la URL.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Este navegador no soporta acceso a la cámara.');
    }
    console.info('[MotionMirror] requesting camera');
    // Camera and mic in one getUserMedia call = one permission prompt, and
    // the mic is confirmed working (live meter) long before the first take.
    const { audioTrack, audioError } = await camera.init({
      audio: micConstraints({ processing: mic.processing }),
    });
    console.info('[MotionMirror] camera ready', JSON.stringify(camera.settings));
    if (audioTrack) await mic.adopt(audioTrack);
    else mic.fail(audioError);
    probeRecorder();
    if (audioError) console.warn('[MotionMirror] microphone unavailable at start', audioError);
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
    recorder.preload().catch((err) => console.warn('[MotionMirror] recorder preload failed', err));
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
  recorder.stop();
  delayEngine.stop();
});

// ---------- Microphone ----------

const MIC_MESSAGES = {
  off: 'Micrófono: se activa junto con la cámara',
  muted: 'El micrófono está silenciado o lo está usando otra app',
  denied: 'Sin permiso para usar el micrófono',
  notfound: 'No se encontró ningún micrófono',
  busy: 'El micrófono está en uso por otra app',
  error: 'El micrófono se desconectó',
};

const MIC_BUTTON_LABELS = {
  off: 'Activar micrófono',
  muted: 'Reconectar',
  denied: 'Permitir micrófono',
  notfound: 'Reintentar',
  busy: 'Reintentar',
  error: 'Reconectar',
};

let micDeniedAttempts = 0;

function renderMic() {
  const { status } = mic;
  micStatus.dataset.status = status;
  if (status === 'ready') {
    micText.textContent = mic.label ? `Micrófono listo · ${mic.label}` : 'Micrófono listo';
  } else if (status === 'denied' && micDeniedAttempts > 0) {
    // Once denied, browsers stop prompting; only the site settings can undo it.
    micText.textContent = 'Sin permiso de micrófono. Actívalo en los permisos del sitio (el ícono junto a la dirección) y vuelve a intentar.';
  } else {
    micText.textContent = MIC_MESSAGES[status] || MIC_MESSAGES.error;
  }
  const showButton = status !== 'ready' && !!camera.track;
  micConnectBtn.classList.toggle('hidden', !showButton);
  micConnectBtn.textContent = MIC_BUTTON_LABELS[status] || 'Reintentar';

  const current = mic.deviceId;
  micDeviceSelect.innerHTML = '';
  mic.devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Micrófono ${i + 1}`;
    if (d.deviceId === current) opt.selected = true;
    micDeviceSelect.appendChild(opt);
  });
  micDeviceField.classList.toggle('hidden', mic.devices.length < 2 || status !== 'ready');

  // A mic that drops mid-take is flagged on the REC badge right away.
  recIndicator.classList.toggle('rec-no-audio', recorder.isRecording && recordingWithAudio && status !== 'ready');
}

mic.addEventListener('change', () => {
  renderMic();
  if (mic.track !== probedMicTrack) probeRecorder();
});

// Finds, in the background, a recording format this device's encoders
// accept with the current camera + mic (see RecordingController.probe), so
// pressing record just works. Re-run whenever either input changes.
let probedMicTrack = null;
function probeRecorder() {
  if (!camera.track) return;
  probedMicTrack = mic.track;
  recorder.probe(camera.track, mic.isReady ? mic.track : null)
    .catch((err) => console.warn('[MotionMirror] recorder probe failed', err));
}

async function connectMic(deviceId) {
  const ok = await mic.connect(deviceId);
  if (!ok && mic.status === 'denied') micDeniedAttempts += 1;
  renderMic();
  return ok;
}

micConnectBtn.addEventListener('click', async () => {
  micConnectBtn.disabled = true;
  await connectMic();
  micConnectBtn.disabled = false;
});

micDeviceSelect.addEventListener('change', () => {
  connectMic(micDeviceSelect.value);
});

audioProcessingToggle.addEventListener('change', () => {
  mic.setProcessing(audioProcessingToggle.checked);
});

// Level meter: only animates while the recording controls are on screen.
function micMeterLoop() {
  const visible = !recordControls.classList.contains('hidden') && !app.classList.contains('focus-mode');
  if (visible) {
    const running = mic.meterRunning && mic.isReady;
    micStatus.classList.toggle('meter-idle', !running);
    const level = running ? mic.getLevel() : 0;
    micMeterFill.style.transform = `scaleX(${level.toFixed(3)})`;
  }
  requestAnimationFrame(micMeterLoop);
}
requestAnimationFrame(micMeterLoop);

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
    // Presets are landscape but phones stream portrait (e.g. 720x1280), so
    // match on the long side; comparing width alone picked 360p there.
    const currentLong = Math.max(settings.width || 0, settings.height || 0);
    const diff = Math.abs((p.width || 0) - currentLong);
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
    probeRecorder();
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
    probeRecorder();
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
  // Recording is a live-view feature only: the delayed view is for watching
  // yourself back, so a take recorded from it would just be the same footage
  // shifted in time.
  recordControls.classList.toggle('hidden', currentMode !== 'live');
  recordUnavailable.classList.toggle('hidden', currentMode === 'live');
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

const RECORD_LABEL = 'Grabar video y audio';
let recordingWithAudio = false;
let takeCounter = 0;
let pendingItem = null;

recordBtn.addEventListener('click', () => {
  if (recorder.isRecording) {
    recorder.stop();
    return;
  }
  if (recorder.isBusy || currentMode !== 'live' || !camera.track) return;

  if (mic.isReady) {
    startRecording(true);
    return;
  }
  // Settle the mic before the take, not after: offer to fix it right here,
  // or to knowingly record without sound.
  shareActions.openSheet(MIC_MESSAGES[mic.status] || 'El micrófono no está listo', [
    {
      title: 'Conectar micrófono y grabar',
      detail: 'Se pide acceso al micrófono y la grabación empieza en cuanto esté listo.',
      run: async () => {
        if (await connectMic()) startRecording(true);
        else showToast(micText.textContent, 5000);
      },
    },
    {
      title: 'Grabar sin audio',
      detail: 'Solo se grabará la imagen.',
      run: () => startRecording(false),
    },
  ]);
});

function startRecording(withAudio) {
  if (recorder.isBusy || !camera.track) return;
  const fps = (camera.settings && camera.settings.frameRate) || 30;
  const audioTrack = withAudio && mic.track ? mic.track.clone() : null;
  try {
    recordingWithAudio = !!audioTrack;
    recorder.start({
      videoTrack: camera.track.clone(),
      audioTrack,
      meta: { fps, hasAudio: !!audioTrack },
    });
  } catch (err) {
    console.error('[MotionMirror] recording failed to start', err);
    showToast(`No se pudo iniciar la grabación: ${describeError(err)}`);
    resetRecordUi();
  }
}

recorder.addEventListener('start', () => {
  setControlsDisabled(true);
  recordBtn.disabled = false;
  recordBtn.textContent = 'Detener grabación';
  recordBtn.classList.add('recording');
  recIndicator.classList.remove('hidden');
  recIndicator.classList.remove('rec-no-audio');
  recordStartedAt = performance.now();
  recTimer.textContent = '00:00';
  recordTimerInterval = setInterval(() => {
    recTimer.textContent = formatMMSS((performance.now() - recordStartedAt) / 1000);
  }, 250);
});

// After stopping, the file is rewritten into a proper MP4. Usually that's a
// sub-second copy, but it can take a while when the browser recorded a
// format that must be re-encoded (e.g. Firefox), so the take shows up in the
// list right away as "processing", with its progress.
recorder.addEventListener('processing', () => {
  recordBtn.disabled = true;
  recordBtn.textContent = 'Procesando video…';
  recordBtn.classList.remove('recording');
  recIndicator.classList.add('hidden');
  clearInterval(recordTimerInterval);
  takeCounter += 1;
  pendingItem = createPendingItem(takeCounter, (performance.now() - recordStartedAt) / 1000);
});

recorder.addEventListener('progress', (e) => {
  if (!pendingItem) return;
  pendingItem.setProgress(e.detail.progress);
  recordBtn.textContent = `Procesando video… ${Math.round(e.detail.progress * 100)}%`;
});

recorder.addEventListener('recording', (e) => {
  const li = pendingItem && pendingItem.li;
  pendingItem = null;
  addRecordingToList(e.detail, li);
  resetRecordUi();
});

recorder.addEventListener('error', (e) => {
  console.error('[MotionMirror] recording failed', e.detail);
  if (pendingItem) pendingItem.li.remove();
  pendingItem = null;
  updateEmptyState();
  showToast(`La grabación falló: ${describeError(e.detail)}`, 6000);
  resetRecordUi();
});

function resetRecordUi() {
  clearInterval(recordTimerInterval);
  recordBtn.textContent = RECORD_LABEL;
  recordBtn.classList.remove('recording');
  recordBtn.disabled = !camera.track;
  recIndicator.classList.add('hidden');
  recIndicator.classList.remove('rec-no-audio');
  recTimer.textContent = '00:00';
  setControlsDisabled(false);
}

function createPendingItem(take, seconds) {
  const li = document.createElement('li');
  li.className = 'rec-pending';
  li.dataset.take = String(take);
  const title = document.createElement('span');
  title.className = 'rec-title';
  title.textContent = `Toma ${take} · ${formatMMSS(seconds)}`;
  const status = document.createElement('span');
  status.className = 'rec-details';
  status.textContent = 'Preparando el video…';
  const bar = document.createElement('div');
  bar.className = 'progress indeterminate';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Procesando video');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('span');
  bar.appendChild(fill);
  li.append(title, status, bar);
  recordingsList.prepend(li);
  updateEmptyState();
  return {
    li,
    setProgress(p) {
      bar.classList.remove('indeterminate');
      fill.style.transform = `scaleX(${p.toFixed(3)})`;
      bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      status.textContent = `Preparando el video… ${Math.round(p * 100)}%`;
    },
  };
}

function updateEmptyState() {
  recordingsEmpty.classList.toggle('hidden', recordingsList.children.length > 0);
}

function setControlsDisabled(disabled) {
  deviceSelect.disabled = disabled;
  resolutionSelect.disabled = disabled;
  fpsSelect.disabled = disabled;
  audioProcessingToggle.disabled = disabled;
  micDeviceSelect.disabled = disabled;
  micConnectBtn.disabled = disabled;
  modeButtons.forEach((b) => { b.disabled = disabled; });
}

function addRecordingToList({ blob, url, durationMs, mimeType, meta }, replaceLi = null) {
  const hasAudio = meta.hasAudio;
  const take = replaceLi ? Number(replaceLi.dataset.take) : ++takeCounter;
  const ext = fileExtensionFor(mimeType);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const name = `motion-mirror_${stamp}.${ext}`;
  // A File (not just a Blob) is what the Web Share API needs; its video/mp4
  // type and .mp4 name are what make share targets treat it as a video.
  const file = new File([blob], name, { type: mimeType, lastModified: now.getTime() });
  const recording = { name, url, file, fps: meta.fps };

  const li = document.createElement('li');

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'rec-open';
  openBtn.title = `Ver ${name}`;
  const title = document.createElement('span');
  title.className = 'rec-title';
  title.textContent = `Toma ${take} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const details = document.createElement('span');
  details.className = 'rec-details';
  details.textContent = `${formatMMSS(durationMs / 1000)} · ${formatBytes(blob.size)} · ${ext.toUpperCase()}${hasAudio ? '' : ' · sin audio'}`;
  openBtn.append(title, details);
  openBtn.addEventListener('click', () => player.open(recording));

  const actions = document.createElement('div');
  actions.className = 'rec-actions';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'btn btn-small btn-primary';
  play.textContent = 'Ver';
  play.addEventListener('click', () => player.open(recording));
  actions.append(play);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-small';
  save.textContent = 'Guardar';
  save.addEventListener('click', () => shareActions.save(recording));
  actions.append(save);

  if (shareActions.canSend(recording)) {
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-small';
    send.textContent = 'Enviar';
    send.title = 'Enviar por WhatsApp u otra app';
    send.addEventListener('click', () => shareActions.send(recording));
    actions.append(send);
  }

  const del = document.createElement('button');
  del.className = 'btn btn-small btn-ghost';
  del.type = 'button';
  del.textContent = 'Eliminar';
  del.addEventListener('click', () => {
    player.closeIfShowing(url);
    URL.revokeObjectURL(url);
    li.remove();
    updateEmptyState();
  });
  actions.append(del);

  li.append(openBtn, actions);
  if (replaceLi && replaceLi.isConnected) replaceLi.replaceWith(li);
  else recordingsList.prepend(li);
  updateEmptyState();
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
      `Grabación: MediaRecorder ${recorder.mimeType || 'no soportado'}${recorder.lastFinalize ? ` → MP4 (${recorder.lastFinalize})` : ''}`,
      `Micrófono: ${mic.status}${mic.label ? ` (${mic.label})` : ''} · medidor ${mic.meterRunning ? 'activo' : 'inactivo'}`,
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
