// src/server/basketball/engine.ts — LIFTED VERBATIM from nba-hub/src/server/engine.ts (Nov 2026); only the imports and the inlined rankOf differ.
// src/server/engine.ts — ESPN basketball summary -> GameView.
//
// Pure: no Devvit imports, no I/O. Runs on the server (the judgement lives
// here, not in the public client bundle) and in tools/replay-server.mjs.
//
// Every rule below is grounded in captured payloads; see docs/ESPN-BASKETBALL.md.
//   - Play ARRAY order is chronological. sequenceNumber is not (it runs backwards).
//   - Free throw  <=> pointsAttempted === 1. FG attempt <=> shootingPlay && pointsAttempted >= 2.
//   - Coordinates are only real on FG attempts (sentinels elsewhere, incl. (25,0) in NCAAM).
//   - team.id: shooter's team on shots (also blocked shots), fouling team on fouls,
//     rebounding team on rebounds, committing team on turnovers.
//   - Plays are rewritten live (text and type change after first appearance), so
//     nothing here is incremental: the view is rebuilt from the full payload each time.

// rankOf inlined from nba-hub gamefacts.ts
function rankOf(c: any): number { const cur = Number(c?.curatedRank?.current) || 0; if (cur >= 1 && cur <= 25) return cur; const r = Number(c?.rank) || 0; return r >= 1 && r <= 25 ? r : 0; }
import type {
  BonusState, BoxRow, BoxView, EventKind, GameState, GameView, InjuryView, Last5Game, League, OddsView,
  PerformerView, PlayView, PlayerRef, RunView, ShotView, Side, TeamStatView, TeamView,
} from '../../shared/basketball.ts';
import { foulTier, isCollege, regulationPeriods } from '../../shared/basketball.ts';

type Json = any;

export interface SituationFeed {
  homeTimeouts?: { timeoutsCurrent?: number; timeoutsRemainingCurrent?: number };
  awayTimeouts?: { timeoutsCurrent?: number; timeoutsRemainingCurrent?: number };
}

export interface EngineInput {
  league: League;
  eventId: string;
  summary: Json;
  /** Core API situation (live only). Used for timeouts remaining. */
  situation?: SituationFeed | null;
  now?: number;
}

// ── small helpers ────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * An ESPN field read as a list. ESPN has shipped objects where lists are
 * expected (and a dropped-field bug reads as undefined), so anything that is
 * not an array is treated as empty rather than letting `.map`/`for..of` throw
 * and take the whole view down with it.
 */
const arr = (x: unknown): Json[] => (Array.isArray(x) ? x : []);

/** "7:22" -> 442, "55.2" -> 55.2, "0.0" -> 0 */
export function clockSeconds(display: string | undefined): number {
  const s = String(display ?? '').trim();
  if (!s) return 0;
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    return num(m) * 60 + num(sec);
  }
  return num(s);
}

