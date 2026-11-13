// src/server/football/engine.ts — ESPN football feeds -> FootballGameView.
//
// Pure: no I/O, no cache. Takes whatever feeds answered this poll (any may be
// null) plus the previous view, and produces a view where every volatile field
// carries the source it came from and when its VALUE last changed.
//
// Feeds, and what each is trusted for:
//   summary     site summary — teams, header status, drives/plays, scoring plays,
//               broadcasts, venue. ~1 MB. The one that dies ("gamecast down").
//   scoreboard  site scoreboard event — status, competitors' scores, and the live
//               `situation` block (down/distance/possession/lastPlay/timeouts).
//               Independent of the summary; the floor when the summary is gone.
//   coreStatus  core API status — clock/displayClock/period/type. Independent.
//   coreSit     core API situation — same block as the scoreboard's.
//   corePlays   core API plays — every play with its own period/clock/scores.
//
// Rules (each grounded in a live failure Joe saw):
//   STUCK CLOCK  the status clock unchanged for STUCK_CLOCK_MS while new play ids
//                arrive → clock/period from the newest play (basketball's rule).
//   SCORE DROP   a lower score is held off until it has persisted SCORE_DROP_MS (feeds
//                blank the score to 0–0 for an update; only a reversal stays down).
//   STUCK SCORE  the newest play's homeScore/awayScore is ahead of every status
//                score → the play's score wins. A LOWER play score never wins
//                (plays are rewritten; a correction shows up on status first).
//   FLOOR        summary failed → score/clock/period/situation from scoreboard
//                and core; drives frozen at last known (core plays, when they
//                answer, are appended to the current drive so the field keeps
//                moving). Score/period/clock are never blank in 'in'.
//   HELD         nothing answered → previous view, stamps 'held'.

import type {
  DriveLite, FeedHealth, Feeds, FootballGameView, Phase, PlayLite, ScoringPlayView, SituationView, Source, Stamp, TeamView,
} from '../../shared/types.ts';

type Json = any;

export const STUCK_CLOCK_MS = 75_000;
/** How long a LOWER score must persist before it is shown. */
export const SCORE_DROP_MS = 12_000;

export interface EngineInput {
  league: 'nfl' | 'cfb';
  eventId: string;
  summary: Json | null;
  scoreboardEvent: Json | null;
  coreStatus: Json | null;
  coreSituation: Json | null;
  corePlays: Json[] | null;
  feeds: Feeds;
  prev: FootballGameView | null;
  now: number;
}

// ── helpers ──────────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const numOrNull = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (v == null ? '' : String(v));
const arr = (x: unknown): Json[] => (Array.isArray(x) ? x : []);
const refId = (ref: unknown): string => (String(ref ?? '').match(/\/(\d+)(?:\?|$)/) ?? [])[1] ?? '';
const idOf = (o: Json): string => str(o?.id ?? refId(o?.$ref));

export function clockSeconds(display: string): number {
  const s = String(display ?? '').trim();
  if (!s) return 0;
  if (s.includes(':')) { const [m, sec] = s.split(':'); return num(m) * 60 + num(sec); }
  return num(s);
}

const ADMIN_PLAY = /timeout|two-minute|end (period|of)/i;
const CHANGE_POSS = /punt|kickoff|interception|fumble/i;
const playTypeText = (p: Json): string => str(p?.type?.text || p?.type?.abbreviation);

// ── teams ────────────────────────────────────────────────────────────────

function recordOf(c: Json): string {
  const rec = Array.isArray(c?.record) ? c.record : Array.isArray(c?.records) ? c.records : null;
  if (rec) {
    for (const r of rec) if (r && (r.type === 'total' || !r.type) && r.summary) return str(r.summary);
    return rec[0]?.summary ? str(rec[0].summary) : '';
  }
  return rec ? str(rec) : '';
}

/** One typed record ("home", "road", "vsconf") from a competitor's record list. */
function recordType(c: Json, type: string): string {
  const rec = Array.isArray(c?.record) ? c.record : Array.isArray(c?.records) ? c.records : [];
  return str(rec.find((r: Json) => r?.type === type)?.summary);
}

