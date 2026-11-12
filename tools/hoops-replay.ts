// tools/hoops-replay.ts — LIFTED from nba-hub/src/dev/replay.ts: a captured FINAL basketball summary → the summary as it looked live after N plays.
// src/dev/replay.ts — turn a captured FINAL summary into the summary as it
// would have looked live after N plays. Dev tooling only; never bundled into
// the Devvit server.
//
// What changes: plays and winprobability are cut at N; header status becomes
// in-progress at the last play's period/clock (or halftime / end of period
// when the last play ends a period); scores and linescores are rebuilt from
// the plays. The box score stays final — fine for the court.

type Json = any;

const clockSeconds = (s: string): number => {
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    return Number(m) * 60 + Number(sec);
  }
  return Number(s) || 0;
};

export function summaryAt(final: Json, n: number, opts: { tipoff?: number } = {}): Json {
  const s: Json = JSON.parse(JSON.stringify(final));
  const all: Json[] = s.plays ?? [];
  const cut = Math.max(0, Math.min(n, all.length));
  s.plays = all.slice(0, cut);
  const ids = new Set(s.plays.map((p: Json) => String(p.id)));
  s.winprobability = (s.winprobability ?? []).filter((w: Json) => ids.has(String(w.playId)));

  const comp = s.header.competitions[0];
  const last = s.plays[s.plays.length - 1];
  const regPeriods = Number(s.format?.regulation?.periods ?? 4);
  const done = cut >= all.length;

  if (done) return s;

  // A pre cut (n = 0) puts tipoff 1h 37m from now so the countdown is exercised.
  if (cut === 0) comp.date = new Date(opts.tipoff ?? Date.now() + (97 * 60 + 12) * 1000).toISOString();

  const period = Number(last?.period?.number ?? 1);
  const clock = String(last?.clock?.displayValue ?? '');
  const endOfPeriod = /end period/i.test(String(last?.type?.text ?? '')) || clockSeconds(clock) === 0 && /end/i.test(String(last?.text ?? ''));
  const half = regPeriods === 4 ? period === 2 : period === 1;
  comp.status = {
    period,
    displayClock: clock,
    type: {
      id: endOfPeriod && half ? '23' : '2',
      name: endOfPeriod && half ? 'STATUS_HALFTIME' : endOfPeriod ? 'STATUS_END_PERIOD' : 'STATUS_IN_PROGRESS',
      state: cut === 0 ? 'pre' : 'in',
      completed: false,
      description: endOfPeriod && half ? 'Halftime' : endOfPeriod ? 'End of Period' : 'In Progress',
      detail: endOfPeriod && half ? 'Halftime' : `${clock} - ${last?.period?.displayValue ?? ''}`,
      shortDetail: endOfPeriod && half ? 'Halftime' : endOfPeriod ? `End ${last?.period?.displayValue ?? ''}` : `${clock} - ${last?.period?.displayValue ?? ''}`,
    },
  };

  // Scores + linescores from the plays.
  const lines: Record<'home' | 'away', number[]> = { home: [], away: [] };
  let pa = 0;
  let ph = 0;
  for (const p of s.plays) {
    const per = Number(p.period?.number ?? 1);
    const a = Number(p.awayScore ?? pa);
    const h = Number(p.homeScore ?? ph);
    while (lines.away.length < per) { lines.away.push(0); lines.home.push(0); }
    lines.away[per - 1] = (lines.away[per - 1] ?? 0) + (a - pa);
    lines.home[per - 1] = (lines.home[per - 1] ?? 0) + (h - ph);
    pa = a; ph = h;
  }
  for (const c of comp.competitors) {
    const side = c.homeAway === 'home' ? 'home' : 'away';
    c.score = String(side === 'home' ? ph : pa);
    c.linescores = lines[side].map((v) => ({ displayValue: String(v) }));
    c.winner = false;
  }
  return s;
}
