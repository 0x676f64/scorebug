// tests/hoops.test.ts — the basketball engine (lifted from nba-hub) against captured finals,
// replayed live through the play-list cut, plus the stuck-clock rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGameView, reconcileClock, STUCK_CLOCK_MS } from '../src/server/basketball/engine.ts';
import { summaryAt } from '../tools/hoops-replay.ts';
import type { GameView, League } from '../src/shared/basketball.ts';

const CAP = join(import.meta.dirname, '..', 'captures');
const load = (f: string): any => JSON.parse(readFileSync(join(CAP, f), 'utf8'));

const GAMES: Array<[League, string]> = [['nba', 'nba-401909287.json'], ['wnba', 'wnba-401857214.json'], ['ncaam', 'ncaam-401805215.json']];

for (const [league, file] of GAMES) {
  test(`${league}: final builds; live cuts build with monotone scores, shots on the floor, a possession`, () => {
    const final = load(file);
    const fv = buildGameView({ league, eventId: 'x', summary: final });
    assert.equal(fv.state, 'post');
    const comp = final.header.competitions[0];
    const hs = Number(comp.competitors.find((c: any) => c.homeAway === 'home').score);
    assert.equal(fv.teams[1].score, hs);
    const total: number = final.plays.length;
    let prev: GameView | null = null;
    let now = 1_700_000_000_000;
    let lastSum = -1, sawPoss = false, sawShots = false;
    for (let n = 25; n < total; n += Math.max(1, Math.floor(total / 40))) {
      const v = buildGameView({ league, eventId: 'x', summary: summaryAt(final, n), now });
      reconcileClock(v, prev, now);
      assert.equal(v.state, 'in');
      assert.ok(v.period >= 1 && v.clock !== '', `${n}: period/clock present`);
      const sum = v.teams[0].score + v.teams[1].score;
      assert.ok(sum >= lastSum, `${n}: score never goes backwards`); lastSum = sum;
      if (v.possession != null) sawPoss = true;
      if (v.shots.length) sawShots = true;
      prev = v; now += 10_000;
    }
    assert.ok(sawPoss && sawShots);
  });
}

test('stuck clock: frozen status clock while plays advance → plays run the clock', () => {
  const final = load('nba-401909287.json');
  let now = 1_700_000_000_000;
  const a = buildGameView({ league: 'nba', eventId: 'x', summary: summaryAt(final, 150), now });
  reconcileClock(a, null, now);
  const frozen = { clock: a.statusClock, period: a.statusPeriod };
  let prev = a;
  for (const n of [160, 170]) {
    now += STUCK_CLOCK_MS / 2 + 5000;
    const s = summaryAt(final, n);
    s.header.competitions[0].status.displayClock = frozen.clock;
    s.header.competitions[0].status.period = frozen.period;
    const v = buildGameView({ league: 'nba', eventId: 'x', summary: s, now });
    reconcileClock(v, prev, now);
    prev = v;
  }
  assert.equal(prev.clockSource, 'plays');
  assert.notEqual(prev.clock, frozen.clock);
});
