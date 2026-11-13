// src/client/overlay/hoops.ts — the basketball half of the overlay: scorebug bar
// (fouls, bonus, timeouts, possession) and the nba-hub live court beneath it.

import type { BasketballGameView, Side, TeamView } from '../../shared/basketball.ts';
import { markSeen, onRerender, onShotLanded, pendingPoints, renderLive, resetLive, setCamera, stopLive } from '../basketball/live.ts';
import { esc, inks, logoSrc, periodShort, setHtml } from '../basketball/ui.ts';
import { barLogo, gameDate, pregameStatus, setInner, setOutcome, setRecord, setScore } from './bar.ts';
import { finalCard, pregameCard, type CardGame, type CardTeam } from './cards.ts';
import { clock } from './clock.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let courtFor = '';
// Half court by default: at overlay size the attacked end is where the action is; the camera follows possession.
const cam = new URLSearchParams(location.search).get('cam') === 'full' ? 'full' : 'half';
setCamera(cam);

/** live.ts calls back when a flight ends or a shot reaches the rim; the shell repaints. */
export function hoopsInit(repaint: () => void): void { onRerender(repaint); onShotLanded(repaint); }
/** The page was hidden: mark everything seen so returning shows NOW, not a replay of what was missed. */
export function hoopsResync(v: BasketballGameView): void { markSeen(v); }

/** Identity and the per-poll facts that don't wait on an animation. */
function paintTeam(side: Side, t: TeamView, v: BasketballGameView): void {
  const name = side === 0 ? 'away' : 'home';
  barLogo($(`logo-${name}`), logoSrc(t));
  const ab = $(`ab-${name}`); if (ab.textContent !== t.abbr) ab.textContent = t.abbr;
  const rk = $(`rank-${name}`); const rank = t.rank ? String(t.rank) : ''; if (rk.textContent !== rank) rk.textContent = rank;
  document.documentElement.style.setProperty(`--${name}`, inks(v)[side] || t.color || (side === 1 ? '#8c2a2a' : '#3a5a8c'));
  // Timeouts: the server's count from ESPN's situation feed; nothing when unknown.
  const left = t.timeoutsLeft;
  const total = v.league === 'nba' ? 7 : 4;
  setInner($(`to-${name}`), v.state === 'in' && left != null ? Array.from({ length: total }, (_, i) => `<i class="${i < left ? '' : 'used'}"></i>`).join('') : '');
  $(`poss-${name}`).classList.toggle('on', v.state === 'in' && v.possession === side);
}

// The score in the bar lands with the ball: a made shot's points are held while its flight is
// queued or in the air (live.ts pendingPoints), and count the moment it reaches the rim. It is
// always server score − pending, so it cannot drift, and never steps down unless the server's
// own score did (a correction).
let shownScore: [number | null, number | null] = [null, null];
function paintScores(v: BasketballGameView, live: boolean, flashOk: boolean): void {
  setOutcome(v.teams[0]!.score, v.teams[1]!.score, v.state === 'post');
  if (v.state === 'pre') { setRecord($('score-away'), v.teams[0]!.record); setRecord($('score-home'), v.teams[1]!.record); shownScore = [null, null]; return; }
  const pend = live ? pendingPoints() : [0, 0];
  for (const side of [0, 1] as const) {
    const truth = v.teams[side]!.score;
    const prev = shownScore[side];
    const val = prev == null || truth < prev ? truth : Math.max(prev, truth - pend[side]!);
    setScore($(`score-${side === 0 ? 'away' : 'home'}`), val, flashOk && live && prev != null && val > prev);
    shownScore[side] = val;
  }
}

export function paintHoops(v: BasketballGameView, brk: string, revealed: boolean): void {
  const live = v.state === 'in';
  paintTeam(0, v.teams[0]!, v); paintTeam(1, v.teams[1]!, v);
  const per = $('period'), dd = $('dd');
  const setPer = (s: string): void => { if (per.textContent !== s) per.textContent = s; };
  if (v.state === 'pre') { const st = pregameStatus(v.tipoff, v.broadcast, 'Tipoff'); setPer(''); clock.show(st.main); setInner(dd, esc(st.sub)); }
  else if (!live) { setPer(''); clock.show(v.state === 'postponed' ? 'POSTPONED' : (v.period > v.regPeriods ? `FINAL/${periodShort(v, v.period)}` : 'FINAL')); setInner(dd, esc(gameDate(v.tipoff))); }
  else if (brk) { setPer(''); clock.show(brk); setInner(dd, ''); }
  else {
    setPer(periodShort(v, v.period));
    clock.run(v.clock, `${v.eventId}|${v.period}`);
    // Fouls and bonus for both sides, compact: "UVU 5  UTU 7 BONUS"
    const f = (s: Side): string => { const t = v.teams[s]!; return `<b>${esc(t.abbr)}</b> ${t.fouls}${t.bonus === 'double' ? ' <b>2×</b>' : t.bonus === 'bonus' ? ' <b>BONUS</b>' : ''}`; };
    setInner(dd, `${f(0)} &nbsp; ${f(1)}`);
  }

  const hoops = $('hoops');
  const was = hoops.style.display !== 'none';
  if (!live) {
    if (was) { stopLive(); hoops.style.display = 'none'; }
    shownScore = [null, null];
    paintScores(v, false, false);
    return;
  }
  if (!was) { hoops.style.display = ''; if (revealed) { hoops.classList.remove('pane-in'); void hoops.offsetWidth; hoops.classList.add('pane-in'); } }
  const key = `${v.eventId}|${v.teams[0]!.id}|${v.teams[1]!.id}`;
  if (courtFor !== key) { resetLive(); courtFor = key; shownScore = [null, null]; }
  try { renderLive(v); } catch (e) { console.error('renderLive', e); }      // queues this poll's shots first…
  paintScores(v, true, revealed);                                              // …so their points are pending here
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

/** A basketball view as the shared pregame/final cards read it. */
function cardGame(v: BasketballGameView): CardGame {
  const team = (t: TeamView, side: Side): CardTeam => {
    const top = v.performers.find((p) => p.side === side);
    return {
      abbr: t.abbr, name: t.name || t.short || t.abbr, rank: t.rank, record: t.record,
      splits: [[side === 1 ? 'Home' : 'Away', t.split.replace(/^(home|away|road)\s+/i, '')], ['Conf', t.confRecord]],
      streak: t.streak, last5: t.last5.map((g) => g.won),
      score: t.score, lines: t.linescores, leader: top ? { name: top.name, line: top.line } : null,
      color: inks(v)[side] || t.color,
    };
  };
  return { away: team(v.teams[0]!, 0), home: team(v.teams[1]!, 1), venue: v.venue, city: v.city, regPeriods: v.regPeriods };
}

export const hoopsPregame = (v: BasketballGameView): string => pregameCard(cardGame(v));
export const hoopsFinal = (v: BasketballGameView): string => finalCard(cardGame(v));