/** summary.leaders → each team's headline line: the passing leader, else the first category that has one. */
function leadersOf(summary: Json): Map<string, { name: string; line: string }> {
  const out = new Map<string, { name: string; line: string }>();
  for (const t of arr(summary?.leaders)) {
    const cats = arr(t?.leaders).filter((c: Json) => arr(c?.leaders).length);
    const cat = cats.find((c: Json) => c?.name === 'passingYards') ?? cats[0];
    const top = cat?.leaders?.[0];
    const name = str(top?.athlete?.shortName ?? top?.athlete?.displayName);
    const line = str(top?.displayValue);
    if (name && line) out.set(idOf(t?.team), { name, line });
  }
  return out;
}

function teamOf(c: Json, prev: TeamView | null): TeamView {
  const t = c?.team ?? {};
  const logos = arr(t.logos);
  const dark = logos.find((l: Json) => arr(l?.rel).includes('dark'));
  const rawRank = num(c?.curatedRank?.current ?? c?.rank);
  const toRaw = c?.timeouts;
  return {
    id: str(t.id) || prev?.id || '',
    name: str(t.displayName) || prev?.name || '',
    nick: str(t.name ?? t.shortDisplayName ?? t.displayName) || prev?.nick || '',
    short: str(t.location ?? t.shortDisplayName ?? t.name ?? t.displayName) || prev?.short || '',
    abbr: str(t.abbreviation) || prev?.abbr || '',
    score: c?.score != null ? num(c.score) : (prev?.score ?? 0),
    record: recordOf(c) || prev?.record || '',
    split: recordType(c, c?.homeAway === 'home' ? 'home' : 'road') || prev?.split || '',
    confRecord: recordType(c, 'vsconf') || prev?.confRecord || '',
    leader: prev?.leader ?? null,
    rank: rawRank >= 1 && rawRank <= 25 ? rawRank : (prev?.rank ?? null),
    logo: str(logos[0]?.href) || str(t.logo) || prev?.logo || '',
    logoDark: str(dark?.href) || prev?.logoDark || '',
    color: t.color ? '#' + str(t.color).replace(/^#/, '') : (prev?.color ?? ''),
    alt: t.alternateColor ? '#' + str(t.alternateColor).replace(/^#/, '') : (prev?.alt ?? ''),
    linescores: arr(c?.linescores).map((l: Json) => num(l?.displayValue ?? l?.value)),
    timeouts: typeof toRaw === 'number' ? toRaw : (prev?.timeouts ?? null),
  };
}

// ── status candidates ────────────────────────────────────────────────────

interface StatusCand {
  src: Source;
  phase: Phase | null;
  statusName: string;
  statusDetail: string;
  completed: boolean;
  period: number;
  clock: string;
  homeScore: number | null;
  awayScore: number | null;
}

function candFromComp(src: Source, comp: Json): StatusCand | null {
  if (!comp) return null;
  const st = comp.status?.type ?? {};
  const comps = arr(comp.competitors);
  const home = comps.find((c: Json) => c?.homeAway === 'home');
  const away = comps.find((c: Json) => c?.homeAway === 'away');
  const state = st.state;
  return {
    src,
    phase: state === 'pre' || state === 'in' || state === 'post' ? state : null,
    statusName: str(st.name),
    statusDetail: str(st.shortDetail ?? st.detail ?? st.description),
    completed: st.completed === true,
    period: num(comp.status?.period),
    clock: str(comp.status?.displayClock),
    homeScore: home?.score != null ? num(home.score) : null,
    awayScore: away?.score != null ? num(away.score) : null,
  };
}

function candFromCoreStatus(cs: Json): StatusCand | null {
  if (!cs?.type?.state) return null;
  const st = cs.type;
  return {
    src: 'core',
    phase: st.state === 'pre' || st.state === 'in' || st.state === 'post' ? st.state : null,
    statusName: str(st.name),
    statusDetail: str(st.shortDetail ?? st.detail ?? st.description),
    completed: st.completed === true,
    period: num(cs.period),
    clock: str(cs.displayClock),
    homeScore: null,
    awayScore: null,
  };
}

// ── plays ────────────────────────────────────────────────────────────────

function liteSpot(s: Json): PlayLite['start'] | undefined {
  if (!s || typeof s !== 'object') return undefined;
  return {
    down: numOrNull(s.down) ?? undefined,
    distance: numOrNull(s.distance) ?? undefined,
    yardLine: numOrNull(s.yardLine) ?? undefined,
    yardsToEndzone: numOrNull(s.yardsToEndzone) ?? undefined,
    team: s.team ? { id: idOf(s.team) } : undefined,
    downDistanceText: s.downDistanceText != null ? str(s.downDistanceText) : undefined,
    shortDownDistanceText: s.shortDownDistanceText != null ? str(s.shortDownDistanceText) : undefined,
    possessionText: s.possessionText != null ? str(s.possessionText) : undefined,
  };
}

export function litePlay(p: Json): PlayLite {
  return {
    id: str(p?.id),
    text: str(p?.text),
    type: { id: p?.type?.id != null ? str(p.type.id) : undefined, text: str(p?.type?.text), abbreviation: p?.type?.abbreviation != null ? str(p.type.abbreviation) : undefined },
    period: { number: num(p?.period?.number) },
    clock: { displayValue: str(p?.clock?.displayValue) },
    homeScore: num(p?.homeScore),
    awayScore: num(p?.awayScore),
    scoringPlay: p?.scoringPlay === true,
    isPenalty: p?.isPenalty === true || undefined,
    isTurnover: p?.isTurnover === true || undefined,
    statYardage: numOrNull(p?.statYardage) ?? undefined,
    start: liteSpot(p?.start),
    end: liteSpot(p?.end),
    scoringType: p?.scoringType ? { name: str(p.scoringType.name), abbreviation: str(p.scoringType.abbreviation) } : undefined,
    team: p?.team ? { id: idOf(p.team) } : undefined,
    modified: p?.modified != null ? str(p.modified) : undefined,
  };
}

function liteDrive(d: Json): DriveLite {
  return {
    id: str(d?.id),
    description: str(d?.description),
    team: { id: idOf(d?.team), abbreviation: d?.team?.abbreviation != null ? str(d.team.abbreviation) : undefined },
    start: d?.start ? { period: d.start.period ? { number: num(d.start.period.number) } : undefined, clock: d.start.clock ? { displayValue: str(d.start.clock.displayValue) } : undefined, yardLine: numOrNull(d.start.yardLine) ?? undefined, text: d.start.text != null ? str(d.start.text) : undefined } : undefined,
    end: d?.end ? { period: d.end.period ? { number: num(d.end.period.number) } : undefined, clock: d.end.clock ? { displayValue: str(d.end.clock.displayValue) } : undefined, yardLine: numOrNull(d.end.yardLine) ?? undefined, text: d.end.text != null ? str(d.end.text) : undefined } : undefined,
    timeElapsed: d?.timeElapsed ? { displayValue: str(d.timeElapsed.displayValue) } : undefined,
    yards: numOrNull(d?.yards) ?? undefined,
    offensivePlays: numOrNull(d?.offensivePlays) ?? undefined,
    result: d?.result != null ? str(d.result) : undefined,
    displayResult: d?.displayResult != null ? str(d.displayResult) : undefined,
    isScore: d?.isScore === true || undefined,
    plays: arr(d?.plays).map(litePlay),
  };
}

const lastPlayOfDrives = (dr: FootballGameView['drives']): PlayLite | null => {
  const cur = dr.current;
  if (cur?.plays.length) return cur.plays[cur.plays.length - 1] ?? null;
  const prev = dr.previous[dr.previous.length - 1];
  return prev?.plays.length ? prev.plays[prev.plays.length - 1] ?? null : null;
};

/** Newest non-admin play across the drives (admin = timeout / period marker). */
function newestRealPlay(dr: FootballGameView['drives']): PlayLite | null {
  const all: PlayLite[] = [];
  for (const d of dr.previous) all.push(...d.plays);
  if (dr.current) all.push(...dr.current.plays);
  for (let i = all.length - 1; i >= 0; i--) { const p = all[i]!; if (!ADMIN_PLAY.test(playTypeText(p))) return p; }
  return all[all.length - 1] ?? null;
}

// ── situation ────────────────────────────────────────────────────────────

function fmtDD(down: number | null, dist: number | null): string {
  if (down == null || down < 1 || down > 4) return '';
  const o = ['', '1st', '2nd', '3rd', '4th'][down];
  return `${o} & ${dist == null ? '—' : dist === 0 ? 'Goal' : dist}`;
}

interface SitCand { src: Source; raw: Json }

function situationFrom(cands: SitCand[], drives: FootballGameView['drives'], home: TeamView, away: TeamView, homePoss: boolean, awayPoss: boolean): { sit: SituationView | null; src: Source } {
  const play = lastPlayOfDrives(drives);
  let down: number | null = null, distance: number | null = null, yardsToEndzone: number | null = null;
  let ddText = '', possText = '', possTeamId = '', isRedZone = false, lastPlayId = '', lastPlayText = '';
  let src: Source = 'plays';

  const live = cands.find((c) => c.raw && typeof c.raw === 'object' && (c.raw.down != null || c.raw.possession != null || c.raw.downDistanceText || c.raw.shortDownDistanceText));
  if (live) {
    const s = live.raw;
    src = live.src;
    down = numOrNull(s.down); distance = numOrNull(s.distance);
    yardsToEndzone = numOrNull(s.yardsToEndzone != null ? s.yardsToEndzone : s.yardLine);
    ddText = str(s.shortDownDistanceText || s.downDistanceText).replace(/\s+at\s+.*$/i, '');
    if (/^-|^0(st|nd|rd|th)/.test(ddText)) ddText = '';
    possText = str(s.possessionText);
    possTeamId = s.possession != null ? idOf(typeof s.possession === 'object' ? s.possession : { id: s.possession }) : (s.team ? idOf(s.team) : '');
    isRedZone = s.isRedZone === true;
    lastPlayId = str(s.lastPlay?.id);
    lastPlayText = str(s.lastPlay?.text);
  } else if (play?.end) {
    const end = play.end;
    down = numOrNull(end.down); distance = numOrNull(end.distance);
    yardsToEndzone = numOrNull(end.yardsToEndzone);
    ddText = str(end.shortDownDistanceText || end.downDistanceText).replace(/\s+at\s+.*$/i, '');
    if (/^-|^0(st|nd|rd|th)/.test(ddText)) ddText = '';
    possText = str(end.possessionText);
    possTeamId = end.team?.id ?? '';
  }

  // Possession truth (lifted from the client): drives.current.team, except after
  // a change-of-possession play where end.team is the new owner.
  const driveTeamId = drives.current?.team?.id ?? '';
  if (driveTeamId) possTeamId = driveTeamId;
  {
    const plays0 = drives.current?.plays ?? [];
    for (let i = plays0.length - 1; i >= 0; i--) {
      const p0 = plays0[i]!;
      if (ADMIN_PLAY.test(playTypeText(p0))) continue;
      if (CHANGE_POSS.test(playTypeText(p0))) {
        const endId = p0.end?.team?.id ?? '';
        if (endId && endId !== possTeamId && (endId === home.id || endId === away.id)) possTeamId = endId;
        else if (!endId && possTeamId) possTeamId = possTeamId === home.id ? away.id : home.id;
      }
      break;
    }
  }
  if (!possTeamId) { if (homePoss) possTeamId = home.id; else if (awayPoss) possTeamId = away.id; }

  if (!lastPlayId && play) { lastPlayId = play.id; lastPlayText = play.text; }
  else if (play && play.id === lastPlayId && play.text.length > lastPlayText.length) lastPlayText = play.text; // the drives copy is the completed sentence

  if (down == null && !ddText) return { sit: null, src };
  return {
    sit: {
      down, distance, yardsToEndzone,
      ddText: ddText || fmtDD(down, distance),
      possText,
      possIsHome: !!possTeamId && possTeamId === home.id,
      possIsAway: !!possTeamId && possTeamId === away.id,
      isRedZone,
      lastPlayId, lastPlayText,
    },
    src,
  };
}

// ── scoring plays ────────────────────────────────────────────────────────

function scoringPlaysOf(summary: Json): ScoringPlayView[] {
  return arr(summary?.scoringPlays).map((p: Json) => ({
    id: str(p?.id),
    period: num(p?.period?.number),
    clock: str(p?.clock?.displayValue),
    text: str(p?.text),
    teamId: idOf(p?.team),
    homeScore: num(p?.homeScore),
    awayScore: num(p?.awayScore),
    type: str(p?.scoringType?.abbreviation ?? p?.type?.abbreviation),
  }));
}

// ── the build ────────────────────────────────────────────────────────────

const emptyHealth = (): FeedHealth => ({ okAt: 0, failAt: 0, reason: '', fails: 0 });
export const emptyFeeds = (): Feeds => ({ summary: emptyHealth(), scoreboard: emptyHealth(), coreStatus: emptyHealth(), corePlays: emptyHealth(), coreSituation: emptyHealth() });

const stamp = (src: Source, at: number): Stamp => ({ src, at });

export function buildFootballView(input: EngineInput): FootballGameView {
  const { league, eventId, summary, scoreboardEvent: sbEv, coreStatus, coreSituation, corePlays, feeds, prev, now } = input;

  const sumComp = summary?.header?.competitions?.[0] ?? null;
  const sbComp = sbEv?.competitions?.[0] ?? null;

  // ── identity: summary header → scoreboard → prev ──
  const idComp = sumComp ?? sbComp;
  const comps = arr(idComp?.competitors);
  const homeRaw = comps.find((c: Json) => c?.homeAway === 'home') ?? null;
  const awayRaw = comps.find((c: Json) => c?.homeAway === 'away') ?? null;
  if (!homeRaw && !awayRaw && !prev) throw new Error(`no identity for ${eventId}: summary and scoreboard both empty`);

  let home = teamOf(homeRaw, prev?.home ?? null);
  let away = teamOf(awayRaw, prev?.away ?? null);
  // Scoreboard carries the AP rank and timeouts on its competitors; the summary header often doesn't.
  if (sbComp && sumComp) {
    const sbHome = arr(sbComp.competitors).find((c: Json) => c?.homeAway === 'home');
    const sbAway = arr(sbComp.competitors).find((c: Json) => c?.homeAway === 'away');
    const rank = (c: Json): number | null => { const r = num(c?.curatedRank?.current ?? c?.rank); return r >= 1 && r <= 25 ? r : null; };
    if (sbHome) { home.rank = rank(sbHome) ?? home.rank; }
    if (sbAway) { away.rank = rank(sbAway) ?? away.rank; }
    const sit = sbComp.situation;
    if (typeof sit?.homeTimeouts === 'number') home.timeouts = sit.homeTimeouts;
    if (typeof sit?.awayTimeouts === 'number') away.timeouts = sit.awayTimeouts;
  } else if (sbComp?.situation) {
    const sit = sbComp.situation;
    if (typeof sit?.homeTimeouts === 'number') home.timeouts = sit.homeTimeouts;
    if (typeof sit?.awayTimeouts === 'number') away.timeouts = sit.awayTimeouts;
  }
  // Core situation (same block) when the scoreboard didn't answer.
  if (coreSituation && typeof coreSituation === 'object') {
    if (typeof coreSituation.homeTimeouts === 'number') home.timeouts = coreSituation.homeTimeouts;
    if (typeof coreSituation.awayTimeouts === 'number') away.timeouts = coreSituation.awayTimeouts;
  }

  // ── drives: summary, else held from prev; core plays extend the current drive ──
  let drives: FootballGameView['drives'];
  let playsSrc: Source;
  if (summary?.drives && (summary.drives.current || arr(summary.drives.previous).length)) {
    drives = { current: summary.drives.current ? liteDrive(summary.drives.current) : null, previous: arr(summary.drives.previous).map(liteDrive) };
    playsSrc = 'summary';
  } else if (prev) {
    drives = { current: prev.drives.current ? { ...prev.drives.current, plays: [...prev.drives.current.plays] } : null, previous: prev.drives.previous };
    playsSrc = 'held';
  } else {
    drives = { current: null, previous: [] };
    playsSrc = 'held';
  }
  if (playsSrc !== 'summary' && corePlays?.length) {
    // Append core plays newer than anything we hold. Core plays carry start/end
    // spots and scores like the summary's; team is a $ref, normalised in litePlay.
    const seen = new Set<string>();
    for (const d of drives.previous) for (const p of d.plays) seen.add(p.id);
    for (const p of drives.current?.plays ?? []) seen.add(p.id);
    const fresh = corePlays.map(litePlay).filter((p) => p.id && !seen.has(p.id));
    if (fresh.length) {
      if (!drives.current) drives.current = { id: 'core', description: '', team: { id: fresh[0]!.team?.id ?? '' }, plays: [] };
      drives.current.plays.push(...fresh);
      playsSrc = 'core';
    }
  }
  const lastPlay = lastPlayOfDrives(drives);
  const lastPlayId = lastPlay?.id ?? '';
  const playsChanged = !prev || lastPlayId !== (lastPlayOfDrives(prev.drives)?.id ?? '');
  const playsStamp = stamp(playsSrc, playsChanged ? now : prev!.stamps.plays.at);

  // ── status: summary → scoreboard → core, then stuck-clock / stuck-score ──
  const cands = [candFromComp('summary', sumComp), candFromComp('scoreboard', sbComp), candFromCoreStatus(coreStatus)].filter((c): c is StatusCand => !!c);
  const primary = cands[0] ?? null;

  let phase: Phase = primary?.phase ?? prev?.phase ?? 'pre';
  let statusName = primary?.statusName || prev?.statusName || '';
  let statusDetail = primary?.statusDetail || prev?.statusDetail || '';
  let completed = primary?.completed ?? prev?.completed ?? false;
  // Phase: if any live feed says post/completed, believe it (a lagging summary
  // must not hold a finished game live for 15 minutes).
  for (const c of cands) { if (c.phase === 'post' || c.completed) { phase = 'post'; completed = completed || c.completed; statusName = c.statusName || statusName; statusDetail = c.statusDetail || statusDetail; break; } }

  // ── clock ──
  // The STATUS clock is the most advanced reading among the live status feeds: the highest
  // period, and within it the lowest clock (a game clock only runs down, so a feed that is
  // behind or frozen reads high and loses). A "0:00" from a feed that does not also say the
  // period ended is an unpopulated clock, not the end of the period, and is ignored when
  // another feed has a real reading.
  const topPeriod = cands.reduce((m, c) => Math.max(m, c.period), 0);
  const pool = cands.filter((c) => c.period === topPeriod && c.clock !== '');
  const isEnd = (c: StatusCand): boolean => /END_PERIOD|HALFTIME|FINAL/i.test(c.statusName);
  const real = pool.filter((c) => clockSeconds(c.clock) > 0 || isEnd(c));
  const pick = (real.length ? real : pool).reduce<StatusCand | null>((best, c) => (!best || clockSeconds(c.clock) < clockSeconds(best.clock) ? c : best), null);

  const statusPeriod = pick ? pick.period : (prev?.statusPeriod ?? 0);
  const statusClock = pick ? pick.clock : (prev?.statusClock ?? '');
  if (pick && phase === 'in') { statusName = pick.statusName || statusName; statusDetail = pick.statusDetail || statusDetail; }
  const realPlay = newestRealPlay(drives);
  const realPlayId = realPlay?.id ?? '';
  // When the status clock last changed, and the newest play at that moment (carried across polls).
  const statusMoved = !prev || statusClock !== prev.statusClock || statusPeriod !== prev.statusPeriod || !prev.statusSince;
  const statusSince = statusMoved ? now : prev!.statusSince;
  const playAtStatus = statusMoved ? realPlayId : prev!.playAtStatus;

  let period = statusPeriod;
  let clock = statusClock;
  let clockSrc: Source = pick ? pick.src : 'held';
  // STUCK CLOCK: the status clock has not moved for STUCK_CLOCK_MS while new plays arrived, and
  // the newest play is further along than it → the plays run the clock until the status moves
  // again. Tracked on the status reading, not the displayed one, so it holds across polls.
  if (phase === 'in' && realPlay && realPlay.clock.displayValue && realPlayId !== playAtStatus && now - statusSince >= STUCK_CLOCK_MS) {
    const pp = realPlay.period.number;
    if (pp > statusPeriod || (pp === statusPeriod && clockSeconds(realPlay.clock.displayValue) < clockSeconds(statusClock))) {
      period = pp; clock = realPlay.clock.displayValue; clockSrc = 'plays';
    }
  }
  // Plays can be a period ahead of a lagging status (never behind a true one).
  if (phase === 'in' && realPlay && realPlay.period.number > period && playsSrc !== 'held') { period = realPlay.period.number; clock = realPlay.clock.displayValue; clockSrc = 'plays'; }
  // Nothing answered: hold exactly what was showing (including a play-run clock).
  if (!pick && prev) { period = prev.period; clock = prev.clock; clockSrc = 'held'; }
  const clockChanged = !prev || clock !== prev.clock || period !== prev.period;
  const clockAt = clockChanged ? now : prev!.stamps.clock.at;

  // ── score ──
  // Among the live status feeds the most advanced reading wins (the highest total: a score
  // only goes up), then the newest REAL play if it is ahead of them all (the stuck-score case).
  // Admin events (a timeout, a period marker) are skipped: their score fields are often 0–0.
  let hs: number | null = null, as: number | null = null, scoreSrc: Source = 'held';
  for (const c of cands) {
    if (c.homeScore == null || c.awayScore == null) continue;
    if (hs == null || as == null || c.homeScore + c.awayScore > hs + as) { hs = c.homeScore; as = c.awayScore; scoreSrc = c.src; }
  }
  const scorePlay = realPlay ?? lastPlay;
  if (phase !== 'pre' && scorePlay) {
    const ph = scorePlay.homeScore, pa = scorePlay.awayScore;
    const fromLivePlays: Source = playsSrc === 'held' ? 'held' : 'plays';
    if (hs == null || as == null) { hs = ph; as = pa; scoreSrc = fromLivePlays; }
    else if (ph + pa > hs + as && ph >= hs && pa >= as && playsSrc !== 'held') { hs = ph; as = pa; scoreSrc = 'plays'; }  // stuck score
  }
  if (hs == null || as == null) { hs = prev?.home.score ?? 0; as = prev?.away.score ?? 0; scoreSrc = 'held'; }
  // A DROP is believed only once it has persisted. Feeds blank the score for an update (0–0 on
  // the timeout after a touchdown, captured Aug 2026); the only real drop is an overturned
  // scoring play, which stays down. Until SCORE_DROP_MS has passed the last score is held.
  let scoreDropSince = 0, scoreDropTo = '';
  if (prev && phase !== 'pre' && (hs < prev.home.score || as < prev.away.score)) {
    const to = `${hs}-${as}`;
    scoreDropSince = prev.scoreDropTo === to && prev.scoreDropSince ? prev.scoreDropSince : now;
    scoreDropTo = to;
    if (now - scoreDropSince < SCORE_DROP_MS) { hs = prev.home.score; as = prev.away.score; scoreSrc = 'held'; }
    else { scoreDropSince = 0; scoreDropTo = ''; }
  }
  const lead = summary?.leaders ? leadersOf(summary) : null;
  home = { ...home, score: hs, leader: lead?.get(home.id) ?? home.leader };
  away = { ...away, score: as, leader: lead?.get(away.id) ?? away.leader };
  const scoreChanged = !prev || hs !== prev.home.score || as !== prev.away.score;
  const scoreStamp = stamp(scoreSrc, scoreChanged ? now : prev!.stamps.score.at);

  // ── situation: summary.situation → scoreboard → core → last play end ──
  const sitCands: SitCand[] = [];
  if (summary?.situation) sitCands.push({ src: 'summary', raw: summary.situation });
  if (sbComp?.situation) sitCands.push({ src: 'scoreboard', raw: sbComp.situation });
  if (coreSituation && typeof coreSituation === 'object' && Object.keys(coreSituation).length > 1) sitCands.push({ src: 'core', raw: coreSituation });
  const homePoss = homeRaw?.possession === true, awayPoss = awayRaw?.possession === true;
  const { sit, src: sitSrcRaw } = situationFrom(sitCands, drives, home, away, homePoss, awayPoss);
  // A live situation needs a live source: a situation derived from held plays is itself held.
  const liveSit = phase === 'in' ? sit : null;
  const sitFromLive = !!liveSit && (sitSrcRaw !== 'plays' || playsSrc !== 'held');
  const heldSituation = liveSit && sitFromLive ? liveSit : (phase === 'in' && prev?.situation ? prev.situation : liveSit);
  const sitSrc: Source = heldSituation ? (sitFromLive ? sitSrcRaw : 'held') : sitSrcRaw;
  const sitKey = (s: SituationView | null): string => (s ? `${s.down}|${s.distance}|${s.possText}|${s.possIsHome}|${s.lastPlayId}` : '');
  const sitChanged = !prev || sitKey(heldSituation) !== sitKey(prev.situation);
  const sitStamp = stamp(sitSrc, sitChanged ? now : prev!.stamps.situation.at);

  // ── mode ──
  const anyLive = !!(summary || sbEv || coreStatus || corePlays?.length);
  const mode: FootballGameView['mode'] = summary?.header ? 'full' : anyLive ? 'floor' : 'held';

  const broadcasts = arr(sumComp?.broadcasts ?? sbComp?.broadcasts).map((b: Json) => ({
    market: str(b?.market?.type ?? b?.market), name: str(b?.media?.shortName ?? arr(b?.names)[0]), isNational: b?.isNational === true || str(b?.market?.type ?? b?.market) === 'national',
  }));
  const v = summary?.gameInfo?.venue ?? sumComp?.venue ?? sbComp?.venue ?? null;
  const venue = v ? { name: str(v.fullName ?? v.name), city: str(v.address?.city), state: str(v.address?.state) } : (prev?.venue ?? null);

  return {
    sport: 'football', league, eventId,
    date: str(idComp?.date) || prev?.date || '',
    seasonType: num(summary?.header?.season?.type ?? sbEv?.season?.type, prev?.seasonType ?? 2),
    week: summary?.header?.week?.number != null ? num(summary.header.week.number) : sbEv?.week?.number != null ? num(sbEv.week.number) : (prev?.week ?? null),
    phase, statusName, statusDetail, completed, period, clock,
    statusClock, statusPeriod, statusSince, playAtStatus,
    scoreDropSince, scoreDropTo,
    home, away,
    situation: heldSituation,
    drives,
    scoringPlays: summary?.scoringPlays ? scoringPlaysOf(summary) : (prev?.scoringPlays ?? []),
    broadcasts: broadcasts.length ? broadcasts : (prev?.broadcasts ?? []),
    venue,
    stamps: {
      score: scoreStamp,
      clock: stamp(clockSrc, clockAt),
      period: stamp(clockSrc, clockAt),
      situation: sitStamp,
      plays: playsStamp,
    },
    feeds,
    mode,
    built: now,
  };
}