const hex = (c: unknown, d: string): string => {
  const s = String(c ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : d;
};

const isFT = (p: Json): boolean => num(p?.pointsAttempted) === 1;
const isFGA = (p: Json): boolean => !!p?.shootingPlay && num(p?.pointsAttempted) >= 2;
const typeText = (p: Json): string => String(p?.type?.text ?? '');
const playText = (p: Json): string => String(p?.text ?? '').replace(/\s+/g, ' ').trim();

// ── league rules ─────────────────────────────────────────────────────────

interface Format {
  periods: number;   // regulation periods
  reg: number;       // seconds per regulation period
  ot: number;        // seconds per overtime
}

function formatOf(summary: Json, league: League): Format {
  const f = summary?.format;
  const periods = num(f?.regulation?.periods, regulationPeriods(league));
  const reg = num(f?.regulation?.clock, league === 'ncaam' ? 1200 : league === 'nba' ? 720 : 600);   // women's college: 10-minute quarters, like the WNBA
  const ot = num(f?.overtime?.clock, 300);
  return { periods, reg, ot };
}

function periodLength(fmt: Format, period: number): number {
  return period <= fmt.periods ? fmt.reg : fmt.ot;
}

function periodStart(fmt: Format, period: number): number {
  if (period <= fmt.periods) return (period - 1) * fmt.reg;
  return fmt.periods * fmt.reg + (period - fmt.periods - 1) * fmt.ot;
}

function elapsedAt(fmt: Format, period: number, clock: string): number {
  return periodStart(fmt, period) + Math.max(0, periodLength(fmt, period) - clockSeconds(clock));
}

export function periodLabel(league: League, fmt: Format, period: number): string {
  if (period <= 0) return '';
  if (period > fmt.periods) {
    const n = period - fmt.periods;
    return n === 1 ? 'OT' : `${n}OT`;
  }
  if (league === 'ncaam' || fmt.periods === 2) return period === 1 ? '1st Half' : '2nd Half';
  return `Q${period}`;
}

/**
 * Team-foul bucket: fouls reset every quarter (NBA/WNBA) or every half
 * (NCAAM). In college (men's and women's), overtime fouls carry over from the last regulation period.
 */
function foulBucket(league: League, fmt: Format, period: number): number {
  if (isCollege(league)) return Math.min(period, fmt.periods);
  return period;
}

/**
 * Whether a team is in the bonus, from its OPPONENT's team fouls.
 * NBA/WNBA: free throws from the 5th team foul in a quarter (4th in overtime),
 * or from the 2nd team foul inside the last two minutes of a period.
 * NCAAM: one-and-one from the 7th, double bonus from the 10th, per half;
 * overtime fouls carry over from the second half.
 * NCAAW: two shots from the 5th team foul of a quarter (no one-and-one since 2015-16); fourth-quarter
 * fouls carry into overtime.
 * "In the bonus" = the opponent has reached the count where fouls are shooting fouls.
 */
function bonusFrom(league: League, fmt: Format, period: number, oppFouls: number, oppLast2: number): BonusState {
  if (league === 'ncaam') return oppFouls >= 10 ? 'double' : oppFouls >= 7 ? 'bonus' : 'none';
  if (league === 'ncaaw') return oppFouls >= 5 ? 'bonus' : 'none';
  const limit = period > fmt.periods ? 4 : 5;
  return oppFouls >= limit || oppLast2 >= 2 ? 'bonus' : 'none';
}

/**
 * Display convention (ESPN does not say which basket a team used): home
 * attacks the right basket in the first half, left in the second half and
 * in every overtime.
 */
function homeAttacksRight(fmt: Format, period: number): boolean {
  return period <= Math.ceil(fmt.periods / 2);
}

// ── play classification ──────────────────────────────────────────────────

const FT_N_OF_M = /(\d)\s*of\s*(\d)/i;

function ftTrip(p: Json): { n: number; m: number } | null {
  const m = FT_N_OF_M.exec(typeText(p)) ?? FT_N_OF_M.exec(playText(p));
  return m ? { n: Number(m[1]), m: Number(m[2]) } : null;
}

const isTechnicalFT = (p: Json): boolean => /technical/i.test(typeText(p)) || /technical/i.test(playText(p));
const isFlagrantFT = (p: Json): boolean => /flagrant/i.test(typeText(p));
const isFoul = (p: Json): boolean => /foul/i.test(typeText(p)) && !/turnover/i.test(typeText(p));
const isTechFoul = (p: Json): boolean => /technical/i.test(typeText(p));
const isTimeout = (p: Json): boolean => /time\s?out/i.test(typeText(p));
const isTeamTimeout = (p: Json): boolean => isTimeout(p) && !/official|tv|reset/i.test(typeText(p)) && !!p?.team?.id;
const isRebound = (p: Json): boolean => /rebound/i.test(typeText(p));
const isTurnover = (p: Json): boolean => !isFGA(p) && (/turnover/i.test(typeText(p)) || /\bturnover\b/i.test(playText(p)));
const isSteal = (p: Json): boolean => /^steal$/i.test(typeText(p));
const isJumpBall = (p: Json): boolean => /jump ?ball/i.test(typeText(p));
const isEndPeriod = (p: Json): boolean => /end (period|game)/i.test(typeText(p));
const isReview = (p: Json): boolean => /challenge|review/i.test(typeText(p));
const isBlocked = (p: Json): boolean => / blocks /i.test(playText(p));

// ── the build ─────────────────────────────────────────────────────────────

export function buildGameView(input: EngineInput): GameView {
  return build(input).view;
}

/** Possession audit: before each FG attempt, did the derived possession match the shooter? */
export interface EngineDiagnostics {
  possChecks: number;
  possHits: number;
}

export function buildWithDiagnostics(input: EngineInput): { view: GameView; diag: EngineDiagnostics } {
  return build(input);
}

function build(input: EngineInput): { view: GameView; diag: EngineDiagnostics } {
  const { league, eventId, summary } = input;
  const fmt = formatOf(summary, league);
  const comp = summary?.header?.competitions?.[0] ?? {};
  const comps: Json[] = arr(comp.competitors);
  const homeC = comps.find((c) => c.homeAway === 'home') ?? comps[0] ?? {};
  const awayC = comps.find((c) => c.homeAway === 'away') ?? comps[1] ?? {};
  const teamIds: [string, string] = [String(awayC.team?.id ?? awayC.id ?? ''), String(homeC.team?.id ?? homeC.id ?? '')];
  const sideOf = (teamId: unknown): Side | null => {
    const t = String(teamId ?? '');
    return t === teamIds[0] ? 0 : t === teamIds[1] ? 1 : null;
  };
  const other = (s: Side | null): Side | null => (s == null ? null : ((1 - s) as Side));

  // Roster: athlete id -> side + display name (boxscore covers everyone who dressed).
  const players: Record<string, PlayerRef> = {};
  const roster = new Map<string, PlayerRef>();
  for (const block of arr(summary?.boxscore?.players)) {
    const side = sideOf(block?.team?.id);
    if (side == null) continue;
    for (const grp of arr(block?.statistics)) {
      for (const a of arr(grp?.athletes)) {
        const id = String(a?.athlete?.id ?? '');
        if (!id) continue;
        roster.set(id, {
          name: String(a.athlete.shortName ?? a.athlete.displayName ?? ''),
          jersey: String(a.athlete.jersey ?? ''),
          side,
        });
      }
    }
  }

  const plays: Json[] = Array.isArray(summary?.plays) ? summary.plays : [];
  const wpById = new Map<string, number>();
  for (const w of arr(summary?.winprobability)) {
    if (w?.playId != null) wpById.set(String(w.playId), Math.round(num(w.homeWinPercentage) * 1000) / 10);
  }

  // ── pass 1: shots, and-ones, fouls, possession ──────────────────────────
  const shots: ShotView[] = [];
  const shotByPlayIdx = new Map<number, ShotView>();
  const foulsByBucket = new Map<string, number>(); // `${side}:${bucket}`
  const foulsLast2 = new Map<string, number>();    // `${side}:${period}` — NBA/WNBA last-2-minutes rule
  let possession: Side | null = null;
  let possChecks = 0;
  let possHits = 0;

  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const side = sideOf(p?.team?.id);
    const period = num(p?.period?.number, 1);

    if (isFGA(p)) {
      if (side != null && possession != null) {
        possChecks++;
        if (possession === side) possHits++;
      }
      const c = p.coordinate ?? {};
      const x = num(c.x, NaN);
      const y = num(c.y, NaN);
      const pid = String(p?.participants?.[0]?.athlete?.id ?? '');
      if (side != null && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 200 && Math.abs(y) < 200) {
        const shot: ShotView = {
          id: String(p.id),
          side,
          player: pid,
          made: !!p.scoringPlay,
          pts: num(p.pointsAttempted) >= 3 ? 3 : 2,
          andOne: false,
          x, y,
          period,
          clock: String(p?.clock?.displayValue ?? ''),
          text: playText(p),
        };
        shots.push(shot);
        shotByPlayIdx.set(i, shot);
        if (pid && roster.has(pid)) players[pid] = roster.get(pid)!;
      }
      possession = p.scoringPlay ? other(side) : side; // miss: shooter's team until the rebound
      continue;
    }

    if (isFT(p)) {
      const trip = ftTrip(p);
      if (isTechnicalFT(p)) continue; // no change of possession
      if (!trip || trip.n < trip.m) { possession = side; continue; }
      if (isFlagrantFT(p)) { possession = side; continue; } // flagrant: fouled team keeps the ball
      possession = p.scoringPlay ? other(side) : side; // last FT missed: live ball, rebound decides
      // And-one: last of a 1-shot trip right after a made FG by the same side, same clock.
      if (trip.m === 1 && side != null) {
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const q = plays[j];
          if (q?.clock?.displayValue !== p?.clock?.displayValue) break;
          const s = shotByPlayIdx.get(j);
          if (s && s.made && s.side === side) { s.andOne = true; break; }
        }
      }
      continue;
    }

    if (isFoul(p) && side != null) {
      if (!isTechFoul(p)) {
        const key = `${side}:${foulBucket(league, fmt, period)}`;
        foulsByBucket.set(key, (foulsByBucket.get(key) ?? 0) + 1);
        if (!isCollege(league) && clockSeconds(p?.clock?.displayValue) <= 120) {
          const k2 = `${side}:${period}`;
          foulsLast2.set(k2, (foulsLast2.get(k2) ?? 0) + 1);
        }
        possession = other(side); // fouled team has (or gets) the ball
      }
      continue;
    }

    if (isRebound(p)) { if (side != null) possession = side; continue; }
    if (isSteal(p)) { if (side != null) possession = side; continue; }
    if (isTurnover(p)) { if (side != null) possession = other(side); continue; }

    if (isJumpBall(p)) {
      const t = playText(p);
      if (/gains possession/i.test(t)) {
        const gainer = String(p?.participants?.[2]?.athlete?.id ?? '');
        const s = roster.get(gainer)?.side ?? side;
        if (s != null) possession = s;
      } else if (/won by/i.test(t) && side != null) {
        possession = side;
      }
      continue;
    }

    if (isEndPeriod(p)) { possession = null; continue; }
    if (isTeamTimeout(p) && possession == null && side != null) possession = side;
  }

  // ── current status ──────────────────────────────────────────────────────
  const st = comp?.status ?? {};
  const stType = st?.type ?? {};
  const lastPlay = plays[plays.length - 1];
  const rawState = String(stType.state ?? 'pre');
  const postponed = /postpon|cancel|suspend/i.test(String(stType.name ?? '') + String(stType.description ?? ''));
  const state: GameState = postponed ? 'postponed' : rawState === 'in' ? 'in' : rawState === 'post' ? 'post' : 'pre';
  const period = num(st.period, num(lastPlay?.period?.number, 0));
  const clock = String(st.displayClock ?? lastPlay?.clock?.displayValue ?? '');
  const bucket = foulBucket(league, fmt, Math.max(1, period));

  // ── teams ────────────────────────────────────────────────────────────────
  const sit = input.situation ?? null;
  // A dead situation feed reports 0 used AND 0 remaining for both teams (seen on LAL@SAC
  // 2026-10-05 preseason); no team starts a game with no timeouts, so that shape is "unknown".
  const sitDead = !!sit && [sit.homeTimeouts, sit.awayTimeouts].every((t) => t && num(t.timeoutsCurrent) === 0 && num(t.timeoutsRemainingCurrent) === 0);
  const toLeft = (t: { timeoutsRemainingCurrent?: number } | undefined): number | null =>
    state === 'in' && !sitDead && t && Number.isFinite(Number(t.timeoutsRemainingCurrent)) ? Number(t.timeoutsRemainingCurrent) : null;
  const homeRight = homeAttacksRight(fmt, Math.max(1, period));

  // lastFiveGames: one block per team; events oldest first; score is "home-away"? No:
  // verified on NBA 401902644 — score "126-104" is the winner-first display with
  // homeTeamScore/awayTeamScore alongside, so the numbers are rebuilt from those.
  const last5For = (teamId: string): Last5Game[] => {
    const blk = arr(summary?.lastFiveGames).find((b: Json) => String(b?.team?.id) === teamId);
    return arr(blk?.events).slice(-5).map((e) => {
      const home = String(e?.homeTeamId) === teamId;
      const mine = num(home ? e?.homeTeamScore : e?.awayTeamScore);
      const theirs = num(home ? e?.awayTeamScore : e?.homeTeamScore);
      return {
        opp: String(e?.opponent?.abbreviation ?? e?.opponent?.displayName ?? '').slice(0, 4),
        oppId: String(e?.opponent?.id ?? (home ? e?.awayTeamId : e?.homeTeamId) ?? ''),
        oppLogo: String(e?.opponentLogo ?? ''),
        home,
        won: String(e?.gameResult ?? '').toUpperCase() === 'W',
        score: `${mine}-${theirs}`,
        ot: /OT/i.test(String(e?.score ?? '')),
      };
    });
  };
  const streakFor = (teamId: string): string => {
    for (const g of arr(summary?.standings?.groups)) {
      for (const e of arr(g?.standings?.entries)) {
        if (String(e?.id) !== teamId) continue;
        const st = arr(e?.stats).find((x: Json) => x?.name === 'streak');
        return String(st?.displayValue ?? '');
      }
    }
    return '';
  };

  const team = (c: Json, side: Side): TeamView => {
    const t = c?.team ?? {};
    const logos: Json[] = arr(t.logos);
    const logo = String(logos.find((l) => arr(l?.rel).includes('default'))?.href ?? logos[0]?.href ?? t.logo ?? '');
    const logoDark = String(logos.find((l) => arr(l?.rel).includes('dark'))?.href ?? logo);
    const rec = Array.isArray(c?.record) ? c.record : Array.isArray(c?.records) ? c.records : [];
    const rankRaw = rankOf(c);   // the AP rank: curatedRank.current (99 = unranked) or rank, 1-25 only
    const oppFouls = foulsByBucket.get(`${1 - side}:${bucket}`) ?? 0;
    return {
      id: String(t.id ?? ''),
      abbr: String(t.abbreviation ?? ''),
      name: String(t.displayName ?? ''),
      short: String(t.name ?? t.shortDisplayName ?? t.abbreviation ?? ''),
      color: hex(t.color, side === 1 ? '#1d428a' : '#c8102e'),
      alt: hex(t.alternateColor, '#ffffff'),
      logo,
      logoDark,
      score: num(c?.score),
      record: String(rec.find((r: Json) => r?.type === 'total')?.summary ?? rec[0]?.summary ?? ''),
      split: (() => {
        const want = side === 1 ? 'home' : 'road';
        const r = rec.find((x: Json) => x?.type === want);
        return r ? `${side === 1 ? 'Home' : 'Away'} ${r.summary}` : '';
      })(),
      confRecord: isCollege(league) ? String(rec.find((r: Json) => r?.type === 'vsconf')?.summary ?? '') : '',
      rank: rankRaw || null,
      last5: last5For(String(t.id ?? '')),
      streak: streakFor(String(t.id ?? '')),
      linescores: arr(c?.linescores).map((l: Json) => num(l?.displayValue ?? l?.value)),
      fouls: state === 'in' ? foulsByBucket.get(`${side}:${bucket}`) ?? 0 : 0,
      bonus: state === 'in' ? bonusFrom(league, fmt, Math.max(1, period), oppFouls, foulsLast2.get(`${1 - side}:${period}`) ?? 0) : 'none',
      timeoutsLeft: toLeft(side === 1 ? sit?.homeTimeouts : sit?.awayTimeouts),
      attacksRight: side === 1 ? homeRight : !homeRight,
    };
  };
  const teams: [TeamView, TeamView] = [team(awayC, 0), team(homeC, 1)];

  // Live payloads can lag the play feed by a poll; the last play's score is authoritative when newer.
  if (state === 'in' && lastPlay) {
    teams[0].score = Math.max(teams[0].score, num(lastPlay.awayScore));
    teams[1].score = Math.max(teams[1].score, num(lastPlay.homeScore));
  }

  // ── play views ───────────────────────────────────────────────────────────
  const playView = (p: Json, i: number): PlayView => {
    const side = sideOf(p?.team?.id);
    const shot = shotByPlayIdx.get(i);
    let kind: EventKind = 'other';
    let label = '';
    if (shot) {
      if (shot.made) {
        kind = shot.pts === 3 ? 'made3' : 'made2';
        label = `+${shot.pts}`;
      } else if (isBlocked(p)) { kind = 'block'; label = 'BLOCK'; }
      else { kind = 'miss'; label = shot.pts === 3 ? 'MISSED 3' : 'MISS'; }
    } else if (isFT(p)) {
      const trip = ftTrip(p);
      const tag = isTechnicalFT(p) ? 'TECH FT' : trip ? `FT ${trip.n} OF ${trip.m}` : 'FT';
      kind = p.scoringPlay ? 'ft' : 'ftmiss';
      label = p.scoringPlay ? `+1 ${tag}` : `MISSED ${tag}`;
    } else if (isFoul(p)) {
      kind = 'foul';
      label = /technical/i.test(typeText(p)) ? 'TECHNICAL' : /flagrant/i.test(typeText(p)) ? 'FLAGRANT' : /offensive/i.test(typeText(p)) ? 'OFFENSIVE FOUL' : 'FOUL';
    } else if (isTimeout(p)) { kind = 'timeout'; label = /official|tv/i.test(typeText(p)) ? 'OFFICIAL TIMEOUT' : 'TIMEOUT'; }
    else if (isRebound(p)) { kind = 'rebound'; label = /offensive/i.test(typeText(p) + playText(p)) ? 'OFF REBOUND' : 'REBOUND'; }
    else if (isSteal(p)) { kind = 'steal'; label = 'STEAL'; }
    else if (isTurnover(p)) { kind = /steal/i.test(playText(p)) ? 'steal' : 'turnover'; label = kind === 'steal' ? 'STEAL' : 'TURNOVER'; }
    else if (isJumpBall(p)) { kind = 'jumpball'; label = 'JUMP BALL'; }
    else if (isEndPeriod(p)) { kind = 'period'; label = /game/i.test(typeText(p)) ? 'FINAL' : `END ${periodLabel(league, fmt, num(p?.period?.number, 1)).toUpperCase()}`; }
    else if (isReview(p)) { kind = 'review'; label = 'REVIEW'; }
    if (shot?.andOne) { kind = 'andone'; label = `AND-ONE +${shot.pts}`; }
    return {
      id: String(p?.id ?? i),
      kind,
      label,
      text: playText(p),
      side,
      period: num(p?.period?.number, 1),
      clock: String(p?.clock?.displayValue ?? ''),
      score: [num(p?.awayScore), num(p?.homeScore)],
      scoring: !!p?.scoringPlay,
      e: Math.round(elapsedAt(fmt, num(p?.period?.number, 1), String(p?.clock?.displayValue ?? ''))),
      wp: wpById.get(String(p?.id)) ?? null,
    };
  };

  const recent: PlayView[] = [];
  let last: PlayView | null = null;
  for (let i = plays.length - 1; i >= 0 && recent.length < 12; i--) {
    const p = plays[i];
    if (/substitution/i.test(typeText(p))) continue;
    const v = playView(p, i);
    if (!last && v.kind !== 'other') last = v;
    recent.push(v);
  }

  // ── lead tracker + current run ───────────────────────────────────────────
  const lead: Array<[number, number]> = [[0, 0]];
  let pa = 0;
  let ph = 0;
  const scores: Array<{ e: number; side: Side; pts: number }> = [];
  for (const p of plays) {
    const a = num(p?.awayScore, pa);
    const h = num(p?.homeScore, ph);
    if (a === pa && h === ph) continue;
    const e = elapsedAt(fmt, num(p?.period?.number, 1), String(p?.clock?.displayValue ?? ''));
    if (a > pa) scores.push({ e, side: 0, pts: a - pa });
    if (h > ph) scores.push({ e, side: 1, pts: h - ph });
    pa = a; ph = h;
    lead.push([Math.round(e), h - a]);
  }
  const lastPeriod = Math.max(fmt.periods, period);
  const length = periodStart(fmt, lastPeriod) + periodLength(fmt, lastPeriod);
  const nowE = state === 'post' ? length : lastPlay ? elapsedAt(fmt, num(lastPlay?.period?.number, 1), String(lastPlay?.clock?.displayValue ?? '')) : 0;
  const run = currentRun(scores, nowE);

  const last8wp = plays.length ? wpById.get(String(plays[plays.length - 1]?.id)) ?? null : null;
  const venue = summary?.gameInfo?.venue;
  const bcs: Json[] = arr(comp?.broadcasts);
  const bc = bcs.find((b: Json) => b?.isNational) ?? bcs[0];
  const broadcasts = bcs
    .map((b: Json) => ({ name: String(b?.media?.shortName ?? '').trim(), type: String(b?.market?.type ?? (b?.isNational ? 'National' : '')).trim() }))
    .filter((b: { name: string }) => b.name)
    .sort((a: { type: string }, b: { type: string }) => Number(b.type === 'National') - Number(a.type === 'National'));

  // ── full play list + win probability series (Plays / Win % tabs) ─────────
  const allPlays: PlayView[] = [];
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    if (/substitution/i.test(typeText(p))) continue;
    allPlays.push(playView(p, i));
  }

  // ── pregame: odds, injuries, note ────────────────────────────────────────
  const pc: Json = arr(summary?.pickcenter)[0];
  const fmtMl = (v: unknown): string => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? (n > 0 ? `+${n}` : String(n)) : '';
  };
  const odds: OddsView | null = pc
    ? {
        provider: String(pc.provider?.name ?? ''),
        line: String(pc.details ?? ''),
        overUnder: Number.isFinite(Number(pc.overUnder)) ? Number(pc.overUnder) : null,
        moneyline: [fmtMl(pc.awayTeamOdds?.moneyLine), fmtMl(pc.homeTeamOdds?.moneyLine)],
      }
    : null;

  let injuries: [InjuryView[], InjuryView[]] | null = null;
  if (Array.isArray(summary?.injuries)) {
    injuries = [[], []];
    for (const block of summary.injuries) {
      const side = sideOf(block?.team?.id);
      if (side == null) continue;
      for (const inj of arr(block?.injuries)) {
        const aid = String(inj?.athlete?.id ?? '');
        injuries[side].push({
          id: aid,
          // Injury entries carry the athlete's headshot when ESPN has one; otherwise the same CDN path the box score uses.
          headshot: String(inj?.athlete?.headshot?.href ?? (aid && !isCollege(league) ? `https://a.espncdn.com/i/headshots/${league}/players/full/${aid}.png` : '')),
          name: String(inj?.athlete?.displayName ?? ''),
          pos: String(inj?.athlete?.position?.abbreviation ?? ''),
          status: String(inj?.status ?? inj?.details?.fantasyStatus?.displayDescription ?? ''),
          detail: String(inj?.details?.type ?? ''),
        });
      }
    }
  }

  /**
   * Series context. ESPN lists the regular-season head-to-head FIRST and the
   * playoff series second (header.competitions[0].series is an array; the
   * top-level seasonseries carries the round name), so a playoff game must
   * pick the playoff entry or it reads "IND wins series 2-1" before Game 3.
   * Verified on WNBA 401918018 (First Round Game 2, 2026-09-29).
   */
  type SeriesInfo = { note: string; round: string; status: string };
  const seriesInfo = (): SeriesInfo => {
    const none: SeriesInfo = { note: '', round: '', status: '' };
    const many = (x: unknown): Json[] => (Array.isArray(x) ? x : x ? [x] : []);   // a lone series object is valid here
    const all: Json[] = [...many(comp?.series), ...many(summary?.seasonseries)].filter(Boolean);
    // The scoreboard-style entry in comp.series can be a bare { type: 'playoff' } with the round
    // name only on the seasonseries entry: prefer the entry that actually names the round.
    const playoff = all.find((x) => x?.type === 'playoff' && (x.round || x.description || x.title)) ?? all.find((x) => x?.type === 'playoff');
    const ser: Json = playoff ?? all[0];
    if (!ser) return none;
    const raw = String(ser.summary ?? '').trim();
    // "LV leads series 1-0" -> "LV leads 1-0"; "Series tied 1-1" keeps its wording.
    const status = /^series starts/i.test(raw) ? '' : /^series tied/i.test(raw) ? raw.replace(/\s+/g, ' ') : raw.replace(/\bseries\b/i, '').replace(/\s+/g, ' ').trim();
    if (playoff) {
      // Round names arrive as "WNBA Semifinals", "First Round", "NBA Finals"; strip the league prefix.
      const round = String(playoff.round ?? playoff.description ?? playoff.title ?? '')
        .replace(/^(wnba|nba)\s+/i, '').trim();
      const wins = arr(playoff.competitors).reduce((n: number, c: Json) => n + num(c?.wins), 0);
      const game = wins + (state === 'post' ? 0 : 1);
      const total = num(playoff.totalCompetitions);
      const gameLabel = total ? `Game ${game} of ${total}` : `Game ${game}`;
      // Game 1 shows the round alone: nothing to lead until Game 2.
      const shown = game > 1 ? status : '';
      return { note: [round, gameLabel, shown].filter(Boolean).join(' · '), round, status: shown };
    }
    // Regular season: only worth a line once the teams have met.
    const played = arr(ser.competitors).reduce((n: number, c: Json) => n + num(c?.wins) + num(c?.ties), 0);
    return played ? { note: `Season series: ${status}`, round: '', status } : none;
  };
  const series = seriesInfo();

  // ── postgame: box score, team stats, top performers ──────────────────────
  const COLS: Array<[string, string]> = [
    ['minutes', 'MIN'], ['points', 'PTS'], ['rebounds', 'REB'], ['assists', 'AST'],
    ['fieldGoalsMade-fieldGoalsAttempted', 'FG'], ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'], ['freeThrowsMade-freeThrowsAttempted', 'FT'],
    ['offensiveRebounds', 'OREB'], ['defensiveRebounds', 'DREB'], ['steals', 'STL'], ['blocks', 'BLK'], ['turnovers', 'TO'], ['fouls', 'PF'], ['plusMinus', '+/-'],
  ];
  let box: BoxView | null = null;
  const perfPool: Array<PerformerView & { pts: number; reb: number; ast: number }> = [];
  {
    const rows: [BoxRow[], BoxRow[]] = [[], []];
    const totals: [string[], string[]] = [[], []];
    let anyKeys: string[] | null = null;
    for (const block of arr(summary?.boxscore?.players)) {
      const side = sideOf(block?.team?.id);
      const grp = arr(block?.statistics)[0];
      if (side == null || !grp) continue;
      const keys: string[] = arr(grp.keys);
      anyKeys = anyKeys ?? keys;
      const idx = COLS.map(([k]) => keys.indexOf(k));
      const pick = (arr: unknown[]): string[] => idx.map((i) => (i >= 0 ? String(arr[i] ?? '') : ''));
      for (const a of arr(grp.athletes)) {
        const st: unknown[] = arr(a?.stats);
        const dnp = a?.didNotPlay ? String(a?.reason ?? 'DNP') : null;
        const fouls = dnp ? 0 : num(st[keys.indexOf('fouls')]);
        const row: BoxRow = {
          id: String(a?.athlete?.id ?? ''),
          name: String(a?.athlete?.shortName ?? a?.athlete?.displayName ?? ''),
          jersey: String(a?.athlete?.jersey ?? ''),
          pos: String(a?.athlete?.position?.abbreviation ?? ''),
          starter: !!a?.starter,
          dnp,
          headshot: String(a?.athlete?.headshot?.href ?? ''),
          stats: dnp ? [] : pick(st),
          fouls,
          foul: foulTier(league, fouls, period, fmt.periods, state === 'in'),
        };
        rows[side].push(row);
        if (!dnp) {
          const g = (k: string): number => num(st[keys.indexOf(k)]);
          perfPool.push({ id: row.id, side, name: String(a?.athlete?.displayName ?? row.name), headshot: row.headshot, line: '', pts: g('points'), reb: g('rebounds'), ast: g('assists') });
        }
      }
      totals[side] = pick(arr(grp.totals));
    }
    if (anyKeys) {
      const present = COLS.filter(([k]) => anyKeys!.includes(k));
      const keep = COLS.map(([k]) => anyKeys!.includes(k));
      const trim = (arr: string[]): string[] => arr.filter((_, i) => keep[i]);
      box = {
        cols: present.map(([, label]) => label),
        rows: [rows[0].map((r) => ({ ...r, stats: r.stats.length ? trim(r.stats) : [] })), rows[1].map((r) => ({ ...r, stats: r.stats.length ? trim(r.stats) : [] }))],
        totals: [trim(totals[0]), trim(totals[1])],
      };
    }
  }
  const performers: PerformerView[] = perfPool
    .filter((p) => p.pts + p.reb + p.ast > 0)      // all zeros = the box score hasn't started populating; show nobody rather than "0 PTS"
    .sort((a, b) => b.pts - a.pts || b.reb + b.ast - (a.reb + a.ast))
    .slice(0, 3)
    .map((p) => ({ id: p.id, side: p.side, name: p.name, headshot: p.headshot, line: `${p.pts} PTS · ${p.reb} REB · ${p.ast} AST` }));

  const TEAM_STATS: Array<[string, string, boolean]> = [
    ['fieldGoalsMade-fieldGoalsAttempted', 'Field goals', false], ['fieldGoalPct', 'FG %', true],
    ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3-pointers', false], ['threePointFieldGoalPct', '3PT %', true],
    ['freeThrowsMade-freeThrowsAttempted', 'Free throws', false], ['freeThrowPct', 'FT %', true],
    ['totalRebounds', 'Rebounds', true], ['offensiveRebounds', 'Off. rebounds', true], ['assists', 'Assists', true],
    ['steals', 'Steals', true], ['blocks', 'Blocks', true], ['totalTurnovers', 'Turnovers', true],
    ['pointsInPaint', 'Points in paint', true], ['fastBreakPoints', 'Fast break pts', true], ['turnoverPoints', 'Pts off turnovers', true],
    ['largestLead', 'Largest lead', true], ['fouls', 'Fouls', true],
  ];
  let leadChanges: number | null = null;
  const teamStats: TeamStatView[] = [];
  {
    const byTeam: [Map<string, string>, Map<string, string>] = [new Map(), new Map()];
    for (const t of arr(summary?.boxscore?.teams)) {
      const side = sideOf(t?.team?.id);
      if (side == null) continue;
      for (const st of arr(t?.statistics)) byTeam[side].set(String(st?.name), String(st?.displayValue ?? ''));
    }
    const lc = num(byTeam[1].get('leadChanges'), NaN);
    if (Number.isFinite(lc)) leadChanges = lc;
    if (byTeam[0].size && byTeam[1].size) {
      for (const [key, label, bar] of TEAM_STATS) {
        const a = byTeam[0].get(key);
        const h = byTeam[1].get(key);
        if (a == null || h == null) continue;
        const an = num(a, NaN);
        const hn = num(h, NaN);
        const share = bar && Number.isFinite(an) && Number.isFinite(hn) && an + hn > 0 ? an / (an + hn) : null;
        teamStats.push({ label, vals: [a, h], awayShare: share });
      }
    }
  }

  const detail = state === 'in'
    ? String(stType.shortDetail ?? `${periodLabel(league, fmt, period)} ${clock}`)
    : String(stType.shortDetail ?? stType.detail ?? '');

  const view: GameView = {
    v: 1,
    league,
    eventId,
    state,
    detail,
    period,
    periodLabel: periodLabel(league, fmt, period),
    clock,
    regPeriods: fmt.periods,
    teams,
    possession: state === 'in' ? possession : null,
    last,
    recent,
    shots,
    players,
    run,
    lead,
    length,
    wp: last8wp,
    venue: String(venue?.fullName ?? ''),
    neutral: comp?.neutralSite === true,
    city: [venue?.address?.city, venue?.address?.state].filter(Boolean).join(', '),
    broadcast: String(bc?.media?.shortName ?? ''),
    broadcasts,
    tipoff: Date.parse(String(comp?.date ?? '')) || 0,
    note: series.note,
    seriesRound: series.round,
    seriesStatus: series.status,
    headline: String(comp?.notes?.[0]?.headline ?? ''),
    odds,
    injuries,
    // No game stats before tipoff (the replay harness keeps the final box score on a pre cut).
    box: state === 'pre' ? null : box,
    teamStats: state === 'pre' ? [] : teamStats,
    performers: state === 'pre' ? [] : performers,
    plays: allPlays,
    leadChanges: state === 'pre' ? null : leadChanges,
    clutch: state === 'in' && period >= fmt.periods && clockSeconds(clock) <= 300 && clockSeconds(clock) > 0
      && Math.abs(teams[0].score - teams[1].score) <= 5 && !/half|^end/i.test(String(stType.shortDetail ?? '')),
    season: { year: num(summary?.header?.season?.year, new Date().getUTCFullYear()), type: num(summary?.header?.season?.type, 2) },
    attendance: Number.isFinite(Number(summary?.gameInfo?.attendance)) && Number(summary?.gameInfo?.attendance) > 0 ? Number(summary.gameInfo.attendance) : null,
    officials: arr(summary?.gameInfo?.officials)
      .slice()
      .sort((a: Json, b: Json) => num(a?.order) - num(b?.order))
      .map((o: Json) => String(o?.displayName ?? o?.fullName ?? '')).filter(Boolean),
    // Only with a real status clock: an empty one (status feed dead, or halftime with no clock) would
    // read as 0:00 and show a full period of lag.
    feedLag: state === 'in' && lastPlay && period > 0 && String(st.displayClock ?? '').trim() !== ''
      ? Math.max(0, Math.round(elapsedAt(fmt, period, clock) - elapsedAt(fmt, num(lastPlay?.period?.number, period), String(lastPlay?.clock?.displayValue ?? clock))))
      : 0,
    statusClock: String(st.displayClock ?? ''),
    statusPeriod: num(st.period, 0),
    lastPlayId: String(lastPlay?.id ?? ''),
    statusSince: input.now ?? Date.now(),
    playAtStatus: String(lastPlay?.id ?? ''),
    clockSource: 'status',
    updated: input.now ?? Date.now(),
  };
  return { view, diag: { possChecks, possHits } };
}

