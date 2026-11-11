// src/client/overlay/main.ts — the OBS browser-source overlay.
//
//   /overlay?league=cfb&team=ALA            the team's current game (today, else yesterday's late game)
//   /overlay?league=nfl&event=401873272     a specific game
//   &pos=bl|br|tl|tr|bc|tc  (default bl)    &scale=0.6..1.6 (default 1)
//
// Polls /api/game and paints only what changed (no flicker — Joe's standing
// rule). Score/period/clock are never blank once a view has landed: the server
// holds them through feed outages and says so via view.mode, which this surface
// shows as a quiet pip plus two words, never a wall.

import type { FootballGameView, TeamView } from '../../shared/types.ts';
import {
  buildFieldStatics, escapeHtml, fieldInputs, fitEzNames, isAdminPlay, lastPlays, logoSrc, renderFieldViz,
  renderPlayBanner, resetField, setHtml, setTimeoutsFromView, tidyPlayText, timeoutsFor,
} from '../football/field.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const q = new URLSearchParams(location.search);
const league = (q.get('league') ?? '').toLowerCase();
const team = q.get('team') ?? '';
let eventId = q.get('event') ?? '';
const pos = q.get('pos') ?? 'bl';
const scale = Math.min(1.6, Math.max(0.5, Number(q.get('scale') ?? 1) || 1));

document.body.className = `pos-${/^(bl|br|tl|tr|bc|tc)$/.test(pos) ? pos : 'bl'}`;
document.documentElement.style.setProperty('--s', String(scale));

// ── state ────────────────────────────────────────────────────────────────
let view: FootballGameView | null = null;
let fieldBuilt = false;
let fieldFor = '';
let timer: number | null = null;
let lastPlayKey = '';
let backoff = 0;

// ── setup card ───────────────────────────────────────────────────────────
function setup(msg: string): void {
  const s = $('setup');
  s.innerHTML = `<h1>scorebug</h1><p>${msg}</p>` +
    `<p>Add this page as an OBS browser source at 1920×1080 with a URL like:</p>` +
    `<p><code>${escapeHtml(location.origin)}/overlay?league=cfb&amp;team=ALA</code></p>` +
    `<p><code>${escapeHtml(location.origin)}/overlay?league=nfl&amp;team=NO&amp;pos=br&amp;scale=0.8</code></p>`;
  s.style.display = '';
  $('bug').style.display = 'none';
}

// ── period labels ────────────────────────────────────────────────────────
function periodLabel(p: number): string {
  if (p <= 0) return '';
  if (p <= 4) return ['1st', '2nd', '3rd', '4th'][p - 1]!;
  return p === 5 ? 'OT' : `${p - 4}OT`;
}

function breakLabel(v: FootballGameView): string {
  const n = v.statusName.toUpperCase();
  const zero = /^0?0:00$/.test(v.clock.trim());
  if (n === 'STATUS_HALFTIME' || (zero && v.period === 2)) return 'HALFTIME';
  if (n === 'STATUS_END_PERIOD' || (zero && (v.period === 1 || v.period === 3))) return `END OF ${periodLabel(v.period).toUpperCase()}`;
  if (/DELAY/.test(n)) return 'DELAYED';
  if (/SUSPEND/.test(n)) return 'SUSPENDED';
  return '';
}

// ── painting ─────────────────────────────────────────────────────────────
function paintTeam(side: 'home' | 'away', t: TeamView, v: FootballGameView): void {
  // In the bar the abbreviation sits beside the logo, so a missing logo collapses to nothing.
  const src = logoSrc(t);
  const holder = $(`logo-${side}`);
  if (setHtml(holder, src ? `<img class="bug-logo" src="${src}" alt="" onerror="this.parentNode.dataset.broken='1'">` : '')) delete holder.dataset.broken;
  holder.style.display = src ? '' : 'none';
  const ab = $(`ab-${side}`); if (ab.textContent !== t.abbr) ab.textContent = t.abbr;
  const rk = $(`rank-${side}`); const rank = t.rank ? String(t.rank) : ''; if (rk.textContent !== rank) rk.textContent = rank;
  const sc = $(`score-${side}`); const s = String(t.score);
  if (sc.textContent !== s) { sc.textContent = s; if (v.phase === 'in' && view) { sc.classList.remove('flash'); void sc.offsetWidth; sc.classList.add('flash'); } }
  document.documentElement.style.setProperty(`--${side}`, t.color || (side === 'home' ? '#8c2a2a' : '#3a5a8c'));
  // Timeouts: three bars (one per OT); the server's count, else the play-text counter.
  const { summary, g } = fieldInputs(v);
  const to = timeoutsFor(summary, g);
  const left = to ? (side === 'home' ? to.home : to.away) : null;
  const total = v.period >= 5 ? 1 : 3;
  const html = v.phase === 'in' && left != null ? Array.from({ length: total }, (_, i) => `<i class="${i < left ? '' : 'used'}"></i>`).join('') : '';
  setHtml($(`to-${side}`), html);
}

