// src/server/football/espn.ts — ESPN football feeds with a shared cache.
//
// One fetch per TTL for every viewer: a busy overlay makes one ESPN round per
// cycle, not one per browser. Every feed is fetched independently with its own
// timeout and health record; the engine decides what each is good for.

import { cache } from '../cache.ts';
import type { FeedHealth, Feeds, FootballGameView, SlateGame, SlateView } from '../../shared/types.ts';
import { buildFootballView, emptyFeeds } from './engine.ts';

export type FootballLeague = 'nfl' | 'cfb';

const SITE: Record<FootballLeague, string> = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football',
};
const CORE: Record<FootballLeague, string> = {
  nfl: 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl',
  cfb: 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football',
};

/** Seconds a built view stays fresh, by phase. */
const VIEW_TTL = { in: 3, pre: 60, post: 600 } as const;
const LOCK_MS = 5_000;
const LOCK_WAIT_MS = 250;
const LOCK_TRIES = 4;
const FETCH_TIMEOUT_MS = 6_000;
const SB_TTL_MS = 15_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const summaryUrl = (l: FootballLeague, id: string): string => `${SITE[l]}/summary?event=${encodeURIComponent(id)}`;
export const scoreboardUrl = (l: FootballLeague, yyyymmdd?: string): string =>
  `${SITE[l]}/scoreboard?${yyyymmdd ? `dates=${yyyymmdd}&` : ''}${l === 'cfb' ? 'groups=80&limit=300' : 'limit=100'}`;
const coreBase = (l: FootballLeague, id: string): string => `${CORE[l]}/events/${id}/competitions/${id}`;

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'scorebug/0.1 (+https://github.com/0x676f64)' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Fetch with a health record: resolves the payload or null, never throws. */
async function feed(name: keyof Feeds, url: string, feeds: Feeds, validate?: (j: any) => boolean): Promise<any | null> {
  const h: FeedHealth = feeds[name];
  try {
    const j = await getJson(url);
    if (validate && !validate(j)) throw new Error('empty');
    h.okAt = Date.now(); h.fails = 0; h.reason = '';
    return j;
  } catch (err) {
    h.failAt = Date.now(); h.fails++; h.reason = err instanceof Error ? err.message.replace(/^AbortError.*/, 'timeout') : String(err);
    return null;
  }
}

// ── scoreboard ───────────────────────────────────────────────────────────

/** A league day's scoreboard, cached briefly; stale copy served on failure. */
export async function fetchScoreboard(league: FootballLeague, yyyymmdd: string | undefined, feeds: Feeds = emptyFeeds()): Promise<any | null> {
  const c = cache();
  const key = `sb:${league}:${yyyymmdd ?? 'current'}`;
  const raw = await c.get(key).catch(() => null);
  const cached = raw ? (JSON.parse(raw) as { _at?: number }) : null;
  if (cached && Date.now() - (cached._at ?? 0) <= SB_TTL_MS) { feeds.scoreboard.okAt = cached._at ?? Date.now(); return cached; }
  const sb = await feed('scoreboard', scoreboardUrl(league, yyyymmdd), feeds, (j) => Array.isArray(j?.events));
  if (sb) {
    sb._at = Date.now();
    await c.set(key, JSON.stringify(sb), { expiration: new Date(Date.now() + 10 * 60_000) }).catch(() => undefined);
    return sb;
  }
  return cached;   // last good slate beats nothing
}

/** The scoreboard event for one game: today's slate first, then yesterday's (late games cross midnight UTC). */
async function scoreboardEvent(league: FootballLeague, eventId: string, feeds: Feeds): Promise<any | null> {
  const days = [undefined, yyyymmdd(0), yyyymmdd(-1)];
  for (const d of days) {
    const sb = await fetchScoreboard(league, d, feeds);
    const ev = (sb?.events ?? []).find((e: any) => String(e?.id) === eventId);
    if (ev) return ev;
    if (!sb) break;   // feed down; don't hammer three times
  }
  return null;
}

function yyyymmdd(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  // ESPN slates roll on US Eastern; use ET.
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
}

// ── the game view ────────────────────────────────────────────────────────

const viewKey = (l: FootballLeague, id: string): string => `view:${l}:${id}`;

/**
 * The FootballGameView for one event. Cached; rebuilt from fresh feeds when
 * stale. A rebuild that cannot get identity from anywhere serves the last good
 * view rather than an error.
 */
