// tools/replay-server.ts — serve the overlay against captured ESPN payloads.
//   node --experimental-strip-types tools/replay-server.ts [port]
//
//   /overlay?league=nfl&event=401873272            replays captures/nfl-401873272, one snapshot per poll
//   &fail=floor      summary dropped from snapshot 60 on (scoreboard synthesised from the summary stays up)
//   &fail=held       everything dropped from snapshot 60 on
//   &fail=stuckclock status clock frozen from snapshot 40 on
//   &fail=stuckscore status score frozen from snapshot 40 on
//   &speed=N         snapshots advanced per poll (default 1)
//   /replay/reset    start every sequence over
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { buildFootballView, emptyFeeds } from '../src/server/football/engine.ts';
import type { FootballGameView } from '../src/shared/types.ts';

const PORT = Number(process.argv[2] ?? 8090);
const ROOT = join(import.meta.dirname, '..');
const PUB = join(ROOT, 'public');
const CAP = join(ROOT, 'captures');

const seqs = new Map<string, any[]>();
function seq(league: string, id: string): any[] {
  const k = `${league}-${id}`;
  if (!seqs.has(k)) {
    const dir = join(CAP, k);
    seqs.set(k, readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  }
  return seqs.get(k)!;
}
const cursors = new Map<string, { i: number; prev: FootballGameView | null; now: number }>();

function sbEventFrom(summary: any): any {
  const comp = summary.header.competitions[0];
  const lp = [...(summary.drives?.previous ?? []), summary.drives?.current].filter(Boolean).flatMap((d: any) => d.plays ?? []).at(-1);
  const end = lp?.end ?? {};
  return { id: summary.header.id, date: comp.date, season: summary.header.season, week: summary.header.week, competitions: [{ ...comp, situation: lp ? { down: end.down, distance: end.distance, yardLine: end.yardLine, yardsToEndzone: end.yardsToEndzone, possession: end.team?.id, possessionText: end.possessionText, shortDownDistanceText: end.shortDownDistanceText, downDistanceText: end.downDistanceText, lastPlay: { id: lp.id, text: lp.text } } : undefined }] };
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (status: number, body: string | Buffer, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/replay/reset') { cursors.clear(); return send(200, '{"ok":true}'); }
  if (url.pathname === '/api/game') {
    const league = (url.searchParams.get('league') ?? 'nfl') as 'nfl' | 'cfb';
    const id = url.searchParams.get('event') ?? (league === 'nfl' ? '401873272' : '401752873');
    const fail = url.searchParams.get('fail') ?? '';
    const speed = Math.max(0, Number(url.searchParams.get('speed') ?? 1));
    const start = Number(url.searchParams.get('start') ?? 0) || 0;
    const key = `${league}:${id}:${fail}:${start}`;
    const snaps = seq(league, id);
    const c = cursors.get(key) ?? { i: start, prev: null, now: Date.now() };
    const i = Math.min(c.i, snaps.length - 1);
    const s = structuredClone(snaps[i]);
    const comp = s.header.competitions[0];
    let summary: any = s, sbEv: any = sbEventFrom(s), coreStatus: any = null;
    if (fail === 'stuckclock' && i >= 40 && c.prev) { comp.status.displayClock = c.prev.clock; comp.status.period = c.prev.period; sbEv = sbEventFrom(s); }
    if (fail === 'stuckscore' && i >= 40 && c.prev) { for (const x of comp.competitors) x.score = String(x.homeAway === 'home' ? c.prev.home.score : c.prev.away.score); sbEv = sbEventFrom(s); }
    if (fail === 'floor' && i >= 60 && c.prev) { summary = null; }
    if (fail === 'held' && i >= 60 && c.prev) { summary = null; sbEv = null; }
    const feeds = c.prev ? structuredClone(c.prev.feeds) : emptyFeeds();
    const mark = (n: keyof typeof feeds, ok: boolean) => { const h = feeds[n]; if (ok) { h.okAt = c.now; h.fails = 0; h.reason = ''; } else { h.failAt = c.now; h.fails++; h.reason = 'HTTP 503 (replay)'; } };
    mark('summary', !!summary); mark('scoreboard', !!sbEv); mark('coreStatus', !!coreStatus);
    // Clock: 10 s of game time per poll so the stuck-clock rule has time to trip.
    c.now += 10_000;
    const view = buildFootballView({ league, eventId: id, summary, scoreboardEvent: sbEv, coreStatus, coreSituation: null, corePlays: null, feeds, prev: c.prev, now: c.now });
    c.prev = view; c.i = Math.min(i + speed, snaps.length - 1);
    cursors.set(key, c);
    return send(200, JSON.stringify({ ...view, _replay: { i, of: snaps.length, fail } }));
  }
  let p = url.pathname === '/' ? '/overlay.html' : url.pathname;
  if (!extname(p)) p += '.html';
  const f = join(PUB, p);
  try { if (statSync(f).isFile()) return send(200, readFileSync(f), TYPES[extname(f)] ?? 'application/octet-stream'); } catch { /* 404 */ }
  send(404, '{"error":"not found"}');
}).listen(PORT, () => console.log(`replay on http://localhost:${PORT}/overlay?league=nfl&event=401873272`));
