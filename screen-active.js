'use strict';

import { BLEReceiver }                from './ble.js';
import { PacketParser }               from './parser.js';
import { ShotClassifier }             from './classifier.js';
import { storeSessionVideo }          from './video-store.js';
import { S, VIDEO_TIMESLICE_MS, VIDEO_BITRATE,
         SENSOR_WINDOW_SLOTS }        from './state.js';
import { showScreen, setEl, showToast, speak, initAudio } from './utils.js';
import { showReviewScreen }           from './screen-review.js';

// ── Module-level instances ────────────────────────────────────────────────────
// parser and classifier are reset on each session start
let parser     = new PacketParser();
let classifier = new ShotClassifier();

// BLE receiver — callbacks defined below so they reference the latest parser/classifier
export const ble = new BLEReceiver(onBlePacket, onBleStatus);

// ── Wire buttons ──────────────────────────────────────────────────────────────
export function wirePracticeActive() {
  document.getElementById('active-stop-btn')?.addEventListener('click', stopPracticeSession);
  document.getElementById('active-restart-btn')?.addEventListener('click', restartPracticeSession);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────
export function startPracticeSession() {
  S.sessionId        = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  S.sessionStart     = performance.now();
  S.sessionEnd       = null;
  S.sessionMakes     = 0;
  S.sessionTotal     = 0;
  S.sessionEvents    = [];
  S.sensorWindow     = [];
  S.allSensorData    = [];
  S.allVideoChunks   = [];
  S.videoSessionBlob = null;
  if (S.videoSessionUrl) { URL.revokeObjectURL(S.videoSessionUrl); S.videoSessionUrl = null; }

  classifier = new ShotClassifier();
  parser.reset();

  showScreen('practice-active');

  const videoEl = document.getElementById('active-video');
  if (videoEl && S.mediaStream) { videoEl.srcObject = S.mediaStream; videoEl.play(); }
  else if (videoEl)               { videoEl.style.display = 'none'; }

  if (S.mediaStream && S.videoEnabled) startVideoRecording();

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

export function stopPracticeSession() {
  S.sessionEnd = performance.now();
  if (S.isBleConnected) ble.disconnect();

  if (S.sessionEvents.length === 0) {
    stopCamera();
    showToast('Session ended with no detected shots.', 'info');
    showScreen('dashboard');
    return;
  }

  setActiveEvent('Saving session video…', '#f39c12');

  const finalizeAndReview = async () => {
    stopCamera();
    if (S.allVideoChunks.length > 0) {
      S.videoSessionBlob = new Blob(S.allVideoChunks.map(c => c.data),
                                    { type: S.videoMimeType || 'video/webm' });
      try { await storeSessionVideo(S.sessionId, S.videoSessionBlob); } catch (e) {
        console.warn('IndexedDB store failed — video lives in RAM only:', e);
      }
    }
    S.reviewIndex = 0;
    await showReviewScreen();
  };

  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    S.mediaRecorder.addEventListener('stop', finalizeAndReview, { once: true });
    S.mediaRecorder.stop();
    S.mediaRecorder = null;
  } else {
    S.mediaRecorder = null;
    finalizeAndReview();
  }
}

export function restartPracticeSession() {
  S.sessionId        = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  S.sessionStart     = performance.now();
  S.sessionEnd       = null;
  S.sessionMakes     = 0;
  S.sessionTotal     = 0;
  S.sessionEvents    = [];
  S.sensorWindow     = [];
  S.allSensorData    = [];
  S.allVideoChunks   = [];
  S.videoSessionBlob = null;
  if (S.videoSessionUrl) { URL.revokeObjectURL(S.videoSessionUrl); S.videoSessionUrl = null; }

  classifier = new ShotClassifier();
  parser.reset();

  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    try { S.mediaRecorder.stop(); } catch (_) {}
    S.mediaRecorder = null;
  }
  S.recordingStartMs = 0;
  if (S.mediaStream && S.videoEnabled) startVideoRecording();

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

// ── Scoreboard helpers ────────────────────────────────────────────────────────
function updateActiveScoreboard() {
  setEl('active-makes', S.sessionMakes);
  setEl('active-total', S.sessionTotal);
  setEl('active-pct', S.sessionTotal
    ? `${Math.round(S.sessionMakes / S.sessionTotal * 100)}%` : '—%');
}

function setActiveEvent(text, color = '#ccc') {
  const el = document.getElementById('active-event');
  if (el) { el.textContent = text; el.style.color = color; }
}

function showCalibrationBar(show) {
  document.getElementById('active-cal-wrap')?.classList.toggle('visible', show);
}

function updateCalBar(pct) {
  const bar = document.getElementById('active-cal-bar');
  if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
}

// ── Video recording ───────────────────────────────────────────────────────────
function startVideoRecording() {
  const mimeOptions = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
  ];
  S.videoMimeType  = mimeOptions.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  S.allVideoChunks = [];
  S.recordingStartMs = performance.now();

  try {
    S.mediaRecorder = new MediaRecorder(S.mediaStream, {
      mimeType: S.videoMimeType,
      videoBitsPerSecond: VIDEO_BITRATE,
    });
    S.mediaRecorder.addEventListener('dataavailable', evt => {
      if (evt.data.size > 0) {
        const startMs = S.allVideoChunks.length * VIDEO_TIMESLICE_MS;
        S.allVideoChunks.push({ data: evt.data, startMs });
      }
    });
    S.mediaRecorder.start(VIDEO_TIMESLICE_MS);
  } catch (e) {
    console.warn('MediaRecorder failed:', e);
    S.videoEnabled = false;
  }
}

