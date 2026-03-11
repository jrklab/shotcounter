/**
 * app.js
 * Main application controller — routes views and wires up all features.
 *
 * Views (data-screen attributes):
 *   auth            — login screen (Google or email/password)
 *   dashboard       — home: Practice Now / Review History / Firmware Update
 *   practice-setup  — BLE + camera pairing gate
 *   practice-active — live session (camera overlay + scoreboard)
 *   practice-review — label carousel (after stopping session)
 *   practice-upload — upload progress
 *   history         — analytics: lifetime stats + trend chart + session log
 *   ota             — OTA firmware update
 */

'use strict';

import { onAuthChange, signInWithGoogle, signInWithEmail,
         signUpWithEmail, signOut, resetPassword } from './auth.js';
import { BLEReceiver }                             from './ble.js';
import { PacketParser }                            from './parser.js';
import { ShotClassifier, ThresholdConfig }         from './classifier.js';
import { OtaUpdater }                              from './ota-ble.js';
import { saveShot, saveSession,
         fetchSessions, fetchAllShots,
         uploadSessionCsv, uploadSessionJson,
         uploadSessionVideo }                        from './db.js';
import { storeSessionVideo, loadSessionVideo,
         deleteSessionVideo }                        from './video-store.js';

// ── Constants ────────────────────────────────────────────────────────────────
const VIDEO_TIMESLICE_MS  = 200;   // chunk interval — short for frequent keyframes (seekable)
const VIDEO_BITRATE       = 500_000; // 500 kbps — reduced for phone storage
const SENSOR_WINDOW_SLOTS = 400;   // max samples in rolling sensor window (~2 s @ 200 Hz)
const EVENT_PRE_MS        = 1500;  // video/review window: ms before basket event
const EVENT_POST_MS       = 2000;  // video/review window: ms after basket event

// Each option maps to a (user_top, user_subtype) pair.
// Swish/Rim-in/Unsure implicitly mean user_top='Make'.
const LABEL_OPTIONS = [
  { top: 'Make',       subtype: 'Swish',   icon: '🏀', label: 'Swish'       },
  { top: 'Make',       subtype: 'Rim-in',  icon: '🔄', label: 'Rim-in'      },
  { top: 'Make',       subtype: 'Unsure',  icon: '❓', label: 'Unsure'      },
  { top: 'Miss',       subtype: null,      icon: '❌', label: 'Miss'        },
  { top: 'Not-a-shot', subtype: null,      icon: '🔇', label: 'Not-a-shot'  },
];

// ── Shared instances ─────────────────────────────────────────────────────────
const ble        = new BLEReceiver(onBlePacket, onBleStatus);
const parser     = new PacketParser();
let   classifier = new ShotClassifier();

// ── App state ────────────────────────────────────────────────────────────────
let user           = null;  // Firebase user
let sessionId      = null;
let sessionStart   = null;  // performance.now() ms when practice starts
let sessionEnd     = null;  // performance.now() ms when practice stops
let sessionMakes   = 0;
let sessionTotal   = 0;

/** @type {{ shot: Object, ai_top: string, ai_subtype: string|null,
 *            user_top: string, user_subtype: string|null,
 *            video_clip_ts: number, timestamp: number,
 *            host_ts: number, hostEventTs: number }[]} */
let sessionEvents  = [];
let reviewIndex    = 0;

// Sensor data rolling window + full-session log for CSV
let sensorWindow   = [];    // rolling ~2 s window  [{accel, gyro, distance, mpu_ts, tof_ts}]
let allSensorData  = [];    // full session sensor log (for CSV export)

// Video recording state
let mediaStream        = null;
let mediaRecorder      = null;
let allVideoChunks     = [];    // ALL recorded chunks — no eviction (stored to IndexedDB at end)
let videoMimeType      = 'video/webm';
let videoEnabled       = false;
let recordingStartMs   = 0;     // performance.now() when recording started
let videoSessionBlob   = null;  // assembled full-session video Blob
let videoSessionUrl    = null;  // object URL for the review video element
let uploadVideoEnabled = false;  // upload full session video to Firebase Storage (user must enable)
let _clipStopListener  = null;  // active timeupdate listener for clip-end pause

// BLE / device state
let isBleConnected = false;
let deviceHwVer    = '–';
let deviceFwVer    = '–';

// Audio keepalive
let audioCtx       = null;
let keepAliveEl    = null;

// OTA updater
let ota            = null;

// History chart instance
let historyChart   = null;

// ── Screen router ────────────────────────────────────────────────────────────
let activeScreen = null;

function showScreen(name) {
  document.querySelectorAll('[data-screen]').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === name);
  });
  activeScreen = name;
}

