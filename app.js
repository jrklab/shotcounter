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
import { uploadClip, saveShot, saveSession,
         fetchSessions, fetchAllShots,
         uploadSessionCsv }                        from './db.js';

// ── Constants ────────────────────────────────────────────────────────────────
const VIDEO_TIMESLICE_MS  = 500;   // chunk interval for MediaRecorder
const VIDEO_BUFFER_CHUNKS = 40;    // rolling buffer: ~20 s of video
const SENSOR_WINDOW_SLOTS = 400;   // max samples in rolling sensor window (~2 s @ 200 Hz)
const EVENT_PRE_MS        = 1500;  // video/review window: ms before basket event
const EVENT_POST_MS       = 2000;  // video/review window: ms after basket event

const LABEL_OPTIONS = [
  { key: 'SWISH',       icon: '🏀', label: 'Swish'       },
  { key: 'RIM_IN',      icon: '🔄', label: 'Rim In'      },
  { key: 'MISS',        icon: '❌', label: 'Miss'        },
  { key: 'FALSE_ALARM', icon: '🔇', label: 'False Alarm' },
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

/** @type {{ shot: Object, clipBlob: Blob|null, mimeType: string, label: string }[]} */
let sessionEvents  = [];
let reviewIndex    = 0;

// Sensor data rolling window (for per-shot snapshot) + full-session log for CSV
let sensorWindow   = [];    // rolling ~2 s window  [{accel, gyro, distance, mpu_ts, tof_ts}]
let allSensorData  = [];    // full session sensor log (for CSV export)

// Video recording state
let mediaStream       = null;
let mediaRecorder     = null;
let videoChunks       = [];    // rolling [{data: Blob, startMs: number, endMs: number}]
let videoInitSegment  = null;  // first MediaRecorder chunk (WebM init/codec headers)
let videoMimeType     = 'video/webm';
let videoEnabled      = false;
let recordingStartMs  = 0;     // absolute performance.now() when recording began
let recordingChunkSeq = 0;     // incrementing chunk counter for timestamp calc
let uploadVideoEnabled = true; // upload video clips to Firebase Storage

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
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
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
  const stopBtn = document.getElementById('active-stop-btn');
  stopBtn?.addEventListener('click', stopPracticeSession);
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
  videoChunks   = [];
  recordingChunkSeq = 0;

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
  stopVideoRecording();

  // Disconnect BLE — sensor no longer needed
  if (isBleConnected) ble.disconnect();

  if (sessionEvents.length === 0) {
    // No events — skip review, go home
    showToast('Session ended with no detected shots.', 'info');
    showScreen('dashboard');
    return;
  }

  // Wait for deferred video clip timers (EVENT_POST_MS + 2 chunks) to fire
  // before switching to review, so all clipBlobs are populated.
  setActiveEvent('Finalizing clips…', '#f39c12');
  const CLIP_WAIT_MS = EVENT_POST_MS + VIDEO_TIMESLICE_MS * 2 + 200;
  setTimeout(() => {
    reviewIndex = 0;
    showScreen('practice-review');
    renderReviewCard();
  }, CLIP_WAIT_MS);
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
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  videoMimeType     = mimeOptions.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  videoChunks       = [];
  videoInitSegment  = null;
  recordingChunkSeq = 0;
  recordingStartMs  = performance.now();

  try {
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType:           videoMimeType,
      videoBitsPerSecond: 1_200_000,
    });
    mediaRecorder.addEventListener('dataavailable', (evt) => {
      if (evt.data.size > 0) {
        const startMs = recordingChunkSeq * VIDEO_TIMESLICE_MS;
        const endMs   = startMs + VIDEO_TIMESLICE_MS;
        // Save the very first chunk as the WebM init/codec segment.
        // It must be prepended to every extracted clip for the video to be
        // decodable (especially on Android where keyframe-less WebM fails).
        if (recordingChunkSeq === 0) {
          videoInitSegment = evt.data;
        }
        recordingChunkSeq++;
        videoChunks.push({ data: evt.data, startMs, endMs });
        if (videoChunks.length > VIDEO_BUFFER_CHUNKS) {
          videoChunks.shift();   // drop oldest chunk
        }
      }
    });
    mediaRecorder.start(VIDEO_TIMESLICE_MS);
  } catch (e) {
    console.warn('MediaRecorder failed:', e);
    videoEnabled = false;
  }
}

function stopVideoRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

function stopCamera() {
  stopVideoRecording();
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream  = null;
    videoEnabled = false;
  }
}

/**
 * Extract a video clip Blob for an event at the given recording-relative timestamp.
 * Uses the timestamp-indexed videoChunks array so the window is accurate.
 * Immediately captures the pre-window; post-window is captured after EVENT_POST_MS.
 * The returned object is mutated asynchronously (clipBlob is set after timeout).
 *
 * @param {Object} evObj   — the event object to fill `.clipBlob` into
 */
