// src/client/overlay/main.ts — the OBS browser-source overlay.
//
//   /overlay?league=cfb&team=ALA            the team's current game (today, else yesterday's late game)
//   /overlay?league=nfl&event=401873272     a specific game
//   &pos=bl|br|tl|tr|bc|tc  (default bl)    &scale=0.5..1.6 (default 1)    basketball: &cam=half|full
//
// VIEWING RULES (the Nov 12 gameplay audit):
//   1. Nothing repaints unless its content changed (setHtml / textContent compares). No blink.
//   2. Nothing moves unless the game did: every slot in the bundle has a fixed size, so a longer
//      play text, a new down-and-distance or a banner never shifts the bar or the field.
//   3. An animation is never cut. The field engine redraws a play's static end state on every
//      call, so a play in flight is not re-rendered until its chain has finished.
//   4. The result arrives with the ball: score, down & distance, possession and the last-play
//      text are held until the play's animation lands (football) / the shot goes in (basketball).
//   5. The clock counts down between polls, easing toward the last value the server gave and
//      never past it — it cannot run during a stoppage and never steps backwards.
//   6. One poll chain, ever; a hidden page slows down and resyncs when it is seen again instead
//      of replaying what it missed.
//   7. Score/period/clock are never blank once a view has landed; feed trouble is a pip and two
//      words (view.mode), never a wall.

import type { FootballGameView, TeamView } from '../../shared/types.ts';
import type { BasketballGameView } from '../../shared/basketball.ts';
import { hoopsBreak, hoopsFinal, hoopsInit, hoopsPregame, hoopsResync, paintHoops } from './hoops.ts';
import {
  buildFieldStatics, escapeHtml, fieldInputs, fitEzNames, isAdminPlay, lastChain, lastPlays, logoHtml, logoSrc, playKeyOf, railColorOf,
  renderFieldViz, renderPlayBanner, resetField, setHtml, setOnScoreLanded, setTimeoutsFromView, tidyPlayText, timeoutsFor,
  type NormTeam,
} from '../football/field.ts';
import { clock } from './clock.ts';
import { barLogo, setScore } from './bar.ts';

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
type AnyView = FootballGameView | BasketballGameView;
let view: AnyView | null = null;
let fieldBuilt = false;
let fieldFor = '';
let lastPlayKey = '';

/** How long after the ball stops the field may be redrawn (the pin and yardage chip pop in over this). */
const FIELD_SETTLE_MS = 800;
/** The result (score, down & distance, last play) lands this long after the ball. */
const REVEAL_AFTER_MS = 150;

// ── setup card ───────────────────────────────────────────────────────────
function setup(msg: string): void {
  const s = $('setup');
  s.innerHTML = `<h1>scorebug</h1><p>${msg}</p>` +
    `<p>Add this page as an OBS browser source at 1920×1080 with a URL like:</p>` +
    `<p><code>${escapeHtml(location.origin)}/overlay?league=cfb&amp;team=ALA</code></p>` +
    `<p><code>${escapeHtml(location.origin)}/overlay?league=nba&amp;team=ATL&amp;pos=br&amp;scale=0.8</code></p>`;
  s.style.display = '';
  $('bug').style.display = 'none';
}

// ── entrance: one reveal, after the fonts are in, so nothing reflows on screen ──
let revealed = false;
function reveal(): void {
  if (revealed) return;
  revealed = true;
  const show = (): void => { $('bug').classList.add('ready'); fitEzNames(); };
  const fonts: Promise<unknown> | undefined = (document as any).fonts?.ready;
  if (!fonts) { show(); return; }
  let done = false;
  const once = (): void => { if (!done) { done = true; show(); } };
  fonts.then(once, once);
  window.setTimeout(once, 1500);       // a blocked font host must not hold the overlay back
}

/** Show or hide a pane; a pane that appears fades in once (phase changes are not pops). */
function pane(id: string, on: boolean): void {
  const el = $(id);
  const was = el.style.display !== 'none';
  if (on === was) return;
  el.style.display = on ? '' : 'none';
  if (on && revealed) { el.classList.remove('pane-in'); void el.offsetWidth; el.classList.add('pane-in'); }
}

