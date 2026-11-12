// src/client/football/field.ts — the football field engine.
//
// LIFTED VERBATIM from cfb-scores/src/client/app.ts (Field v3 geometry, play
// decomposition, renderFieldViz, play banner), Nov 2026. The CFB grammar is a
// superset of the NFL one (it parses "LAC 14" and "OhioSt30" alike), and the
// NFL alias table is merged into TEXT_ABBR_ALIASES, so one engine serves both
// leagues. Only the PRELUDE below is new: it supplies the handful of helpers
// the engine imported from the rest of the Devvit client, typed against the
// server's GameView. Nothing below the prelude is changed except `export`s.
//
// Inputs (same three the Devvit client passed):
//   summary  { drives: {current, previous}, scoringPlays?, winprobability? }  — the
//            server's trimmed drives; the engine only ever read these keys.
//   g        { home, away, homePossession, awayPossession }                   — teams with
//            id/abbr/name/nick/short/color/timeouts.
//   sit      the server's SituationView (possText, distance, yardsToEndzone, lastPlayText).
//
// DOM contract (ids): field-svg (viewBox "0 -16 600 118"), fv-rz, fv-drive,
// fv-play, fv-pin, fv-chip, fv-first, fv-los, and for the banner: penalty-pill.

import type { FootballGameView, SituationView, TeamView } from '../../shared/types.ts';

// ═══════════════════════════ PRELUDE (new) ═══════════════════════════════

export type NormTeam = Pick<TeamView, 'id' | 'abbr' | 'name' | 'nick' | 'short' | 'color' | 'logo' | 'timeouts'>;
export interface NormGame { home: NormTeam; away: NormTeam; homePossession: boolean; awayPossession: boolean }
export type Situation = Pick<SituationView, 'possText' | 'distance' | 'yardsToEndzone' | 'lastPlayText' | 'possIsHome' | 'possIsAway'>;
/** What the engine reads off the old summary object, carved from a GameView. */
export interface FieldSummary { drives: FootballGameView['drives']; scoringPlays?: FootballGameView['scoringPlays']; winprobability?: any[]; header?: any }

