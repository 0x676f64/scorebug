// src/server/basketball/espn.ts — ESPN basketball feeds with the shared cache.
//
// Ported from nba-hub/src/server/espn.ts: same fast-feed overlay (core status +
// core plays on a cached site summary), same build lock and last-good view.
// Devvit's redis → cache(); the team-day/standings feeds stay in the Devvit app.
// Added for scorebug: the scoreboard event as the floor when the summary dies,
// per-field stamps, and `mode`, matching football.

import { cache } from '../cache.ts';
import type { Feeds, FeedHealth, Source, Stamp } from '../../shared/types.ts';
import type { BasketballGameView, GameState, GameView, League } from '../../shared/basketball.ts';
import { ESPN_LEAGUE, isCollege } from '../../shared/basketball.ts';
import { buildGameView, reconcileClock, type SituationFeed } from './engine.ts';

export type BasketballLeague = 'nba' | 'wnba' | 'ncaam' | 'ncaaw';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues';
const PATH = ESPN_LEAGUE;

const VIEW_TTL: Record<GameState, number> = { in: 3, pre: 60, post: 600, postponed: 600 };
const SUMMARY_TTL_FAST_MS = 12_000;
const LOCK_MS = 4_000;
const LOCK_WAIT_MS = 300;
const LOCK_TRIES = 3;
const FETCH_TIMEOUT_MS = 6_000;
const SB_TTL_MS = 15_000;
/** How long a LOWER score must persist before it is shown. */
const SCORE_DROP_MS = 12_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'scorebug/0.1 (+https://github.com/0x676f64)' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export const summaryUrl = (league: League, eventId: string): string => `${SITE}/${PATH[league]}/summary?event=${encodeURIComponent(eventId)}`;
export const scoreboardUrl = (league: League, yyyymmdd?: string): string => {
  const extra = isCollege(league) ? '&groups=50&limit=400' : '';
  return `${SITE}/${PATH[league]}/scoreboard?${yyyymmdd ? `dates=${yyyymmdd}` : ''}${extra}`;
};
const situationUrl = (l: League, id: string): string => `${CORE}/${PATH[l]}/events/${id}/competitions/${id}/situation`;
const statusUrl = (l: League, id: string): string => `${CORE}/${PATH[l]}/events/${id}/competitions/${id}/status`;
const playsUrl = (l: League, id: string): string => `${CORE}/${PATH[l]}/events/${id}/competitions/${id}/plays?limit=1000`;

const emptyHealth = (): FeedHealth => ({ okAt: 0, failAt: 0, reason: '', fails: 0 });
const emptyFeeds = (): Feeds => ({ summary: emptyHealth(), scoreboard: emptyHealth(), coreStatus: emptyHealth(), corePlays: emptyHealth(), coreSituation: emptyHealth() });
const mark = (feeds: Feeds, name: keyof Feeds, ok: boolean, reason = ''): void => {
  const h = feeds[name];
  if (ok) { h.okAt = Date.now(); h.fails = 0; h.reason = ''; } else { h.failAt = Date.now(); h.fails++; h.reason = reason; }
};
const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^AbortError.*/, 'timeout') : String(e));

// ── fast live feeds (verbatim from nba-hub) ──────────────────────────────

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const refId = (ref: unknown): string => (String(ref ?? '').match(/\/(\d+)(?:\?|$)/) ?? [])[1] ?? '';
const idOf = (o: any): string => String(o?.id ?? refId(o?.$ref) ?? '');

function normalisePlay(p: any): any {
  return {
    ...p,
    team: p?.team ? { ...p.team, id: idOf(p.team) } : undefined,
    participants: Array.isArray(p?.participants)
      ? p.participants.map((x: any) => ({ ...x, athlete: x?.athlete ? { ...x.athlete, id: idOf(x.athlete) } : undefined }))
      : undefined,
  };
}

