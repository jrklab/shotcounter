'use strict';

import { saveShot, saveSession,
         uploadSessionCsv, uploadSessionJson,
         uploadSessionVideo, uploadPracticeSummary } from './db.js';
import { loadSessionVideo, deleteSessionVideo }      from './video-store.js';
import { S }                                         from './state.js';
import { showScreen, setEl }                         from './utils.js';

// ── Upload orchestrator ───────────────────────────────────────────────────────
export async function startUpload() {
  showScreen('practice-upload');
  const uid = S.user?.uid;
  if (!uid) { showScreen('dashboard'); return; }

  // Steps: 1 CSV + 1 JSON + 1 Summary + N shots + optional 1 session video
  const videoSteps = S.uploadVideoEnabled ? 1 : 0;
  const totalSteps = 3 + S.sessionEvents.length + videoSteps;
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

  // ── 1. Upload session CSV ─────────────────────────────────────────────────
  try {
    setStatus('Uploading session CSV…');
    await uploadSessionCsv(uid, S.sessionId, generateSessionCsv());
  } catch (e) { console.warn('CSV upload failed:', e); }
  doneSteps++; updateBar();

  // ── 2. Upload session labels JSON ─────────────────────────────────────────
  try {
    setStatus('Uploading session labels JSON…');
    await uploadSessionJson(uid, S.sessionId, generateSessionJson());
  } catch (e) { console.warn('Labels JSON upload failed:', e); }
  doneSteps++; updateBar();

  // ── 3. Upload practice summary JSON ──────────────────────────────────────
  try {
    setStatus('Uploading practice summary…');
    const summary = {
      session_id:    S.sessionId,
      duration_sec:  durSec,
      user_makes:    userMakes,
      user_total:    userTotal,
      user_accuracy: userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0,
      ai_makes:      aiMakes,
      ai_total:      aiTotal,
      ai_accuracy:   aiTotal  > 0 ? Math.round(aiMakes  / aiTotal  * 100) : 0,
    };
    const summaryBlob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    await uploadPracticeSummary(uid, S.sessionId, summaryBlob);
  } catch (e) { console.warn('Practice summary upload failed:', e); }
  doneSteps++; updateBar();

  // ── 4. Save shot documents ────────────────────────────────────────────────
  for (let i = 0; i < S.sessionEvents.length; i++) {
    const ev = S.sessionEvents[i];
    try {
      setStatus(`Saving shot ${i + 1} / ${S.sessionEvents.length}…`);
      const id = await saveShot({
        userId:        uid,
        sessionId:     S.sessionId,
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
    } catch (e) { console.warn('Shot save failed:', e); }
    doneSteps++; updateBar();
  }

  // ── 5. Upload session video (if enabled) ──────────────────────────────────
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

  // ── 6. Save session summary to Firestore ──────────────────────────────────
  try {
    await saveSession(uid, S.sessionId, {
      makes: userMakes, total: userTotal,
      ai_makes: aiMakes, ai_total: aiTotal,
      durationSec: durSec, shotIds, video_url: sessionVideoUrl,
    });
  } catch (e) { console.warn('Session save failed:', e); }

  S.allSensorData = [];   // free memory

  setStatus('✅ Upload complete!');
  if (progressEl) progressEl.style.width = '100%';

  const uPct = userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0;
  const aPct = aiTotal   > 0 ? Math.round(aiMakes   / aiTotal   * 100) : 0;
  setEl('upload-summary', `User: ${userMakes}/${userTotal} (${uPct}%) · AI: ${aiMakes}/${aiTotal} · ${durSec}s`);

  const doneBtn = document.getElementById('upload-done-btn');
  if (doneBtn) doneBtn.style.display = '';
  doneBtn?.addEventListener('click', () => showScreen('dashboard'), { once: true });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function generateSessionCsv() {
  const header = [
    'Host_Timestamp (ms)',
    'MPU_Timestamp (ms)', 'AcX (g)', 'AcY (g)', 'AcZ (g)',
    'GyX (dps)', 'GyY (dps)', 'GyZ (dps)',
    'TOF_Timestamp (ms)', 'Range (mm)', 'Signal_Rate',
  ].join(',');

  const rows = S.allSensorData.map(s => [
    (s.host_ts  ?? 0).toFixed(3),
    s.mpu_ts ?? 0,
    (s.accel[0] ?? 0).toFixed(6), (s.accel[1] ?? 0).toFixed(6), (s.accel[2] ?? 0).toFixed(6),
    (s.gyro[0]  ?? 0).toFixed(4), (s.gyro[1]  ?? 0).toFixed(4), (s.gyro[2]  ?? 0).toFixed(4),
    s.tof_ts ?? 0, s.distance ?? 0, s.signal_rate ?? 0,
  ].join(','));

  return new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
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
      row_idx:       idx,
      event_ts_s:    ev.shot.basket_time ?? ev.shot.impact_time ?? 0,
      event_type:    ev.ai_top === 'Make' ? 'basket' : 'impact',
      host_ts_udp:   (ev.host_ts ?? 0) / 1000.0,
      video_clip_ts: ev.video_clip_ts ?? null,
    };
  });
  return new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
}