// ── Entry point ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  wireAuthScreen();
  wireDashboard();
  wirePracticeSetup();
  wirePracticeActive();
  wireReviewScreen();
  wireHistoryScreen();
  wireOtaScreen();

  onAuthChange(u => {
    user = u;
    if (u) {
      showScreen('dashboard');
      refreshDashboardHeader(u);
    } else {
      showScreen('auth');
    }
  });

  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    showToast('⚠️ Web Bluetooth not supported in this browser.', 'warn');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function wireAuthScreen() {
  const emailInput    = document.getElementById('auth-email');
  const pwInput       = document.getElementById('auth-password');
  const googleBtn     = document.getElementById('auth-google-btn');
  const emailSignIn   = document.getElementById('auth-email-signin');
  const emailSignUp   = document.getElementById('auth-email-signup');
  const resetBtn      = document.getElementById('auth-reset-btn');
  const authError     = document.getElementById('auth-error');
  const authTab       = document.querySelectorAll('.auth-tab');

  // Tab switching (Sign In / Register)
  authTab.forEach(tab => tab.addEventListener('click', () => {
    authTab.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    emailSignIn.style.display  = mode === 'signin' ? '' : 'none';
    emailSignUp.style.display  = mode === 'signup' ? '' : 'none';
    resetBtn.style.display     = mode === 'signin' ? '' : 'none';
    authError.textContent      = '';
  }));

  googleBtn.addEventListener('click', async () => {
    authError.textContent = '';
    try {
      await signInWithGoogle();
    } catch (e) {
      authError.textContent = friendlyAuthError(e);
    }
  });

  emailSignIn.addEventListener('click', async () => {
    authError.textContent = '';
    const email = emailInput.value.trim();
    const pw    = pwInput.value;
    if (!email || !pw) { authError.textContent = 'Enter email and password.'; return; }
    try {
      await signInWithEmail(email, pw);
    } catch (e) {
      authError.textContent = friendlyAuthError(e);
    }
  });

  emailSignUp.addEventListener('click', async () => {
    authError.textContent = '';
    const email = emailInput.value.trim();
    const pw    = pwInput.value;
    if (!email || !pw)   { authError.textContent = 'Enter email and password.'; return; }
    if (pw.length < 6)   { authError.textContent = 'Password must be at least 6 characters.'; return; }
    try {
      await signUpWithEmail(email, pw);
    } catch (e) {
      authError.textContent = friendlyAuthError(e);
    }
  });

  resetBtn?.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) { authError.textContent = 'Enter your email first.'; return; }
    try {
      await resetPassword(email);
      authError.style.color = '#2ecc71';
      authError.textContent = 'Password reset email sent.';
      setTimeout(() => { authError.style.color = ''; authError.textContent = ''; }, 4000);
    } catch (e) {
      authError.textContent = friendlyAuthError(e);
    }
  });
}

function friendlyAuthError(e) {
  const code = e.code ?? '';
  if (code.includes('wrong-password') || code.includes('invalid-credential'))
    return 'Incorrect email or password.';
  if (code.includes('user-not-found'))  return 'No account with that email.';
  if (code.includes('email-already'))   return 'Email already registered — sign in instead.';
  if (code.includes('invalid-email'))   return 'Enter a valid email address.';
  if (code.includes('popup-closed'))    return 'Sign-in popup was closed.';
  return e.message ?? 'Sign-in failed.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function wireDashboard() {
  document.getElementById('dash-practice-btn')?.addEventListener('click', () => {
    showScreen('practice-setup');
    resetPracticeSetup();
  });

  document.getElementById('dash-history-btn')?.addEventListener('click', () => {
    showScreen('history');
    loadHistory();
  });

  document.getElementById('dash-ota-btn')?.addEventListener('click', () => {
    showScreen('ota');
    loadOtaScreen();
  });

  document.getElementById('dash-signout-btn')?.addEventListener('click', async () => {
    if (isBleConnected) ble.disconnect();
    await signOut();
  });
}

