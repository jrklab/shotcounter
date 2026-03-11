'use strict';

import { S, EVENT_PRE_MS, EVENT_POST_MS } from './state.js';
import { setEl, speak, showScreen }       from './utils.js';
import { loadSessionVideo }               from './video-store.js';
import { startUpload }                    from './screen-upload.js';

// ── Enter review screen ───────────────────────────────────────────────────────
export async function showReviewScreen() {
  showScreen('practice-review');

  const videoEl = document.getElementById('review-video');
  if (!videoEl) { renderReviewCard(); return; }

  // Try IndexedDB first, fall back to in-RAM blob
  let blob = null;
  try { blob = await loadSessionVideo(S.sessionId); } catch (e) { console.warn('IndexedDB load failed:', e); }
  blob = blob ?? S.videoSessionBlob;

  if (blob) {
    if (S.videoSessionUrl) URL.revokeObjectURL(S.videoSessionUrl);
    S.videoSessionUrl  = URL.createObjectURL(blob);
    videoEl.src        = S.videoSessionUrl;
    videoEl.load();
    videoEl.style.display = '';
  } else {
    videoEl.style.display = 'none';
  }

  renderReviewCard();
}

// ── Wire buttons ──────────────────────────────────────────────────────────────
export function wireReviewScreen() {
  document.getElementById('review-back-btn')?.addEventListener('click', () => {
    if (S.reviewIndex > 0) { S.reviewIndex--; renderReviewCard(); }
  });
}

// ── Render one review card ────────────────────────────────────────────────────
export function renderReviewCard(announcement = null) {
  const total = S.sessionEvents.length;
  const event = S.sessionEvents[S.reviewIndex];

  setEl('review-progress', `${S.reviewIndex + 1} / ${total}`);

  const backBtn = document.getElementById('review-back-btn');
  if (backBtn) backBtn.disabled = (S.reviewIndex === 0);

  // AI prediction banner
  const predEl = document.getElementById('review-prediction');
  if (predEl) {
    const icon = event.ai_top === 'Make' ? '🏀' : (event.ai_top === 'Miss' ? '❌' : '🔇');
    predEl.textContent = `AI: ${icon} ${event.ai_top}${event.ai_subtype ? ' — ' + event.ai_subtype : ''}`;
    predEl.style.color = event.ai_top === 'Make' ? '#2ecc71'
                       : event.ai_top === 'Miss' ? '#e74c3c' : '#888888';
  }
  speak(announcement ?? (event.ai_top === 'Make' ? (event.ai_subtype ?? 'Make') : event.ai_top));

  // ── Video clip — seek and loop within the event window ────────────────────
  const videoEl = document.getElementById('review-video');
  if (videoEl && S.videoSessionUrl) {
    const seekSec = Math.max(0, (event.hostEventTs - EVENT_PRE_MS) / 1000);
    const endSec  = seekSec + (EVENT_PRE_MS + EVENT_POST_MS) / 1000;

    if (S._clipStopListener) {
      videoEl.removeEventListener('timeupdate', S._clipStopListener);
      S._clipStopListener = null;
    }
    S._clipStopListener = () => {
      if (videoEl.currentTime >= endSec) {
        videoEl.currentTime = seekSec;
        videoEl.play().catch(() => {});
      }
    };
    videoEl.addEventListener('timeupdate', S._clipStopListener);

    const doSeek = () => { videoEl.currentTime = seekSec; videoEl.play().catch(() => {}); };
    if (videoEl.readyState >= 1) doSeek();
    else videoEl.addEventListener('loadedmetadata', doSeek, { once: true });
  }

  // ── Top-class buttons: Make | Miss | Not-a-shot ───────────────────────────
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
          else if (!event.user_subtype) event.user_subtype = 'Rim-in';
          renderReviewCard(`Correction, ${top}`);
        });
        topContainer.appendChild(btn);
      });
  }

  // ── Subtype buttons: Swish | Rim-in | Unsure — greyed unless Make ─────────
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

  // ── Comment field (Feature 16) ────────────────────────────────────────────
  const commentEl = document.getElementById('review-comment');
  if (commentEl) {
    commentEl.value  = event.comment ?? '';
    commentEl.oninput = () => { event.comment = commentEl.value; };
  }

  // ── Confirm — advance to next card or trigger upload ─────────────────────
  const confirmBtn = document.getElementById('review-confirm-btn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      S.reviewIndex++;
      if (S.reviewIndex >= S.sessionEvents.length) startUpload();
      else renderReviewCard();
    };
  }
}