function paint(v: FootballGameView): void {
  const bug = $('bug'); bug.style.display = '';
  $('setup').style.display = 'none';
  const brk = v.phase === 'in' ? breakLabel(v) : '';
  bug.classList.toggle('live', v.phase === 'in');
  bug.classList.toggle('break', !!brk);
  bug.classList.remove('mode-full', 'mode-floor', 'mode-held');
  bug.classList.add(`mode-${v.mode}`);

  paintTeam('away', v.away, v); paintTeam('home', v.home, v);

  // status cell
  const per = $('period'), clk = $('clock'), dd = $('dd'), deg = $('degraded');
  if (v.phase === 'pre') {
    per.textContent = ''; clk.textContent = kickoffShort(v.date); dd.textContent = v.broadcasts.find((b) => b.isNational)?.name ?? v.broadcasts[0]?.name ?? '';
  } else if (v.phase === 'post') {
    per.textContent = ''; clk.textContent = v.period > 4 ? `FINAL/${periodLabel(v.period)}` : 'FINAL'; dd.textContent = '';
  } else if (brk) {
    per.textContent = ''; clk.textContent = brk; dd.textContent = '';
  } else {
    const p = periodLabel(v.period); if (per.textContent !== p) per.textContent = p;
    if (clk.textContent !== v.clock) clk.textContent = v.clock;
    const sit = v.situation;
    const ddHtml = sit?.ddText ? `<b>${escapeHtml(sit.ddText)}</b>${sit.possText ? ` at ${escapeHtml(sit.possText)}` : ''}` : '';
    setHtml(dd, ddHtml);
  }
  // Possession arrows
  $('poss-away').classList.toggle('on', v.phase === 'in' && !brk && !!v.situation?.possIsAway);
  $('poss-home').classList.toggle('on', v.phase === 'in' && !brk && !!v.situation?.possIsHome);
  // Degraded note: two words, from the feed state.
  const age = Math.round((Date.now() - Math.max(v.stamps.score.at, v.stamps.clock.at, v.stamps.plays.at)) / 1000);
  deg.textContent = v.mode === 'floor' ? 'scores only' : v.mode === 'held' ? `reconnecting · ${age}s` : '';

  // panes by phase
  $('fieldwrap').style.display = v.phase === 'in' ? '' : 'none';
  $('last-play').style.display = 'none';
  $('pregame').style.display = v.phase === 'pre' ? '' : 'none';
  $('final').style.display = v.phase === 'post' ? '' : 'none';

  if (v.phase === 'pre') {
    setHtml($('pregame'), `<div><div class="pg-k">KICKOFF</div><div class="pg-v" id="kick-clock">${escapeHtml(kickoffLong(v.date))}</div></div>` +
      `<div class="pg-meta">${escapeHtml([v.venue?.name, v.venue?.city && v.venue?.state ? `${v.venue.city}, ${v.venue.state}` : ''].filter(Boolean).join(' · '))}</div>` +
      `<div class="pg-meta">${escapeHtml(v.away.record ? `${v.away.abbr} ${v.away.record}` : '')}${v.home.record ? `&nbsp;&nbsp;${escapeHtml(`${v.home.abbr} ${v.home.record}`)}` : ''}</div>`);
    return;
  }
  if (v.phase === 'post') {
    const w = v.home.score > v.away.score ? v.home : v.away.score > v.home.score ? v.away : null;
    const last = v.scoringPlays[v.scoringPlays.length - 1];
    setHtml($('final'), `<div><div class="pg-k">${w ? 'WINNER' : 'FINAL'}</div><div class="pg-v">${w ? escapeHtml(w.short || w.abbr) : 'Tie'}</div></div>` +
      (last ? `<div class="pg-meta">${escapeHtml(tidyPlayText(last.text))}</div>` : ''));
    return;
  }

  // live: field + last play
  const { summary, g, sit } = fieldInputs(v);
  setTimeoutsFromView(v);
  const key = `${v.eventId}|${v.home.id}|${v.away.id}`;
  if (!fieldBuilt || fieldFor !== key) {
    resetField();
    buildFieldStatics(g as any);
    fieldBuilt = true; fieldFor = key;
    fitEzNames();
    try { (document as any).fonts?.ready?.then(fitEzNames); } catch { /* no-op */ }
  }
  const fb = $('field-break'), fbl = $('field-break-label');
  fb.style.display = brk ? 'flex' : 'none';
  if (brk) fbl.textContent = brk;
  if (!brk) {
    try { renderFieldViz(summary, g as any, sit as any); } catch (e) { console.error('renderFieldViz', e); }
    try { renderPlayBanner(summary, g as any); } catch (e) { console.error('renderPlayBanner', e); }
  } else { $('penalty-pill').className = 'play-banner'; }

  // last play (always a real play; admin events ride above it)
  const lp = $('last-play');
  const { last, lastReal } = lastPlays(summary);
  const realText = tidyPlayText(lastReal?.text ? String(lastReal.text) : (sit?.lastPlayText || ''));
  if (realText && !brk) {
    const title = String(lastReal?.type?.text || 'Last play');
    const adminNow = last && isAdminPlay(last) ? String(last?.type?.text || '') : '';
    const changed = setHtml(lp,
      (adminNow ? `<div class="lp-event"><span class="lp-event-dot"></span>${escapeHtml(adminNow)}</div>` : '') +
      `<div class="lp-head"><span class="lp-title">${escapeHtml(title)}</span></div>${escapeHtml(realText)}`);
    lp.style.display = '';
    const pk = String(lastReal?.id ?? '');
    if (changed && pk !== lastPlayKey) { lp.classList.remove('fresh'); void lp.offsetWidth; lp.classList.add('fresh'); lastPlayKey = pk; }
  }
}

