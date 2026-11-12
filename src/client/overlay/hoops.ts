// src/client/overlay/hoops.ts — the basketball half of the overlay: scorebug bar
// (fouls, bonus, timeouts, possession) and the nba-hub live court beneath it.

import type { BasketballGameView, Side, TeamView } from '../../shared/basketball.ts';
import { renderLive, resetLive, stopLive } from '../basketball/live.ts';
import { esc, logoSrc, periodShort, setHtml } from '../basketball/ui.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let courtFor = '';

function paintTeam(side: Side, t: TeamView, v: BasketballGameView): void {
  const name = side === 0 ? 'away' : 'home';
  const src = logoSrc(t);
  const holder = $(`logo-${name}`);
  if (setHtml(holder, src ? `<img class="bug-logo" src="${esc(src)}" alt="" onerror="this.parentNode.dataset.broken='1'">` : '')) delete holder.dataset.broken;
  holder.style.display = src ? '' : 'none';
  const ab = $(`ab-${name}`); if (ab.textContent !== t.abbr) ab.textContent = t.abbr;
  const rk = $(`rank-${name}`); const rank = t.rank ? String(t.rank) : ''; if (rk.textContent !== rank) rk.textContent = rank;
  const sc = $(`score-${name}`); const s = String(t.score);
  if (sc.textContent !== s) { sc.textContent = s; if (v.state === 'in') { sc.classList.remove('flash'); void sc.offsetWidth; sc.classList.add('flash'); } }
  document.documentElement.style.setProperty(`--${name}`, t.color || (side === 1 ? '#8c2a2a' : '#3a5a8c'));
  // Timeouts: the server's count from ESPN's situation feed; nothing when unknown.
  const left = t.timeoutsLeft;
  const total = v.league === 'nba' ? 7 : v.league === 'wnba' ? 4 : 4;
  const html = v.state === 'in' && left != null ? Array.from({ length: Math.min(total, 7) }, (_, i) => `<i class="${i < left ? '' : 'used'}"></i>`).join('') : '';
  setHtml($(`to-${name}`), html);
  $(`poss-${name}`).classList.toggle('on', v.state === 'in' && v.possession === side);
}

export function paintHoops(v: BasketballGameView, brk: string): void {
  paintTeam(0, v.teams[0]!, v); paintTeam(1, v.teams[1]!, v);
  const per = $('period'), clk = $('clock'), dd = $('dd');
  if (v.state === 'pre') { per.textContent = ''; clk.textContent = tip(v.tipoff); setHtml(dd, esc(v.broadcast)); }
  else if (v.state === 'post' || v.state === 'postponed') { per.textContent = ''; clk.textContent = v.state === 'postponed' ? 'POSTPONED' : (v.period > v.regPeriods ? `FINAL/${periodShort(v, v.period)}` : 'FINAL'); setHtml(dd, ''); }
  else if (brk) { per.textContent = ''; clk.textContent = brk; setHtml(dd, ''); }
  else {
    const p = periodShort(v, v.period); if (per.textContent !== p) per.textContent = p;
    if (clk.textContent !== v.clock) clk.textContent = v.clock;
    // Fouls and bonus for both sides, compact: "DET 4 · BONUS  CIN 2"
    const f = (s: Side): string => { const t = v.teams[s]!; return `<b>${esc(t.abbr)}</b> ${t.fouls}${t.bonus === 'double' ? ' <b>2×</b>' : t.bonus === 'bonus' ? ' <b>BONUS</b>' : ''}`; };
    setHtml(dd, `${f(0)} &nbsp; ${f(1)}`);
  }

  const hoops = $('hoops');
  if (v.state !== 'in') { if (hoops.style.display !== 'none') { stopLive(); hoops.style.display = 'none'; } return; }
  hoops.style.display = '';
  const key = `${v.eventId}|${v.teams[0]!.id}|${v.teams[1]!.id}`;
  if (courtFor !== key) { resetLive(); courtFor = key; }
  try { renderLive(v); } catch (e) { console.error('renderLive', e); }
}

export function hoopsBreak(v: BasketballGameView): string {
  const d = v.detail.toUpperCase();
  if (/HALF/.test(d) && !/\d:\d\d|\d\.\d/.test(d)) return 'HALFTIME';
  if (/^END/.test(d)) return `END OF ${periodShort(v, v.period).toUpperCase()}`;
  if (/DELAY/.test(d)) return 'DELAYED';
  return '';
}

function tip(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Pregame card content. */
export function hoopsPregame(v: BasketballGameView): string {
  const rec = (t: TeamView): string => (t.record ? `${t.abbr} ${t.record}` : '');
  const when = v.tipoff ? new Date(v.tipoff).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return `<div><div class="pg-k">TIPOFF</div><div class="pg-v">${esc(when)}</div></div>` +
    `<div class="pg-meta">${esc([v.venue, v.city].filter(Boolean).join(' · '))}</div>` +
    `<div class="pg-meta">${esc(rec(v.teams[0]!))}${rec(v.teams[1]!) ? `&nbsp;&nbsp;${esc(rec(v.teams[1]!))}` : ''}</div>`;
}

export function hoopsFinal(v: BasketballGameView): string {
  const [a, h] = v.teams;
  const w = h!.score > a!.score ? h! : a!.score > h!.score ? a! : null;
  const top = v.performers[0];
  return `<div><div class="pg-k">${w ? 'WINNER' : 'FINAL'}</div><div class="pg-v">${w ? esc(w.name) : 'Tie'}</div></div>` +
    (top ? `<div class="pg-meta">${esc(top.name)} · ${esc(top.line)}</div>` : '');
}
