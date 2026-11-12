// src/client/basketball/court.ts — LIFTED VERBATIM from nba-hub/src/client/court.ts (Nov 2026); imports rewired only.
// src/client/court.ts — court geometry and SVG drawing.
//
// Units: 10 SVG units per foot. Court is 94 x 50 ft, landscape, x to the
// right, y down. ESPN shot frame (docs/ESPN-BASKETBALL.md): x 0..50 across
// the court, y = feet from the rim toward midcourt, rim at (25, 0).

import type { League } from '../../shared/basketball.ts';

export const U = 10;
export const LEN = 94;
export const WID = 50;
export const RIM = 5.25;            // rim centre from baseline
const BACKBOARD = 4;                // backboard plane from baseline
const RIM_R = 0.75;

interface Lines {
  arc: number;                      // three-point arc radius from rim centre
  corner: number;                   // lateral distance rim -> corner three line
  lane: number;                     // lane width
  restricted: number;               // restricted-area arc radius
}

// NBA: 23.75 ft arc, 22 ft corners, 16 ft lane.
// WNBA and NCAA men: 6.75 m (22.15 ft) arc, 6.6 m (21.65 ft) corners; WNBA lane 16 ft, NCAA 12 ft.
// NCAA women: the same 22.15 ft arc since 2021-22 (one line for both college games), 12 ft lane.
export const LINES: Record<League, Lines> = {
  nba: { arc: 23.75, corner: 22, lane: 16, restricted: 4 },
  wnba: { arc: 22.146, corner: 21.654, lane: 16, restricted: 4 },
  ncaam: { arc: 22.146, corner: 21.654, lane: 12, restricted: 4 },
  ncaaw: { arc: 22.146, corner: 21.654, lane: 12, restricted: 4 },
};

/** ESPN half-court shot (x, y) -> court feet for the basket on the given side. */
export function toCourt(x: number, y: number, right: boolean): [number, number] {
  return right ? [LEN - RIM - y, x] : [RIM + y, WID - x];
}

const f = (n: number): string => (Math.round(n * U * 10) / 10).toString();

/** One basket end. `right` mirrors it to the right-hand baseline. */
function endPaths(l: Lines, right: boolean): string[] {
  const X = (d: number): number => (right ? LEN - d : d);   // distance from this baseline -> court x
  const cy = WID / 2;
  const laneTop = cy - l.lane / 2;
  const ftDist = 19;                                        // free-throw line from baseline
  const out: string[] = [];

  // Lane (paint)
  out.push(`<rect class="paint" x="${f(Math.min(X(0), X(ftDist)))}" y="${f(laneTop)}" width="${f(ftDist)}" height="${f(l.lane)}"/>`);
  // Free-throw circle: solid half toward midcourt, dashed half inside the lane.
  const fx = X(ftDist);
  const sweepOut = right ? 0 : 1;
  out.push(`<path class="ln" d="M${f(fx)} ${f(cy - 6)} A${f(6)} ${f(6)} 0 0 ${sweepOut} ${f(fx)} ${f(cy + 6)}"/>`);
  out.push(`<path class="ln dash" d="M${f(fx)} ${f(cy - 6)} A${f(6)} ${f(6)} 0 0 ${1 - sweepOut} ${f(fx)} ${f(cy + 6)}"/>`);
  // Three-point line: straight corners, then the arc.
  const cornerLen = RIM + Math.sqrt(Math.max(0, l.arc ** 2 - l.corner ** 2));
  const y1 = cy - l.corner;
  const y2 = cy + l.corner;
  out.push(`<path class="ln" d="M${f(X(0))} ${f(y1)} L${f(X(cornerLen))} ${f(y1)} A${f(l.arc)} ${f(l.arc)} 0 0 ${sweepOut} ${f(X(cornerLen))} ${f(y2)} L${f(X(0))} ${f(y2)}"/>`);
  // Restricted area
  const rx = X(RIM);
  out.push(`<path class="ln thin" d="M${f(rx)} ${f(cy - l.restricted)} A${f(l.restricted)} ${f(l.restricted)} 0 0 ${sweepOut} ${f(rx)} ${f(cy + l.restricted)}"/>`);
  // Backboard + rim
  out.push(`<line class="board" x1="${f(X(BACKBOARD))}" y1="${f(cy - 3)}" x2="${f(X(BACKBOARD))}" y2="${f(cy + 3)}"/>`);
  out.push(`<circle class="rim" cx="${f(rx)}" cy="${f(cy)}" r="${f(RIM_R)}"/>`);
  return out;
}

/** Static court markup (floor + lines). Dynamic layers are drawn on top. */
export function courtMarkup(league: League): string {
  const l = LINES[league];
  const cx = LEN / 2;
  const cy = WID / 2;
  return [
    `<rect class="floor" x="0" y="0" width="${f(LEN)}" height="${f(WID)}" rx="6"/>`,
    `<g id="layer-poss"></g>`,
    ...endPaths(l, false),
    ...endPaths(l, true),
    `<line class="ln" x1="${f(cx)}" y1="0" x2="${f(cx)}" y2="${f(WID)}"/>`,
    `<circle class="ln" cx="${f(cx)}" cy="${f(cy)}" r="${f(6)}" fill="none"/>`,
    `<circle class="ln thin" cx="${f(cx)}" cy="${f(cy)}" r="${f(2)}" fill="none"/>`,
    `<rect class="edge" x="0" y="0" width="${f(LEN)}" height="${f(WID)}" rx="6"/>`,
    `<g id="layer-tags"></g>`,
    `<g id="layer-shots"></g>`,
  ].join('');
}

export { f as fu };
