'use strict';

import { OtaUpdater }                  from './ota-ble.js';
import { S, APP_REVISION }             from './state.js';
import { showScreen, setEl, showToast } from './utils.js';
import { ble }                         from './screen-active.js';

// ── BLE connect button state ──────────────────────────────────────────────────
function refreshDeviceInfo() {
  const meta = window.deviceMeta;
  setEl('di-info-manufacturer', meta?.manufacturer || '–');
  setEl('di-info-model',        meta?.model        || '–');
  setEl('di-info-hw',           meta?.hwRevision   || '–');
  setEl('di-info-fw',           meta?.fwRevision   || S.deviceFwVer || '–');
  setEl('di-info-mac',          meta?.systemId     || '–');
  setEl('di-info-app',          APP_REVISION);
  setEl('di-info-batt', S.lastBattMv ? `${(S.lastBattMv / 1000).toFixed(2)} V` : '–');
  setEl('di-info-temp', S.lastTempC  != null ? `${S.lastTempC.toFixed(1)} °C` : '–');
}

function refreshBleRow() {
  const btn   = document.getElementById('di-ble-btn');
  const state = document.getElementById('di-ble-state');
  if (!btn || !state) return;
  if (S.isBleConnected) {
    btn.textContent = 'Disconnect';
    btn.className   = 'btn btn-red btn-sm';
    state.textContent = '✅ Connected';
    state.classList.add('ok');
    // Refresh device info fields now that meta is available
    refreshDeviceInfo();
  } else {
    btn.textContent = 'Connect';
    btn.className   = 'btn btn-blue btn-sm';
    state.textContent = '⛕ Not connected';
    state.classList.remove('ok');
  }
}
// Expose so onBleStatus (screen-active.js) can call it when the DI page is open
window._updateOtaBleStatus = refreshBleRow;
// Expose so onBlePacket (screen-active.js) can push live batt/temp to DI page
window._updateOtaReadings  = refreshDeviceInfo;

// ── Wire screen ───────────────────────────────────────────────────────────────
export function wireOtaScreen() {
  document.getElementById('ota-back-btn')?.addEventListener('click', () => {
    if (S.isBleConnected) ble.disconnect();
    showScreen('dashboard');
  });
  document.getElementById('ota-check-btn')?.addEventListener('click', loadOtaScreen);
  document.getElementById('ota-update-btn')?.addEventListener('click', runOtaUpdate);
  document.getElementById('di-baseline-btn')?.addEventListener('click', computeBaseline);
  document.getElementById('di-ble-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('di-ble-btn');
    if (S.isBleConnected) {
      ble.disconnect();
    } else {
      if (btn) btn.disabled = true;
      try { await ble.connect(); } catch (_) {}
      if (btn) btn.disabled = false;
    }
  });
}

// ── Load / check latest version ───────────────────────────────────────────────
export async function loadOtaScreen() {
  // Sync BLE row immediately
  refreshBleRow();

  // ── Populate static device info ─────────────────────────────────────────
  refreshDeviceInfo();

  // ── Firmware version check ────────────────────────────────────────────────
  setEl('ota-device-version', S.deviceFwVer || '–');
  setEl('ota-latest-version', 'Checking…');
  setEl('ota-update-status', '');
  const updateBtn = document.getElementById('ota-update-btn');
  if (updateBtn) updateBtn.disabled = true;

  S.ota = new OtaUpdater(
    (pct, msg) => {
      const bar = document.getElementById('ota-progress-bar');
      if (bar) bar.style.width = `${pct}%`;
      setEl('ota-update-status', msg);
    },
    (msg) => { setEl('ota-update-status', msg); console.log('[OTA]', msg); },
  );

  try {
    const info = await S.ota.fetchLatestRelease();
    setEl('ota-latest-version', `v${info.version} (${(info.size / 1024).toFixed(0)} KB)`);
    if (updateBtn) updateBtn.disabled = false;
  } catch (e) {
    setEl('ota-latest-version', 'Failed to check');
    setEl('ota-update-status', `Error: ${e.message}`);
  }
}

