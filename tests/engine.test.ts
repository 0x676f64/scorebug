// tests/engine.test.ts — the football engine against captured ESPN payloads,
// then the three live failure modes simulated on top of them.
//   node --test --experimental-strip-types tests/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFootballView, emptyFeeds, STUCK_CLOCK_MS, type EngineInput } from '../src/server/football/engine.ts';
import type { FootballGameView } from '../src/shared/types.ts';

const CAP = join(import.meta.dirname, '..', 'captures');
const seq = (dir: string): any[] => readdirSync(join(CAP, dir)).filter((f) => /^\d+\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(CAP, dir, f), 'utf8')));

const base = (league: 'nfl' | 'cfb', summary: any, prev: FootballGameView | null, now: number, extra: Partial<EngineInput> = {}): EngineInput => ({
  league, eventId: String(summary?.header?.id ?? prev?.eventId ?? '0'), summary, scoreboardEvent: null, coreStatus: null, coreSituation: null, corePlays: null,
  feeds: prev ? structuredClone(prev.feeds) : emptyFeeds(), prev, now, ...extra,
});

/** A scoreboard event synthesised from a summary (the two share the competition shape). */
function sbEventFrom(summary: any, overrides: Record<string, unknown> = {}): any {
  const comp = summary.header.competitions[0];
  return { id: summary.header.id, date: comp.date, competitions: [{ ...comp, situation: summary.situation ?? undefined, ...overrides }] };
}

test('NFL sequence: every snapshot builds, score and clock track the summary, plays grow', () => {
  const snaps = seq('nfl-401873272');
  let prev: FootballGameView | null = null;
  let now = 1_700_000_000_000;
  let lastPlays = 0;
  for (const s of snaps) {
    const v = buildFootballView(base('nfl', s, prev, now));
    const comp = s.header.competitions[0];
    const home = comp.competitors.find((c: any) => c.homeAway === 'home'), away = comp.competitors.find((c: any) => c.homeAway === 'away');
    assert.equal(v.home.score, Number(home.score ?? 0));
    assert.equal(v.away.score, Number(away.score ?? 0));
    assert.equal(v.phase, comp.status.type.state);
    assert.equal(v.mode, 'full');
    if (v.phase === 'in') { assert.ok(v.clock, 'clock present'); assert.ok(v.period > 0, 'period present'); }
    const n = (v.drives.current?.plays.length ?? 0) + v.drives.previous.reduce((a, d) => a + d.plays.length, 0);
    assert.ok(n >= lastPlays, 'play count never shrinks'); lastPlays = n;
    prev = v; now += 10_000;
  }
  assert.ok(prev && prev.drives.previous.length > 5);
});

test('CFB sequence builds with ranks and situation from last play', () => {
  const snaps = seq('cfb-401752873');
  let prev: FootballGameView | null = null;
  let now = 1_700_000_000_000;
  let sawSituation = false;
  for (const s of snaps) {
    const v = buildFootballView(base('cfb', s, prev, now));
    if (v.phase === 'in' && v.situation) { sawSituation = true; assert.ok(v.situation.possIsHome || v.situation.possIsAway, 'possession resolved'); }
    prev = v; now += 10_000;
  }
  assert.ok(sawSituation, 'situation derived from play end spots when summary.situation is absent');
});

test('STUCK CLOCK: status clock frozen while plays advance → plays run the clock after STUCK_CLOCK_MS', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  let now = 1_700_000_000_000;
  // Build from snapshot A normally.
  const a = snaps[20], b = snaps[30];
  let v = buildFootballView(base('nfl', a, null, now));
  const frozenClock = v.clock, frozenPeriod = v.period;
  // Snapshot B has newer plays; freeze its status clock at A's.
  const bFrozen = structuredClone(b);
  bFrozen.header.competitions[0].status.displayClock = frozenClock;
  bFrozen.header.competitions[0].status.period = frozenPeriod;
  now += 10_000;
  v = buildFootballView(base('nfl', bFrozen, v, now));
  assert.equal(v.clock, frozenClock, 'not yet stuck: status still trusted');
  assert.equal(v.stamps.clock.src, 'summary');
  // Same frozen status, time passes, another new play arrives.
  const c = structuredClone(snaps[31]);
  c.header.competitions[0].status.displayClock = frozenClock;
  c.header.competitions[0].status.period = frozenPeriod;
  now += STUCK_CLOCK_MS + 1000;
  v = buildFootballView(base('nfl', c, v, now));
  const lp = (c.drives.current?.plays ?? []).at(-1);
  assert.equal(v.stamps.clock.src, 'plays');
  assert.equal(v.clock, lp.clock.displayValue);
  assert.equal(v.period, lp.period.number);
});

test('STUCK SCORE: status score behind the newest play → play score wins; a lower play score never does', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  const s = structuredClone(snaps[40]);
  const comp = s.header.competitions[0];
  const lp = (s.drives.current?.plays ?? []).at(-1);
  // Status says 0-0, newest play says the real score.
  for (const c of comp.competitors) c.score = '0';
  let v = buildFootballView(base('nfl', s, null, 1_700_000_000_000));
  assert.equal(v.home.score, lp.homeScore);
  assert.equal(v.away.score, lp.awayScore);
  assert.equal(v.stamps.score.src, 'plays');
  // Status ahead of the plays (a correction landed on status first): status wins.
  const s2 = structuredClone(snaps[40]);
  for (const c of s2.header.competitions[0].competitors) c.score = String(Number(c.score) + 7);
  v = buildFootballView(base('nfl', s2, null, 1_700_000_000_000));
  assert.equal(v.stamps.score.src, 'summary');
});

