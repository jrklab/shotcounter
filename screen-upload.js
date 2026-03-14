'use strict';

import { saveShot, saveSession,
         uploadSensorBin, uploadSessionJson,
         uploadSessionVideo }                        from './db.js';
import { loadSessionVideo, deleteSessionVideo }      from './video-store.js';
import { S, APP_REVISION }                          from './state.js';
import { showScreen, setEl }                        from './utils.js';
import { Timestamp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// ── Upload orchestrator ───────────────────────────────────────────────────────
export async function startUpload() {
  showScreen('practice-upload');
  const uid = S.user?.uid;
  if (!uid) { showScreen('dashboard'); return; }

  // Steps: 1 sensor.bin + 1 labels JSON + N shots + optional 1 session video
  const videoSteps = S.uploadVideoEnabled ? 1 : 0;
  const totalSteps = 2 + S.sessionEvents.length + videoSteps;
  let   doneSteps  = 0;
  const shotIds    = [];

  const progressEl = document.getElementById('upload-progress');
  const statusEl   = document.getElementById('upload-status');
  const setStatus  = msg => { if (statusEl) statusEl.textContent = msg; };
  const updateBar  = ()  => {
    if (progressEl) progressEl.style.width = `${Math.round(doneSteps / totalSteps * 100)}%`;
  };

  setStatus('Generating session data…');

  // ── Compute session stats ─────────────────────────────────────────────────
  const userMakes = S.sessionEvents.filter(e => e.user_top === 'Make').length;
  const userTotal = S.sessionEvents.filter(e => e.user_top !== 'Not-a-shot').length;
  const aiMakes   = S.sessionEvents.filter(e => e.ai_top  === 'Make').length;
  const aiTotal   = S.sessionEvents.filter(e => e.ai_top  !== 'Not-a-shot').length;
  const durSec    = Math.round(((S.sessionEnd ?? performance.now()) - S.sessionStart) / 1000);

  // ── 1. Upload raw sensor binary ──────────────────────────────────────────
  const lossPct = S.totalLostPackets > 0
    ? parseFloat((S.totalLostPackets / (S.allRawPackets.length + S.totalLostPackets) * 100).toFixed(2))
    : 0;
  let sensorDataUrl = null;
  try {
    setStatus('Uploading sensor data…');
    const binBlob = generateSensorBin();
    sensorDataUrl = await uploadSensorBin(uid, S.sessionId, binBlob);
  } catch (e) { console.warn('Sensor bin upload failed:', e); }
  doneSteps++; updateBar();

  // ── 2. Upload session labels JSON ─────────────────────────────────────────
  try {
    setStatus('Uploading session labels JSON…');
    await uploadSessionJson(uid, S.sessionId, generateSessionJson());
  } catch (e) { console.warn('Labels JSON upload failed:', e); }
  doneSteps++; updateBar();

  // ── 3. Save shot documents ────────────────────────────────────────────────
  for (let i = 0; i < S.sessionEvents.length; i++) {
    const ev = S.sessionEvents[i];
    const source = (ev.user_top === ev.ai_top && ev.user_subtype === ev.ai_subtype)
      ? 'auto' : 'manual';
    try {
      setStatus(`Saving shot ${i + 1} / ${S.sessionEvents.length}…`);
      const id = await saveShot({
        userId:          uid,
        sessionId:       S.sessionId,
        createdAt:       Timestamp.now(),
        ai_top:          ev.ai_top,
        ai_subtype:      ev.ai_subtype,
        confidence:      ev.shot.confidence ?? 0,
        user_top:        ev.user_top,
        user_subtype:    ev.user_subtype,
        comment:         ev.comment ?? '',
        source,
        event_type:      ev.event_type,
        device_event_ts: ev.device_event_ts,
        host_event_ts:   ev.host_event_ts_s,
        video_clip_ts:   ev.video_clip_ts ?? null,
        video_clip_url:  null,
      });
      shotIds.push(id);
    } catch (e) { console.warn('Shot save failed:', e); }
    doneSteps++; updateBar();
  }

  // ── 4. Upload session video (if enabled) ──────────────────────────────────
  let sessionVideoUrl = null;
  if (S.uploadVideoEnabled) {
    let blob = S.videoSessionBlob;
    if (!blob) { try { blob = await loadSessionVideo(S.sessionId); } catch (_) {} }
    if (blob) {
      try {
        setStatus('Uploading session video…');
        sessionVideoUrl = await uploadSessionVideo(uid, S.sessionId, blob, S.videoMimeType);
        deleteSessionVideo(S.sessionId).catch(() => {});
      } catch (e) {
        console.warn('Session video upload failed:', e);
        setStatus('⚠️ Video upload failed — data saved.');
      }
    } else {
      setStatus('⚠️ No video data found — skipping video upload.');
    }
    doneSteps++; updateBar();
  }

  // ── 5. Save session document to Firestore ──────────────────────────────────
  try {
    await saveSession(uid, S.sessionId, {
      userId:    uid,
      sessionId: S.sessionId,
      Device_Meta: {
        Manufacturer_Name: window.deviceMeta?.manufacturer ?? '',
        Model_Number:      window.deviceMeta?.model        ?? '',
        Hardware_Revision: window.deviceMeta?.hwRevision   ?? '',
        Firmware_Revision: window.deviceMeta?.fwRevision   ?? '',
        'System_ID (MAC)': window.deviceMeta?.systemId     ?? '',
        Battery_Start_mV:  S.battStartMv ?? 0,
        Battery_End_mV:    S.battEndMv   ?? 0,
      },
      Client_Meta: {
        App_Revision:        APP_REVISION,
        User_Agent:          navigator.userAgent,
        BLE_Packet_Loss_Pct: lossPct,
      },
      Practice_Meta: {
        ai_accuracy:   aiTotal  > 0 ? parseFloat((aiMakes  / aiTotal  * 100).toFixed(1)) : 0,
        ai_makes:      aiMakes,
        ai_total:      aiTotal,
        user_accuracy: userTotal > 0 ? parseFloat((userMakes / userTotal * 100).toFixed(1)) : 0,
        user_makes:    userMakes,
        user_total:    userTotal,
        createdAt:     Timestamp.now(),
        durationSec:   durSec,
      },
      createdAt:                 Timestamp.now(),
      sensor_data_url:           sensorDataUrl,
      recording_start_global_ms: S.recordingStartGlobalMs,
      recording_start_s:         S.recordingStartMs / 1000,
      video_url:                 sessionVideoUrl,
      shotIds,
    });
  } catch (e) { console.warn('Session save failed:', e); }

  // Free memory
  S.allSensorData = [];
  S.allRawPackets = [];

  setStatus('✅ Upload complete!');
  if (progressEl) progressEl.style.width = '100%';

  const uPct = userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0;
  const aPct = aiTotal   > 0 ? Math.round(aiMakes   / aiTotal   * 100) : 0;
  setEl('upload-summary', `User: ${userMakes}/${userTotal} (${uPct}%) · AI: ${aiMakes}/${aiTotal} · ${durSec}s`);

  const doneBtn = document.getElementById('upload-done-btn');
  if (doneBtn) doneBtn.style.display = '';
  doneBtn?.addEventListener('click', () => showScreen('dashboard'), { once: true });
}

// ── Binary sensor export ─────────────────────────────────────────────────────
function generateSensorBin() {
  const RECORD_SIZE = 8 + 336; // float64 hostMs + 336-byte raw BLE packet
  const buf = new ArrayBuffer(S.allRawPackets.length * RECORD_SIZE);
  const dv  = new DataView(buf);
  const u8  = new Uint8Array(buf);
  S.allRawPackets.forEach(({ hostMs, buffer }, i) => {
    const offset = i * RECORD_SIZE;
    dv.setFloat64(offset, hostMs, true); // little-endian float64
    u8.set(new Uint8Array(buffer), offset + 8);
  });
  return new Blob([buf], { type: 'application/octet-stream' });
}

// ── Session labels JSON export ────────────────────────────────────────────────
function generateSessionJson() {
  const output = {};
  S.sessionEvents.forEach((ev, idx) => {
    const source = (ev.user_top === ev.ai_top && ev.user_subtype === ev.ai_subtype)
      ? 'auto' : 'manual';
    output[idx] = {
      ai_top:        ev.ai_top,
      ai_subtype:    ev.ai_subtype,
      user_top:      ev.user_top,
      user_subtype:  ev.user_subtype,
      comment:       ev.comment ?? '',          // Feature 16
      source,
      event_type:      ev.event_type,
      device_event_ts: ev.device_event_ts,
      host_event_ts:   ev.host_event_ts_s,
      video_clip_ts: ev.video_clip_ts ?? null,
    };
  });
  return new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
}
