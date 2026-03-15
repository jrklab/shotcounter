'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
export const VIDEO_TIMESLICE_MS  = 200;    // chunk interval for frequent keyframes
export const VIDEO_BITRATE       = 500_000; // 500 kbps
export const SENSOR_WINDOW_SLOTS = 400;    // max samples in rolling window (~2 s)
export const EVENT_PRE_MS        = 1500;   // ms before event for review window
export const EVENT_POST_MS       = 2000;   // ms after event for review window

// ── App revision — increment here when releasing a new web app version ────────
export const APP_REVISION = 'v0.1.10';

// ── Beta detection — prefix session IDs when served from the beta app ─────────
// Checks the full URL so "beta" is matched anywhere (hostname, path, etc.).
// localhost is also treated as beta (dev/test traffic).
export const IS_BETA = (() => {
  const url = window.location.href;
  return url.includes('localhost') || url.includes('beta');
})();

// ── Shared mutable state ──────────────────────────────────────────────────────
// All screen modules import and mutate this object directly (S.foo = ...).
export const S = {
  // ── Auth ───────────────────────────────────────────────────────────────────
  user:         null,
  activeScreen: null,

  // ── Session ────────────────────────────────────────────────────────────────
  sessionId:      null,
  sessionStart:   null,   // performance.now() ms when practice starts
  sessionEnd:     null,   // performance.now() ms when practice stops
  sessionMakes:   0,
  sessionTotal:   0,

  // ── Battery (mV, read from sensor packets) ──────────────────────────────────
  battStartMv:  null,   // first non-zero battery reading of the session
  battEndMv:    null,   // most-recent battery reading  lastBattMv:   null,   // most-recent battery reading (any time, for Device Info page)
  lastTempC:    null,   // most-recent temperature reading (any time)
  // ── BLE packet loss counter ─────────────────────────────────────────────────
  totalLostPackets: 0,  // accumulated from parser.parse() lostPackets across session

  // ── Raw BLE packet log (Task 4) ─────────────────────────────────────────────
  // Each entry: { hostMs: performance.now(), buffer: ArrayBuffer (336 bytes) }
  allRawPackets: [],

  // ── Recording timestamps ────────────────────────────────────────────────────
  recordingStartGlobalMs: 0,  // Date.now() when recording started (wall clock)

  /** @type {{ shot, ai_top, ai_subtype, user_top, user_subtype,
   *            device_event_ts, host_event_ts_s, video_clip_ts,
   *            timestamp, host_ts, comment, source, event_type }[]} */
  sessionEvents:  [],
  reviewIndex:    0,

  // ── Sensor ─────────────────────────────────────────────────────────────────
  sensorWindow:  [],    // rolling ~2 s window
  allSensorData: [],    // full-session log for CSV (freed after upload)

  // ── Video ──────────────────────────────────────────────────────────────────
  mediaStream:        null,
  mediaRecorder:      null,
  allVideoChunks:     [],
  videoMimeType:      'video/webm',
  videoEnabled:       false,
  recordingStartMs:   0,
  videoSessionBlob:   null,
  videoSessionUrl:    null,
  uploadVideoEnabled: false,
  _clipStopListener:  null,

  // ── BLE / device ───────────────────────────────────────────────────────────
  isBleConnected: false,
  deviceHwVer:    '–',
  deviceFwVer:    '–',

  // ── Audio ──────────────────────────────────────────────────────────────────
  audioCtx:    null,
  keepAliveEl: null,

  // ── OTA ────────────────────────────────────────────────────────────────────
  ota: null,

  // ── History chart ──────────────────────────────────────────────────────────
  historyChart: null,
};
