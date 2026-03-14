'use strict';

/**
 * app.js — Entry point.
 * Wires all screens together and boots the auth listener.
 *
 * Screen modules:
 *   screen-auth.js    — login / registration
 *   screen-setup.js   — BLE + camera pairing gate
 *   screen-active.js  — live practice session
 *   screen-review.js  — shot label review carousel
 *   screen-upload.js  — upload progress + data export
 *   screen-history.js — analytics: lifetime stats + trend chart + session list
 *   screen-ota.js     — OTA firmware update
 *
 * Shared modules:
 *   state.js  — single mutable S object (all screen state)
 *   utils.js  — showScreen, setEl, showToast, speak, initAudio
 */

import { wireAuthScreen, startAuthListener }    from './screen-auth.js';
import { wirePracticeSetup, resetPracticeSetup } from './screen-setup.js';
import { wirePracticeActive, ble }              from './screen-active.js';
import { wireReviewScreen }                     from './screen-review.js';
import { wireHistoryScreen, loadHistory }       from './screen-history.js';
import { wireOtaScreen, loadOtaScreen }         from './screen-ota.js';
import { showScreen, showToast }                from './utils.js';
import { S, APP_REVISION }                      from './state.js';
import { signOut }                              from './auth.js';

document.addEventListener('DOMContentLoaded', () => {
  // Wire all screens
  wireAuthScreen();
  wirePracticeSetup();
  wirePracticeActive();
  wireReviewScreen();
  wireHistoryScreen();
  wireOtaScreen();

  // Dashboard navigation
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
    if (S.isBleConnected) ble.disconnect();
    await signOut();
  });

  // Stamp app version
  const verEl = document.getElementById('app-version');
  if (verEl) verEl.textContent = APP_REVISION;

  // Start auth listener — handles showScreen('dashboard') / showScreen('auth')
  startAuthListener();

  if (!navigator.bluetooth) showToast('⚠️ Web Bluetooth not supported in this browser.', 'warn');
});
