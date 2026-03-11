'use strict';

import { S } from './state.js';

// ── Screen router ─────────────────────────────────────────────────────────────
export function showScreen(name) {
  document.querySelectorAll('[data-screen]').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === name);
  });
  S.activeScreen = name;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
export function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

let toastTimer = null;
export function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className   = `toast show toast-${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── Audio / speech ────────────────────────────────────────────────────────────
export function initAudio() {
  if (S.audioCtx && S.audioCtx.state !== 'closed') {
    if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
    return;
  }
  S.audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
  const dest  = S.audioCtx.createMediaStreamDestination();
  const osc   = S.audioCtx.createOscillator();
  const gain  = S.audioCtx.createGain();
  gain.gain.value = 0.001;   // inaudible — keeps OS audio session alive
  osc.connect(gain);
  gain.connect(dest);
  gain.connect(S.audioCtx.destination);
  osc.start();
  S.keepAliveEl           = new Audio();
  S.keepAliveEl.srcObject = dest.stream;
  S.keepAliveEl.play().catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: '🏀 Basketball Tracker' });
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }
}

export function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 1.1;
  utt.volume = 1;
  window.speechSynthesis.speak(utt);
}

// Re-acquire wake lock when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.audioCtx?.state === 'suspended') S.audioCtx.resume();
});