export function stopCamera() {
  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop();
  S.mediaRecorder = null;
  if (S.mediaStream) {
    S.mediaStream.getTracks().forEach(t => t.stop());
    S.mediaStream  = null;
    S.videoEnabled = false;
  }
}

// ── BLE packet handler ────────────────────────────────────────────────────────
function onBlePacket(dataView) {
  const { batch, lostPackets, deviceInfo } = parser.parse(dataView);
  if (lostPackets > 0) console.warn(`Packet loss: ${lostPackets}`);

  if (deviceInfo) {
    S.deviceHwVer = `v${deviceInfo.hwVersion}`;
    S.deviceFwVer = `v${deviceInfo.fwVersion}`;
    updateDeviceInfoBar(deviceInfo);
  }

  if (!batch || S.activeScreen !== 'practice-active') return;

  const hostNow            = performance.now();
  batch.forEach(s => { s.host_ts = hostNow; });
  const latestDeviceTs_ms  = batch[batch.length - 1].mpu_ts;

  // Rolling sensor window
  S.sensorWindow.push(...batch);
  if (S.sensorWindow.length > SENSOR_WINDOW_SLOTS) {
    S.sensorWindow.splice(0, S.sensorWindow.length - SENSOR_WINDOW_SLOTS);
  }
  S.allSensorData.push(...batch);

  const cal     = classifier.calibrator;
  const wasDone = cal.isComplete;
  const newShots = classifier.processBatch(batch);

  if (!wasDone) {
    if (cal.isComplete) {
      showCalibrationBar(false);
      setActiveEvent('baseline ready — detecting shots 🏀', '#2ecc71');
    } else {
      updateCalBar(cal.progress);
    }
  }

  for (const shot of newShots) onShotDetected(shot, hostNow, latestDeviceTs_ms);
}

function onShotDetected(shot, hostNow = performance.now(), latestDeviceTs_ms = null) {
  const isMake    = shot.classification === 'MAKE';
  const type      = shot.basket_type ?? '';
  const subtypeMap = { SWISH: 'Swish', BANK: 'Rim-in' };
  const aiTop     = isMake ? 'Make' : (shot.classification === 'MISS' ? 'Miss' : 'Not-a-shot');
  const aiSubtype = isMake ? (subtypeMap[type] ?? null) : null;

  if (isMake) S.sessionMakes++;
  S.sessionTotal++;
  updateActiveScoreboard();

  const eventDeviceTs_ms = (shot.basket_time ?? shot.impact_time ?? 0) * 1000;
  const deviceLag_ms     = latestDeviceTs_ms !== null
    ? Math.max(0, latestDeviceTs_ms - eventDeviceTs_ms) : 0;
  const hostEventTs   = (hostNow - S.recordingStartMs) - deviceLag_ms;
  const video_clip_ts = hostEventTs / 1000.0;

  S.sessionEvents.push({
    shot,
    ai_top:       aiTop,
    ai_subtype:   aiSubtype,
    user_top:     aiTop,
    user_subtype: aiSubtype,
    video_clip_ts,
    timestamp:    Date.now(),
    host_ts:      hostNow,
    hostEventTs,
    comment:      '',    // Feature 16: optional user comment
  });

  const scoreText = `${S.sessionMakes} out of ${S.sessionTotal}`;
  if (isMake) {
    setActiveEvent(aiSubtype ? `🏀 ${aiSubtype}!` : '🏀 Make!', '#2ecc71');
    speak(`${aiSubtype ?? 'Make'}, ${scoreText}`);
  } else {
    setActiveEvent('❌ Miss', '#e74c3c');
    speak(`Miss, ${scoreText}`);
  }
}

function onBleStatus(state, detail) {
  S.isBleConnected = state === 'connected';

  const bleState = document.getElementById('setup-ble-state');
  const bleBtn   = document.getElementById('setup-ble-btn');
  if (bleState) {
    bleState.textContent = S.isBleConnected ? '✅ Connected' : '⛕ Not connected';
    bleState.classList.toggle('ok', S.isBleConnected);
  }
  if (bleBtn) bleBtn.textContent = S.isBleConnected ? 'Disconnect' : 'Connect';

  const statusEl = document.getElementById('global-ble-status');
  if (statusEl) {
    statusEl.textContent = S.isBleConnected ? 'BLE ●' : 'BLE ○';
    statusEl.style.color = S.isBleConnected ? '#2ecc71' : '#555566';
  }

  if (typeof window._updatePracticeReadyGate === 'function') {
    window._updatePracticeReadyGate();
  }
}

function updateDeviceInfoBar(info) {
  setEl('di-hw',   `v${info.hwVersion}`);
  setEl('di-fw',   `v${info.fwVersion}`);
  setEl('di-batt', info.battMv ? `${(info.battMv / 1000).toFixed(2)} V` : '–');
  setEl('di-temp', `${info.tempC}°C`);
}