/** Chrome both sports share: live/break/mode classes and the two-word degraded note. */
function paintChrome(v: AnyView, live: boolean, brk: string): void {
  const bug = $('bug'); bug.style.display = '';
  $('setup').style.display = 'none';
  bug.classList.toggle('live', live);
  bug.classList.toggle('break', !!brk);
  for (const m of ['full', 'floor', 'held'] as const) bug.classList.toggle(`mode-${m}`, v.mode === m);
  const age = Math.round((Date.now() - Math.max(v.stamps.score.at, v.stamps.clock.at, v.stamps.plays.at)) / 1000);
  const note = v.mode === 'floor' ? 'scores only' : v.mode === 'held' ? `reconnecting · ${Math.max(0, age)}s` : '';
  const deg = $('degraded'); if (deg.textContent !== note) deg.textContent = note;
}

// ── football ─────────────────────────────────────────────────────────────
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

/** Identity: logo, abbreviation, rank, team colour. Never waits on anything. */
function paintIdentity(side: 'home' | 'away', t: TeamView): void {
  barLogo($(`logo-${side}`), logoSrc(t));
  const ab = $(`ab-${side}`); if (ab.textContent !== t.abbr) ab.textContent = t.abbr;
  const rk = $(`rank-${side}`); const rank = t.rank ? String(t.rank) : ''; if (rk.textContent !== rank) rk.textContent = rank;
  document.documentElement.style.setProperty(`--${side}`, t.color || (side === 'home' ? '#8c2a2a' : '#3a5a8c'));
}

let fieldSig = '';                // what the field last drew
let fbResultPainted = false;      // a result has been painted for this game (so a later change may flash)
let revealTimer: number | undefined;
let pendingResult: FootballGameView | null = null;

/** The RESULT of the latest play: score, down & distance, possession, timeouts, banner, last-play text. */
function paintResult(v: FootballGameView, brk: string): void {
  pendingResult = null;
  window.clearTimeout(revealTimer);
  const flash = fbResultPainted && v.phase === 'in';
  setScore($('score-away'), v.away.score, flash);
  setScore($('score-home'), v.home.score, flash);
  const { summary, g, sit } = fieldInputs(v);
  const live = v.phase === 'in';
  const dd = $('dd');
  if (v.phase === 'pre') setHtml(dd, escapeHtml(v.broadcasts.find((b) => b.isNational)?.name ?? v.broadcasts[0]?.name ?? ''));
  else if (!live || brk) setHtml(dd, '');
  else { const st = v.situation; setHtml(dd, st?.ddText ? `<b>${escapeHtml(st.ddText)}</b>${st.possText ? ` at ${escapeHtml(st.possText)}` : ''}` : ''); }
  $('poss-away').classList.toggle('on', live && !brk && !!v.situation?.possIsAway);
  $('poss-home').classList.toggle('on', live && !brk && !!v.situation?.possIsHome);
  // Timeouts: three bars (one in overtime); the server's count, else the play-text counter.
  setTimeoutsFromView(v);
  const to = timeoutsFor(summary, g);
  const total = v.period >= 5 ? 1 : 3;
  for (const side of ['away', 'home'] as const) {
    const left = to ? to[side] : null;
    setHtml($(`to-${side}`), live && left != null ? Array.from({ length: total }, (_, i) => `<i class="${i < left ? '' : 'used'}"></i>`).join('') : '');
  }
  if (!live) return;
  fbResultPainted = true;
  if (!brk) { try { renderPlayBanner(summary, g as any); } catch (e) { console.error('renderPlayBanner', e); } }
  else $('penalty-pill').className = 'play-banner';
  // Last play: always a real play; admin events (timeout, two-minute warning) ride above it.
  // The box keeps its place through a break — it is still the last play.
  const lp = $('last-play');
  const { last, lastReal } = lastPlays(summary);
  const realText = tidyPlayText(lastReal?.text ? String(lastReal.text) : (sit?.lastPlayText || ''));
  const adminNow = last && isAdminPlay(last) ? String(last?.type?.text || '') : '';
  const changed = setHtml(lp, realText
    ? `<div class="lp-head"><span class="lp-title">${escapeHtml(String(lastReal?.type?.text || 'Last play'))}</span>` +
      (adminNow ? `<span class="lp-event"><span class="lp-event-dot"></span>${escapeHtml(adminNow)}</span>` : '') +
      `</div><div class="lp-text">${escapeHtml(realText)}</div>`
    : '');
  const pk = String(lastReal?.id ?? '');
  if (changed && pk !== lastPlayKey) { lastPlayKey = pk; if (revealed) { lp.classList.remove('fresh'); void lp.offsetWidth; lp.classList.add('fresh'); } }
}