async function fetchFast(league: League, eventId: string, feeds: Feeds): Promise<{ status: any; plays: any[] }> {
  const [status, plays] = await Promise.all([
    getJson(statusUrl(league, eventId)).then((j) => { mark(feeds, 'coreStatus', !!j?.type?.state, 'empty'); return j; }).catch((e) => { mark(feeds, 'coreStatus', false, errText(e)); return null; }),
    getJson(playsUrl(league, eventId)).then((j) => { mark(feeds, 'corePlays', Array.isArray(j?.items), 'empty'); return j; }).catch((e) => { mark(feeds, 'corePlays', false, errText(e)); return null; }),
  ]);
  return { status: status?.type?.state ? status : null, plays: Array.isArray(plays?.items) ? plays.items : [] };
}

function overlayFast(summary: any, fast: { status: any; plays: any[] }): void {
  const comp = summary?.header?.competitions?.[0];
  if (!comp) return;
  const sumState = comp.status?.type?.state;
  if (fast.status && fast.status.type?.state === sumState) {
    const { clock, displayClock, period, type } = fast.status;
    comp.status = { ...(comp.status ?? {}), clock, displayClock, period, type };
  }
  if (sumState !== 'in') return;
  const current: any[] = Array.isArray(summary?.plays) ? summary.plays : [];
  if (fast.plays.length && fast.plays.length >= current.length) {
    summary.plays = fast.plays.map(normalisePlay);
    const last = summary.plays[summary.plays.length - 1];
    for (const c of comp.competitors ?? []) {
      const sc = c?.homeAway === 'home' ? last?.homeScore : last?.awayScore;
      if (Number.isFinite(Number(sc)) && Number(sc) >= Number(c?.score ?? 0)) c.score = String(sc);
    }
  }
}

// ── scoreboard ───────────────────────────────────────────────────────────

export async function fetchScoreboard(league: League, yyyymmdd: string | undefined, feeds: Feeds = emptyFeeds()): Promise<any | null> {
  const c = cache();
  const key = `sb:${league}:${yyyymmdd ?? 'current'}`;
  const raw = await c.get(key).catch(() => null);
  const cached = raw ? (JSON.parse(raw) as { _at?: number }) : null;
  if (cached && Date.now() - (cached._at ?? 0) <= SB_TTL_MS) { mark(feeds, 'scoreboard', true); return cached; }
  try {
    const sb = await getJson(scoreboardUrl(league, yyyymmdd));
    if (!Array.isArray(sb?.events)) throw new Error('empty');
    sb._at = Date.now();
    await c.set(key, JSON.stringify(sb), { expiration: new Date(Date.now() + 10 * 60_000) }).catch(() => undefined);
    mark(feeds, 'scoreboard', true);
    return sb;
  } catch (e) {
    mark(feeds, 'scoreboard', false, errText(e));
    return cached;
  }
}