test('FLOOR (LSU case): summary gone, scoreboard alive → score/clock/period/situation live, drives held, mode floor', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  let now = 1_700_000_000_000;
  let v = buildFootballView(base('nfl', snaps[40], null, now));
  const heldPlays = v.drives.current?.plays.length ?? 0;
  // Next poll: summary dead; the scoreboard event (from a LATER snapshot) still answers with a situation block.
  const later = snaps[45];
  const sb = sbEventFrom(later, { situation: { down: 3, distance: 7, yardLine: 34, possession: later.header.competitions[0].competitors[0].team.id, possessionText: 'DET 34', shortDownDistanceText: '3rd & 7', isRedZone: false, lastPlay: { id: '999', text: 'A play the summary never saw' }, homeTimeouts: 2, awayTimeouts: 3 } });
  now += 10_000;
  v = buildFootballView(base('nfl', null, v, now, { scoreboardEvent: sb }));
  assert.equal(v.mode, 'floor');
  const lc = later.header.competitions[0];
  assert.equal(v.clock, lc.status.displayClock);
  assert.equal(v.period, lc.status.period);
  assert.equal(v.stamps.clock.src, 'scoreboard');
  assert.equal(v.home.score, Number(lc.competitors.find((c: any) => c.homeAway === 'home').score));
  assert.equal(v.stamps.score.src, 'scoreboard');
  assert.ok(v.situation, 'situation from the scoreboard');
  assert.equal(v.situation!.ddText, '3rd & 7');
  assert.equal(v.situation!.lastPlayText, 'A play the summary never saw');
  assert.equal(v.stamps.situation.src, 'scoreboard');
  assert.equal(v.drives.current?.plays.length, heldPlays, 'drives frozen at last known');
  assert.equal(v.stamps.plays.src, 'held');
  assert.equal(v.home.timeouts, 2);
});

test('FLOOR + core plays: summary gone but core plays answer → field keeps moving', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  let now = 1_700_000_000_000;
  let v = buildFootballView(base('nfl', snaps[40], null, now));
  const before = v.drives.current?.plays.length ?? 0;
  // Core plays: the later snapshot's current-drive plays with team as $ref.
  const laterPlays = (snaps[46].drives.current?.plays ?? []).map((p: any) => ({ ...p, team: p.team ? { $ref: `http://x/teams/${p.team.id}?lang=en` } : undefined }));
  const coreStatus = { type: snaps[46].header.competitions[0].status.type, displayClock: snaps[46].header.competitions[0].status.displayClock, period: snaps[46].header.competitions[0].status.period };
  now += 10_000;
  v = buildFootballView(base('nfl', null, v, now, { coreStatus, corePlays: laterPlays }));
  assert.equal(v.mode, 'floor');
  assert.ok((v.drives.current?.plays.length ?? 0) > before, 'new core plays appended');
  assert.equal(v.stamps.plays.src, 'core');
  assert.equal(v.stamps.clock.src, 'core');
});

test('HELD: nothing answers → previous view, stamps held, never blank', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  let now = 1_700_000_000_000;
  let v = buildFootballView(base('nfl', snaps[40], null, now));
  const clock = v.clock, hs = v.home.score;
  now += 10_000;
  v = buildFootballView(base('nfl', null, v, now));
  assert.equal(v.mode, 'held');
  assert.equal(v.clock, clock);
  assert.equal(v.home.score, hs);
  assert.equal(v.stamps.clock.src, 'held');
  assert.equal(v.stamps.score.src, 'held');
  assert.ok(v.home.abbr && v.away.abbr, 'identity held');
});

test('first poll with no summary and no prev but a scoreboard event → identity from the scoreboard', () => {
  const snaps = seq('nfl-401873272').filter((s) => s.header.competitions[0].status.type.state === 'in');
  const sb = sbEventFrom(snaps[40]);
  const v = buildFootballView(base('nfl', null, null, 1_700_000_000_000, { scoreboardEvent: sb }));
  assert.equal(v.mode, 'floor');
  assert.ok(v.home.abbr && v.away.abbr);
  assert.ok(v.clock);
});

test('phase flips to post when any feed says so, even if the summary lags', () => {
  const snaps = seq('nfl-401873272');
  const live = snaps.filter((s) => s.header.competitions[0].status.type.state === 'in');
  const v0 = buildFootballView(base('nfl', live.at(-1), null, 1_700_000_000_000));
  const coreStatus = { type: { state: 'post', name: 'STATUS_FINAL', completed: true, shortDetail: 'Final' }, displayClock: '0:00', period: 4 };
  const v = buildFootballView(base('nfl', live.at(-1), v0, 1_700_000_010_000, { coreStatus }));
  assert.equal(v.phase, 'post');
  assert.equal(v.completed, true);
});