function paintFootball(v: FootballGameView): void {
  const live = v.phase === 'in';
  const brk = live ? breakLabel(v) : '';
  paintChrome(v, live, brk);
  if ($('hoops').style.display !== 'none') $('hoops').style.display = 'none';
  paintIdentity('away', v.away); paintIdentity('home', v.home);

  // status cell: period + clock (the clock runs on its own ticker)
  const per = $('period');
  const setPer = (s: string): void => { if (per.textContent !== s) per.textContent = s; };
  if (v.phase === 'pre') { setPer(''); clock.show(kickoffShort(v.date)); }
  else if (v.phase === 'post') { setPer(''); clock.show(v.period > 4 ? `FINAL/${periodLabel(v.period)}` : 'FINAL'); }
  else if (brk) { setPer(''); clock.show(brk); }
  else { setPer(periodLabel(v.period)); clock.run(v.clock, `${v.eventId}|${v.period}`); }

  pane('fieldwrap', live); pane('last-play', live);
  pane('pregame', v.phase === 'pre'); pane('final', v.phase === 'post');

  if (v.phase === 'pre') {
    setHtml($('pregame'), `<div><div class="pg-k">KICKOFF</div><div class="pg-v" id="kick-clock">${escapeHtml(countdown(new Date(v.date).getTime()))}</div></div>` +
      `<div class="pg-meta">${escapeHtml([v.venue?.name, v.venue?.city && v.venue?.state ? `${v.venue.city}, ${v.venue.state}` : ''].filter(Boolean).join(' · '))}</div>` +
      `<div class="pg-meta">${escapeHtml(v.away.record ? `${v.away.abbr} ${v.away.record}` : '')}${v.home.record ? `&nbsp;&nbsp;${escapeHtml(`${v.home.abbr} ${v.home.record}`)}` : ''}</div>`);
  }
  if (v.phase === 'post') {
    const w = v.home.score > v.away.score ? v.home : v.away.score > v.home.score ? v.away : null;
    const last = v.scoringPlays[v.scoringPlays.length - 1];
    setHtml($('final'), `<div><div class="pg-k">${w ? 'WINNER' : 'FINAL'}</div><div class="pg-v">${w ? escapeHtml(w.short || w.abbr) : 'Tie'}</div></div>` +
      (last ? `<div class="pg-meta">${escapeHtml(tidyPlayText(last.text))}</div>` : ''));
  }
  if (!live) { fbResultPainted = false; paintResult(v, brk); return; }

  // ── live: the field ──
  const { summary, g, sit } = fieldInputs(v);
  const key = `${v.eventId}|${v.home.id}|${v.away.id}`;
  if (!fieldBuilt || fieldFor !== key) {
    resetField();
    buildFieldStatics(g as any);
    fieldBuilt = true; fieldFor = key; fbResultPainted = false; lastPlayKey = ''; fieldSig = '';
    fitEzNames();
  }
  const fb = $('field-break');
  const brkWas = fb.style.display !== 'none';
  if (!!brk !== brkWas) { fb.style.display = brk ? 'flex' : 'none'; if (brk) { fb.classList.remove('pane-in'); void fb.offsetWidth; fb.classList.add('pane-in'); } }
  if (brk) { const l = $('field-break-label'); if (l.textContent !== brk) l.textContent = brk; fieldSig = ''; paintResult(v, brk); return; }

  // Rule 3: a play in flight is left alone. renderFieldViz for the SAME play writes its static
  // end state, which would cut the animation; a NEW play is always let through.
  const pk = playKeyOf(summary);
  const now = Date.now();
  const inFlight = lastChain.key === pk && now < lastChain.at + lastChain.ms + FIELD_SETTLE_MS;
  // Rule 1: and when nothing the field draws has changed, it is not redrawn at all (the engine
  // rewrites its play layer on every call).
  const cur = v.drives.current;
  const sig = [pk, cur?.id ?? '', cur?.plays.length ?? 0, v.drives.previous.length, sit?.possText ?? '', sit?.distance ?? '', sit?.yardsToEndzone ?? '', g.homePossession, g.awayPossession].join('|');
  if (!inFlight && sig !== fieldSig) {
    try { renderFieldViz(summary, g as any, sit as any); fieldSig = sig; } catch (e) { console.error('renderFieldViz', e); }
  }

  // Rule 4: the result lands with the ball. The first paint of a game shows everything at once.
  const landsAt = lastChain.key === pk ? lastChain.at + lastChain.ms + REVEAL_AFTER_MS : 0;
  if (!fbResultPainted || now >= landsAt) { paintResult(v, brk); return; }
  pendingResult = v;
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => { if (pendingResult && view === pendingResult) paintResult(pendingResult, ''); }, landsAt - now);
}

