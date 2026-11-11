// src/server/index.ts — scorebug HTTP server.
//
//   GET /api/game?league=cfb&event=401866461      FootballGameView
//   GET /api/game?league=cfb&team=BALL             resolve the team's current game first
//   GET /api/slate?league=nfl[&date=YYYY-MM-DD]    the day's scoreboard, trimmed
//   GET /api/img?u=https://a.espncdn.com/...       same-origin image proxy (allowlisted)
//   GET /health                                    cache + per-game feed ages
//   GET /overlay?league=cfb&team=BALL              the OBS overlay (static)
//   GET /                                          index

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { cache } from './cache.ts';
import { findEventForTeam, getFootballView, getSlate, type FootballLeague } from './football/espn.ts';
import type { FootballGameView } from '../shared/types.ts';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC = process.env.PUBLIC_DIR ?? join(process.cwd(), 'public');
const BUILD = process.env.BUILD_ID ?? new Date().toISOString();

const isFootball = (l: string): l is FootballLeague => l === 'nfl' || l === 'cfb';

function json(res: ServerResponse, status: number, body: unknown, cacheSeconds = 0): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!extname(rel)) rel += '.html';                       // /overlay → overlay.html
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return false;
  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
    const body = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'content-length': body.byteLength, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(body);
    return true;
  } catch { return false; }
}

// Image proxy: OBS browser sources and Twitch panels load fine cross-origin,
// but logos through one origin let the client cache and recolour them, and
// keep ESPN's CDN out of the surface's CSP. Allowlisted hosts only.
const IMG_HOSTS = ['a.espncdn.com', 'espnmedia-cdn.akamaized.net'];
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
async function onImage(url: URL, res: ServerResponse): Promise<void> {
  let target: URL;
  try { target = new URL(url.searchParams.get('u') ?? ''); } catch { json(res, 400, { error: 'bad url' }); return; }
  if (target.protocol !== 'https:' || !IMG_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith('.' + h))) { json(res, 403, { error: 'host not allowed' }); return; }
  try {
    const r = await fetch(target.toString());
    if (!r.ok) { json(res, 502, { error: `upstream ${r.status}` }); return; }
    const type = String(r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMG_TYPES.has(type)) { json(res, 415, { error: 'not an image' }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'content-type': type, 'content-length': buf.byteLength, 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
    res.end(buf);
  } catch (err) { json(res, 502, { error: String(err) }); }
}

// Per-process registry of games served recently, for /health.
const recent = new Map<string, { league: string; eventId: string; at: number }>();

async function onGame(url: URL, res: ServerResponse): Promise<void> {
  const league = String(url.searchParams.get('league') ?? '').toLowerCase();
  if (!isFootball(league)) { json(res, 400, { error: 'league must be nfl or cfb (basketball lands next)' }); return; }
  let eventId = String(url.searchParams.get('event') ?? '');
  const team = String(url.searchParams.get('team') ?? '');
  if (!eventId && team) {
    const g = await findEventForTeam(league, team);
    if (!g) { json(res, 404, { error: `no game on the slate for ${team}` }); return; }
    eventId = g.eventId;
  }
  if (!/^\d+$/.test(eventId)) { json(res, 400, { error: 'event (numeric) or team required' }); return; }
  try {
    const view = await getFootballView(league, eventId);
    recent.set(`${league}:${eventId}`, { league, eventId, at: Date.now() });
    json(res, 200, view);
  } catch (err) {
    json(res, 502, { error: 'no data from any feed', detail: String(err instanceof Error ? err.message : err) });
  }
}

async function onSlate(url: URL, res: ServerResponse): Promise<void> {
  const league = String(url.searchParams.get('league') ?? '').toLowerCase();
  if (!isFootball(league)) { json(res, 400, { error: 'league must be nfl or cfb' }); return; }
  const date = url.searchParams.get('date') ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { error: 'date must be YYYY-MM-DD' }); return; }
  json(res, 200, await getSlate(league, date), 10);
}

async function onHealth(res: ServerResponse): Promise<void> {
  const c = cache();
  const now = Date.now();
  const games: Array<Record<string, unknown>> = [];
  for (const [k, r] of recent) {
    if (now - r.at > 2 * 3600 * 1000) { recent.delete(k); continue; }
    const raw = await c.get(`view:${r.league}:${r.eventId}`).catch(() => null);
    if (!raw) continue;
    const v = JSON.parse(raw) as FootballGameView;
    const age = (ms: number): number | null => (ms ? Math.round((now - ms) / 1000) : null);
    games.push({
      game: `${r.league} ${v.away.abbr}@${v.home.abbr} ${v.eventId}`,
      phase: v.phase, mode: v.mode, period: v.period, clock: v.clock, score: `${v.away.score}-${v.home.score}`,
      builtAgoS: age(v.built),
      stamps: Object.fromEntries(Object.entries(v.stamps).map(([f, s]) => [f, `${s.src} ${age(s.at)}s`])),
      feeds: Object.fromEntries(Object.entries(v.feeds).map(([f, h]) => [f, { okAgoS: age(h.okAt), fails: h.fails, reason: h.reason || undefined }])),
    });
  }
  json(res, 200, { ok: true, build: BUILD, cache: { kind: c.kind, ok: await c.ping() }, uptimeS: Math.round(process.uptime()), games });
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method' }); return; }
  if (p === '/api/game') return onGame(url, res);
  if (p === '/api/slate') return onSlate(url, res);
  if (p === '/api/img') return onImage(url, res);
  if (p === '/health') return onHealth(res);
  if (await serveStatic(p, res)) return;
  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  onRequest(req, res).catch((err) => {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  });
});

server.listen(PORT, () => console.log(`scorebug listening on :${PORT}  public=${PUBLIC}  cache=${cache().kind}  build=${BUILD}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