function refreshDashboardHeader(u) {
  const nameEl   = document.getElementById('dash-user-name');
  const avatarEl = document.getElementById('dash-user-avatar');
  if (nameEl)   nameEl.textContent = u.displayName || u.email || 'User';
  if (avatarEl && u.photoURL) {
    avatarEl.src = u.photoURL;
    avatarEl.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRACTICE SETUP — connect BLE + camera
// ═══════════════════════════════════════════════════════════════════════════════

function wirePracticeSetup() {
  const bleBtn      = document.getElementById('setup-ble-btn');
  const camBtn      = document.getElementById('setup-cam-btn');
  const startBtn    = document.getElementById('setup-start-btn');
  const backBtn     = document.getElementById('setup-back-btn');
  const bleState    = document.getElementById('setup-ble-state');
  const camState    = document.getElementById('setup-cam-state');
  const uploadToggle = document.getElementById('setup-upload-video-toggle');

  // Sync toggle state to uploadVideoEnabled
  if (uploadToggle) {
    uploadToggle.checked = uploadVideoEnabled;
    uploadToggle.addEventListener('change', () => {
      uploadVideoEnabled = uploadToggle.checked;
    });
  }

  backBtn?.addEventListener('click', () => {
    if (isBleConnected) ble.disconnect();
    stopCamera();
    showScreen('dashboard');
  });

  bleBtn?.addEventListener('click', async () => {
    initAudio();   // must happen in user gesture
    if (isBleConnected) {
      ble.disconnect();
    } else {
      bleBtn.disabled = true;
      try { await ble.connect(); } catch (_) {}
      bleBtn.disabled = false;
    }
  });

  camBtn?.addEventListener('click', async () => {
    if (mediaStream) {
      stopCamera();
      camState.textContent = '⛕ Not enabled';
      camState.classList.remove('ok');
      camBtn.textContent = 'Enable';
      const preview = document.getElementById('setup-cam-preview');
      if (preview) preview.style.display = 'none';
      updateReadyGate();
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        // 640×480 portrait: good enough to see a shot, much smaller file than 1080p
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      videoEnabled = true;
      const preview = document.getElementById('setup-cam-preview');
      if (preview) {
        preview.srcObject = mediaStream;
        preview.style.display = 'block';
        preview.play();
      }
      camState.textContent = '✅ Camera ready';
      camState.classList.add('ok');
      camBtn.textContent = 'Disable';
    } catch (e) {
      videoEnabled = false;
      camState.textContent = `⭕ ${e.message}`;
      showToast('Camera access denied — please enable camera to continue.', 'error');
    }
    updateReadyGate();
  });

  startBtn?.addEventListener('click', startPracticeSession);

  function updateReadyGate() {
    // Both BLE and camera are required to start
    if (startBtn) startBtn.disabled = !(isBleConnected && videoEnabled);
  }
  // Expose so BLE status changes can update it
  window._updatePracticeReadyGate = updateReadyGate;
}

function resetPracticeSetup() {
  const bleState = document.getElementById('setup-ble-state');
  const camState = document.getElementById('setup-cam-state');
  if (bleState) bleState.textContent = isBleConnected ? '✅ Connected' : '⭕ Not connected';
  if (camState) camState.textContent = mediaStream    ? '✅ Camera ready' : '⭕ Not enabled';
  if (bleState) bleState.classList.toggle('ok', isBleConnected);
  if (camState) camState.classList.toggle('ok', !!mediaStream);
  // Camera btn label
  const camBtn = document.getElementById('setup-cam-btn');
  if (camBtn) camBtn.textContent = mediaStream ? 'Disable' : 'Enable';
  // Sync upload toggle
  const uploadToggle = document.getElementById('setup-upload-video-toggle');
  if (uploadToggle) uploadToggle.checked = uploadVideoEnabled;
  // Start requires both BLE + camera
  const startBtn = document.getElementById('setup-start-btn');
  if (startBtn) startBtn.disabled = !(isBleConnected && videoEnabled);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRACTICE ACTIVE — live sensor + camera + scoreboard
// ═══════════════════════════════════════════════════════════════════════════════

function wirePracticeActive() {
  document.getElementById('active-stop-btn')?.addEventListener('click', stopPracticeSession);
  document.getElementById('active-restart-btn')?.addEventListener('click', restartPracticeSession);
}

function startPracticeSession() {
  // Reset session state
  sessionId     = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  sessionStart  = performance.now();
  sessionEnd    = null;
  sessionMakes  = 0;
  sessionTotal  = 0;
  sessionEvents = [];
  sensorWindow  = [];
  allSensorData = [];
  allVideoChunks = [];
  videoSessionBlob = null;
  // Release previous session object URL if any
  if (videoSessionUrl) { URL.revokeObjectURL(videoSessionUrl); videoSessionUrl = null; }

  // Reset classifier and parser for fresh calibration
  classifier = new ShotClassifier();
  parser.reset();

  showScreen('practice-active');

  // Wire camera to the active video element
  const videoEl = document.getElementById('active-video');
  if (videoEl && mediaStream) {
    videoEl.srcObject = mediaStream;
    videoEl.play();
  } else if (videoEl) {
    videoEl.style.display = 'none';
  }

  // Start video recording if camera is available
  if (mediaStream && videoEnabled) {
    startVideoRecording();
  }

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

function stopPracticeSession() {
  sessionEnd = performance.now();

  // Disconnect BLE — sensor no longer needed
  if (isBleConnected) ble.disconnect();

  if (sessionEvents.length === 0) {
    stopCamera();
    showToast('Session ended with no detected shots.', 'info');
    showScreen('dashboard');
    return;
  }

  setActiveEvent('Saving session video…', '#f39c12');

  // Wait for MediaRecorder to flush its final chunk via the 'stop' event,
  // then assemble the full blob and persist it to IndexedDB.
  const finalizeAndReview = async () => {
    stopCamera();  // release camera tracks now that recording is finished

    if (allVideoChunks.length > 0) {
      videoSessionBlob = new Blob(allVideoChunks.map(c => c.data),
                                  { type: videoMimeType || 'video/webm' });
      try {
        await storeSessionVideo(sessionId, videoSessionBlob);
      } catch (e) {
        console.warn('IndexedDB store failed — video lives in RAM only:', e);
      }
    }

    reviewIndex = 0;
    await showReviewScreen();
  };

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.addEventListener('stop', finalizeAndReview, { once: true });
    mediaRecorder.stop();
    mediaRecorder = null;
  } else {
    mediaRecorder = null;
    finalizeAndReview();
  }
}

/**
 * Restart the session in-place: reset all counters + re-calibrate baseline,
 * but keep camera and BLE connected.
 */
function restartPracticeSession() {
  sessionId        = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  sessionStart     = performance.now();
  sessionEnd       = null;
  sessionMakes     = 0;
  sessionTotal     = 0;
  sessionEvents    = [];
  sensorWindow     = [];
  allSensorData    = [];
  allVideoChunks   = [];
  videoSessionBlob = null;
  if (videoSessionUrl) { URL.revokeObjectURL(videoSessionUrl); videoSessionUrl = null; }

  // Fresh classifier + parser for new baseline calibration
  classifier = new ShotClassifier();
  parser.reset();

  // Restart video recording without re-requesting camera
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (_) {}
    mediaRecorder = null;
  }
  recordingStartMs = 0;
  if (mediaStream && videoEnabled) startVideoRecording();

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

// ── Scoreboard helpers ───────────────────────────────────────────────────────

function updateActiveScoreboard() {
  const makesEl = document.getElementById('active-makes');
  const totalEl = document.getElementById('active-total');
  const pctEl   = document.getElementById('active-pct');
  if (makesEl) makesEl.textContent = sessionMakes;
  if (totalEl) totalEl.textContent = sessionTotal;
  if (pctEl)   pctEl.textContent   = sessionTotal
    ? `${Math.round(sessionMakes / sessionTotal * 100)}%` : '—%';
}

function setActiveEvent(text, color = '#ccc') {
  const el = document.getElementById('active-event');
  if (el) { el.textContent = text; el.style.color = color; }
}

let _calBarTimer = null;
function showCalibrationBar(show) {
  const wrap = document.getElementById('active-cal-wrap');
  if (wrap) wrap.classList.toggle('visible', show);
}

function updateCalBar(pct) {
  const bar = document.getElementById('active-cal-bar');
  if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
}

// ── Video recording ──────────────────────────────────────────────────────────

function startVideoRecording() {
  const mimeOptions = [
    'video/webm;codecs=vp8',  // VP8 preferred: better Android seek support than VP9
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
  ];
  videoMimeType    = mimeOptions.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  allVideoChunks   = [];
  recordingStartMs = performance.now();

  try {
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType:           videoMimeType,
      videoBitsPerSecond: VIDEO_BITRATE,
    });
    mediaRecorder.addEventListener('dataavailable', (evt) => {
      if (evt.data.size > 0) {
        // Record-relative start time of this chunk (used for hostEventTs seeking)
        const startMs = allVideoChunks.length * VIDEO_TIMESLICE_MS;
        allVideoChunks.push({ data: evt.data, startMs });
      }
    });
    // Short timeslice → more frequent keyframes → accurate seeks during review
    mediaRecorder.start(VIDEO_TIMESLICE_MS);
  } catch (e) {
    console.warn('MediaRecorder failed:', e);
    videoEnabled = false;
  }
}

function stopCamera() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream  = null;
    videoEnabled = false;
  }
}