// The scoring ribbon across the field, timed by the engine to the moment the score lands.
setOnScoreLanded((scorer: NormTeam, play: any, delayMs: number) => {
  const both = `${String(play?.type?.text ?? '')} ${String(play?.text ?? '')}`;
  const kind = /touchdown/i.test(both) ? 'TOUCHDOWN'
    : /field goal/i.test(both) && /good/i.test(both) && !/no good|missed|blocked/i.test(both) ? 'FIELD GOAL'
    : /safety/i.test(both) ? 'SAFETY' : '';
  if (!kind) return;      // extra points and two-point tries keep the banner only
  window.setTimeout(() => {
    const wrap = $('fieldwrap');
    const v = view;
    if (!v || v.sport !== 'football' || v.phase !== 'in' || wrap.style.display === 'none') return;
    wrap.querySelector('.fv-ribbon')?.remove();
    const rb = document.createElement('div');
    rb.className = 'fv-ribbon';
    rb.style.setProperty('--tc', railColorOf(scorer, '#1d2a3a'));
    rb.innerHTML = `<div class="fv-ribbon-in">${logoHtml(scorer, 'fv-ribbon-logo')}<div class="fv-ribbon-t"><b>${escapeHtml(scorer.abbr)} ${kind}</b>` +
      `<span>${escapeHtml(tidyPlayText(String(play?.text ?? '')))}</span></div></div>`;
    wrap.appendChild(rb);
    const done = (): void => { rb.remove(); };
    rb.addEventListener('animationend', (e) => { if ((e as AnimationEvent).animationName === 'fv-ribbon') done(); });
    window.setTimeout(done, 5200);
  }, Math.max(0, delayMs));
});

// ── basketball ───────────────────────────────────────────────────────────
function paintBasketball(v: BasketballGameView): void {
  const live = v.state === 'in';
  const brk = live ? hoopsBreak(v) : '';
  paintChrome(v, live, brk);
  pane('fieldwrap', false); pane('last-play', false);
  pane('pregame', v.state === 'pre');
  pane('final', v.state === 'post' || v.state === 'postponed');
  paintHoops(v, brk, revealed);
  if (v.state === 'pre') setHtml($('pregame'), hoopsPregame(v, countdown(v.tipoff)));
  if (v.state === 'post' || v.state === 'postponed') setHtml($('final'), hoopsFinal(v));
}

function paint(v: AnyView): void {
  if (v.sport === 'basketball') paintBasketball(v); else paintFootball(v);
  reveal();
}
/** Repaint the current view (a flight finished, a shot landed). */
function repaint(): void { if (view) paint(view); }
hoopsInit(repaint);

