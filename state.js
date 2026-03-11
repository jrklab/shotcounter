'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
export const VIDEO_TIMESLICE_MS  = 200;    // chunk interval for frequent keyframes
export const VIDEO_BITRATE       = 500_000; // 500 kbps
export const SENSOR_WINDOW_SLOTS = 400;    // max samples in rolling window (~2 s)
export const EVENT_PRE_MS        = 1500;   // ms before event for review window
export const EVENT_POST_MS       = 2000;   // ms after event for review window

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

  /** @type {{ shot, ai_top, ai_subtype, user_top, user_subtype,
   *            video_clip_ts, timestamp, host_ts, hostEventTs, comment }[]} */
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