function scheduleClipExtraction(evObj) {
  if (!videoEnabled || videoChunks.length === 0) return;
  const eventTs   = performance.now() - recordingStartMs;
  // Snapshot pre-window chunks immediately (they may be evicted later)
  const preChunks = videoChunks.filter(c => c.endMs >= eventTs - EVENT_PRE_MS && c.startMs <= eventTs + VIDEO_TIMESLICE_MS);

  setTimeout(() => {
    const postChunks = videoChunks.filter(c => c.startMs > eventTs && c.startMs <= eventTs + EVENT_POST_MS);
    const combined   = [...preChunks, ...postChunks].sort((a, b) => a.startMs - b.startMs);
    if (combined.length > 0) {
      // Always prepend the WebM initialization segment (first recorded chunk) so
      // the browser can decode the clip even when chunk 0 has been evicted from
      // the rolling buffer.  Avoid duplicating it if it's already the first chunk.
      const firstChunkStartMs = combined[0].startMs;
      const blobParts = (videoInitSegment && firstChunkStartMs > 0)
        ? [videoInitSegment, ...combined.map(c => c.data)]
        : combined.map(c => c.data);
      evObj.clipBlob = new Blob(blobParts, { type: videoMimeType || 'video/webm' });
    }
  }, EVENT_POST_MS + VIDEO_TIMESLICE_MS * 2);
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

  // New shot events
  for (const shot of newShots) {
    onShotDetected(shot);
  }
}