// ── kickoff / tipoff ─────────────────────────────────────────────────────
function kickoffShort(iso: string): string {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function countdown(at: number): string {
  if (!Number.isFinite(at) || !at) return '';
  const ms = at - Date.now();
  if (ms > 0 && ms < 24 * 3600_000) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
window.setInterval(() => {
  const v = view; if (!v) return;
  const at = v.sport === 'football' ? (v.phase === 'pre' ? new Date(v.date).getTime() : 0) : (v.state === 'pre' ? v.tipoff : 0);
  if (!at) return;
  const el = document.getElementById('kick-clock'); const s = countdown(at);
  if (el && el.textContent !== s) el.textContent = s;
}, 1000);

// ── polling: one chain, ever ─────────────────────────────────────────────
const LIVE_MS = 2000;            // faster than the server's 3 s view TTL, so a poll never waits a whole cycle
const HIDDEN_MS = 20_000;
let timer: number | undefined;
let inflight = false;
let backoff = 0;
let resync = false;              // the page was hidden: do not replay what it missed

const phaseOf = (v: AnyView): 'pre' | 'in' | 'post' => (v.sport === 'basketball' ? (v.state === 'in' ? 'in' : v.state === 'pre' ? 'pre' : 'post') : v.phase);
function delayFor(v: AnyView | null): number {
  if (!v) return 5000;
  const ph = phaseOf(v);
  if (ph === 'in') return LIVE_MS;
  if (ph === 'pre') { const ms = (v.sport === 'basketball' ? v.tipoff : new Date(v.date).getTime()) - Date.now(); return ms < 10 * 60_000 ? 5000 : 30_000; }
  return 60_000;
}

function schedule(ms: number): void { window.clearTimeout(timer); timer = window.setTimeout(() => { void load(); }, ms); }

async function load(): Promise<void> {
  window.clearTimeout(timer);
  if (inflight) return;                                   // the running request reschedules when it ends
  // A page nobody can see (an OBS scene that isn't live) stops polling every 2 s; the visibility
  // handler reloads the moment it is shown again.
  if (document.hidden && view) { resync = true; schedule(HIDDEN_MS); return; }
  inflight = true;
  const qs = new URLSearchParams(q);                      // every knob forwards (the replay harness reads fail/speed/start)
  qs.set('league', league);
  if (eventId) qs.set('event', eventId); else qs.set('team', team);
  qs.set('t', String(Date.now()));                        // no cache between here and the server may answer for another moment
  try {
    const res = await fetch(`/api/game?${qs}`, { cache: 'no-store' });
    if (res.status === 404 && !view) { setup(`Nothing on today's ${league.toUpperCase()} slate for <code>${escapeHtml(team)}</code>. Check the abbreviation (ESPN's, e.g. ALA, LSU, NO, KC).`); inflight = false; schedule(60_000); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as AnyView;
    backoff = 0;
    // An older build than the one on screen (two servers, a proxy) never replaces a newer one.
    if (!view || next.eventId !== view.eventId || next.built >= view.built || view.mode === 'held') {
      eventId = next.eventId;
      view = next;
      // Back from hidden: show where the game IS — no backlog of flights, no held result.
      if (resync) { resync = false; fbResultPainted = false; if (next.sport === 'basketball') hoopsResync(next); }
      paint(next);
    }
  } catch (err) {
    console.warn('[overlay] load failed', err);
    backoff = Math.min(backoff + 1, 5);
    if (view) { view = { ...view, mode: 'held' }; paint(view); }   // the server is unreachable: hold what we have, say so
    else setup('The scorebug service is not answering yet. Retrying.');
  }
  inflight = false;
  schedule(view ? delayFor(view) * (1 + backoff) : 5000 * (1 + backoff));
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });

// For tools/audit.mjs: read-only view of what the shell is doing.
(window as any).__scorebug = { chain: () => ({ ...lastChain }), view: () => view, revealed: () => revealed };

if (!/^(nfl|cfb|nba|wnba|ncaam|ncaaw)$/.test(league) || (!team && !eventId)) setup('Add <code>?league=cfb|nfl|nba|wnba|ncaam|ncaaw</code> and either <code>&amp;team=ABBR</code> or <code>&amp;event=ID</code>.');
else void load();