function kickoffShort(iso: string): string {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function kickoffLong(iso: string): string {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  const ms = d.getTime() - Date.now();
  if (ms > 0 && ms < 24 * 3600_000) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ── polling ──────────────────────────────────────────────────────────────
function delayFor(v: FootballGameView | null): number {
  if (!v) return 5000;
  if (v.phase === 'in') return v.mode === 'full' ? 4000 : 3000;
  if (v.phase === 'pre') { const ms = new Date(v.date).getTime() - Date.now(); return ms < 10 * 60_000 ? 5000 : 30_000; }
  return 60_000;
}

async function load(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const qs = new URLSearchParams(q);          // every knob forwards (the replay harness reads fail/speed/start)
  qs.set('league', league);
  if (eventId) qs.set('event', eventId); else qs.set('team', team);
  try {
    const res = await fetch(`/api/game?${qs}`, { cache: 'no-store' });
    if (res.status === 404) { setup(`Nothing on today's ${league.toUpperCase()} slate for <code>${escapeHtml(team)}</code>. Check the abbreviation (ESPN's, e.g. ALA, LSU, NO, KC).`); timer = window.setTimeout(load, 60_000); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as FootballGameView;
    eventId = next.eventId;
    backoff = 0;
    view = next;
    paint(next);
  } catch (err) {
    console.warn('[overlay] load failed', err);
    backoff = Math.min(backoff + 1, 5);
    if (view) { view = { ...view, mode: 'held' }; paint(view); }   // the server is unreachable: hold what we have, say so
    else setup('The scorebug service is not answering yet. Retrying.');
  }
  timer = window.setTimeout(load, view ? delayFor(view) * (backoff ? 1 + backoff : 1) : 5000 * (1 + backoff));
}

// 1 Hz kickoff countdown without a server round-trip.
window.setInterval(() => { if (view?.phase === 'pre') { const el = document.getElementById('kick-clock'); if (el) el.textContent = kickoffLong(view.date); } }, 1000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });

if (!/^(nfl|cfb)$/.test(league) || (!team && !eventId)) setup('Add <code>?league=cfb|nfl</code> and either <code>&amp;team=ABBR</code> or <code>&amp;event=ID</code>.');
else void load();

export {};