/** Adapt a server GameView to the three engine inputs. */
export function fieldInputs(v: FootballGameView): { summary: FieldSummary; g: NormGame; sit: Situation | null } {
  return {
    summary: {
      drives: v.drives,
      scoringPlays: v.scoringPlays.map((s) => ({ ...s, team: { id: s.teamId } })) as any,
      header: { competitions: [{ status: { period: v.period } }] },
    },
    g: { home: v.home, away: v.away, homePossession: !!v.situation?.possIsHome, awayPossession: !!v.situation?.possIsAway },
    sit: v.situation,
  };
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// innerHTML only when the markup actually changed (the "blink" family of bugs).
const lastHtmlOf = new WeakMap<Element, string>();
export function setHtml(el: Element, html: string): boolean {
  if (lastHtmlOf.get(el) === html) return false;
  lastHtmlOf.set(el, html);
  el.innerHTML = html;
  return true;
}

function numOrNull(v: any): number | null {
  const n = Number(v);
  return isFinite(n) && v != null ? n : null;
}

function lastPlayOf(summary: any): any | null {
  const cur = summary?.drives?.current;
  if (cur?.plays?.length) return cur.plays[cur.plays.length - 1];
  const prev = summary?.drives?.previous;
  if (prev?.length) {
    const d = prev[prev.length - 1];
    if (d?.plays?.length) return d.plays[d.plays.length - 1];
  }
  return null;
}

/** ESPN logo through the same-origin proxy; abbr badge when there is none. */
export function logoSrc(t: NormTeam): string {
  return t.logo && /^https:\/\//i.test(t.logo) ? `/api/img?u=${encodeURIComponent(t.logo)}` : '';
}
export function logoHtml(team: NormTeam, sizeClass: string): string {
  const src = logoSrc(team);
  if (!team.id || !src) return `<span class="logo-badge ${sizeClass}">${escapeHtml(team.abbr || "?")}</span>`;
  return `<img class="${sizeClass}" src="${src}" alt="${escapeHtml(team.abbr)}" data-tabbr="${escapeHtml(team.abbr)}" onerror="this.outerHTML='<span class=&quot;logo-badge ${sizeClass}&quot;>'+this.dataset.tabbr+'</span>'">`;
}

const LEAGUE_COLOR_OVERRIDES: Record<string, string> = {};
function teamColorOf(t: NormTeam, fallback: string): string {
  return t.color || LEAGUE_COLOR_OVERRIDES[t.id] || fallback;
}
export function railColorOf(t: NormTeam, fallback: string): string {
  const dual = TEAM_COLORS_DUAL[t.id];
  if (dual) {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return dual[light ? 1 : 0];
  }
  return teamColorOf(t, fallback);
}

/** The server supplies timeouts on each team; the play-text counter below is the fallback. */
let espnTimeouts: { away: number; home: number } | null = null;
export function setTimeoutsFromView(v: FootballGameView): void {
  espnTimeouts = typeof v.home.timeouts === 'number' && typeof v.away.timeouts === 'number' ? { away: v.away.timeouts, home: v.home.timeouts } : null;
}

export function tidyPlayText(raw: string): string {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(/^\(\d{1,2}:\d{2}\)\s*/, "");
  t = t.replace(/^(?:\((?:No Huddle|Shotgun|Huddle|Punt formation|Field Goal formation)[^)]*\)\s*)+/i, "");
  t = t.replace(/^(?:No Huddle(?:[- ]Shotgun)?|Shotgun|Under Center|Pistol)\s+(?=[#\d]|[A-Z]\.|[A-Z][a-z]+ )/i, "");
  t = t.replace(/#\d{1,2}\s+(?=[A-Z])/g, "");
  t = t.replace(/\b\d{1,2}-(?=[A-Z]\.?[A-Za-z'])/g, "");
  t = t.replace(/,?\s*clock \d{1,2}:\d{2}\.?/gi, "");
  t = t.replace(/\s*\((?:H|LS|K|P|QB):\s*[^)]*\)/g, "");
  t = t.replace(/\bTOUCHDOWN\s+(?=[A-Z]\.?[A-Za-z'])/g, "TOUCHDOWN. ");
  t = t.replace(/\bto (?:the )?([A-Z]{2,5})00\b\s*TOUCHDOWN/g, "into the end zone, TOUCHDOWN");
  t = t.replace(/\bto (?:the )?([A-Z]{2,5})00\b/g, "to the $1 goal line");
  t = t.replace(/\b([A-Z]{2,5})(\d{2})\b/g, (m, a, n) => /^[A-Z]{2,5}$/.test(a) && Number(n) <= 50 ? `${a} ${Number(n)}` : m);
  t = t.replace(/\bfor (\d+) yards? gain\b/g, "for $1 yards");
  t = t.replace(/\bfor (\d+) yards? loss\b/g, "for a loss of $1");
  t = t.replace(/\s+(?:broken up by|tackled by|pushed out of bounds by|forced by|recovered by|intercepted by)\s*[,.]?$/i, "");
  t = t.replace(/\s+,/g, ",").replace(/,\s*$/, "").trim();
  return t;
}

function scoringTeamOf(summary: any, g: NormGame, play: any, offense: NormTeam): NormTeam {
  const sp = ((summary?.scoringPlays || []) as any[]).find((x: any) => String(x?.id ?? "") === String(play?.id ?? ""));
  const id = sp?.team?.id != null ? String(sp.team.id) : "";
  if (id === g.away.id) return g.away;
  if (id === g.home.id) return g.home;
  const tt = playTypeText(play) + " " + String(play?.text || "");
  const td = /touchdown/i.test(tt);
  const flip = td && (/intercept/i.test(tt) || (/fumble/i.test(tt) && !/\(own\)/i.test(tt) && /opponent|return/i.test(tt)) || /blocked/i.test(tt) || /punt return/i.test(tt));
  return flip ? (offense.id === g.home.id ? g.away : g.home) : offense;
}

/** Surfaces hook the moment a score lands (ribbon, stage). No-op by default. */
export let onScoreLanded: ((scorer: NormTeam, play: any, delayMs: number) => void) | null = null;
export function setOnScoreLanded(fn: typeof onScoreLanded): void { onScoreLanded = fn; }
function scheduleScoreStage(summary: any, g: NormGame, play: any, offense: NormTeam, delayMs: number): void {
  if (onScoreLanded) onScoreLanded(scoringTeamOf(summary, g, play, offense), play, delayMs);
}

/**
 * scorebug: the animation chain renderFieldViz last started — which play, when, and how long
 * the ball is in motion. A surface that polls faster than a chain runs must not call
 * renderFieldViz for the SAME play before it ends (that call writes the static end state over
 * the running animation), and can hold the result (score, down & distance, last-play text)
 * until the ball lands. The Devvit apps polled every 10 s, longer than any chain.
 */
export let lastChain: { key: string; at: number; ms: number } = { key: '', at: 0, ms: 0 };
/** The key renderFieldViz animates on, for a summary: the newest real play (admin events excluded). */
export function playKeyOf(summary: any): string {
  const { last, lastReal } = lastPlays(summary);
  return String(lastReal?.id ?? last?.id ?? '');
}

/** Drive geometry of the last render — surfaces draw the drive meter from it. */
export let lastDriveGeom: { start: number; spot: number } | null = null;

const TEAM_COLORS_DUAL: Record<string, [string, string]> = {
  "1":  ["#a71930", "#a71930"], // ATL red
  "2":  ["#c60c30", "#c60c30"], // BUF: royal blue -> charging red
  "3":  ["#e64100", "#c83803"], // CHI: navy -> orange
  "4":  ["#fb4f14", "#fb4f14"], // CIN orange
  "5":  ["#ff3c00", "#311d00"], // CLE: orange bright in dark, brown in light
  "6":  ["#b0b7bc", "#7f9695"], // DAL: navy -> silver
  "7":  ["#fb4f14", "#fb4f14"], // DEN orange
  "8":  ["#0076b6", "#0076b6"], // DET Honolulu blue (allowed)
  "9":  ["#ffb612", "#203731"], // GB: gold in dark, forest in light
  "10": ["#4b92db", "#4b92db"], // TEN light blue (allowed)
  "11": ["#a2aaad", "#6b7a86"], // IND: royal blue -> grey
  "12": ["#e31837", "#e31837"], // KC red
  "13": ["#c4c9cc", "#101820"], // LV: silver in dark, black in light
  "14": ["#ffa300", "#ffa300"], // LAR: royal -> sol gold
  "15": ["#008e97", "#008e97"], // MIA aqua
  "16": ["#4f2683", "#4f2683"], // MIN purple
  "17": ["#c60c30", "#c60c30"], // NE: navy -> red
  "18": ["#d3bc8d", "#9f8958"], // NO gold
  "19": ["#a71930", "#a71930"], // NYG: royal blue -> red
  "20": ["#1f8a5f", "#125740"], // NYJ green (brighter in dark)
  "21": ["#3d8f8f", "#004c54"], // PHI midnight green (brighter in dark)
  "22": ["#97233f", "#97233f"], // ARI cardinal
  "23": ["#ffb612", "#ffb612"], // PIT gold
  "24": ["#0080c6", "#0080c6"], // LAC powder blue (allowed)
  "25": ["#aa0000", "#aa0000"], // SF red
  "26": ["#69be28", "#69be28"], // SEA: navy -> action green
  "27": ["#d50a0a", "#d50a0a"], // TB red
  "28": ["#8a2b2b", "#5a1414"], // WSH burgundy (brighter in dark)
  "29": ["#9aa2a9", "#101820"], // CAR: process blue -> silver/black
  "30": ["#00838f", "#006778"], // JAX teal
  "33": ["#6e56cf", "#241773"], // BAL purple (brighter in dark)
  "34": ["#c41e3a", "#c41e3a"], // HOU: deep steel -> battle red
};
// Bold stat numerals need CONTRAST, not brand cleverness: in light mode use
// the team's dark primary (payload color — navy is fine here per Joe), with a
// luminance floor so pale primaries (silver, gold) fall to deep navy ink; in
// dark mode the bright rail colors already read well.
// Text in a team colour needs contrast with the card behind it. Dark card:
// anything too dark (MIN purple, WSH burgundy, the navies) is lifted toward
// white until it reads; ice card: the existing "dark enough" rule.

// ═══════════════════════ FIELD GEOMETRY + PLAY GRAMMAR (verbatim) ═══════════════════════
// ── Field (v3 geometry) ───────────────────────────────────────────────────
// Units 0-120 left->right. Left EZ 0-10 (HOME attacks left, goal line at 10);
// right EZ 110-120 (AWAY attacks right, goal line at 110).


// ── Field (flat SVG, ESPN coordinate system) ─────────────────────────────
// Perspective is BAKED into coordinates (from ESPN's own FieldSVG): bottom
// edge x 0..600 at y=86, top edge x 30..570 at y=26, side strip 86..90,
// play lane at y=56.35, returns on a lower lane at y=65.3. One coordinate
// space for field, paths, pin, chip, posts — nothing lives outside it.

const FB = (() => {
  const T = 14, B = 92; // deeper surface (78 vs ESPN's 60) = "see more field"
  return {
    T, B, S: B + 4,
    LANE: T + (B - T) * 0.53,
    LANE2: T + (B - T) * 0.72,
    W: 600, TX: 24, TW: 552, // slightly straighter angle than ESPN's 30/540
  };
})();
// NOTE: one perspective for every surface, deliberately. An inline-flattened
// variant was tried and reverted — measurement showed it bought only 24px of
// far-edge width and no end-zone room, which isn't worth a different-looking
// field on Reddit (Joe: the current angle already reads well on desktop and
// on a 6" phone).
const xB = (u: number): number => (u / 120) * FB.W;
const xT = (u: number): number => FB.TX + (u / 120) * FB.TW;
const LANE_F = (FB.B - FB.LANE) / (FB.B - FB.T);
const xLane = (u: number): number => xB(u) + (xT(u) - xB(u)) * LANE_F;
const LANE2_F = (FB.B - FB.LANE2) / (FB.B - FB.T);
const xLane2 = (u: number): number => xB(u) + (xT(u) - xB(u)) * LANE2_F;
const clampUnit = (u: number): number => Math.max(10, Math.min(110, u));

// ESPN's goal-post paths, lifted verbatim (gold uprights + grey bases).
const POSTS_SVG =
  '<path fill="#6c6e6f" d="M6,48.75s0-.75,2-.75,2,.75,2,.75v8.5s0,.75-2,.75-2-.75-2-.75v-8.5Z"/>' +
  '<path fill="#e2ce23" d="M13,43c-2.21,0-4,1.79-4,4v2s0,.4-1,.4-1-.4-1-.4v-2c0-3.31,2.69-6,6-6h1v2h-1Z"/>' +
  '<path fill="#e2ce23" d="M18,10.4v26.6c0,.18-.05.36-.14.51l-6,10c-.23.39-.69.57-1.12.45-.43-.12-.73-.51-.73-.96v-30.6s0-.4,1-.4,1,.4,1,.4v26.99l4-6.67V10.4s0-.4,1-.4,1,.4,1,.4Z"/>' +
  '<rect fill="#e2ce23" x="11" y="42" width="2" height="2"/>' +
  '<path fill="#e2ce23" d="M 9.7 16.6 s 0 -0.42 0.83 -0.42 s 0.83 0.42 0.83 0.42 v 27 l -1.82 0"/>' +
  '<path fill="#6c6e6f" d="M594,57.25s0,.75-2,.75-2-.75-2-.75v-8.5s0-.75,2-.75,2,.75,2,.75v8.5Z"/>' +
  '<path fill="#e2ce23" d="M586,43v-2h1c3.31,0,6,2.69,6,6v2s0,.4-1,.4-1-.4-1-.4v-2c0-2.21-1.79-4-4-4h-1Z"/>' +
  '<path fill="#e2ce23" d="M583,10c1,0,1,.4,1,.4v26.32s4,6.67,4,6.67v-26.99s0-.4,1-.4,1,.4,1,.4v30.6c0,.45-.3.84-.73.96-.43.12-.89-.06-1.12-.45l-6-10c-.09-.16-.14-.33-.14-.51V10.4s0-.4,1-.4Z"/>' +
  '<rect fill="#e2ce23" x="587" y="42" width="2" height="2"/>' +
  '<path fill="#e2ce23" d="M 588.5 16.6 s 0 -0.42 0.83 -0.42 s 0.83 0.42 0.83 0.42 v 27 l -1.82 0"/>';

function bandPoly(u1: number, u2: number, cls: string, fill?: string): string {
  const pts = `${xB(u2)} ${FB.B} ${xB(u1)} ${FB.B} ${xT(u1)} ${FB.T} ${xT(u2)} ${FB.T}`;
  return `<polygon class="${cls}" points="${pts}"${fill ? ` fill="${fill}"` : ""}/>`;
}
function sideRect(u1: number, u2: number, cls: string, fill?: string): string {
  return `<rect class="${cls}" x="${xB(u1)}" y="${FB.B}" width="${xB(u2) - xB(u1)}" height="${FB.S - FB.B}"${fill ? ` fill="${fill}"` : ""}/>`;
}
function yardLine(u: number, wide = false): string {
  return `<line class="fv-tenline" x1="${xT(u)}" y1="${FB.T}" x2="${xB(u)}" y2="${FB.B}"${wide ? ' stroke-width="2"' : ""}/>`;
}

// End-zone names ride a textPath along the zone's exact midline, so the
// baseline matches the trapezoid slant with no manual rotation or glyph
// squishing. Left reads bottom-to-top, right top-to-bottom (ESPN's way).
function ezNamePaths(): string {
  const lB = (xB(0) + xB(10)) / 2, lT = (xT(0) + xT(10)) / 2;
  const rB = (xB(110) + xB(120)) / 2, rT = (xT(110) + xT(120)) / 2;
  return `<path id="fv-ezpath-l" d="M ${lB} ${FB.B + 1} L ${lT} ${FB.T - 1}" fill="none"/>` +
    `<path id="fv-ezpath-r" d="M ${rT} ${FB.T - 1} L ${rB} ${FB.B + 1}" fill="none"/>`;
}
function ezNameText(g: NormGame, left: boolean): string {
  const team = left ? g.away : g.home; // EZ labeled by its DEFENDER
  const nick = (team.nick || team.abbr).toUpperCase();
  // Oswald (condensed): advance ≈ 0.47 × size. Stay TALL by default (14) and
  // shrink only when the name would overflow the usable midline (~54 units);
  // a spacing-only textLength clamp guards the estimate without ever
  // squishing glyphs (that was the old distortion).
  // Start at the max size; fitEzNames() measures the REAL rendered width
  // after paint and scales down only if needed (an estimate of Oswald's
  // advance width was always going to be approximate — measurement isn't).
  const size = 14;
  const clampAttr = "";
  return `<text class="fv-ezname" font-size="${size.toFixed(1)}" dy="0.34em">` +
    `<textPath href="#fv-ezpath-${left ? "l" : "r"}" startOffset="50%" text-anchor="middle"${clampAttr}>` +
    `${escapeHtml(nick)}</textPath></text>`;
}

function buildFieldStatics(g: NormGame): void {
  const svg = $("field-svg");
  if (!svg) return;
  let s = "";
  // top bands (10-yd, alternating) + colored EZs
  for (let u = 10; u < 110; u += 10) {
    s += bandPoly(u, u + 10, (u / 10) % 2 === 1 ? "fv-band" : "fv-band fv-band--dark");
  }
  s += bandPoly(0, 10, "fv-ez", g.away.color || "#5b6474");
  s += bandPoly(110, 120, "fv-ez", g.home.color || "#5b6474");
  // side strip
  for (let u = 10; u < 110; u += 10) {
    s += sideRect(u, u + 10, (u / 10) % 2 === 1 ? "fv-band" : "fv-band fv-band--dark");
  }
  s += sideRect(0, 10, "fv-ez", g.away.color || "#5b6474");
  s += sideRect(110, 120, "fv-ez", g.home.color || "#5b6474");
  // yard lines (10s only; midfield heavier)
  for (let u = 20; u <= 100; u += 10) s += yardLine(u, u === 60);
  // Oct 31 (turf skin): five-yard lines, two hash rows and the yard numbers
  // live INSIDE the plane. Statics only — no play geometry reads them.
  for (let u = 15; u <= 105; u += 10) s += `<line class="fv-fiveline" x1="${xT(u)}" y1="${FB.T}" x2="${xB(u)}" y2="${FB.B}"/>`;
  {
    const hy = (f: number): number => FB.T + (FB.B - FB.T) * f;
    const hx = (u: number, f: number): number => xB(u) + (xT(u) - xB(u)) * (1 - f);
    for (const f of [0.36, 0.64]) s += `<line class="fv-hash" x1="${hx(10, f).toFixed(1)}" y1="${hy(f).toFixed(1)}" x2="${hx(110, f).toFixed(1)}" y2="${hy(f).toFixed(1)}"/>`;
  }
  for (let u = 20; u <= 100; u += 10) {
    const n = u <= 60 ? u - 10 : 110 - u;
    s += `<text class="fv-ynum" x="${xB(u).toFixed(1)}" y="${(FB.B - 3.5).toFixed(1)}" text-anchor="middle">${n}</text>`;
  }
  s += `<line class="fv-edge" x1="0" y1="${FB.B}" x2="${FB.W}" y2="${FB.B}"/>`;
  // depth shading: soft gradient down the top surface + a darkened side
  // strip (ESPN's side-overlay) — the "3D" read on a flat SVG
  s += `<defs><linearGradient id="fv-depth" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="rgba(10,24,40,0)"/>` +
    `<stop offset="0.72" stop-color="rgba(10,24,40,0.02)"/>` +
    `<stop offset="1" stop-color="rgba(10,24,40,0.10)"/></linearGradient></defs>`;
  s += `<polygon fill="url(#fv-depth)" points="${xB(120)} ${FB.B} ${xB(0)} ${FB.B} ${xT(0)} ${FB.T} ${xT(120)} ${FB.T}"/>`;
  s += `<rect class="fv-sideoverlay" x="0" y="${FB.B}" width="${FB.W}" height="${FB.S - FB.B}"/>`;
  // uprights + EZ names (post paths are ESPN-verbatim for a y=26 top edge;
  // translate them onto ours)
  s += `<g transform="translate(0 ${FB.T - 26})">${POSTS_SVG}</g>`;
  s += ezNamePaths();
  s += ezNameText(g, true) + ezNameText(g, false);
  // dynamic layers (order = paint order)
  s += `<defs><pattern id="fv-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)"><rect width="2.6" height="7" class="fv-hatch-bar"/></pattern></defs>`;
  s += `<g id="fv-rz"></g>`;
  s += `<line id="fv-los" class="fv-los" x1="0" y1="${FB.T}" x2="0" y2="${FB.B}" style="display:none"/>`;
  s += `<line id="fv-first" class="fv-first" x1="0" y1="${FB.T}" x2="0" y2="${FB.B}" style="display:none"/>`;
  s += `<g id="fv-drive"></g><g id="fv-play"></g><g id="fv-pin" style="display:none"></g><g id="fv-chip" style="display:none"></g>`;
  svg.innerHTML = s;

  // Yard markers: HTML labels absolutely positioned at the TRUE yard-line x
  // positions on the bottom edge (ESPN's FieldView__markers model — fixed
  // 11px type at every field scale). Mobile keeps abbr · 20 · 50 · 20 · abbr.
  const strip = $("yard-nums");
  if (strip) {
    strip.innerHTML = "";
    const put = (unit: number, text: string, minor: boolean): void => {
      const sp = document.createElement("span");
      sp.textContent = text;
      sp.className = "fv-mark" + (minor ? " minor" : "");
      sp.style.left = ((xB(unit) / FB.W) * 100).toFixed(2) + "%";
      strip.appendChild(sp);
    };
    put(5, g.away.abbr, false);
    const nums: Array<[number, string, boolean]> = [
      [20, "10", true], [30, "20", false], [40, "30", true], [50, "40", true],
      [60, "50", false], [70, "40", true], [80, "30", true], [90, "20", false],
      [100, "10", true],
    ];
    nums.forEach(([u, t, minor]) => put(u, t, minor));
    put(115, g.home.abbr, false);
  }
}

// ── Play decomposition ────────────────────────────────────────────────────

const ADMIN_PLAY = /timeout|two-minute|end (period|of)/i;
const KICKOFF_PLAY = /kickoff/i;
const PUNT_PLAY = /punt/i;
const FG_PLAY = /field goal|extra point/i;
const INT_PLAY = /interception/i;
const AIR_PLAY = /pass|punt|kick|field goal|interception|reception/i;
const GROUND_OVERRIDE = /sack|kneel|rush|run/i;
const INCOMPLETE_PLAY = /incompletion|incomplete/i;

function playTypeText(p: any): string {
  return String(p?.type?.text || p?.type?.abbreviation || "");
}
function isAdminPlay(p: any): boolean { return ADMIN_PLAY.test(playTypeText(p)); }
// ESPN drive play lists include events that aren't offensive plays: timeouts
// and period markers (admin), the kickoff that started the possession, and
// sometimes the OTHER team's punt as the drive's first entry. None of those
// should count toward "N plays" — mirror ESPN's own offensivePlays notion.
// The plays a drive should DISPLAY: same exclusions as the count — no
// timeouts/period markers, no kickoffs (they belong to neither drive), no
// opponent punt at the head of the receiving team's list.
function displayPlaysOf(drive: any): any[] {
  const plays: any[] = drive?.plays || [];
  const kept = plays.filter((p: any) => {
    if (isAdminPlay(p)) return false;
    if (/kickoff/.test(playTypeText(p).toLowerCase())) return false;
    return true;
  });
  if (kept.length && /punt/.test(playTypeText(kept[0]).toLowerCase())) kept.shift();
  return kept;
}

function realPlayCount(drive: any): number {
  const explicit = drive?.offensivePlays;
  if (typeof explicit === "number" && explicit >= 0) return explicit;
  const plays: any[] = drive?.plays || [];
  const kept = plays.filter((p: any) => {
    const t = playTypeText(p).toLowerCase();
    if (isAdminPlay(p)) return false;
    if (/kickoff/.test(t)) return false;
    return true;
  });
  // A punt at the very head of the drive is the opponent's punt TO us.
  if (kept.length && /punt/.test(playTypeText(kept[0]).toLowerCase())) kept.shift();
  return kept.length;
}
function isAirPlay(p: any): boolean {
  const t = playTypeText(p).toLowerCase();
  if (GROUND_OVERRIDE.test(t)) return false;
  return AIR_PLAY.test(t);
}
function ytgToUnit(ytg: number, frameIsHome: boolean): number {
  return frameIsHome ? 10 + ytg : 110 - ytg;
}
// ═══ CFB PLAY-TEXT SPOT GRAMMAR ═══════════════════════════════════════════
// ESPN's college play text writes a spot as a SCHOOL CODE glued to the yard
// line — mixed case, no space: "caught at OhioSt30", "to the KentSt00"
// (goal line), "from Cuse20", "to the Pitt50" (midfield carries a code too).
// The NFL fork's grammar ("at LAC 14": 2-4 capitals, a space, the number)
// never matched a single CFB spot, so the entire text-authoritative layer —
// ending spots, the drive anchor, kick catch spots, fumble/INT spots — was
// silently dead and every coordinate fell to frame math (Sep 19: two long
// TDs drawn into the wrong end zone were the visible symptom). One token
// grammar now accepts both forms; the NFL form still parses identically.
//
// The code is ESPN's TEXT code, not team.abbreviation: "Cuse" for SYR,
// "OhioSt" for OSU, "KentSt" for KENT, "Pitt" for PITT. Resolution ladder
// (strongest tier wins; a tie between the two teams resolves to nothing and
// logs, so a bad guess can never mirror a spot):
//   3  exact — normalized code equals abbr / location / name / nick / alias
//   2  prefix — either side is a prefix of the other ("Pitt" ⊂ pittsburgh),
//      with a trailing "St"/"State" stripped from both first ("MichSt")
//   1  substring — code inside location/name ("Cuse" ⊂ syracuse)
// Unknown or ambiguous codes log ONCE per game to the console — paste those
// lines back and they become TEXT_ABBR_ALIASES entries (key = ESPN abbr).
const SPOT_CODE = String.raw`([A-Za-z][A-Za-z&.'()-]{0,15}?)`;
const SPOT_YARD = String.raw`(\d{1,2})`;

// Filled from tools/cfb-spot-audit.mjs over the full Sep 19 2026 slate (75
// games). Key = ESPN team.abbreviation; values = the code ESPN's play text
// actually uses. Same code can belong to different schools (MSU, OSU, USC,
// PSU) — that is fine because resolution only ever considers the two teams
// in the game. Rerun the audit after any wrong-side play and append here.
const TEXT_ABBR_ALIASES: Record<string, string[]> = {
  SYR: ["CUSE"],
  OSU: ["OHIOST"],
  WAKE: ["WFU"],
  PRST: ["PSU"],
  ND: ["UND"],
  MISS: ["OM"],
  RUTG: ["RU"],
  KENN: ["KSU"],
  UTAH: ["UTA"],
  MICH: ["U-M", "UM", "UOM"],
  KSU: ["KSTATE"],
  MER: ["MU"],
  EMU: ["EMI"],
  WYO: ["UW"],
  MASS: ["UMASS"],
  BALL: ["BSU"],
  LIB: ["LU"],
  LT: ["LATECH"],
  SELA: ["SLU"],
  SC: ["USC"],
  MSST: ["MSU"],
  MOST: ["MSU"],
  MUR: ["MSU"],
  GAST: ["GSU"],
  OKST: ["OSU"],
  ORST: ["OSU"],
  GASO: ["GS"],
  COLO: ["CU"],
  VT: ["VA"],
  MD: ["UMD"],
  ARST: ["ASU"],
  ETAM: ["ET"],
  SDAK: ["USD"],
  FRES: ["FS"],
  // Sep 26 2026 slate audit (65 games): every code the resolver could not
  // place, owner confirmed against the play text.
  ORE: ["UO"],
  BUCK: ["BU"],
  KENT: ["KENTST", "KSU"],
  USA: ["SA"],
  CARK: ["UCA"],
  BOIS: ["BSU"],
  GWEB: ["GWU"],
  TULN: ["TLN"],
  AFA: ["AF"],
  // NFL (merged from nfl-scores): play text uses the league's GSIS codes,
  // which differ from ESPN's abbreviation for these clubs.
  LAR: ["LA", "LAR", "STL"],
  LAC: ["LAC", "SD"],
  LV:  ["LV", "OAK", "LVR"],
  WSH: ["WAS", "WSH"],
  BAL: ["BLT", "BAL"],
  CLE: ["CLV", "CLE"],
  ARI: ["ARZ", "ARI"],
  HOU: ["HST", "HOU"],
  JAX: ["JAX", "JAC"],
  NE:  ["NE", "NWE"],
  NO:  ["NO", "NOR"],
  TB:  ["TB", "TAM"],
  KC:  ["KC", "KAN"],
  GB:  ["GB", "GNB"],
  SF:  ["SF", "SFO"],
};

function normCode(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/state/g, "st");
}
function stripSt(s: string): string {
  return s.length > 4 && s.endsWith("st") ? s.slice(0, -2) : s;
}
function teamKeys(t: NormTeam): string[] {
  const loc = t.nick && t.name.endsWith(t.nick) ? t.name.slice(0, -t.nick.length).trim() : t.name;
  const raw = [t.abbr, loc, t.name, t.nick, ...(TEXT_ABBR_ALIASES[(t.abbr || "").toUpperCase()] || [])];
  return raw.map(normCode).filter((k) => k.length >= 2);
}
// 3 exact · 2 prefix · 1 substring · 0 none
function matchStrength(code: string, t: NormTeam): number {
  const c = normCode(code);
  if (c.length < 2) return 0;
  const keys = teamKeys(t);
  // Bare "State39" (ESPN wrote it for Mississippi State, Sep 26): the one
  // team whose location ends in State owns it; two such teams tie → null.
  if (c === "st") return keys.some((k) => k.length > 4 && k.endsWith("st")) ? 2 : 0;
  if (keys.some((k) => k === c)) return 3;
  if (c.length >= 3) {
    // A "…St" code only prefix-matches "…St" keys (MichSt → Michigan State,
    // never Michigan); a plain code compares whole. Short abbr keys (2 chars)
    // never anchor a prefix match on their own.
    const cSt = c.length > 4 && c.endsWith("st");
    if (keys.some((k) => {
      const kSt = k.length > 4 && k.endsWith("st");
      if (cSt) return kSt && (stripSt(k).startsWith(stripSt(c)) || stripSt(c).startsWith(stripSt(k)));
      return k.startsWith(c) || (k.length >= 3 && c.startsWith(k));
    })) return 2;
    if (keys.some((k) => k.length > c.length && k.includes(c))) return 1;
  }
  return 0;
}
const unknownAbbrs = new Set<string>();
function noteUnknownAbbr(abbr: string, g: NormGame, why = "unknown"): void {
  const key = `${why}:${abbr}`;
  if (unknownAbbrs.has(key)) return;
  unknownAbbrs.add(key);
  console.warn(`[cfb-scores] spot code "${abbr}" ${why} — teams ${g.away.abbr} (${g.away.name}) / ${g.home.abbr} (${g.home.name}); add to TEXT_ABBR_ALIASES`);
}

// Resolve a text spot to an absolute field unit (away defends LEFT, goal u=10).
function spotToUnit(abbr: string, yard: number, g: NormGame): number | null {
  const a = matchStrength(abbr, g.away);
  const h = matchStrength(abbr, g.home);
  if (a === 0 && h === 0) { noteUnknownAbbr(abbr, g); return null; }
  if (a > h) return 10 + yard;
  if (h > a) return 110 - yard;
  noteUnknownAbbr(abbr, g, "ambiguous"); // both teams match at the same tier
  return null;
}

// Every spot mention in a play's text, in order, as absolute field units.
// This is the ONLY frame-free source of position we have: "Cuse21" states
// both the yard line and whose territory it's in, so it can't be mirrored.
// Text wins over ytg math wherever it exists; ytg stays the fallback for
// spotless texts. The code is OPTIONAL because the NFL writes midfield bare
// ("at 50"); a bare number is only unambiguous at the 50. "from X" is an
// ORIGIN (kick/punt launch point) — never an ending spot, so excluded here.
const SPOT_RE = new RegExp(String.raw`\b(?:at|to)\s+(?:the\s+)?(?:${SPOT_CODE}\s*)?${SPOT_YARD}\b`, "g");

// "thrown to SMU17" names where an incomplete pass was AIMED, not where the
// ball ended (it ended at the LOS). Counting it as an ending spot fed the
// start-side arithmetic pick a target 40 yards downfield with statYardage 0,
// which chose the MIRRORED start every time (Sep 26: MOST@SMU, ILL@OSU).
const THROWN_TO_RE = new RegExp(String.raw`\bthrown\s+to\s+(?:the\s+)?${SPOT_CODE}\s*${SPOT_YARD}\b`, "i");
function stripThrowTarget(text: string): string {
  return text.replace(new RegExp(THROWN_TO_RE.source, "gi"), "thrown");
}

function textSpots(rawText: string, g: NormGame): number[] {
  const text = stripThrowTarget(rawText);
  const out: number[] = [];
  SPOT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPOT_RE.exec(text)) !== null) {
    const abbr = String(m[1] || "");
    const yard = Number(m[2]);
    if (!abbr) {
      if (yard === 50) out.push(60); // midfield, the one spot needing no side
      continue;
    }
    const u = spotToUnit(abbr, yard, g);
    if (u != null) out.push(clampUnit(u));
  }
  return out;
}

// "PENALTY … N yards from X to Y": Y is where the ball ends (college text).
// The NFL writes "enforced at X" (the foul spot) and never "to", so it
// stays on frame math.
const PEN_FROM_TO_RE = new RegExp(String.raw`\bPENALTY\b[^.]*?\bfrom\s+(?:the\s+)?([A-Za-z][A-Za-z&.'()-]{0,15}?)\s*(\d{1,2})\s+to\s+(?:the\s+)?([A-Za-z][A-Za-z&.'()-]{0,15}?)\s*(\d{1,2})\b`, "i");
function penaltyEndSpot(text: string, g: NormGame): number | null {
  const m = text.match(PEN_FROM_TO_RE);
  if (!m) return null;
  const u = spotToUnit(String(m[3]), Number(m[4]), g);
  return u != null ? clampUnit(u) : null;
}
// Kick parsing reads the kick sentence only: the penalty clause carries its
// own "from"/"to"/yardage that are NOT the kick's (the LSU 19 enforcement
// spot became a punt launch).
function kickSentence(text: string): string {
  return String(text || "").replace(/\bPENALTY\b[\s\S]*$/i, "");
}

interface PlayGeom { x1: number; x2: number; air: boolean; penalty: boolean; yards: number; }

function playGeom(p: any, offenseIsHome: boolean, homeId: string, awayId: string, g?: NormGame): PlayGeom | null {
  const s = numOrNull(p?.start?.yardsToEndzone);
  const e = numOrNull(p?.end?.yardsToEndzone);
  if (s == null || e == null) return null;
  // FRAME RULE (hardened after the live PIT@BUF mirror bug): end.team's
  // frame is definitional ONLY on change-of-possession plays (punt/kick/
  // INT/fumble — the ball ends in the receiver's frame). On ordinary
  // scrimmage plays the LIVE feed can put the DEFENSE in end.team, and
  // trusting it mirrored the LOS (team "marching the wrong way" while the
  // possession-driven arrow stayed correct). Postgame fixtures never showed
  // this because amended data carries the offense there.
  const endTeamId = p?.end?.team?.id != null ? String(p.end.team.id) : "";
  let endFrameIsHome = offenseIsHome;
  if (CHANGE_POSS.test(playTypeText(p)) && endTeamId && (endTeamId === homeId || endTeamId === awayId)) {
    endFrameIsHome = endTeamId === homeId;
  }
  const startFrameIsHome = KICKOFF_PLAY.test(playTypeText(p)) ? !offenseIsHome : offenseIsHome;

  // TEXT IS AUTHORITATIVE for the ending spot: the LAST spot named in the
  // play text is where the ball actually ended ("…RECOVERED by LA-N.Andersen
  // at LAC 14") — no frames, so it cannot be mirrored. Frame math fills in
  // when the text names no spot.
  // EXCEPTION — PENALTIES: "enforced at DET 14" is where the foul was marked
  // FROM, not where the ball ends (a 5-yard foul from DET 14 ends at DET 9).
  // ESPN's end.ytg already carries the post-enforcement spot, so penalties
  // keep the frame math. Verified on a full game: with penalties excluded,
  // text and frame math agree on 109 of 110 plays, and the one disagreement
  // was the midfield "at 50" case handled above.
  const playText = String(p?.text || "");
  const isPenaltyPlay = p?.isPenalty === true || /PENALTY/i.test(playText);
  const spots = g && !isPenaltyPlay ? textSpots(playText, g) : [];
  // Nov 7 (Joe, LSU–ALA): the college penalty clause names the POST-
  // enforcement spot outright — "Holding (H.Berry) 9 yards from LSU 19 to
  // LSU 10" — frame-free, so it beats end.ytg (which the live feed carried
  // in the wrong frame and mirrored a punt return to the Alabama 10).
  const penEnd = isPenaltyPlay && g ? penaltyEndSpot(playText, g) : null;
  const textEnd = penEnd != null ? penEnd : spots.length ? spots[spots.length - 1]! : null;

  // START-SIDE CONSISTENCY PICK. The live feed corrupts start.team the same
  // way it corrupts end.team (seen live: a pass AT LAC 14 for no gain drew
  // its arc from the Rams' 14 — start.ytg was right, start.TEAM was the
  // defense). So the frame is VALIDATED with arithmetic instead of trusted:
  // |x1 − x2| must equal the play's own statYardage. x2 is text-derived and
  // statYardage is absolute, so exactly one of the two possible framings is
  // consistent. Only plain scrimmage plays qualify — on kicks/turnovers
  // statYardage is the RETURN, and penalties keep frame math throughout.
  let x1 = clampUnit(ytgToUnit(s, startFrameIsHome));
  const plainScrimmage = !CHANGE_POSS.test(playTypeText(p)) && !FG_PLAY.test(playTypeText(p)) && !isPenaltyPlay;
  if (plainScrimmage && textEnd != null) {
    const want = Math.abs(Number(p?.statYardage) || 0);
    const alt = clampUnit(ytgToUnit(s, !startFrameIsHome));
    const errA = Math.abs(Math.abs(x1 - textEnd) - want);
    const errB = Math.abs(Math.abs(alt - textEnd) - want);
    if (errB + 1 < errA) x1 = alt; // mirror only when clearly more consistent
  }
  return {
    x1,
    x2: textEnd != null ? textEnd : clampUnit(ytgToUnit(e, endFrameIsHome)),
    air: isAirPlay(p),
    penalty: p?.isPenalty === true,
    yards: Number(p?.statYardage) || 0,
  };
}

function activeDrive(summary: any): any | null {
  return summary?.drives?.current
    || (summary?.drives?.previous?.length ? summary.drives.previous[summary.drives.previous.length - 1] : null);
}
function offenseOf(summary: any, g: NormGame): { team: NormTeam; isHome: boolean } | null {
  const drive = activeDrive(summary);
  const id = drive?.team?.id != null ? String(drive.team.id) : "";
  if (id === g.home.id) return { team: g.home, isHome: true };
  if (id === g.away.id) return { team: g.away, isHome: false };
  if (g.homePossession) return { team: g.home, isHome: true };
  if (g.awayPossession) return { team: g.away, isHome: false };
  return null;
}
const CHANGE_POSS = /punt|kickoff|interception|fumble/i;

// Who owns the ball AFTER the last real play. ESPN keeps the finished drive
// as drives.current for a beat after a punt/kick/INT, so the drive team alone
// shows the OLD possessor at the new spot — the end.team of a
// change-of-possession play is the truth.
// Timeouts aren't a field in the summary payload — but every charged timeout
// play carries its number and team ("Timeout #1 by CIN at 01:04."). Numbering
// resets each half, and ESPN sometimes skips a number, so take the HIGHEST
// number seen this half as the used count. 3 per half, 2 in overtime.
// Charged timeouts. Two text dialects, both real:
//   NFL: "Timeout #1 by CIN at 01:04."   — numbered; take the highest # seen
//        this half (ESPN sometimes skips a number).
//   CFB: "Timeout Wake Forest, clock 06:46" — UNnumbered, names the school;
//        the play also carries team.id. Count occurrences per side.
// The old NFL-only regex never matched a college timeout, so the dots sat at
// three all game (Joe, Sep 19). "Official Timeout" (TV) is never charged.
const TIMEOUT_RE = /Timeout\s*#(\d+)\s*by\s*([A-Za-z][A-Za-z&.'()-]{1,15})/i;
const CFB_TIMEOUT_RE = /^\s*Timeout\s+(.+?)\s*(?:,|\.|$|\bclock\b)/i;

function timeoutsRemaining(summary: any, g: NormGame): { away: number; home: number } | null {
  const period = Number(summary?.header?.competitions?.[0]?.status?.period) ||
    Number(lastPlayOf(summary)?.period?.number) || 0;
  if (!period) return null;
  const perHalf = period >= 5 ? 1 : 3; // CFB: ONE timeout per OT period
  // CFB: one timeout per OT PERIOD, so each OT is its own bucket.
  const halfOf = (p: number): number => (p >= 5 ? 2 + (p - 4) : p <= 2 ? 1 : 2);
  const nowHalf = halfOf(period);

  const drives = summary?.drives;
  const all: any[] = [...(drives?.previous || [])];
  if (drives?.current) all.push(drives.current);

  const numbered: Record<string, number> = {};
  const counted: Record<string, number> = {};
  const seenIds = new Set<string>();
  for (const d of all) {
    for (const p of d?.plays || []) {
      const per = Number(p?.period?.number) || 0;
      if (!per || halfOf(per) !== nowHalf) continue;
      const text = String(p?.text || "");
      const type = playTypeText(p);
      const isCharged = !/official/i.test(text) && (/^timeout$/i.test(type) || /^\s*Timeout\b/i.test(text));
      if (!isCharged) continue;
      const pid = String(p?.id ?? "");
      if (pid) { if (seenIds.has(pid)) continue; seenIds.add(pid); } // a drive boundary can list a play twice
      // Side: the text names the caller (authoritative); team.id is the fallback.
      let side = "";
      const mN = TIMEOUT_RE.exec(text);
      const mC = mN ? null : CFB_TIMEOUT_RE.exec(text);
      const code = mN ? String(mN[2] || "") : mC ? String(mC[1] || "") : "";
      if (code) {
        const a = matchStrength(code, g.away), h = matchStrength(code, g.home);
        side = a > h ? "away" : h > a ? "home" : "";
      }
      if (!side) {
        const tid = p?.team?.id != null ? String(p.team.id) : "";
        side = tid === g.away.id ? "away" : tid === g.home.id ? "home" : "";
      }
      if (!side) continue;
      if (mN) {
        const n = Number(mN[1] || 0) || 0;
        if (n > (numbered[side] || 0)) numbered[side] = n;
      } else {
        counted[side] = (counted[side] || 0) + 1;
      }
    }
  }
  const usedOf = (side: string): number => Math.max(numbered[side] || 0, counted[side] || 0);
  const left = (side: "away" | "home"): number =>
    Math.max(0, Math.min(perHalf, perHalf - usedOf(side)));
  return { away: left("away"), home: left("home") };
}

function timeoutDotsHtml(left: number, total: number): string {
  let s = "";
  for (let i = 0; i < total; i++) {
    s += `<span class="to-dot${i < left ? "" : " to-used"}"></span>`;
  }
  return s;
}

function spotOwnerOf(summary: any, g: NormGame, off: { team: NormTeam; isHome: boolean }): { team: NormTeam; isHome: boolean } {
  const { lastReal } = lastPlays(summary);
  if (lastReal && CHANGE_POSS.test(playTypeText(lastReal))) {
    // A punt or kickoff that was not blocked, fumbled or onside flips
    // possession by rule — no end.team needed (the live feed put the KICKING
    // team there on the LSU–ALA holding-on-the-return play, Nov 7).
    const lt = playTypeText(lastReal), ltx = String(lastReal?.text || "");
    if ((PUNT_PLAY.test(lt) || KICKOFF_PLAY.test(lt)) && !/fumble|recover|blocked|onside|muff/i.test(ltx)) {
      return off.isHome ? { team: g.away, isHome: false } : { team: g.home, isHome: true };
    }
    const endId = lastReal?.end?.team?.id != null ? String(lastReal.end.team.id) : "";
    if (endId === g.home.id && !off.isHome) return { team: g.home, isHome: true };
    if (endId === g.away.id && off.isHome) return { team: g.away, isHome: false };
    // No usable end.team: a completed kick/punt/INT still flips by definition.
    if (!endId) return off.isHome ? { team: g.away, isHome: false } : { team: g.home, isHome: true };
  }
  return off;
}

function lastPlays(summary: any): { last: any | null; lastReal: any | null } {
  const drive = activeDrive(summary);
  const plays: any[] = drive?.plays || [];
  let last: any | null = null, lastReal: any | null = null;
  for (let i = plays.length - 1; i >= 0; i--) {
    if (!last) last = plays[i];
    if (!lastReal && !isAdminPlay(plays[i])) lastReal = plays[i];
    if (last && lastReal) break;
  }
  return { last, lastReal };
}

// One visual step of a play's performance.
interface Seg {
  d: string;           // SVG path
  len: number;         // approx px length (drives duration + mask dash)
  kind: "arc" | "ground" | "loop" | "return";
  color: string;
  lane2?: boolean;     // segment ends on the LOWER lane (post-turnover returns)
}
interface PlayViz { segs: Seg[]; xMark: number | null; badge: string | null; endUnit: number; }

function laneLine(u1: number, u2: number, lane2 = false): string {
  const y = lane2 ? FB.LANE2 : FB.LANE;
  const fx = lane2 ? xLane2 : xLane;
  return `M ${fx(u1).toFixed(1)} ${y} L ${fx(u2).toFixed(1)} ${y}`;
}
function arcPath(u1: number, u2: number, kick: boolean): string {
  const a = xLane(u1), b = xLane(u2), y = FB.LANE;
  // A cubic with both controls at cy peaks at only 75% of the way there, so
  // the old cy=T+1 topped out ~25px above the lane — "very low" (Joe).
  // Aim for a real PEAK instead, scaled by distance: a 63-yd kickoff sails
  // up near the viewBox top (-16), a short punt noticeably lower, passes
  // stay below the far sideline so they read as throws, not kicks.
  const len = Math.abs(b - a);
  const rise = kick
    ? Math.min(62, Math.max(42, 36 + len * 0.09))   // peak ≈ -7 … 13
    : Math.min(40, Math.max(22, 16 + len * 0.08));   // peak ≈ 15 … 33
  const cy = y - rise / 0.75;
  const c1 = a + (b - a) * 0.22, c2 = a + (b - a) * 0.78;
  return `M ${a.toFixed(1)} ${y} C ${c1.toFixed(1)} ${cy.toFixed(1)}, ${c2.toFixed(1)} ${cy.toFixed(1)}, ${b.toFixed(1)} ${y}`;
}
// Field goals / PATs fly THROUGH the uprights (Joe): the path ends inside
// the prong gap (posts sit at screen x≈12 left / x≈588 right, prongs span
// screen y≈-1..25), still airborne — the ball's end-fade sells the finish.
function fgPath(u1: number, left: boolean): string {
  const a = xLane(u1), y = FB.LANE;
  const bx = left ? 12 : 588;
  const by = 8; // mid-prong height
  const c1 = a + (bx - a) * 0.25, c2 = a + (bx - a) * 0.78;
  return `M ${a.toFixed(1)} ${y} C ${c1.toFixed(1)} -8, ${c2.toFixed(1)} -5, ${bx} ${by}`;
}

function loopPath(u: number, dir: number): string {
  // small forward curl down to the return lane (ESPN's turnover loop)
  const x = xLane(u);
  const midY = (FB.LANE + FB.LANE2) / 2;
  return `M ${x.toFixed(1)} ${FB.LANE} C ${(x + dir * 7).toFixed(1)} ${FB.LANE} ${(x + dir * 7).toFixed(1)} ${midY.toFixed(1)} ${(x + dir * 2).toFixed(1)} ${FB.LANE2}`;
}
function segLen(u1: number, u2: number, arc: boolean): number {
  const d = Math.abs(xLane(u2) - xLane(u1));
  return arc ? d * 1.25 + 20 : d;
}

const CATCH_RE = new RegExp(String.raw`(?:kicks|kickoff|punts|punt)[^.]*?\bto\s+(?:the\s+)?${SPOT_CODE}\s*${SPOT_YARD}`, "i");
const INT_RE = new RegExp(String.raw`INTERCEPTED.{0,50}?\bat\s+(?:the\s+)?${SPOT_CODE}\s*${SPOT_YARD}`, "i");
// A LOST fumble is a turnover and should read like one on the field (Joe).
// ESPN types it "Fumble Recovery (Opponent)" — "(Own)" keeps possession and
// stays an ordinary play. Both spots come from the text: where it was
// fumbled, and where the other team recovered.
const LOST_FUMBLE = /fumble\s*(?:recovery|return)?\s*\(opponent\)|fumble return touchdown/i;
// NB: use `.` not `[^.]` — player names carry periods ("RECOVERED by
// CIN-C.Howell at DET 7"), which a dot-excluding class would block.
const FUMBLE_AT_RE = new RegExp(String.raw`FUMBLES?\b.{0,40}?\bat\s+(?:the\s+)?(?:${SPOT_CODE}\s*)?${SPOT_YARD}`, "i");
const RECOVERED_AT_RE = new RegExp(String.raw`RECOVERED by.{0,60}?\bat\s+(?:the\s+)?(?:${SPOT_CODE}\s*)?${SPOT_YARD}`, "i");

function spotFromMatch(m: RegExpMatchArray | null, g: NormGame): number | null {
  if (!m) return null;
  const abbr = String(m[1] || "").toUpperCase();
  const yard = Number(m[2]);
  if (!abbr) return yard === 50 ? 60 : null; // bare number is only safe at midfield
  const u = spotToUnit(abbr, yard, g);
  return u == null ? null : clampUnit(u);
}
const FAIR_OR_TB = /fair catch|touchback/i;

// Decompose the last play into performable segments (frame-aware,
// text-assisted for kicks/punts/INTs).
// The last text-named spot before `play`, looking back through the drive
// (and into the previous drive if needed). Frame-free by construction —
// it's the same textSpots() the ending-spot logic trusts. Used to anchor
// plays whose OWN text names no spot, e.g. "27 yard field goal is GOOD".
function priorTextSpot(summary: any, play: any, g: NormGame): number | null {
  const drives = summary?.drives;
  const all: any[] = [...(drives?.previous || [])];
  if (drives?.current) all.push(drives.current);
  const flat: any[] = [];
  for (const d of all) for (const p of d?.plays || []) flat.push(p);
  const id = String(play?.id ?? "");
  let idx = flat.findIndex((p) => String(p?.id ?? "") === id);
  if (idx < 0) idx = flat.length; // not found → scan from the end
  for (let i = idx - 1, seen = 0; i >= 0 && seen < 8; i--) {
    const p = flat[i];
    if (isAdminPlay(p)) continue;
    seen++;
    if (String(p?.text || "").search(/PENALTY/i) >= 0) continue; // enforcement spots aren't final
    const spots = textSpots(String(p?.text || ""), g);
    if (spots.length) return spots[spots.length - 1]!;
  }
  return null;
}

function decomposePlay(p: any, off: { team: NormTeam; isHome: boolean }, g: NormGame, priorSpot: number | null = null, sitSpot: number | null = null, startSpot: number | null = null): PlayViz | null {
  let gm = playGeom(p, off.isHome, g.home.id, g.away.id, g);
  if (!gm) return null;
  const ink = gm.penalty ? "var(--penalty-yellow)" : "var(--play-ink)";
  // A mirrored frame maps u to 120−u. When the drive's last known spot is
  // available, a start ~80 units from it is a mirror artifact, not football.
  const preferNearPrior = (u: number): number => {
    if (priorSpot == null) return u;
    const alt = clampUnit(120 - u);
    return Math.abs(alt - priorSpot) + 6 < Math.abs(u - priorSpot) ? alt : u;
  };

  const text = String(p?.text || "");
  const tType = playTypeText(p);

  // ═══ SITUATION ANCHOR (Sep 27) ═══════════════════════════════════════
  // The play's own end.possessionText ("MOST 36") is the ball spot AFTER
  // the play, written with the team abbr — frame-free, same payload as the
  // play, and the one field that has never been wrong on the header. For an
  // ordinary scrimmage play that IS the end, and the start is statYardage
  // back along the offense's direction. Both coordinates now come from
  // sources ESPN's start/end.team corruption can't touch. Excluded: scoring
  // plays (end.possessionText is the PAT spot), changes of possession,
  // kicks and field goals (own text-anchored branches), and penalties
  // (statYardage isn't a gain; only the END is anchored for those).
  {
    const scrimmage = !CHANGE_POSS.test(tType) && !FG_PLAY.test(tType) &&
      !KICKOFF_PLAY.test(tType) && !PUNT_PLAY.test(tType) && p?.scoringPlay !== true;
    if (sitSpot != null && scrimmage) {
      const yds = Number(p?.statYardage) || 0;
      if (gm.penalty) {
        const alt = clampUnit(120 - gm.x1);
        const x1 = Math.abs(alt - sitSpot) + 6 < Math.abs(gm.x1 - sitSpot) ? alt : gm.x1;
        gm = { ...gm, x1, x2: sitSpot };
      } else if (startSpot != null && Math.abs(Math.abs(startSpot - sitSpot) - Math.abs(yds)) <= 2) {
        // Best case: the play's own start.possessionText names the start
        // with a team abbr — frame-free, no direction needed. Accepted only
        // when it agrees with statYardage, so a stale field can't slip in.
        gm = { ...gm, x1: startSpot, x2: sitSpot };
      } else {
        // Direction from the PLAY's offense (start.team, verified 155/155 in
        // fixtures), not the drive team: ESPN flips drives.current to the next
        // possession the moment a drive ends, which would mirror the last
        // play of every drive (4th-down stops).
        const dir = off.isHome ? -1 : 1;
        gm = { ...gm, x1: clampUnit(sitSpot - dir * yds), x2: sitSpot };
      }
    }
  }
  // LAST CELL OF THE MATRIX: plays whose text names NO spot at all
  // ("pass incomplete deep left") have no arithmetic check and no text end
  // — the only coordinates still standing on frame math. A play starts
  // where the previous one ended, so the drive anchor validates them too.
  // Both x1 and x2 came from the same frame, so they flip together.
  // Penalties excluded (their ytg math has been correct throughout).
  {
    const noTextSpots = !gm.penalty && textSpots(text, g).length === 0;
    if (noTextSpots && !CHANGE_POSS.test(tType) && !FG_PLAY.test(tType)) {
      const nx1 = preferNearPrior(gm.x1);
      if (nx1 !== gm.x1) gm = { ...gm, x1: nx1, x2: clampUnit(120 - gm.x2) };
    }
  }

  // TOUCHDOWNS name no spot ("for 11 yards, TOUCHDOWN") and ESPN records
  // end.ytg = 0 — which maps to a goal line WHOSE SIDE the frame decides,
  // so a flipped frame scored the TD in the wrong end zone (Joe, Rams TD
  // pinned in the Rams' own zone). A TD's end is DEFINITIONAL: the goal
  // line the gain reaches. start + gain lands on exactly one of them —
  // arithmetic decides, frame consulted never. (Defensive/return TDs are
  // CHANGE_POSS and keep their own text-anchored branches; nullified TDs
  // are penalties and keep ytg math.)
  if (/TOUCHDOWN/i.test(text) && p?.scoringPlay === true &&
      !gm.penalty && !CHANGE_POSS.test(tType) && !FG_PLAY.test(tType)) {
    const yd = Math.abs(Number(p?.statYardage) || 0);
    const nearGoal = (u: number): number | null =>
      Math.abs(u - 110) <= 2 ? 110 : Math.abs(u - 10) <= 2 ? 10 : null;
    // NO clamp here (Sep 19, OSU 75-yd TD drawn into their OWN end zone; the
    // Georgia 61-yarder the same afternoon): clampUnit(85 + 75) = 110 made
    // the overshoot look like a goal line, so every 50+ yard TD "reached"
    // BOTH goals and the near-half tie-break sent it the wrong way. Raw
    // arithmetic overshoots past 110 / below 10 and is correctly rejected.
    const gA = nearGoal(gm.x1 + yd);
    const gB = nearGoal(gm.x1 - yd);
    // Tie-break (only a ~50-yd TD from midfield can hit both): the offense's
    // definitional attack direction — home attacks LEFT (u=10), away RIGHT.
    const attackGoal = off.isHome ? 10 : 110;
    const goal = gA != null && gB == null ? gA
      : gB != null && gA == null ? gB
      : attackGoal;
    gm = { ...gm, x2: goal };
  }
  // (No PAT animation by design — ESPN doesn't draw one either; the extra
  // point lives only in the TD text. Joe, Sep 9.)
  const segs: Seg[] = [];
  let xMark: number | null = null;
  let badge: string | null = null;
  let endUnit = gm.x2;

  const kickish = KICKOFF_PLAY.test(tType) || PUNT_PLAY.test(tType);

  if (INCOMPLETE_PLAY.test(tType)) {
    // Arc to where the pass was thrown when the text says ("thrown to
    // SMU17") and that spot lies downfield within 70 yards; otherwise a
    // short arc in the attack direction. Red X where it dies. No movement.
    const dir = off.isHome ? -1 : 1;
    const tm = text.match(THROWN_TO_RE);
    const target = tm ? spotToUnit(String(tm[1]), Number(tm[2]), g) : null;
    const sane = target != null && (target - gm.x1) * dir > 0.5 && Math.abs(target - gm.x1) <= 70;
    const to = sane ? clampUnit(target!) : clampUnit(gm.x1 + dir * 16);
    segs.push({ d: arcPath(gm.x1, to, false), len: segLen(gm.x1, to, true), kind: "arc", color: ink });
    xMark = to;
    endUnit = gm.x1;
  } else if (INT_PLAY.test(tType)) {
    const m = text.match(INT_RE);
    const pick = m ? spotToUnit(m[1]!, Number(m[2]), g) : null;
    const at = pick != null ? clampUnit(pick) : gm.x2;
    segs.push({ d: arcPath(gm.x1, at, false), len: segLen(gm.x1, at, true), kind: "arc", color: ink });
    const dir = off.isHome ? 1 : -1; // the RETURNER's direction — opposite the offense
    segs.push({ d: loopPath(at, dir), len: 18, kind: "loop", color: ink, lane2: true });
    if (Math.abs(gm.x2 - at) > 0.5) {
      segs.push({ d: laneLine(at, gm.x2, true), len: segLen(at, gm.x2, false), kind: "return", color: ink, lane2: true });
      badge = `${Math.round(Math.abs(gm.x2 - at))}-Yd Return`;
    }
  } else if (LOST_FUMBLE.test(tType)) {
    // Same grammar as an interception: carry the ball to the fumble spot,
    // loop to show the change of hands, then return the OTHER way.
    const fx1 = preferNearPrior(gm.x1);
    const fumbleAt = spotFromMatch(text.match(FUMBLE_AT_RE), g) ?? fx1;
    const recovAt = spotFromMatch(text.match(RECOVERED_AT_RE), g) ?? gm.x2;
    if (Math.abs(fumbleAt - fx1) > 0.5) {
      segs.push({ d: laneLine(fx1, fumbleAt, false), len: segLen(fx1, fumbleAt, false), kind: "ground", color: ink });
    }
    const dir = off.isHome ? 1 : -1; // the RECOVERING team's direction
    segs.push({ d: loopPath(recovAt, dir), len: 18, kind: "loop", color: ink, lane2: true });
    if (Math.abs(gm.x2 - recovAt) > 0.5) {
      segs.push({ d: laneLine(recovAt, gm.x2, true), len: segLen(recovAt, gm.x2, false), kind: "return", color: ink, lane2: true });
      badge = `${Math.round(Math.abs(gm.x2 - recovAt))}-Yd Return`;
    }
  } else if (kickish) {
    const kt = kickSentence(text);
    const m = kt.match(CATCH_RE);
    const caught = m ? spotToUnit(m[1]!, Number(m[2]), g) : null;
    const isTb = /touchback/i.test(text);
    const intoEz = /touchback|to (?:the )?end zone/i.test(text);

    // ═══ FRAME-FREE LAUNCH, generalized for CFB (Joe's WASH@MICH kickoff:
    // "Beckham Sunderland kickoff for 65 yds for a touchback" — NO from-
    // spot, NO catch spot, NO team abbr anywhere, "yds" not "yards"; every
    // NFL anchor missing, so the launch silently fell to frame math and
    // drew from the wrong half). Derivation ladder, all frame-free:
    //   1. "from MICH 35" named outright (NFL kickoffs) → absolute.
    //   2. distance arithmetic: the kick's stated distance is measured
    //      LOS→catch (returns/fair catches) or LOS→goal line (touchbacks).
    //      Both candidate launches (landing ± dist) are computed; out-of-
    //      bounds ones drop, and the drive's last spot breaks a tie.
    //   3. no distance at all → the drive anchor (preferNearPrior).
    const fromM = kt.match(new RegExp(String.raw`\bfrom\s+(?:the\s+)?${SPOT_CODE}\s*${SPOT_YARD}`, "i"));
    const fromU = fromM ? spotToUnit(String(fromM[1]), Number(fromM[2]), g) : null;
    const distM = kt.match(/\b(?:kicks?|kickoff|punts?)\b[^.]{0,24}?\b(\d{1,3})\s*(?:yards?|yds?)\b/i);
    const dist = distM ? Number(distM[1]) : null;

    let kx1: number;
    if (fromU != null) {
      kx1 = clampUnit(fromU);
    } else if (dist != null && isTb && sitSpot != null) {
      // TOUCHBACK, DECIDED: the placement ("BALL ON WASH 25") sits beside
      // the goal line the ball crossed — so the goal is the one nearest the
      // placement, and the launch is the stated distance from THAT goal.
      // No tie-break, no team fields (Joe's WASH@MICH kickoff: both
      // distance candidates were in bounds and the tie-break leaned on a
      // corrupted frame — this replaces guessing with the rule book).
      const goal = sitSpot <= 60 ? 10 : 110;
      kx1 = clampUnit(goal === 10 ? 10 + dist : 110 - dist);
    } else if (dist != null && (caught != null || isTb)) {
      const cands: number[] = caught != null
        ? [clampUnit(caught) - dist, clampUnit(caught) + dist]
        : [10 + dist, 110 - dist]; // touchback: distance ran to a goal line
      const inb = cands.filter((u) => u >= 0 && u <= 120);
      if (inb.length === 1) kx1 = clampUnit(inb[0]!);
      else if (inb.length > 1) {
        const ref = sitSpot != null ? sitSpot : priorSpot != null ? priorSpot : gm.x1;
        kx1 = clampUnit(inb.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a)));
      } else kx1 = preferNearPrior(gm.x1);
    } else {
      kx1 = preferNearPrior(gm.x1);
    }

    // Direction and the attacked end zone follow FROM the launch — a kick
    // flies toward the far end zone. No team roles consulted (the old
    // off.isHome path inverts when start.team is the receiver, which CFB
    // may well do; the launch side is already frame-free, so use it).
    const kickDir = kx1 > 60 ? -1 : 1;
    const ezLanding = kickDir > 0 ? 115 : 5;

    if (caught == null && !intoEz && !/fair catch/i.test(text)) {
      console.warn(`[cfb-scores] kick text had no parseable catch spot: "${text.slice(0, 90)}"`);
    }
    // statYardage on kick/punt plays is the RETURN yardage — reconstruct a
    // missing catch spot by walking back from the end along the kick dir.
    let derived: number | null = null;
    if (caught == null && !intoEz && Math.abs(gm.yards) > 0.5) {
      derived = clampUnit(gm.x2 + kickDir * Math.abs(gm.yards));
    }
    // Touchback VETOES any parsed catch spot ("Touchback to the LAC 35"
    // writes the placement inside the kick sentence).
    const at = isTb || (intoEz && caught == null) ? ezLanding
      : caught != null ? clampUnit(caught)
      : derived != null ? derived : gm.x2;
    segs.push({ d: arcPath(kx1, at, true), len: segLen(kx1, at, true), kind: "arc", color: ink });
    // intoEz moves only the LANDING; whether a return draws is governed by
    // the text (touchback/fair catch suppress it). A kick fielded IN the
    // zone and run out gets its return drawn from the zone — correct.
    if (!FAIR_OR_TB.test(text) && Math.abs(gm.x2 - at) > 0.5) {
      // Middle lane: the kick arc is in the air, so the return can run on
      // the main line and the direction arrow connects to it (Joe).
      segs.push({ d: laneLine(at, gm.x2, false), len: segLen(at, gm.x2, false), kind: "return", color: ink });
      // The stated return: college says "return 27 yards", the NFL "to DAL 36 for 27 yards" — the LAST "for N yards" of the kick sentence is the runback.
      const forAll = [...kt.matchAll(/\bfor\s+(-?\d{1,3})\s*(?:yards?|yds?)\b/gi)];
      const rm = kt.match(/\breturn(?:s|ed)?\s+(?:for\s+)?(\d{1,3})\s*(?:yards?|yds?)\b/i) || (forAll.length ? forAll[forAll.length - 1] : null);
      badge = `${rm ? Number(rm[1]) : Math.round(Math.abs(gm.x2 - at))}-Yd Return`;
    }
  } else if (FG_PLAY.test(tType)) {
    // A field goal's text names NO spot ("27 yard field goal is GOOD"), so
    // this was the last play type with nothing frame-free to stand on — and
    // a mirrored start.ytg drew a 90-yard kick from the wrong side (Joe,
    // LAR@LAC play 14). ANCHOR ON THE DRIVE instead: the plays before it
    // name spots, and a FG is always kicked from where the drive just was.
    // Side = the half the drive was in; LOS = kick distance − 18 (10 yards
    // of end zone + 8-yard hold — verified against ESPN's own start.ytg on
    // 5/5 fixture kicks, all exactly 18) in that half's frame. PATs snap
    // from the 15. Frame math is only the fallback with no prior spot.
    let x1 = gm.x1;
    let left = off.isHome;
    if (priorSpot != null) {
      const attackingRight = priorSpot > 60;       // drive was in the right half → kicking at the right posts
      const dm = text.match(/(\d{1,2})\s*(?:yard|yd)\s*field goal/i);
      const isPat = /extra point/i.test(tType) || /extra point/i.test(text);
      // CFB: PATs snap from the 3 (NFL: the 15). The −18 FG offset was
      // derived from NFL ESPN data (5/5 exact) — VERIFY against CFB
      // captures the same way; college holds are the same 7-8 yds so it
      // should transfer, but it's an assumption until measured.
      const ytgLos = isPat ? 3 : dm ? Math.max(1, Number(dm[1]) - 18) : null;
      x1 = ytgLos != null
        ? clampUnit(attackingRight ? 110 - ytgLos : 10 + ytgLos)
        : clampUnit(priorSpot);
      left = !attackingRight;
    }
    segs.push({ d: fgPath(x1, left), len: segLen(x1, left ? 0 : 120, true) + 14, kind: "arc", color: ink });
    endUnit = x1;
  } else if (gm.air) {
    segs.push({ d: arcPath(gm.x1, gm.x2, false), len: segLen(gm.x1, gm.x2, true), kind: "arc", color: ink });
  } else if (Math.abs(gm.x2 - gm.x1) > 0.5) {
    segs.push({ d: laneLine(gm.x1, gm.x2), len: segLen(gm.x1, gm.x2, false), kind: "ground", color: ink });
  }

  if (!badge && gm.yards !== 0 && !FG_PLAY.test(tType)) {
    badge = `${gm.yards > 0 ? "+" : ""}${gm.yards} Yds`;
  }
  return { segs, xMark, badge, endUnit };
}


// ═══════════════════════════ RENDERER (verbatim) ═══════════════════════════
// ── Renderer ──────────────────────────────────────────────────────────────

// Football pacing: unhurried. Short runs still get a real draw (~700ms),
// long bombs take about two seconds, and each segment breathes before the
// next begins.
// Pacing: football is a slow game and the play should FLOAT (Joe). Nudged up
// ~15% from 7x/700-2100 — enough to feel unhurried, not enough to lag the
// 10s poll cadence (worst case ~2.4s + gaps still lands well inside it).
// Round 2 of "make it float" (Joe): another ~25% slower. Worst case (INT
// arc + loop + return) is ~5.2s against the 10s live poll — still safe.
const durOf = (len: number): number => Math.max(1000, Math.min(3000, len * 10));

function ballShape(): string {
  // Black ball, a touch larger (Joe) — the brown read as mud at phone size.
  // Laces stay light so the ball still has a readable centre against dark.
  // No laces (Joe, Oct 10): a plain football shape. Dark theme recolours
  // it (CSS .fv-ball) with the same grey glow as the play line.
  return `<ellipse class="fv-ball" rx="5.9" ry="3.8" fill="#141414" stroke="#000" stroke-width="0.8"/>`;
}

function pinMarkup(team: NormTeam, u: number): string {
  const x = xLane(u).toFixed(1);
  // scorebug: the Devvit apps bundled /teams/{id}.png; here the proxied ESPN logo is the source.
  const local = logoSrc(team) || `/teams/${encodeURIComponent(team.id)}.png`;
  const T = FB.T;
  // The abbr is a FALLBACK for a failed logo, not a backdrop — it stays
  // hidden until the image actually errors (logos with transparency were
  // letting it show through, per Joe).
  return `<g class="fv-pin-g" transform="translate(${x} 0)">` +
    `<path class="fv-pin-tail" d="M -5.6 ${T + 7} L 0 ${T + 19} L 5.6 ${T + 7} Z"/>` +
    `<circle class="fv-pin-bubble" cy="${T - 6}" r="15.5"/>` +
    `<text class="fv-pin-abbr" y="${T - 2.5}" text-anchor="middle">${escapeHtml(team.abbr)}</text>` +
    `<image href="${local}" x="-12" y="${T - 18} " width="24" height="24" preserveAspectRatio="xMidYMid meet"` +
    ` onerror="this.remove();this.parentNode&&this.parentNode.classList.add('no-logo')"/>` +
    `</g>`;
}

// True-fit the end-zone names: measure what actually rendered and shrink to
// the usable midline. Runs after the statics are in the DOM (fonts may land
// later, so it re-runs on document.fonts.ready too).
function fitEzNames(): void {
  const USABLE = Math.hypot(27, FB.B - FB.T) * 0.82;
  document.querySelectorAll<SVGTextElement>("text.fv-ezname").forEach((t) => {
    try {
      t.setAttribute("font-size", "14");
      const w = t.getComputedTextLength();
      if (!w) return;
      if (w > USABLE) {
        const next = Math.max(8, 14 * (USABLE / w));
        t.setAttribute("font-size", next.toFixed(1));
      }
    } catch { /* getComputedTextLength can throw pre-layout */ }
  });
}

let lastAnimatedPlayId = "";

function renderFieldViz(summary: any, g: NormGame, sit: Situation | null): void {
  const svg = $("field-svg");
  if (!svg || !svg.firstChild) return;
  const driveG = $("fv-drive"), playG = $("fv-play"), pinG = $("fv-pin"),
    chipG = $("fv-chip"), first = $("fv-first");
  if (!driveG || !playG || !pinG || !chipG || !first) return;

  const off = offenseOf(summary, g);
  const drive = activeDrive(summary);
  const { last, lastReal } = lastPlays(summary);

  if (!off || !drive) {
    driveG.innerHTML = ""; playG.innerHTML = "";
    pinG.style.display = "none"; chipG.style.display = "none";
    (first as unknown as SVGElement & HTMLElement).style.display = "none";
    return;
  }

  // Key on the play being VISUALIZED. Admin plays (timeouts, two-minute,
  // end-period) get fresh ids but change nothing on the field — keying on
  // `last` made them re-perform the previous play.
  const playKey = String(lastReal?.id ?? last?.id ?? "");
  // Reduced motion: the play is drawn in its end state (the static branch).
  const isNewPlay = !!playKey && playKey !== lastAnimatedPlayId && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Frame the play by ITS OWN offense, not the current drive's. ESPN flips
  // drives.current to the NEXT possession immediately (e.g. right after a
  // FG, current = the receiving team's new drive), so `off` can belong to
  // the wrong team while lastReal is still the previous drive's play — that
  // mirrored the whole FG render (wrong start half, wrong posts) in the
  // live LAR@LAC game. start.team is the play's offense on every normal
  // play (verified 155/155 in fixtures) and the KICKER on kickoffs, which
  // playGeom's kickoff flip already expects.
  const playOff = ((): { team: NormTeam; isHome: boolean } => {
    const st = lastReal?.start?.team?.id != null ? String(lastReal.start.team.id) : "";
    if (!st || (st !== g.home.id && st !== g.away.id)) return off;
    const kick = KICKOFF_PLAY.test(playTypeText(lastReal));
    const offenseId = kick ? (st === g.home.id ? g.away.id : g.home.id) : st;
    return offenseId === g.home.id
      ? { team: g.home, isHome: true }
      : { team: g.away, isHome: false };
  })();

  const priorSpot = lastReal ? priorTextSpot(summary, lastReal, g) : null;
  // The situation's possessionText ("WASH 25") is parsed early so the play
  // decomposition can use it too — for a touchback it names the placement,
  // which sits beside the goal line the kick crossed.
  let sitSpot: number | null = null;
  {
    // CFB abbreviations can carry & or - ("TA&M 25", "M-OH 40").
    const pm = String(sit?.possText || "").trim().match(/^([A-Z][A-Z&-]{1,5})\s+(\d{1,2})$/);
    if (pm && Number(pm[2]) <= 50) { // "MONT 65" between PAT and kickoff is not a yard line
      const u = spotToUnit(pm[1]!, Number(pm[2]), g);
      if (u != null) sitSpot = clampUnit(u);
    }
  }
  // Offense direction from the drive/possession truth (sit), not the play's
  // start.team, which the live feed corrupts. Away attacks right (+1).
  // The play's own pre-snap spot, frame-free ("MOST 36") — see decomposePlay.
  let startSpot: number | null = null;
  {
    const sm = String(lastReal?.start?.possessionText || "").trim().match(/^([A-Z][A-Z&-]{1,5})\s+(\d{1,2})$/);
    if (sm && Number(sm[2]) <= 50) {
      const u = spotToUnit(sm[1]!, Number(sm[2]), g);
      if (u != null) startSpot = clampUnit(u);
    }
  }
  const viz = lastReal ? decomposePlay(lastReal, playOff, g, priorSpot, sitSpot, startSpot) : null;

  // spot
  let spot: number | null = viz ? viz.endUnit : null;
  if (spot == null && last) {
    const e = numOrNull(last?.end?.yardsToEndzone);
    if (e != null) spot = clampUnit(ytgToUnit(e, playOff.isHome));
  }
  // ABSOLUTE ANCHOR for the LOS: ESPN's possessionText ("LAC 14") names the
  // spot with a team abbr — spotToUnit maps it frame-free. When present it
  // outranks everything above, covering play types the geometry cannot
  // validate (e.g. incompletions, where start and end are the same ytg).
  if (sitSpot != null) spot = sitSpot;
  if (spot == null && sit && sit.yardsToEndzone != null) {
    spot = clampUnit(ytgToUnit(sit.yardsToEndzone, off.isHome));
  }

  // AFTER A SCORE (Sep 27, r/raiders): until the kickoff is played, ESPN's
  // situation is the KICKOFF placement for the scoring team ("LV 35, 1st &
  // 10"). Treating that as a line of scrimmage pinned the ball at the
  // Raiders' 35, with a drive line, an arrow and the TD's yardage badge,
  // while the touchdown itself sat correctly at the goal line. The ball is
  // where the play ended until the next real play exists; no drive line and
  // no attack arrow, because the drive is over.
  const postScore = !!lastReal && lastReal.scoringPlay === true && viz != null;
  if (postScore) spot = viz!.endUnit;

  // drive line
  let driveStart: number | null = null;
  for (const p of drive.plays || []) {
    if (isAdminPlay(p) || KICKOFF_PLAY.test(playTypeText(p))) continue;
    const s = numOrNull(p?.start?.yardsToEndzone);
    if (s != null) { driveStart = clampUnit(ytgToUnit(s, off.isHome)); break; }
  }
  lastDriveGeom = !postScore && driveStart != null && spot != null ? { start: driveStart, spot } : null;
  driveG.innerHTML = (!postScore && driveStart != null && spot != null && Math.abs(spot - driveStart) > 1)
    ? `<path class="fv-driveline" d="${laneLine(driveStart, spot)}"/>` : "";

  // last play performance
  let chainMs = 0;
  let out = "";
  if (viz && viz.segs.length) {
    if (isNewPlay) {
      let begin = 200;
      const mid = "fvm" + Date.now();
      let defs = "";
      viz.segs.forEach((seg, i) => {
        const dur = durOf(seg.len);
        defs += `<mask id="${mid}-${i}" maskUnits="userSpaceOnUse">` +
          `<path d="${seg.d}" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"` +
          ` pathLength="100" stroke-dasharray="100" stroke-dashoffset="100">` +
          `<animate attributeName="stroke-dashoffset" from="100" to="0" dur="${dur}ms"` +
          ` begin="${begin}ms" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.06 0.2 1"/>` +
          `</path></mask>`;
        out += `<path d="${seg.d}" fill="none" stroke="${seg.color}" stroke-width="2.4"` +
          ` stroke-linecap="round" stroke-dasharray="6 5" mask="url(#${mid}-${i})"/>`;
        // ball rides every segment
        out += `<g opacity="1"><animate attributeName="opacity" from="1" to="0" begin="${begin + dur + 360}ms" dur="520ms" fill="freeze"/>` +
          `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${begin}ms" dur="1ms" fill="freeze"/>` +
          `${ballShape()}<animateMotion path="${seg.d}" begin="${begin}ms" dur="${dur}ms" fill="freeze" rotate="${seg.kind === "arc" ? "auto" : "0"}" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.06 0.2 1"/></g></g>`;
        begin += dur + 230; // air between segments
      });
      chainMs = begin;
      if (viz.xMark != null) {
        const xm = xLane(viz.xMark);
        out = `<defs>${defs}</defs>` + out +
          `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${chainMs - 60}ms" dur="320ms" fill="freeze"/>` +
          `<path class="fv-x" d="M ${(xm - 4.5).toFixed(1)} ${FB.LANE - 4.5} L ${(xm + 4.5).toFixed(1)} ${FB.LANE + 4.5} M ${(xm + 4.5).toFixed(1)} ${FB.LANE - 4.5} L ${(xm - 4.5).toFixed(1)} ${FB.LANE + 4.5}"/></g>`;
      } else {
        out = `<defs>${defs}</defs>` + out;
      }
    } else {
      viz.segs.forEach((seg) => {
        out += `<path d="${seg.d}" fill="none" stroke="${seg.color}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="6 5"/>`;
      });
      if (viz.xMark != null) {
        const xm = xLane(viz.xMark);
        out += `<path class="fv-x" d="M ${(xm - 4.5).toFixed(1)} ${FB.LANE - 4.5} L ${(xm + 4.5).toFixed(1)} ${FB.LANE + 4.5} M ${(xm + 4.5).toFixed(1)} ${FB.LANE - 4.5} L ${(xm - 4.5).toFixed(1)} ${FB.LANE + 4.5}"/>`;
      }
    }
  }

  // direction arrow at the spot — the NEW possessor's attack direction
  const owner = spotOwnerOf(summary, g, off);

  // RED ZONE tint (ESPN-style, Joe's ask): when the spot owner is inside the
  // attacked 20, the last 20 yards glow a pale red. Home attacks LEFT
  // (toward unit 10), away RIGHT (toward 110) — same convention as the arrow.
  {
    const rzG = $("fv-rz");
    if (rzG) {
      const attackingLeft = owner.isHome;
      const inRz = spot != null && (attackingLeft ? spot <= 30 : spot >= 90);
      // Rewritten only when the side changes: a new polygon every poll
      // replayed the fade-in for as long as the offense stayed inside the 20.
      const side = inRz ? (attackingLeft ? "L" : "R") : "";
      if ((rzG as unknown as HTMLElement).dataset.side !== side) {
        (rzG as unknown as HTMLElement).dataset.side = side;
        const u1 = attackingLeft ? 10 : 90, u2 = attackingLeft ? 30 : 110;
        rzG.innerHTML = inRz ? `<polygon class="fv-rz" points="${xB(u2)} ${FB.B} ${xB(u1)} ${FB.B} ${xT(u1)} ${FB.T} ${xT(u2)} ${FB.T}"/>` : "";
      }
    }
  }
  if (spot != null && !postScore) {
    const d = owner.isHome ? -1 : 1;
    // Attach to the lane the play actually ended on (post-turnover returns
    // run on the lower lane), with the arrow's BASE flush against the end
    // of the line so line and arrow read as one stroke (Joe: details).
    const lastSeg = viz?.segs.length ? viz.segs[viz.segs.length - 1] : null;
    const onLane2 = !!lastSeg?.lane2;
    const ay = onLane2 ? FB.LANE2 : FB.LANE;
    const hx = (onLane2 ? xLane2 : xLane)(clampUnit(spot));
    const arrow = `<path class="fv-arrow" d="M ${hx.toFixed(1)} ${ay - 5.5} L ${(hx + d * 10).toFixed(1)} ${ay} L ${hx.toFixed(1)} ${ay + 5.5} Z"/>`;
    out += isNewPlay
      ? `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${Math.max(0, chainMs - 80)}ms" dur="340ms" fill="freeze"/>${arrow}</g>`
      : arrow;
  }
  // Oct 31: a scoring play lights the attacked end zone (SMIL, on the
  // same timeline as the play) and books the score ribbon for the moment
  // the play lands.
  const scoringNow = isNewPlay && lastReal?.scoringPlay === true && !!viz;
  if (scoringNow) {
    const scorer = scoringTeamOf(summary, g, lastReal, playOff.team);
    const right = scorer.id === g.away.id; // away attacks right
    const [u1, u2] = right ? [110, 120] : [0, 10];
    out += `<polygon class="fv-ezglow" points="${xB(u2)} ${FB.B} ${xB(u1)} ${FB.B} ${xT(u1)} ${FB.T} ${xT(u2)} ${FB.T}" opacity="0">` +
      `<animate attributeName="opacity" values="0;.6;0;.6;0;.45;0" begin="${Math.max(0, chainMs)}ms" dur="1.8s" fill="freeze"/></polygon>`;
  }
  playG.innerHTML = out;
  if (scoringNow) scheduleScoreStage(summary, g, lastReal, playOff.team, chainMs + 120);
  if (isNewPlay) {
    // SMIL begin times are absolute on the SVG's document timeline, which
    // started when the field was built — without this reset, every animation
    // is already "in the past" and renders instantly at its end state.
    try { (svg as unknown as SVGSVGElement).setCurrentTime(0); } catch { /* older engines */ }
  }

  // pin directly above the arrow, in the same coordinate space — the OWNER's mark
  if (spot != null) {
    setHtml(pinG, pinMarkup(postScore ? playOff.team : owner.team, spot));
    pinG.style.display = "";
    if (isNewPlay) {
      pinG.classList.remove("anim-in");
      void getComputedStyle(pinG).opacity; // a real style flush — offsetWidth is undefined on an SVG <g>
      pinG.classList.add("anim-in");
      (pinG as unknown as HTMLElement).style.animationDelay = `${Math.max(0, chainMs - 80)}ms`;
    } else {
      (pinG as unknown as HTMLElement).style.animationDelay = "0ms";
    }
  } else pinG.style.display = "none";

  // yardage / return badge below the side strip
  if (viz?.badge && spot != null) {
    const bx = xLane(spot);
    // Bigger badge (Joe: "very small"). With kick returns on the middle
    // lane there's room below it; turnover returns end on the lower lane,
    // so the badge drops just beneath that instead. Arrow spans ±5.5
    // around its lane — both placements clear it.
    const lastSegB = viz.segs.length ? viz.segs[viz.segs.length - 1] : null;
    const CH = 16;
    const top = lastSegB?.lane2 ? FB.LANE2 + 6 : FB.LANE + 9;
    const w = Math.max(54, viz.badge.length * 7.3 + 16);
    chipG.innerHTML = `<rect class="fv-chipbg${lastReal?.isPenalty ? " pen" : ""}" x="${(bx - w / 2).toFixed(1)}" y="${top.toFixed(1)}" rx="5" width="${w.toFixed(1)}" height="${CH}"/>` +
      `<text class="fv-chiptext${lastReal?.isPenalty ? " pen" : ""}" x="${bx.toFixed(1)}" y="${(top + 11.6).toFixed(1)}" text-anchor="middle">${escapeHtml(viz.badge)}</text>`;
    chipG.style.display = "";
    if (isNewPlay) {
      chipG.classList.remove("anim-in");
      void getComputedStyle(chipG).opacity;
      chipG.classList.add("anim-in");
      (chipG as unknown as HTMLElement).style.animationDelay = `${chainMs}ms`;
    } else (chipG as unknown as HTMLElement).style.animationDelay = "0ms";
  } else chipG.style.display = "none";

  // first-down line (slanted, gold)
  const dist = sit?.distance ?? numOrNull(lastReal?.end?.distance);
  if (spot != null && dist != null && dist > 0) {
    const f = clampUnit(owner.isHome ? spot - dist : spot + dist);
    first.setAttribute("x1", String(xT(f).toFixed(1)));
    first.setAttribute("y1", String(FB.T));
    first.setAttribute("x2", String(xB(f).toFixed(1)));
    first.setAttribute("y2", String(FB.B));
    (first as unknown as HTMLElement).style.display = "";
  } else (first as unknown as HTMLElement).style.display = "none";

  // line of scrimmage (blue, under the pin) — the broadcast read
  const los = $("fv-los");
  if (los) {
    if (spot != null && !postScore) {
      los.setAttribute("x1", String(xT(clampUnit(spot)).toFixed(1)));
      los.setAttribute("y1", String(FB.T));
      los.setAttribute("x2", String(xB(clampUnit(spot)).toFixed(1)));
      los.setAttribute("y2", String(FB.B));
      (los as unknown as HTMLElement).style.display = "";
    } else (los as unknown as HTMLElement).style.display = "none";
  }

  if (isNewPlay) { lastAnimatedPlayId = playKey; lastChain = { key: playKey, at: Date.now(), ms: chainMs }; }   // scorebug: lastChain
}


const SWING_MIN = 7; // percentage points
function winProbSwing(summary: any, playId: string): { pts: number; towardHome: boolean } | null {
  const wp: any[] = summary?.winprobability || [];
  if (!wp.length || !playId) return null;
  const i = wp.findIndex((w: any) => String(w?.playId) === String(playId));
  if (i < 1) return null;
  const now = Number(wp[i]?.homeWinPercentage);
  const prev = Number(wp[i - 1]?.homeWinPercentage);
  if (!isFinite(now) || !isFinite(prev)) return null;
  const delta = (now - prev) * 100;
  if (Math.abs(delta) < SWING_MIN) return null;
  return { pts: Math.round(Math.abs(delta)), towardHome: delta > 0 };
}

function renderPlayBanner(summary: any, g: NormGame): void {
  const pill = $("penalty-pill");
  if (!pill) return;
  const { last, lastReal } = lastPlays(summary);
  const p = (last?.isPenalty === true ? last : lastReal?.isPenalty === true ? lastReal : null);
  if (p) {
    // NFL: "PENALTY on LAC-J.Smith, Holding, 5 yards, …"
    // CFB: "PENALTY Pitt UNS: Unsportsmanlike Conduct (#32 J.Marcelin) 15 yards from Cuse20"
    //      "PENALTY Cuse Personal Foul (#0 D.Clement) 15 yards from Pitt35 to Pitt50"
    const ptext = String(p?.text || "");
    const m = ptext.match(/PENALTY on ([A-Z]{2,4})[^,]*,\s*([^,.]+)/) ||
      ptext.match(/PENALTY\s+([A-Za-z][A-Za-z&.'()-]*)\s+(?:[A-Z]{2,5}:\s*)?(.+?)(?:\s*\(|\s+\d+\s+yards?|,|\.|$)/); // "(" not "(#": the tidied text has no jersey numbers, and "(C.Brown)" was cut at its period (Nov 7)
    const abbr = m?.[1] || "";
    const name = (m?.[2] || "Penalty").trim();
    const pa = abbr ? matchStrength(abbr, g.away) : 0, ph = abbr ? matchStrength(abbr, g.home) : 0;
    const team = pa > ph ? g.away : ph > pa ? g.home : null;
    pill.className = "play-banner on pen";
    setHtml(pill, (team ? `<span class="pb-logo">${logoHtml(team, "pb-logo-img")}</span>` : "") +
      escapeHtml(name));
    return;
  }
  // Big swings get a chip regardless of play type — a turnover or a 4th-down
  // stop can move the needle harder than a score (Joe: the live feed is the
  // main attraction; this is the moment people screenshot).
  const swing = lastReal ? winProbSwing(summary, String(lastReal?.id ?? "")) : null;
  const swingHtml = swing
    ? `<span class="pb-swing">${logoHtml(swing.towardHome ? g.home : g.away, "pb-swing-logo")}` +
      `<span class="pb-swing-val">+${swing.pts}%</span></span>`
    : "";

  const scorer = lastReal?.scoringPlay === true ? lastReal : null;
  if (scorer) {
    const off = offenseOf(summary, g);
    const label = String(scorer?.type?.text || "Score").toUpperCase();
    pill.className = "play-banner on score";
    setHtml(pill, (off ? `<span class="pb-logo">${logoHtml(off.team, "pb-logo-img")}</span>` : "") +
      escapeHtml(label) + swingHtml);
    return;
  }
  // Non-scoring play that still moved the needle hard (turnover, 4th-down
  // stop, explosive gain): the swing alone earns the banner.
  if (swing) {
    const label = String(lastReal?.type?.text || "Big Play").toUpperCase();
    pill.className = "play-banner on swing";
    setHtml(pill, escapeHtml(label) + swingHtml);
    return;
  }
  pill.className = "play-banner";
  setHtml(pill, "");
}


// ═══════════════════════════ EXPORTS (new) ═══════════════════════════════

/** Forget the current game so the next render rebuilds the statics for new teams. */
export function resetField(): void {
  lastAnimatedPlayId = "";
  lastChain = { key: '', at: 0, ms: 0 };
  lastDriveGeom = null;
  const svg = $("field-svg");
  if (svg) svg.innerHTML = "";
  for (const id of ["fv-drive", "fv-play", "fv-pin", "fv-chip"]) { const el = $(id); if (el) el.innerHTML = ""; }
}

/** ESPN's own timeouts-remaining when the server has them, else the play-text counter. */
export function timeoutsFor(summary: any, g: NormGame): { away: number; home: number } | null {
  return espnTimeouts ?? timeoutsRemaining(summary, g);
}

export {
  FB, xLane, xB, xT, clampUnit, buildFieldStatics, fitEzNames, renderFieldViz, renderPlayBanner,
  lastPlays, activeDrive, offenseOf, spotOwnerOf, displayPlaysOf, realPlayCount, isAdminPlay, playTypeText,
  timeoutsRemaining, timeoutDotsHtml, decomposePlay, winProbSwing, spotToUnit, matchStrength, KICKOFF_PLAY,
};
