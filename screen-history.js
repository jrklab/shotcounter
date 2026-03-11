'use strict';

import { fetchSessions }            from './db.js';
import { S }                        from './state.js';
import { showScreen, setEl, showToast } from './utils.js';

// ── Wire screen ───────────────────────────────────────────────────────────────
export function wireHistoryScreen() {
  document.getElementById('history-back-btn')?.addEventListener('click', () => showScreen('dashboard'));
}

// ── Load and render ───────────────────────────────────────────────────────────
export async function loadHistory() {
  if (!S.user) return;
  const loadingEl = document.getElementById('history-loading');
  const contentEl = document.getElementById('history-content');
  if (loadingEl) loadingEl.style.display = '';
  if (contentEl) contentEl.style.display = 'none';

  try {
    const sessions = await fetchSessions(S.user.uid, 10);

    renderLifetimeStats(sessions);
    renderTrendChart(sessions.slice().reverse());   // oldest first for chart
    renderSessionList(sessions);

    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) { contentEl.style.display = 'flex'; contentEl.style.flexDirection = 'column'; contentEl.style.gap = '16px'; }
  } catch (e) {
    console.error('History load failed:', e);
    showToast('Failed to load history.', 'error');
    if (loadingEl) loadingEl.textContent = 'Failed to load — check your connection.';
  }
}

// ── Lifetime stats (uses AI scores — Feature 14) ──────────────────────────────
function renderLifetimeStats(sessions) {
  let aiMakes = 0, aiTotal = 0;
  for (const s of sessions) {
    aiMakes += s.ai_makes ?? s.makes ?? 0;
    aiTotal += s.ai_total ?? s.total ?? 0;
  }
  const pct = aiTotal > 0 ? Math.round(aiMakes / aiTotal * 100) : 0;
  setEl('stat-total', aiTotal);
  setEl('stat-makes', aiMakes);
  setEl('stat-pct',   `${pct}%`);
}

// ── Trend chart ───────────────────────────────────────────────────────────────
function renderTrendChart(sessions) {
  const ctx = document.getElementById('trend-chart');
  if (!ctx || !window.Chart) return;

  const labels = sessions.map(s => {
    const d = s.createdAt?.toDate?.() ?? new Date(s.createdAt?.seconds * 1000 ?? 0);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const data = sessions.map(s => s.total > 0 ? Math.round(s.makes / s.total * 100) : 0);

  if (S.historyChart) S.historyChart.destroy();

  S.historyChart = new window.Chart(ctx, {
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
        y: { min: 0, max: 100, ticks: { color: '#667', callback: v => `${v}%` }, grid: { color: '#1e2736' } },
        x: { ticks: { color: '#667', maxTicksLimit: 8 }, grid: { color: '#1e2736' } },
      },
    },
  });
}

// ── Session list table ────────────────────────────────────────────────────────
function renderSessionList(sessions) {
  const listEl = document.getElementById('session-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!sessions.length) {
    listEl.innerHTML = '<p style="color:#445566;text-align:center;padding:20px">No sessions yet — go practice!</p>';
    return;
  }

  // Header row
  const hdr = document.createElement('div');
  hdr.className = 'session-item session-hdr';
  hdr.innerHTML = '<div class="sh-date">Date</div><div class="sh-dur">Dur</div>' +
                  '<div class="sh-score">User</div><div class="sh-score">AI</div>';
  listEl.appendChild(hdr);

  let totDur = 0, totUM = 0, totUT = 0, totAM = 0, totAT = 0;

  for (const s of sessions) {
    const d    = s.createdAt?.toDate?.() ?? new Date((s.createdAt?.seconds ?? 0) * 1000);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const uM = s.makes    ?? 0;
    const uT = s.total    ?? 0;
    const aM = s.ai_makes ?? uM;
    const aT = s.ai_total ?? uT;
    const uP = uT > 0 ? Math.round(uM / uT * 100) : 0;
    const aP = aT > 0 ? Math.round(aM / aT * 100) : 0;
    const dur = s.durationSec ? Math.round(s.durationSec / 60) : 0;
    totDur += dur; totUM += uM; totUT += uT; totAM += aM; totAT += aT;

    const row = document.createElement('div');
    row.className = 'session-item';
    row.innerHTML =
      `<div class="sh-date">${date}<br><span class="session-time">${time}</span></div>` +
      `<div class="sh-dur">${dur}m</div>` +
      `<div class="sh-score"><b>${uM}/${uT}</b><br><span style="color:${uP >= 50 ? '#2ecc71' : '#e74c3c'}">${uP}%</span></div>` +
      `<div class="sh-score"><b>${aM}/${aT}</b><br><span style="color:${aP >= 50 ? '#2ecc71' : '#e74c3c'}">${aP}%</span></div>`;
    listEl.appendChild(row);
  }

  // Totals row
  const tUP = totUT > 0 ? Math.round(totUM / totUT * 100) : 0;
  const tAP = totAT > 0 ? Math.round(totAM / totAT * 100) : 0;
  const tot = document.createElement('div');
  tot.className = 'session-item session-totals';
  tot.innerHTML =
    `<div class="sh-date"><b>Total</b></div>` +
    `<div class="sh-dur"><b>${totDur}m</b></div>` +
    `<div class="sh-score"><b>${totUM}/${totUT}</b><br><span style="color:${tUP >= 50 ? '#2ecc71' : '#e74c3c'}">${tUP}%</span></div>` +
    `<div class="sh-score"><b>${totAM}/${totAT}</b><br><span style="color:${tAP >= 50 ? '#2ecc71' : '#e74c3c'}">${tAP}%</span></div>`;
  listEl.appendChild(tot);
}