// ── Sensor window ────────────────────────────────────────────────────────────

function snapshotSensorWindow() {
  return [...sensorWindow];   // clone
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLE packet handler
// ═══════════════════════════════════════════════════════════════════════════════

function onBlePacket(dataView) {
  const { batch, lostPackets, deviceInfo } = parser.parse(dataView);
  if (lostPackets > 0) console.warn(`Packet loss: ${lostPackets}`);

  if (deviceInfo) {
    deviceHwVer = `v${deviceInfo.hwVersion}`;
    deviceFwVer = `v${deviceInfo.fwVersion}`;
    updateDeviceInfoBar(deviceInfo);
  }

  if (!batch || activeScreen !== 'practice-active') return;

  // Capture the host (browser) time when this BLE packet was received.
  // All samples in this packet share the same host timestamp.
  const hostNow = performance.now();
  batch.forEach(s => { s.host_ts = hostNow; });

  // The last sample's device timestamp is the latest device time in the packet.
  const latestDeviceTs_ms = batch[batch.length - 1].mpu_ts;

  // Rolling sensor window (for per-shot snapshot)
  sensorWindow.push(...batch);
  if (sensorWindow.length > SENSOR_WINDOW_SLOTS) {
    sensorWindow.splice(0, sensorWindow.length - SENSOR_WINDOW_SLOTS);
  }

  // Full-session log for CSV export (unbounded — freed at session end / upload)
  allSensorData.push(...batch);

  const cal      = classifier.calibrator;
  const wasDone  = cal.isComplete;

  const newShots = classifier.processBatch(batch);

  // Calibration progress
  if (!wasDone) {
    if (cal.isComplete) {
      showCalibrationBar(false);
      setActiveEvent('baseline ready — detecting shots 🏀', '#2ecc71');
    } else {
      updateCalBar(cal.progress);
    }
  }

  // New shot events — pass host timing context so clip extraction is accurate
  for (const shot of newShots) {
    onShotDetected(shot, hostNow, latestDeviceTs_ms);
  }
}

function onShotDetected(shot, hostNow = performance.now(), latestDeviceTs_ms = null) {
  const isMake = shot.classification === 'MAKE';
  const type   = shot.basket_type ?? '';

  // Map classifier basket_type → human-readable subtype
  const subtypeMap = { SWISH: 'Swish', BANK: 'Rim-in' };
  const aiTop     = isMake ? 'Make' : (shot.classification === 'MISS' ? 'Miss' : 'Not-a-shot');
  const aiSubtype = isMake ? (subtypeMap[type] ?? null) : null;

  if (isMake) sessionMakes++;
  sessionTotal++;
  updateActiveScoreboard();

  // Compute host-corrected recording-relative time of the event
  const eventDeviceTs_ms = (shot.basket_time ?? shot.impact_time ?? 0) * 1000;
  const deviceLag_ms     = latestDeviceTs_ms !== null
    ? Math.max(0, latestDeviceTs_ms - eventDeviceTs_ms)
    : 0;
  const hostEventTs   = (hostNow - recordingStartMs) - deviceLag_ms;
  // video_clip_ts: event time relative to video start, in seconds (Feature 1b / Feature 2)
  const video_clip_ts = hostEventTs / 1000.0;

  const ev = {
    shot,
    ai_top:       aiTop,
    ai_subtype:   aiSubtype,
    user_top:     aiTop,      // default = AI prediction until user overrides
    user_subtype: aiSubtype,  // default = AI prediction until user overrides
    video_clip_ts,
    timestamp:    Date.now(),
    host_ts:      hostNow,
    hostEventTs,
  };

  sessionEvents.push(ev);

  const scoreText = `${sessionMakes} out of ${sessionTotal}`;
  if (isMake) {
    const dispLabel = aiSubtype ? `🏀 ${aiSubtype}!` : '🏀 Make!';
    setActiveEvent(dispLabel, '#2ecc71');
    speak(`${aiSubtype ?? 'Make'}, ${scoreText}`);
  } else {
    setActiveEvent('❌ Miss', '#e74c3c');
    speak(`Miss, ${scoreText}`);
  }
}

function onBleStatus(state, detail) {
  isBleConnected = state === 'connected';

  // Update setup screen
  const bleState = document.getElementById('setup-ble-state');
  const bleBtn   = document.getElementById('setup-ble-btn');
  if (bleState) {
    bleState.textContent = isBleConnected ? '✅ Connected' : '⛕ Not connected';
    bleState.classList.toggle('ok', isBleConnected);
  }
  if (bleBtn) bleBtn.textContent = isBleConnected ? 'Disconnect' : 'Connect';

  // Global BLE status
  const statusEl = document.getElementById('global-ble-status');
  if (statusEl) {
    statusEl.textContent = isBleConnected ? 'BLE ●' : 'BLE ○';
    statusEl.style.color = isBleConnected ? '#2ecc71' : '#555566';
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

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW & LABEL screen
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enter the review screen and attach the full-session video.
 * Loads the blob from IndexedDB (or falls back to in-RAM blob) and sets
 * it as the video element src once — individual cards just seek.
 */
async function showReviewScreen() {
  showScreen('practice-review');

  const videoEl = document.getElementById('review-video');
  if (!videoEl) { renderReviewCard(); return; }

  // Try IndexedDB first, fall back to in-RAM blob
  let blob = null;
  try {
    blob = await loadSessionVideo(sessionId);
  } catch (e) {
    console.warn('IndexedDB load failed:', e);
  }
  blob = blob ?? videoSessionBlob;

  if (blob) {
    if (videoSessionUrl) URL.revokeObjectURL(videoSessionUrl);
    videoSessionUrl    = URL.createObjectURL(blob);
    videoEl.src        = videoSessionUrl;
    videoEl.load();
    videoEl.style.display = '';
  } else {
    videoEl.style.display = 'none';
  }

  renderReviewCard();
}

function wireReviewScreen() {
  // Back button — go to previous card (disabled on first card)
  document.getElementById('review-back-btn')?.addEventListener('click', () => {
    if (reviewIndex > 0) {
      reviewIndex--;
      renderReviewCard();
    }
  });
}

function renderReviewCard(announcement = null) {
  const total = sessionEvents.length;
  const event = sessionEvents[reviewIndex];

  // Progress indicator
  setEl('review-progress', `${reviewIndex + 1} / ${total}`);

  // Back button: disabled on the first card
  const backBtn = document.getElementById('review-back-btn');
  if (backBtn) backBtn.disabled = (reviewIndex === 0);

  // AI prediction banner
  const predEl = document.getElementById('review-prediction');
  if (predEl) {
    const icon = event.ai_top === 'Make' ? '🏀' : (event.ai_top === 'Miss' ? '❌' : '🔇');
    predEl.textContent = `AI: ${icon} ${event.ai_top}${event.ai_subtype ? ' — ' + event.ai_subtype : ''}`;
    predEl.style.color = event.ai_top === 'Make' ? '#2ecc71'
                       : event.ai_top === 'Miss' ? '#e74c3c' : '#888888';
  }
  // Announce: AI result on card load, or explicit override (e.g. 'Correction, Miss')
  speak(announcement ?? (event.ai_top === 'Make' ? (event.ai_subtype ?? 'Make') : event.ai_top));

  // Video clip — seek to the event window and LOOP within the 3.5 s clip (Feature 3a)
  const videoEl = document.getElementById('review-video');
  if (videoEl && videoSessionUrl) {
    const seekSec = Math.max(0, (event.hostEventTs - EVENT_PRE_MS) / 1000);
    const endSec  = seekSec + (EVENT_PRE_MS + EVENT_POST_MS) / 1000;

    // Remove previous clip listener before installing a new one
    if (_clipStopListener) {
      videoEl.removeEventListener('timeupdate', _clipStopListener);
      _clipStopListener = null;
    }

    // Loop within the clip window: when we reach endSec, seek back to seekSec
    _clipStopListener = () => {
      if (videoEl.currentTime >= endSec) {
        videoEl.currentTime = seekSec;
        videoEl.play().catch(() => {});
      }
    };
    videoEl.addEventListener('timeupdate', _clipStopListener);

    const doSeek = () => { videoEl.currentTime = seekSec; videoEl.play().catch(() => {}); };
    if (videoEl.readyState >= 1) doSeek();
    else videoEl.addEventListener('loadedmetadata', doSeek, { once: true });
  }

  // ── Top-class buttons: Make | Miss | Not-a-shot (Feature 6) ──────────────
  const topContainer = document.getElementById('review-top-btns');
  if (topContainer) {
    topContainer.innerHTML = '';
    [{ top: 'Make', icon: '🏀' }, { top: 'Miss', icon: '❌' }, { top: 'Not-a-shot', icon: '🔇' }]
      .forEach(({ top, icon }) => {
        const btn = document.createElement('button');
        btn.className = 'label-btn label-btn-top';
        btn.textContent = `${icon} ${top}`;
        btn.classList.toggle('selected', event.user_top === top);
        btn.addEventListener('click', () => {
          event.user_top = top;
          if (top !== 'Make') event.user_subtype = null;
          renderReviewCard(`Correction, ${top}`);
        });
        topContainer.appendChild(btn);
      });
  }

  // ── Subtype buttons: Swish | Rim-in | Unsure — greyed unless Make ────────
  const subContainer = document.getElementById('review-sub-btns');
  if (subContainer) {
    subContainer.innerHTML = '';
    const isMakeSelected = event.user_top === 'Make';
    [{ sub: 'Swish', icon: '🏀' }, { sub: 'Rim-in', icon: '🔄' }, { sub: 'Unsure', icon: '❓' }]
      .forEach(({ sub, icon }) => {
        const btn = document.createElement('button');
        btn.className = 'label-btn label-btn-sub';
        btn.textContent = `${icon} ${sub}`;
        btn.classList.toggle('selected', event.user_subtype === sub);
        btn.classList.toggle('label-btn-disabled', !isMakeSelected);
        btn.disabled = !isMakeSelected;
        btn.addEventListener('click', () => {
          event.user_subtype = sub;
          renderReviewCard(`Correction, ${sub}`);
        });
        subContainer.appendChild(btn);
      });
  }

  // Confirm — accept current user selection and advance
  const confirmBtn = document.getElementById('review-confirm-btn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      reviewIndex++;
      if (reviewIndex >= sessionEvents.length) startUpload();
      else renderReviewCard();
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

async function startUpload() {
  showScreen('practice-upload');
  const uid = user?.uid;
  if (!uid) { showScreen('dashboard'); return; }

  // Steps: 1 CSV + 1 JSON + 1 Summary + N shots + optional 1 session video
  const videoSteps  = uploadVideoEnabled ? 1 : 0;
  const totalSteps  = 3 + sessionEvents.length + videoSteps;
  let   doneSteps   = 0;
  const shotIds     = [];

  const progressEl = document.getElementById('upload-progress');
  const statusEl   = document.getElementById('upload-status');

  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  const updateBar = () => {
    if (progressEl) progressEl.style.width = `${Math.round(doneSteps / totalSteps * 100)}%`;
  };

  setStatus('Generating session data…');

  // ── Compute session stats ─────────────────────────────────────────────────
  const userMakes = sessionEvents.filter(e => e.user_top === 'Make').length;
  const userTotal = sessionEvents.filter(e => e.user_top !== 'Not-a-shot').length;
  const aiMakes   = sessionEvents.filter(e => e.ai_top  === 'Make').length;
  const aiTotal   = sessionEvents.filter(e => e.ai_top  !== 'Not-a-shot').length;
  const durSec    = Math.round(((sessionEnd ?? performance.now()) - sessionStart) / 1000);

  // ── 1. Upload full-session CSV ────────────────────────────────────────────
  try {
    setStatus('Uploading session CSV…');
    const csvBlob = generateSessionCsv();
    await uploadSessionCsv(uid, sessionId, csvBlob);
  } catch (e) {
    console.warn('CSV upload failed:', e);
  }
  doneSteps++; updateBar();

  // ── 2. Upload session labels JSON ─────────────────────────────────────────
  try {
    setStatus('Uploading session labels JSON…');
    const jsonBlob = generateSessionJson();
    await uploadSessionJson(uid, sessionId, jsonBlob);
  } catch (e) {
    console.warn('Labels JSON upload failed:', e);
  }
  doneSteps++; updateBar();

  // ── 3. Upload practice summary JSON ──────────────────────────────────────
  try {
    setStatus('Uploading practice summary…');
    const summary = {
      session_id:    sessionId,
      duration_sec:  durSec,
      user_makes:    userMakes,
      user_total:    userTotal,
      user_accuracy: userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0,
      ai_makes:      aiMakes,
      ai_total:      aiTotal,
      ai_accuracy:   aiTotal > 0 ? Math.round(aiMakes / aiTotal * 100) : 0,
    };
    const summaryBlob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    await uploadPracticeSummary(uid, sessionId, summaryBlob);
  } catch (e) {
    console.warn('Practice summary upload failed:', e);
  }
  doneSteps++; updateBar();

  // ── 4. Save shot documents ────────────────────────────────────────────────
  for (let i = 0; i < sessionEvents.length; i++) {
    const ev = sessionEvents[i];
    try {
      setStatus(`Saving shot ${i + 1} / ${sessionEvents.length}…`);
      const id = await saveShot({
        userId:        uid,
        sessionId,
        timestamp:     ev.timestamp,
        ai_prediction: ev.ai_top,
        ai_subtype:    ev.ai_subtype,
        basket_type:   ev.shot.basket_type ?? null,
        user_label:    ev.user_top + (ev.user_subtype ? '/' + ev.user_subtype : ''),
        user_top:      ev.user_top,
        user_subtype:  ev.user_subtype,
        confidence:    ev.shot.confidence ?? 0,
        host_event_ts: ev.hostEventTs,
        video_clip_ts: ev.video_clip_ts,
      });
      shotIds.push(id);
    } catch (e) {
      console.warn('Shot save failed:', e);
    }
    doneSteps++; updateBar();
  }

  // ── 5. Upload session video (if enabled) ──────────────────────────────────
  let sessionVideoUrl = null;
  if (uploadVideoEnabled) {
    let blob = videoSessionBlob;
    if (!blob) {
      try { blob = await loadSessionVideo(sessionId); } catch (_) {}
    }
    if (blob) {
      try {
        setStatus('Uploading session video…');
        sessionVideoUrl = await uploadSessionVideo(uid, sessionId, blob, videoMimeType);
        deleteSessionVideo(sessionId).catch(() => {});
      } catch (e) {
        console.warn('Session video upload failed:', e);
        setStatus('⚠️ Video upload failed — data saved.');
      }
    } else {
      setStatus('⚠️ No video data found — skipping video upload.');
    }
    doneSteps++; updateBar();
  }

  // ── 6. Save session summary to Firestore ──────────────────────────────────
  try {
    await saveSession(uid, sessionId, {
      makes: userMakes, total: userTotal,
      ai_makes: aiMakes, ai_total: aiTotal,
      durationSec: durSec, shotIds, video_url: sessionVideoUrl,
    });
  } catch (e) {
    console.warn('Session save failed:', e);
  }

  // Free session sensor data from memory
  allSensorData = [];

  setStatus('✅ Upload complete!');
  if (progressEl) progressEl.style.width = '100%';

  // ── Show summary ──────────────────────────────────────────────────────────
  const uPct = userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0;
  const aPct = aiTotal  > 0 ? Math.round(aiMakes  / aiTotal  * 100) : 0;
  setEl('upload-summary', `User: ${userMakes}/${userTotal} (${uPct}%) · AI: ${aiMakes}/${aiTotal} · ${durSec}s`);
  const doneBtn = document.getElementById('upload-done-btn');
  if (doneBtn) doneBtn.style.display = '';
  doneBtn?.addEventListener('click', () => {
    showScreen('dashboard');
  }, { once: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a full-session CSV Blob from allSensorData.
 * Format matches data_receiver.py CSV output so the same Python tools can process it.
 *
 * Columns:
 *   MPU_Timestamp (ms), AcX (g), AcY (g), AcZ (g),
 *   GyX (dps), GyY (dps), GyZ (dps),
 *   TOF_Timestamp (ms), Range (mm), Signal_Rate
 */
function generateSessionCsv() {
  const header = [
    'Host_Timestamp (ms)',
    'MPU_Timestamp (ms)', 'AcX (g)', 'AcY (g)', 'AcZ (g)',
    'GyX (dps)', 'GyY (dps)', 'GyZ (dps)',
    'TOF_Timestamp (ms)', 'Range (mm)', 'Signal_Rate',
  ].join(',');

  const rows = allSensorData.map(s => [
    (s.host_ts  ?? 0).toFixed(3),   // host receive time (performance.now() ms)
    s.mpu_ts ?? 0,
    (s.accel[0] ?? 0).toFixed(6),
    (s.accel[1] ?? 0).toFixed(6),
    (s.accel[2] ?? 0).toFixed(6),
    (s.gyro[0]  ?? 0).toFixed(4),
    (s.gyro[1]  ?? 0).toFixed(4),
    (s.gyro[2]  ?? 0).toFixed(4),
    s.tof_ts    ?? 0,
    s.distance  ?? 0,
    s.signal_rate ?? 0,
  ].join(','));

  const csvString = [header, ...rows].join('\n');
  return new Blob([csvString], { type: 'text/csv' });
}

/**
 * Generate session_labels.json matching the unified schema (Feature 2).
 * Fields: ai_top, ai_subtype, user_top, user_subtype, source,
 *         row_idx, event_ts_s, event_type, host_ts_udp, video_clip_ts
 *
 * Top classes:   "Make" | "Miss" | "Not-a-shot"
 * Subtypes:      "Swish" | "Rim-in" | "Unsure"  (only for "Make")
 * event_type:    "basket" | "impact"   (lowercase)
 * video_clip_ts: seconds from video start to the detected event
 */
function generateSessionJson() {
  const output = {};
  sessionEvents.forEach((ev, idx) => {
    const isMake = ev.ai_top === 'Make';
    const source = (ev.user_top === ev.ai_top && ev.user_subtype === ev.ai_subtype)
      ? 'auto' : 'manual';

    output[idx] = {
      ai_top:        ev.ai_top,
      ai_subtype:    ev.ai_subtype,
      user_top:      ev.user_top,
      user_subtype:  ev.user_subtype,
      source,
      row_idx:       idx,
      event_ts_s:    ev.shot.basket_time ?? ev.shot.impact_time ?? 0,
      event_type:    isMake ? 'basket' : 'impact',
      host_ts_udp:   (ev.host_ts ?? 0) / 1000.0,
      video_clip_ts: ev.video_clip_ts ?? null,
    };
  });
  return new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY screen
// ═══════════════════════════════════════════════════════════════════════════════

function wireHistoryScreen() {
  document.getElementById('history-back-btn')?.addEventListener('click', () => showScreen('dashboard'));
}

async function loadHistory() {
  if (!user) return;
  const loadingEl = document.getElementById('history-loading');
  const contentEl = document.getElementById('history-content');
  if (loadingEl) loadingEl.style.display = '';
  if (contentEl) contentEl.style.display = 'none';

  try {
    const sessions = await fetchSessions(user.uid, 10);

    renderLifetimeStats(sessions);
    renderTrendChart(sessions.slice().reverse());   // oldest first for chart
    renderSessionList(sessions);

    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'flex';
    if (contentEl) contentEl.style.flexDirection = 'column';
    if (contentEl) contentEl.style.gap = '16px';
  } catch (e) {
    console.error('History load failed:', e);
    showToast('Failed to load history.', 'error');
    if (loadingEl) loadingEl.textContent = 'Failed to load — check your connection.';
  }
}

function renderLifetimeStats(sessions) {
  let userMakes = 0, userTotal = 0;
  for (const s of sessions) { userMakes += s.makes ?? 0; userTotal += s.total ?? 0; }
  const pct = userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0;
  setEl('stat-total', userTotal);
  setEl('stat-makes', userMakes);
  setEl('stat-pct',   `${pct}%`);
}

function renderTrendChart(sessions) {
  const ctx = document.getElementById('trend-chart');
  if (!ctx || !window.Chart) return;

  const labels = sessions.map(s => {
    const d = s.createdAt?.toDate?.() ?? new Date(s.createdAt?.seconds * 1000 ?? 0);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const data = sessions.map(s => s.total > 0 ? Math.round(s.makes / s.total * 100) : 0);

  if (historyChart) historyChart.destroy();

  historyChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label:           'Shooting %',
        data,
        borderColor:     '#f0e040',
        backgroundColor: 'rgba(240,224,64,0.1)',
        tension:         0.3,
        pointRadius:     4,
        fill:            true,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 0, max: 100,
          ticks: { color: '#667', callback: v => `${v}%` },
          grid:  { color: '#1e2736' },
        },
        x: {
          ticks: { color: '#667', maxTicksLimit: 8 },
          grid:  { color: '#1e2736' },
        },
      },
    },
  });
}

function renderSessionList(sessions) {
  const listEl = document.getElementById('session-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!sessions.length) {
    listEl.innerHTML = '<p style="color:#445566;text-align:center;padding:20px">No sessions yet — go practice!</p>';
    return;
  }

  // Table header
  const hdr = document.createElement('div');
  hdr.className = 'session-item session-hdr';
  hdr.innerHTML = '<div class="sh-date">Date</div><div class="sh-dur">Dur</div>' +
                  '<div class="sh-score">User</div><div class="sh-score">AI</div>';
  listEl.appendChild(hdr);

  let totDur = 0, totUM = 0, totUT = 0, totAM = 0, totAT = 0;

  for (const s of sessions) {
    const d   = s.createdAt?.toDate?.() ?? new Date((s.createdAt?.seconds ?? 0) * 1000);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const uM = s.makes    ?? 0;
    const uT = s.total    ?? 0;
    const aM = s.ai_makes ?? uM;
    const aT = s.ai_total ?? uT;
    const uP = uT > 0 ? Math.round(uM / uT * 100) : 0;
    const aP = aT > 0 ? Math.round(aM / aT * 100) : 0;
    const dur = s.durationSec ? Math.round(s.durationSec / 60) : 0;
    totDur += dur; totUM += uM; totUT += uT; totAM += aM; totAT += aT;

    const row = document.createElement('div');
    row.className = 'session-item';
    row.innerHTML =
      `<div class="sh-date">${date}<br><span class="session-time">${time}</span></div>` +
      `<div class="sh-dur">${dur}m</div>` +
      `<div class="sh-score"><b>${uM}/${uT}</b><br><span style="color:${uP >= 50 ? '#2ecc71' : '#e74c3c'}">${uP}%</span></div>` +
      `<div class="sh-score"><b>${aM}/${aT}</b><br><span style="color:${aP >= 50 ? '#2ecc71' : '#e74c3c'}">${aP}%</span></div>`;
    listEl.appendChild(row);
  }

  // Totals row
  const tUP = totUT > 0 ? Math.round(totUM / totUT * 100) : 0;
  const tAP = totAT > 0 ? Math.round(totAM / totAT * 100) : 0;
  const tot = document.createElement('div');
  tot.className = 'session-item session-totals';
  tot.innerHTML =
    `<div class="sh-date"><b>Total</b></div>` +
    `<div class="sh-dur"><b>${totDur}m</b></div>` +
    `<div class="sh-score"><b>${totUM}/${totUT}</b><br><span style="color:${tUP >= 50 ? '#2ecc71' : '#e74c3c'}">${tUP}%</span></div>` +
    `<div class="sh-score"><b>${totAM}/${totAT}</b><br><span style="color:${tAP >= 50 ? '#2ecc71' : '#e74c3c'}">${tAP}%</span></div>`;
  listEl.appendChild(tot);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OTA FIRMWARE UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

function wireOtaScreen() {
  document.getElementById('ota-back-btn')?.addEventListener('click', () => showScreen('dashboard'));
  document.getElementById('ota-check-btn')?.addEventListener('click', () => loadOtaScreen());
  document.getElementById('ota-update-btn')?.addEventListener('click', () => runOtaUpdate());
}

async function loadOtaScreen() {
  setEl('ota-device-version', deviceFwVer || '–');
  setEl('ota-latest-version', 'Checking…');
  setEl('ota-update-status', '');
  const updateBtn = document.getElementById('ota-update-btn');
  if (updateBtn) updateBtn.disabled = true;

  ota = new OtaUpdater(
    (pct, msg) => {
      const bar = document.getElementById('ota-progress-bar');
      if (bar) bar.style.width = `${pct}%`;
      setEl('ota-update-status', msg);
    },
    (msg) => {
      setEl('ota-update-status', msg);
      console.log('[OTA]', msg);
    },
  );

  try {
    const info = await ota.fetchLatestRelease();
    setEl('ota-latest-version', `v${info.version} (${(info.size / 1024).toFixed(0)} KB)`);

    // Enable update button
    if (updateBtn) updateBtn.disabled = false;
  } catch (e) {
    setEl('ota-latest-version', 'Failed to check');
    setEl('ota-update-status', `Error: ${e.message}`);
  }
}

async function runOtaUpdate() {
  if (!ota) return;
  const updateBtn = document.getElementById('ota-update-btn');
  const bar       = document.getElementById('ota-progress-bar');
  if (updateBtn) updateBtn.disabled = true;
  if (bar)       bar.style.width     = '0%';

  try {
    // 1. Download firmware
    await ota.downloadFirmware();

    // 2. Connect via BLE OTA service (requires user gesture — this click IS one)
    await ota.connect();

    // 3. Flash
    const success = await ota.flash();
    if (success) {
      showToast('Firmware updated successfully!', 'success');
    } else {
      showToast('OTA sent — check device for status.', 'warn');
    }
  } catch (e) {
    // A GATT / NetworkError that occurs after CMD_END was sent means the device
    // rebooted to apply the new firmware — this is the EXPECTED success path.
    const isGattDisconnect = /gatt|network error|disconnect/i.test(e.message ?? '');
    if (isGattDisconnect && ota?._endSent) {
      setEl('ota-update-status', '✅ Device rebooted — OTA successful!');
      showToast('Firmware updated! Device is rebooting.', 'success');
    } else {
      setEl('ota-update-status', `Error: ${e.message}`);
      showToast(`OTA failed: ${e.message}`, 'error');
    }
  } finally {
    ota.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO / SPEECH
// ═══════════════════════════════════════════════════════════════════════════════

function initAudio() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
  const dest  = audioCtx.createMediaStreamDestination();
  const osc   = audioCtx.createOscillator();
  const gain  = audioCtx.createGain();
  gain.gain.value = 0.001;      // inaudible oscillator keeps OS audio session alive
  osc.connect(gain);
  gain.connect(dest);
  gain.connect(audioCtx.destination);
  osc.start();
  keepAliveEl         = new Audio();
  keepAliveEl.srcObject = dest.stream;
  keepAliveEl.play().catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: '🏀 Basketball Tracker' });
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }
}

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 1.1;
  utt.volume = 1;
  window.speechSynthesis.speak(utt);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

let toastTimer = null;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent  = msg;
  toast.className    = `toast show toast-${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// Re-acquire wake lock when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (audioCtx?.state === 'suspended') audioCtx.resume();
});