function onShotDetected(shot) {
  const isMake = shot.classification === 'MAKE';
  const type   = shot.basket_type ?? '';

  if (isMake) sessionMakes++;
  sessionTotal++;
  updateActiveScoreboard();

  const sensorSnap = snapshotSensorWindow();

  const ev = {
    shot,
    clipBlob:  null,   // filled asynchronously by scheduleClipExtraction
    mimeType:  videoMimeType,
    label:     isMake ? (type || 'MAKE') : 'MISS',  // default = AI prediction
    sensorSnap,
    timestamp: Date.now(),
  };

  sessionEvents.push(ev);

  // Schedule timestamp-accurate clip capture (pre + post window)
  if (videoEnabled) {
    scheduleClipExtraction(ev);
  }

  if (isMake) {
    setActiveEvent(type === 'SWISH' ? '🏀 SWISH!' : '🏀 Made!', '#2ecc71');
    speak(type === 'SWISH' ? 'Swish' : 'Made');
  } else {
    setActiveEvent('❌ Miss', '#e74c3c');
    speak('Miss');
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

function wireReviewScreen() {
  document.getElementById('review-skip-btn')?.addEventListener('click', () => {
    reviewIndex++;
    if (reviewIndex >= sessionEvents.length) {
      startUpload();
    } else {
      renderReviewCard();
    }
  });
}

function renderReviewCard() {
  const total    = sessionEvents.length;
  const event    = sessionEvents[reviewIndex];
  const shot     = event.shot;
  const isMake   = shot.classification === 'MAKE';

  // Progress indicator
  setEl('review-progress', `${reviewIndex + 1} / ${total}`);

  // AI prediction banner
  const predEl = document.getElementById('review-prediction');
  if (predEl) {
    const icon = isMake ? (shot.basket_type === 'SWISH' ? '🏀' : '✅') : '❌';
    predEl.textContent  = `AI: ${icon} ${shot.classification}${shot.basket_type ? ' — ' + shot.basket_type : ''}`;
    predEl.style.color  = isMake ? '#2ecc71' : '#e74c3c';
  }

  // Video clip
  const videoEl = document.getElementById('review-video');
  if (videoEl) {
    if (event.clipBlob) {
      videoEl.src   = URL.createObjectURL(event.clipBlob);
      videoEl.style.display = '';
      videoEl.load();
      videoEl.play().catch(() => {});
    } else {
      videoEl.style.display = 'none';
    }
  }

  // Label buttons — build dynamically
  const btnsContainer = document.getElementById('review-label-btns');
  if (btnsContainer) {
    btnsContainer.innerHTML = '';
    LABEL_OPTIONS.forEach(opt => {
      const btn = document.createElement('button');
      btn.className   = 'label-btn';
      btn.textContent = `${opt.icon} ${opt.label}`;
      btn.classList.toggle('selected', event.label === opt.key);
      btn.addEventListener('click', () => {
        event.label = opt.key;
        // Advance
        reviewIndex++;
        if (reviewIndex >= sessionEvents.length) {
          startUpload();
        } else {
          renderReviewCard();
        }
      });
      btnsContainer.appendChild(btn);
    });
  }

  // Confirm button (uses current AI label)
  const confirmBtn = document.getElementById('review-confirm-btn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      // Keep current label (already set to AI prediction by default)
      reviewIndex++;
      if (reviewIndex >= sessionEvents.length) {
        startUpload();
      } else {
        renderReviewCard();
      }
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

  // Steps: 1 CSV + N shots (+ optional N clips)
  const clipSteps   = uploadVideoEnabled ? sessionEvents.length : 0;
  const totalSteps  = 1 + sessionEvents.length + clipSteps;
  let   doneSteps   = 0;
  const shotIds     = [];

  const progressEl = document.getElementById('upload-progress');
  const statusEl   = document.getElementById('upload-status');

  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  const updateBar = () => {
    if (progressEl) progressEl.style.width = `${Math.round(doneSteps / totalSteps * 100)}%`;
  };

  setStatus('Generating session data…');

  // ── 1. Upload full-session CSV ────────────────────────────────────────────
  try {
    setStatus('Uploading session CSV…');
    const csvBlob = generateSessionCsv();
    await uploadSessionCsv(uid, sessionId, csvBlob);
  } catch (e) {
    console.warn('CSV upload failed:', e);
  }
  doneSteps++;
  updateBar();

  // ── 2. Upload per-shot clips + save shot documents ────────────────────────
  for (let i = 0; i < sessionEvents.length; i++) {
    const ev  = sessionEvents[i];
    let videoUrl = null;

    // Upload video clip (if enabled and available)
    if (uploadVideoEnabled && ev.clipBlob) {
      try {
        setStatus(`Uploading clip ${i + 1} / ${sessionEvents.length}…`);
        videoUrl = await uploadClip(uid, sessionId, i, ev.clipBlob, ev.mimeType);
      } catch (e) {
        console.warn('Clip upload failed:', e);
      }
      doneSteps++;
      updateBar();
    }

    // Save shot document
    try {
      setStatus(`Saving shot ${i + 1} / ${sessionEvents.length}…`);
      const id = await saveShot({
        userId:        uid,
        sessionId,
        timestamp:     ev.timestamp,
        ai_prediction: ev.shot.classification,
        basket_type:   ev.shot.basket_type ?? null,
        user_label:    ev.label,
        confidence:    ev.shot.confidence ?? 0,
        video_url:     videoUrl,
      });
      shotIds.push(id);
    } catch (e) {
      console.warn('Shot save failed:', e);
    }

    doneSteps++;
    updateBar();
    setStatus(`Saved shot ${doneSteps} / ${sessionEvents.length}`);
  }

  // ── 3. Save session summary ───────────────────────────────────────────────
  const makes  = sessionEvents.filter(e => e.label !== 'MISS' && e.label !== 'FALSE_ALARM').length;
  const total  = sessionEvents.filter(e => e.label !== 'FALSE_ALARM').length;
  const durSec = Math.round(((sessionEnd ?? performance.now()) - sessionStart) / 1000);

  try {
    await saveSession(uid, sessionId, { makes, total, durationSec: durSec, shotIds });
  } catch (e) {
    console.warn('Session save failed:', e);
  }

  // Free session sensor data from memory
  allSensorData = [];

  setStatus('✅ Upload complete!');
  if (progressEl) progressEl.style.width = '100%';

  // Show summary
  setEl('upload-summary', `Session: ${makes} / ${total} shots · ${durSec}s`);
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
    'MPU_Timestamp (ms)', 'AcX (g)', 'AcY (g)', 'AcZ (g)',
    'GyX (dps)', 'GyY (dps)', 'GyZ (dps)',
    'TOF_Timestamp (ms)', 'Range (mm)', 'Signal_Rate',
  ].join(',');

  const rows = allSensorData.map(s => [
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
    const [sessions, allShots] = await Promise.all([
      fetchSessions(user.uid, 20),
      fetchAllShots(user.uid),
    ]);

    renderLifetimeStats(allShots);
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

function renderLifetimeStats(shots) {
  const makes = shots.filter(s => s.user_label !== 'MISS' && s.user_label !== 'FALSE_ALARM').length;
  const total = shots.filter(s => s.user_label !== 'FALSE_ALARM').length;
  const pct   = total > 0 ? Math.round(makes / total * 100) : 0;
  setEl('stat-total',  total);
  setEl('stat-makes',  makes);
  setEl('stat-pct',    `${pct}%`);
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

  for (const s of sessions) {
    const d    = s.createdAt?.toDate?.() ?? new Date(s.createdAt?.seconds * 1000 ?? 0);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const pct  = s.total > 0 ? Math.round(s.makes / s.total * 100) : 0;
    const dur  = s.durationSec ? `${Math.floor(s.durationSec / 60)}′${String(s.durationSec % 60).padStart(2,'0')}″` : '';

    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-date">${date} <span class="session-time">${time}</span></div>
      <div class="session-stats">
        <span class="session-makes">${s.makes} / ${s.total}</span>
        <span class="session-pct" style="color:${pct >= 50 ? '#2ecc71' : '#e74c3c'}">${pct}%</span>
        ${dur ? `<span class="session-dur">${dur}</span>` : ''}
      </div>`;
    listEl.appendChild(item);
  }
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
    setEl('ota-update-status', `Error: ${e.message}`);
    showToast(`OTA failed: ${e.message}`, 'error');
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
