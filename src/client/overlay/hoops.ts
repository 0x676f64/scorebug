// src/client/overlay/hoops.ts — the basketball half of the overlay: scorebug bar
// (fouls, bonus, timeouts, possession) and the nba-hub live court beneath it.

import type { BasketballGameView, Side, TeamView } from '../../shared/basketball.ts';
import { renderLive, resetLive, setCamera, stopLive } from '../basketball/live.ts';
import { esc, inks, logoSrc, periodShort, setHtml } from '../basketball/ui.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let courtFor = '';
// Half court by default: at overlay size the attacked end is where the action is; the camera follows possession.
const cam = new URLSearchParams(location.search).get('cam') === 'full' ? 'full' : 'half';
setCamera(cam);

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
  document.documentElement.style.setProperty(`--${name}`, inks(v)[side] || t.color || (side === 1 ? '#8c2a2a' : '#3a5a8c'));
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
  paintBreak(v, brk);
}

/**
 * The break the game is in, or ''. Two independent signals, so a lagging feed can't hide it:
 *   - ESPN's status detail ("Halftime", "End of 1st", "End 3rd")
 *   - the play feed's own End Period marker being the newest meaningful play
 * It ends the moment the status period moves on or a play from a later period arrives.
 */
export function hoopsBreak(v: BasketballGameView): string {
  if (v.state !== 'in') return '';
  const d = v.detail.toUpperCase();
  if (/DELAY/.test(d)) return 'DELAYED';
  const fromDetail = (/HALF/.test(d) && !/\d:\d\d|\d\.\d/.test(d)) || /^END\b/.test(d);
  const end = v.last && v.last.kind === 'period' && !/FINAL/i.test(v.last.label) ? v.last : null;
  const newest = v.plays?.[v.plays.length - 1];
  const fromPlays = !!end && v.period <= end.period && (!newest || newest.period <= end.period);
  if (!fromDetail && !fromPlays) return '';
  const ended = fromPlays ? end!.period : v.period;      // the period that just finished
  const half = v.regPeriods / 2;                         // 2 for quarters, 1 for halves
  if (ended === half) return 'HALFTIME';
  if (ended === v.regPeriods) return 'END OF REGULATION';
  return `END OF ${periodShort(v, ended)}`;
}

/** What comes after the break, for the banner's second line. */
function nextUp(v: BasketballGameView, brk: string): string {
  if (brk === 'HALFTIME') return v.regPeriods === 2 ? '2nd half next' : '3rd quarter next';
  if (brk === 'END OF REGULATION') return 'Overtime next';
  const m = brk.match(/^END OF (Q|H)(\d)$/);
  if (m) return `${['', '1st', '2nd', '3rd', '4th'][Number(m[2]) + 1] ?? ''} ${m[1] === 'Q' ? 'quarter' : 'half'} next`.trim();
  if (/OT$/.test(brk)) return 'Another overtime next';
  return '';
}

let breakShown = '';
function paintBreak(v: BasketballGameView, brk: string): void {
  const el = $('court-break');
  if (!brk) { if (breakShown) { el.hidden = true; breakShown = ''; } return; }
  const [a, h] = v.teams;
  const lead = a!.score === h!.score ? `Tied at ${a!.score}` : (a!.score > h!.score ? `${a!.abbr} by ${a!.score - h!.score}` : `${h!.abbr} by ${h!.score - a!.score}`);
  setHtml($('court-break-label'), esc(brk));
  setHtml($('court-break-sub'), esc([lead, nextUp(v, brk)].filter(Boolean).join('  ·  ')));
  if (breakShown !== brk) { el.hidden = false; el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); breakShown = brk; }
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