// ── Flash firmware ────────────────────────────────────────────────────────────
async function runOtaUpdate() {
  if (!S.ota) return;
  const updateBtn = document.getElementById('ota-update-btn');
  const bar       = document.getElementById('ota-progress-bar');
  if (updateBtn) updateBtn.disabled = true;
  if (bar)       bar.style.width    = '0%';

  try {
    await S.ota.downloadFirmware();
    // Disconnect sensor BLE before OTA takes over
    if (S.isBleConnected) ble.disconnect();
    await S.ota.connect();
    const success = await S.ota.flash();
    if (success) showToast('Firmware updated successfully!', 'success');
    else         showToast('OTA sent — check device for status.', 'warn');
  } catch (e) {
    const isGattDisconnect = /gatt|network error|disconnect/i.test(e.message ?? '');
    if (isGattDisconnect && S.ota?._endSent) {
      setEl('ota-update-status', '✅ Device rebooted — OTA successful!');
      showToast('Firmware updated! Device is rebooting.', 'success');
    } else {
      setEl('ota-update-status', `Error: ${e.message}`);
      showToast(`OTA failed: ${e.message}`, 'error');
    }
  } finally {
    S.ota.disconnect();
  }
}

// ── Sensor baseline ───────────────────────────────────────────────────────────────
function computeBaseline() {
  const el = document.getElementById('di-baseline-result');
  if (!el) return;

  const allSamples = S.sensorWindow;
  const MPU_WINDOW = 400;   // 2 s at 200 Hz
  const MIN_MPU    = 10;
  const MIN_TOF    = 5;

  if (!allSamples || allSamples.length < MIN_MPU) {
    el.innerHTML = '<span class="di-baseline-warn">⚠️ Connect device and wait for sensor data (need ≥10 samples).</span>';
    return;
  }

  const win = allSamples.slice(-MPU_WINDOW);
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const acX = avg(win.map(s => s.accel?.[0] ?? 0));
  const acY = avg(win.map(s => s.accel?.[1] ?? 0));
  const acZ = avg(win.map(s => s.accel?.[2] ?? 0));
  const gyX = avg(win.map(s => s.gyro?.[0]  ?? 0));
  const gyY = avg(win.map(s => s.gyro?.[1]  ?? 0));
  const gyZ = avg(win.map(s => s.gyro?.[2]  ?? 0));

  // Identify ToF-paired samples (0xFFFE = no slot assigned by firmware)
  // All paired samples are included regardless of distance value — only signal rate is needed
  const tofSamples  = win.filter(s => s.distance !== 0xFFFE);
  const hasToF      = tofSamples.length >= MIN_TOF;
  // signal_rate is 9.7 fixed-point: divide by 128 to convert to MCPS, removed 1/128 to make it consistent
  const signalRate  = hasToF ? avg(tofSamples.map(s => s.signal_rate)) : null;

  const mpuLabel = `Accel (g) — ${win.length} samples`;
  const tofLabel = hasToF ? `ToF Signal Rate — ${tofSamples.length} samples` : 'ToF Signal Rate';

  el.innerHTML = `
    <table class="di-baseline-table">
      <thead><tr><th>${mpuLabel}</th><th>Gyro (°/s)</th></tr></thead>
      <tbody>
        <tr><td>X: ${acX.toFixed(4)}</td><td>X: ${gyX.toFixed(4)}</td></tr>
        <tr><td>Y: ${acY.toFixed(4)}</td><td>Y: ${gyY.toFixed(4)}</td></tr>
        <tr><td>Z: ${acZ.toFixed(4)}</td><td>Z: ${gyZ.toFixed(4)}</td></tr>
      </tbody>
      <thead><tr><th colspan="2">${tofLabel}</th></tr></thead>
      <tbody>
        ${hasToF
          ? `<tr><td colspan="2">${signalRate.toFixed(3)}</td></tr>`
          : `<tr><td colspan="2" class="di-baseline-warn">No valid ToF data</td></tr>`
        }
      </tbody>
    </table>`;
}