function yyyymmdd(offsetDays: number): string {
  const et = new Date(new Date(Date.now() + offsetDays * 86_400_000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
}

async function scoreboardEvent(league: League, eventId: string, feeds: Feeds): Promise<any | null> {
  for (const d of [undefined, yyyymmdd(0), yyyymmdd(-1)]) {
    const sb = await fetchScoreboard(league, d, feeds);
    const ev = (sb?.events ?? []).find((e: any) => String(e?.id) === eventId);
    if (ev) return ev;
    if (!sb) break;
  }
  return null;
}

/**
 * A summary-shaped object from a scoreboard event: enough for the engine to
 * build teams, status and score when the real summary is gone. No plays, no
 * box — the view keeps the previous plays (held) and runs on this status.
 */
function summaryFromScoreboard(ev: any): any {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  return { header: { id: ev.id, season: ev.season, competitions: [comp] }, plays: [], boxscore: {}, format: ev.format, gameInfo: { venue: comp.venue } };
}

// ── the view ─────────────────────────────────────────────────────────────

const stamp = (src: Source, at: number): Stamp => ({ src, at });

export function getView(league: BasketballLeague, eventId: string): Promise<BasketballGameView> {
  return getGameView(league, eventId);
}

export async function getGameView(league: League, eventId: string): Promise<BasketballGameView> {
  const c = cache();
  const key = `view:${league}:${eventId}`;
  const parse = (raw: string | null): (BasketballGameView & { _exp?: number }) | null => (raw ? JSON.parse(raw) : null);
  const fresh = (v: (BasketballGameView & { _exp?: number }) | null): BasketballGameView | null => (v && (v._exp ?? 0) > Date.now() ? strip(v) : null);
  let cached = parse(await c.get(key).catch(() => null));
  const hit = fresh(cached);
  if (hit) return hit;
  const lockKey = `lock:${key}`;
  const won = (await c.set(lockKey, '1', { nx: true, expiration: new Date(Date.now() + LOCK_MS) }).catch(() => 'OK')) === 'OK';
  if (!won) {
    if (cached) return strip(cached);
    for (let i = 0; i < LOCK_TRIES; i++) {
      await sleep(LOCK_WAIT_MS);
      cached = parse(await c.get(key).catch(() => null));
      const v = fresh(cached);
      if (v) return v;
    }
  }
  try {
    const prev = cached ? strip(cached) : null;
    const view = await buildFromFeeds(league, eventId, prev);
    const ttl = VIEW_TTL[view.state];
    await c.set(key, JSON.stringify({ ...view, _exp: Date.now() + ttl * 1000 }), { expiration: new Date(Date.now() + 6 * 3600 * 1000) }).catch(() => undefined);
    return view;
  } catch (err) {
    if (cached) return strip(cached);
    throw err;
  } finally {
    if (won) await c.del(lockKey).catch(() => undefined);
  }
}

/** One poll. Exported for the replay harness, which passes the feeds in. */
export async function buildFromFeeds(league: League, eventId: string, prev: BasketballGameView | null, now = Date.now()): Promise<BasketballGameView> {
  const c = cache();
  const feeds: Feeds = prev ? structuredClone(prev.feeds) : emptyFeeds();
  const sumKey = `summary:${league}:${eventId}`;
  const cachedSummary = await c.get(sumKey).catch(() => null);
  let summary = cachedSummary ? JSON.parse(cachedSummary) : null;
  let fast: { status: any; plays: any[] } | null = null;
  let situation: SituationFeed | null = null;
  if (summary) {
    fast = await fetchFast(league, eventId, feeds);
    if (!fast.plays.length || !fast.status || fast.status.type.state !== 'in') summary = null;
    else if (fast.plays.length < num(summary._nPlays)) summary = null;
  }
  const fromCache = !!summary;
  let summaryOk = fromCache;
  if (!summary) {
    try {
      summary = await getJson(summaryUrl(league, eventId));
      summaryOk = Array.isArray(summary?.header?.competitions?.[0]?.competitors) && summary.header.competitions[0].competitors.length >= 2;
      mark(feeds, 'summary', summaryOk, 'incomplete');
      if (!summaryOk) summary = null;
    } catch (e) { mark(feeds, 'summary', false, errText(e)); summary = null; }
  } else mark(feeds, 'summary', true);

  // Floor: the scoreboard event stands in for a dead summary.
  let sbEv: any = null;
  let mode: BasketballGameView['mode'] = 'full';
  if (!summary) {
    sbEv = await scoreboardEvent(league, eventId, feeds);
    const stand = summaryFromScoreboard(sbEv);
    if (stand) { summary = stand; mode = 'floor'; }
    else if (prev) { return held(prev, feeds, now); }
    else throw new Error(`no identity for ${eventId}: summary and scoreboard both empty`);
  }

  const live = summary?.header?.competitions?.[0]?.status?.type?.state === 'in';
  if (live) {
    const [sit, f] = await Promise.all([
      getJson(situationUrl(league, eventId)).then((j) => { mark(feeds, 'coreSituation', true); return j as SituationFeed; }).catch((e) => { mark(feeds, 'coreSituation', false, errText(e)); return null; }),
      fast ? Promise.resolve(fast) : fetchFast(league, eventId, feeds),
    ]);
    situation = sit;
    fast = f;
    overlayFast(summary, fast);
    const nPlays = Array.isArray(summary.plays) ? summary.plays.length : 0;
    if (mode === 'full' && fast.plays.length && fast.status && !fromCache && fast.plays.length >= nPlays) {
      const { plays: _p, ...rest } = summary;
      await c.set(sumKey, JSON.stringify({ ...rest, _nPlays: nPlays }), { expiration: new Date(Date.now() + SUMMARY_TTL_FAST_MS) }).catch(() => undefined);
    }
  }
  // Floor with no plays from anywhere: keep the previous plays so the court doesn't empty.
  if (mode === 'floor' && prev && !(Array.isArray(summary.plays) && summary.plays.length)) {
    summary.plays = [];   // the engine rebuilds from an empty list; plays/shots are patched from prev below
  }
  const base: GameView = buildGameView({ league, eventId, summary, situation, now });
  reconcileClock(base, prev, now);
  if (mode === 'floor' && prev && !base.plays?.length) {
    base.plays = prev.plays; base.shots = prev.shots; base.recent = prev.recent; base.last = prev.last; base.run = prev.run; base.lead = prev.lead; base.players = prev.players;
    base.possession = prev.possession; base.box = prev.box; base.teamStats = prev.teamStats; base.performers = prev.performers;
  }
  // A DROP is believed only once it has persisted (football's SCORE DROP rule): a feed that
  // blanks the score for one update must not show 0–0; a scoring change that stays is real.
  let scoreDropSince = 0, scoreDropTo = '';
  let scoreHeld = false;
  if (prev && base.state === 'in' && (base.teams[0].score < prev.teams[0].score || base.teams[1].score < prev.teams[1].score)) {
    const to = `${base.teams[0].score}-${base.teams[1].score}`;
    scoreDropSince = prev.scoreDropTo === to && prev.scoreDropSince ? prev.scoreDropSince : now;
    scoreDropTo = to;
    if (now - scoreDropSince < SCORE_DROP_MS) {
      base.teams = [{ ...base.teams[0], score: prev.teams[0].score }, { ...base.teams[1], score: prev.teams[1].score }];
      scoreHeld = true;
    } else { scoreDropSince = 0; scoreDropTo = ''; }
  }
  const scoreSrc: Source = scoreHeld ? 'held' : mode === 'floor' ? 'scoreboard' : (fast?.plays.length ? 'plays' : 'summary');
  const clockSrc: Source = base.clockSource === 'plays' ? 'plays' : mode === 'floor' ? 'scoreboard' : (fast?.status ? 'core' : 'summary');
  const playsSrc: Source = mode === 'floor' && prev && base.plays === prev.plays ? 'held' : (fast?.plays.length ? 'core' : 'summary');
  const scoreKey = `${base.teams[0].score}-${base.teams[1].score}`;
  const prevScoreKey = prev ? `${prev.teams[0].score}-${prev.teams[1].score}` : '';
  const clockChanged = !prev || base.clock !== prev.clock || base.period !== prev.period;
  return {
    ...base,
    sport: 'basketball',
    stamps: {
      score: stamp(scoreSrc, scoreKey !== prevScoreKey ? now : prev!.stamps.score.at),
      clock: stamp(clockSrc, clockChanged ? now : prev!.stamps.clock.at),
      period: stamp(clockSrc, clockChanged ? now : prev!.stamps.period.at),
      plays: stamp(playsSrc, !prev || base.lastPlayId !== prev.lastPlayId ? now : prev!.stamps.plays.at),
    },
    feeds, mode, built: now, scoreDropSince, scoreDropTo,
  };
}

function held(prev: BasketballGameView, feeds: Feeds, now: number): BasketballGameView {
  const h = (s: Stamp): Stamp => ({ src: 'held', at: s.at });
  return { ...prev, stamps: { score: h(prev.stamps.score), clock: h(prev.stamps.clock), period: h(prev.stamps.period), plays: h(prev.stamps.plays) }, feeds, mode: 'held', built: now };
}

function strip(v: BasketballGameView & { _exp?: number }): BasketballGameView { const { _exp, ...rest } = v; return rest; }

// ── slate ────────────────────────────────────────────────────────────────

export async function findEventForTeam(league: BasketballLeague, team: string): Promise<string | null> {
  const want = team.toUpperCase();
  for (const d of [undefined, yyyymmdd(-1)]) {
    const sb = await fetchScoreboard(league, d);
    for (const e of sb?.events ?? []) {
      const comps: any[] = e?.competitions?.[0]?.competitors ?? [];
      if (comps.some((c) => [c?.team?.abbreviation, c?.team?.id].map((x) => String(x ?? '').toUpperCase()).includes(want))) return String(e.id);
    }
  }
  return null;
}
