'use strict';

import { OtaUpdater }             from './ota-ble.js';
import { S }                      from './state.js';
import { showScreen, setEl, showToast } from './utils.js';

// ── Wire screen ───────────────────────────────────────────────────────────────
export function wireOtaScreen() {
  document.getElementById('ota-back-btn')?.addEventListener('click', () => showScreen('dashboard'));
  document.getElementById('ota-check-btn')?.addEventListener('click', loadOtaScreen);
  document.getElementById('ota-update-btn')?.addEventListener('click', runOtaUpdate);
}

// ── Load / check latest version ───────────────────────────────────────────────
export async function loadOtaScreen() {
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