/** How long ESPN's status clock may sit still while plays arrive before the plays run the clock. */
export const STUCK_CLOCK_MS = 90_000;

/**
 * A status clock that has not moved for STUCK_CLOCK_MS while new plays came in is stuck (ESPN's
 * own page shows the same: a dead "0.0 - 3rd" over a live play list). The clock, period and
 * detail then come from the latest play, which carries its own period and clock, and the status
 * clock takes over again the moment it changes. A clock sitting still with no new plays (halftime,
 * the break after a period, a timeout) is not stuck. `prev` is the view from the previous poll.
 */
export function reconcileClock(view: GameView, prev: Pick<GameView, 'statusClock' | 'statusPeriod' | 'statusSince' | 'playAtStatus'> | null, now: number): void {
  if (view.state !== 'in') return;
  if (prev && prev.statusClock === view.statusClock && prev.statusPeriod === view.statusPeriod && prev.statusSince) {
    view.statusSince = prev.statusSince;
    view.playAtStatus = prev.playAtStatus;
  } else {
    view.statusSince = now;
    view.playAtStatus = view.lastPlayId;
  }
  const last = view.plays?.[view.plays.length - 1];
  const stuck = !!last && !!view.lastPlayId && view.lastPlayId !== view.playAtStatus && now - view.statusSince >= STUCK_CLOCK_MS && last.period > 0 && last.clock !== '';
  if (!stuck) return;
  const fmt: Format = { periods: view.regPeriods, reg: view.league === 'ncaam' ? 1200 : view.league === 'nba' ? 720 : 600, ot: 300 };
  view.period = last.period;
  view.periodLabel = periodLabel(view.league, fmt, last.period);
  view.clock = last.clock;
  view.detail = `${view.periodLabel} ${last.clock}`;
  view.clockSource = 'plays';
}

/**
 * The current run, ESPN-style ("8-0 run in last 2:09"): walk back from the
 * latest score while the other side has scored at most 2 points, and report it
 * if the running side has at least 7 and a lead of 7+ inside the run.
 */
function currentRun(scores: Array<{ e: number; side: Side; pts: number }>, nowE: number): RunView | null {
  const latest = scores[scores.length - 1];
  if (!latest) return null;
  const side = latest.side;
  let pts = 0;
  let opp = 0;
  let start = latest.e;
  for (let i = scores.length - 1; i >= 0; i--) {
    const s = scores[i];
    if (!s) break;
    if (s.side === side) { pts += s.pts; start = s.e; }
    else if (opp + s.pts <= 2 && pts - (opp + s.pts) >= 5) { opp += s.pts; }
    else break;
  }
  if (pts < 6 || pts - opp < 6) return null;   // 6-0, 8-2, 9-3 ... count as a run
  const span = Math.max(0, Math.round(nowE - start));
  return { side, pts, opp, span: `${Math.floor(span / 60)}:${String(span % 60).padStart(2, '0')}` };
}
