// src/client/overlay/cards.ts — the pregame and final cards under the bar.
//
// One layout for every league. Each sport maps its view onto CardTeam; this file owns the
// markup, so football and basketball cannot drift apart.
//
//   pregame   each team's full name with its labelled splits, venue between them. The overall
//             record sits in the BAR, where the score will be, so it is the first thing read.
//   final     a line score by period (the winner's row carries the arrow), then each team's
//             headline stat line.

const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CardTeam {
  abbr: string;
  /** "Buffalo Bills" */
  name: string;
  rank: number | null;
  /** Overall record, "7-1". */
  record: string;
  /** Labelled splits in reading order: [["Away", "3-1"], ["Conf", "2-2"]]. */
  splits: Array<[string, string]>;
  /** "W3" / "L1", or "". */
  streak: string;
  /** Last five, oldest first: true = won. Empty when unknown. */
  last5: boolean[];
  score: number;
  /** Points per period, as far as played. */
  lines: number[];
  /** Headline stat line for the final card. */
  leader: { name: string; line: string } | null;
  color: string;
}

export interface CardGame {
  away: CardTeam;
  home: CardTeam;
  venue: string;
  city: string;
  /** Regulation periods: 4 (quarters) or 2 (halves). */
  regPeriods: number;
}

function teamBlock(t: CardTeam, side: 'away' | 'home'): string {
  const chips = t.splits.filter(([, v]) => v).map(([k, v]) => `<span class="mc-split"><i>${esc(k)}</i>${esc(v)}</span>`);
  if (t.streak) chips.push(`<span class="mc-split"><i>Streak</i>${esc(t.streak)}</span>`);
  const form = t.last5.length
    ? `<span class="mc-form" title="Last five">${t.last5.map((w) => `<b class="${w ? 'w' : 'l'}">${w ? 'W' : 'L'}</b>`).join('')}</span>`
    : '';
  return `<div class="mc-team ${side}" style="--tc:${esc(t.color || '#8a93a0')}">` +
    `<div class="mc-name">${esc(t.name)}</div>` +
    `<div class="mc-facts">${chips.join('')}${form}</div></div>`;
}

export function pregameCard(g: CardGame): string {
  return teamBlock(g.away, 'away') +
    `<div class="mc-where"><div class="mc-venue">${esc(g.venue)}</div><div class="mc-city">${esc(g.city)}</div></div>` +
    teamBlock(g.home, 'home');
}

/** Column heads for the line score: 1 2 3 4, H1 H2, then OT, 2OT… */
function periodHeads(n: number, reg: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (i <= reg) out.push(reg === 2 ? `H${i}` : String(i));
    else out.push(i - reg === 1 ? 'OT' : `${i - reg}OT`);
  }
  return out;
}

export function finalCard(g: CardGame): string {
  const n = Math.max(g.regPeriods, g.away.lines.length, g.home.lines.length);
  const heads = periodHeads(n, g.regPeriods);
  const winner = g.home.score > g.away.score ? 'home' : g.away.score > g.home.score ? 'away' : '';
  const row = (t: CardTeam, side: 'away' | 'home'): string =>
    `<tr class="${winner === side ? 'won' : winner ? 'lost' : ''}"><th scope="row"><span class="ls-chip" style="background:${esc(t.color || '#8a93a0')}"></span>${esc(t.abbr)}</th>` +
    heads.map((_, i) => `<td>${t.lines[i] != null ? t.lines[i] : '–'}</td>`).join('') +
    `<td class="ls-total">${t.score}</td></tr>`;
  const table = `<table class="ls"><thead><tr><th></th>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}<th scope="col">T</th></tr></thead>` +
    `<tbody>${row(g.away, 'away')}${row(g.home, 'home')}</tbody></table>`;
  const leader = (t: CardTeam): string => (t.leader
    ? `<div class="ld"><span class="ld-team">${esc(t.abbr)}</span><span class="ld-name">${esc(t.leader.name)}</span><span class="ld-line">${esc(t.leader.line)}</span></div>`
    : '');
  const leaders = leader(g.away) + leader(g.home);
  return table + (leaders ? `<div class="lds">${leaders}</div>` : '');
}