export async function getFootballView(league: FootballLeague, eventId: string): Promise<FootballGameView> {
  const c = cache();
  const key = viewKey(league, eventId);
  const parse = (raw: string | null): (FootballGameView & { _exp?: number }) | null => (raw ? JSON.parse(raw) : null);
  const fresh = (v: (FootballGameView & { _exp?: number }) | null): FootballGameView | null => (v && (v._exp ?? 0) > Date.now() ? strip(v) : null);

  let cachedRaw = await c.get(key).catch(() => null);
  let cached = parse(cachedRaw);
  const hit = fresh(cached);
  if (hit) return hit;

  const lockKey = `lock:${key}`;
  const won = (await c.set(lockKey, '1', { nx: true, expiration: new Date(Date.now() + LOCK_MS) }).catch(() => 'OK')) === 'OK';
  if (!won) {
    if (cached) return strip(cached);
    for (let i = 0; i < LOCK_TRIES; i++) {
      await sleep(LOCK_WAIT_MS);
      cachedRaw = await c.get(key).catch(() => null);
      cached = parse(cachedRaw);
      const v = fresh(cached);
      if (v) return v;
    }
  }
  try {
    const prev = cached ? strip(cached) : null;
    const view = await buildFromFeeds(league, eventId, prev);
    const ttl = VIEW_TTL[view.phase];
    await c.set(key, JSON.stringify({ ...view, _exp: Date.now() + ttl * 1000 }), { expiration: new Date(Date.now() + 6 * 3600 * 1000) }).catch(() => undefined);
    return view;
  } catch (err) {
    if (cached) return strip(cached);
    throw err;
  } finally {
    if (won) await c.del(lockKey).catch(() => undefined);
  }
}

/** One poll: every feed in parallel, then the engine. Exported for the replay harness. */
export async function buildFromFeeds(league: FootballLeague, eventId: string, prev: FootballGameView | null, now = Date.now()): Promise<FootballGameView> {
  const feeds: Feeds = prev ? structuredClone(prev.feeds) : emptyFeeds();
  const live = !prev || prev.phase === 'in' || (prev.phase === 'pre' && new Date(prev.date).getTime() - now < 30 * 60_000);
  const base = coreBase(league, eventId);
  const [summary, sbEv, coreStatus, coreSituation, corePlaysRaw] = await Promise.all([
    feed('summary', summaryUrl(league, eventId), feeds, (j) => !!j?.header?.competitions?.[0]),
    scoreboardEvent(league, eventId, feeds),
    live ? feed('coreStatus', `${base}/status`, feeds, (j) => !!j?.type?.state) : null,
    live ? feed('coreSituation', `${base}/situation`, feeds) : null,
    live ? feed('corePlays', `${base}/plays?limit=1000`, feeds, (j) => Array.isArray(j?.items)) : null,
  ]);
  return buildFootballView({
    league, eventId, summary, scoreboardEvent: sbEv, coreStatus, coreSituation,
    corePlays: corePlaysRaw ? corePlaysRaw.items : null,
    feeds, prev, now,
  });
}

function strip(v: FootballGameView & { _exp?: number }): FootballGameView { const { _exp, ...rest } = v; return rest; }

// ── slate ────────────────────────────────────────────────────────────────

export async function getSlate(league: FootballLeague, date?: string): Promise<SlateView> {
  const sb = await fetchScoreboard(league, date?.replaceAll('-', ''));
  const games: SlateGame[] = (sb?.events ?? []).map((e: any) => {
    const comp = e?.competitions?.[0] ?? {};
    const comps: any[] = comp.competitors ?? [];
    const home = comps.find((c) => c?.homeAway === 'home') ?? {};
    const away = comps.find((c) => c?.homeAway === 'away') ?? {};
    const team = (c: any) => {
      const t = c?.team ?? {}; const r = Number(c?.curatedRank?.current ?? c?.rank) || 0;
      return { id: String(t.id ?? ''), abbr: String(t.abbreviation ?? ''), short: String(t.location ?? t.shortDisplayName ?? ''), score: Number(c?.score ?? 0) || 0, rank: r >= 1 && r <= 25 ? r : null, logo: String(t.logo ?? ''), color: t.color ? '#' + String(t.color).replace(/^#/, '') : '' };
    };
    const st = comp.status?.type ?? {};
    return {
      eventId: String(e?.id ?? ''), league, date: String(comp.date ?? e?.date ?? ''),
      phase: st.state === 'in' || st.state === 'post' ? st.state : 'pre',
      statusDetail: String(st.shortDetail ?? ''), period: Number(comp.status?.period ?? 0) || 0, clock: String(comp.status?.displayClock ?? ''),
      home: team(home), away: team(away),
      possession: comp.situation?.possession != null ? String(comp.situation.possession) : null,
      network: String(comp.broadcasts?.[0]?.names?.[0] ?? comp.broadcast ?? ''),
    };
  });
  return { league, date: date ?? yyyymmdd(0), games, built: Date.now() };
}

/** Resolve a team abbreviation (or ESPN team id) to today's event on the slate, else the next on it. */
export async function findEventForTeam(league: FootballLeague, team: string): Promise<SlateGame | null> {
  const want = team.toUpperCase();
  for (const d of [undefined, yyyymmdd(-1)]) {
    const slate = await getSlate(league, d);
    const match = slate.games.find((g) => [g.home.abbr, g.away.abbr, g.home.id, g.away.id].map((x) => x.toUpperCase()).includes(want));
    if (match) return match;
  }
  return null;
}
