// src/client/basketball/court3d.ts — LIFTED VERBATIM from nba-hub/src/client/court3d.ts (Nov 2026); imports rewired only.
// src/client/court3d.ts — sideline-camera court with a shot animation.
//
// Original drawing (no ESPN assets): the court is modelled in feet
// (X 0..94 along the length, Y 0..50 across, Z up) and projected through a
// simple pinhole camera placed off the near sideline. Lines are sampled and
// projected, so arcs foreshorten correctly. Upright pieces (stanchions,
// backboards, rims) and the ball live in the same 3-D space.

import type { League } from '../../shared/basketball.ts';
import { LEN, LINES, RIM, WID } from './court.ts';

type V3 = [number, number, number];
type P2 = [number, number];

// ── camera ────────────────────────────────────────────────────────────────
//
// Three views share one scene:
//   'full'  — the whole court from high off the near sideline (desktop).
//   'left' / 'right' — one half from behind midcourt, facing that basket
//             (broadcast angle). Roughly twice the size on a phone, and the
//             rim faces the viewer, so makes and misses read clearly.

export type View = 'full' | 'left' | 'right';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

const FOCAL = 1000;
const PAD = 14;
export const VIEW_W = 1000;

interface Cam { cam: V3; fwd: V3; right: V3; up: V3; minX: number; minY: number; scale: number; h: number }

function makeCam(view: View): Cam {
  let cam: V3;
  let target: V3;
  let extent: V3[];
  if (view === 'full') {
    cam = [LEN / 2, WID / 2 + 150, 118];
    target = [LEN / 2, WID / 2 - 1, 0];
    extent = [[0, 0, 0], [LEN, 0, 0], [0, WID + 5, 0], [LEN, WID + 5, 0], [-4, WID / 2, 13.5], [LEN + 4, WID / 2, 13.5], [LEN / 2, 0, 12]];
  } else {
    const r = view === 'right';
    const bx = r ? LEN : 0;
    const s = r ? 1 : -1;                                   // +1 = basket toward +X
    // Broadcast "baseline-facing" angle: from well behind the top of the key, fairly low,
    // so the backboard faces the viewer and the rim reads large. Framed from ~31 ft out
    // (beyond the arc) to the baseline; deeper shots fly in from the bottom edge.
    cam = [bx - s * 64, WID / 2, 22];
    target = [bx - s * 10, WID / 2, 6];
    extent = [[bx - s * 30, -1, 0], [bx - s * 30, WID + 1, 0], [bx, -1, 0], [bx, WID + 1, 0], [bx - s * 4, WID / 2 - 6, 15.5], [bx - s * 4, WID / 2 + 6, 15.5], [bx - s * 12, WID / 2, 17.5], [bx - s * 20, WID / 2, 17]];
  }
  const fwd = norm(sub(target, cam));
  const right = norm(cross([0, 0, 1], fwd));
  const up = cross(fwd, right);
  const rawP = (p: V3): P2 => {
    const d = sub(p, cam);
    const z = dot(d, fwd);
    return [(FOCAL * dot(d, right)) / z, (-FOCAL * dot(d, up)) / z];
  };
  const raw = extent.map(rawP);
  const minX = Math.min(...raw.map((p) => p[0]));
  const maxX = Math.max(...raw.map((p) => p[0]));
  const minY = Math.min(...raw.map((p) => p[1]));
  const maxY = Math.max(...raw.map((p) => p[1]));
  const scale = (VIEW_W - PAD * 2) / (maxX - minX);
  return { cam, fwd, right, up, minX, minY, scale, h: Math.round((maxY - minY) * scale + PAD * 2) };
}

const CAMS: Record<View, Cam> = { full: makeCam('full'), left: makeCam('left'), right: makeCam('right') };
let C: Cam = CAMS.full;
let currentView: View = 'full';

/**
 * Hoop hardware is drawn larger than life (rim, backboard, net, ball) so a
 * make or miss reads on a phone. Positions stay true: the rim centre is
 * still 5.25 ft from the baseline at 10 ft, so shots fly to the right spot.
 */
const HOOP_SCALE: Record<View, number> = { full: 1.4, left: 1.8, right: 1.8 };
let K = HOOP_SCALE.full;
export const rimRadius = (): number => 0.75 * K;

export function setView(v: View): void { currentView = v; C = CAMS[v]; K = HOOP_SCALE[v]; }
export function getView(): View { return currentView; }
export function viewHeight(v: View = currentView): number { return CAMS[v].h; }

export function project(p: V3): P2 {
  const d = sub(p, C.cam);
  // Points at or behind the camera (backcourt heaves in a half-court view) would
  // project inverted; clamp depth so they land far off-frame instead.
  const z = Math.max(1, dot(d, C.fwd));
  const x = (FOCAL * dot(d, C.right)) / z;
  const y = (-FOCAL * dot(d, C.up)) / z;
  return [(x - C.minX) * C.scale + PAD, (y - C.minY) * C.scale + PAD];
}

/** Screen scale (px per foot) at a point — for sizing the ball and markers. */
export function scaleAt(p: V3): number {
  const a = project(p);
  const b = project([p[0], p[1] + 1, p[2]]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

const r1 = (n: number): string => n.toFixed(1);
const path = (pts: V3[], close = false): string =>
  pts.map((p, i) => { const [x, y] = project(p); return `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`; }).join('') + (close ? 'Z' : '');

/** Floor-plane arc around (cx, cy), angles in radians, sampled. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 40): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]);
  }
  return out;
}

// ── static court ─────────────────────────────────────────────────────────

function end(league: League, right: boolean): { floor: string[]; upright: string[]; front: string[] } {
  const l = LINES[league];
  const s = right ? -1 : 1;                 // direction from this baseline into the court
  const bx = right ? LEN : 0;               // baseline X
  const X = (d: number): number => bx + s * d;
  const cy = WID / 2;
  const rimX = X(RIM);
  const floor: string[] = [];

  // Lane
  const lw = l.lane / 2;
  floor.push(`<path class="paint" d="${path([[X(0), cy - lw, 0], [X(19), cy - lw, 0], [X(19), cy + lw, 0], [X(0), cy + lw, 0]], true)}"/>`);
  // Free-throw circle: solid half toward midcourt, dashed half inside the lane
  const ftx = X(19);
  const H = Math.PI / 2;
  floor.push(`<path class="ln" d="${path(right ? arc(ftx, cy, 6, H, 3 * H) : arc(ftx, cy, 6, -H, H))}"/>`);
  floor.push(`<path class="ln dash" d="${path(right ? arc(ftx, cy, 6, -H, H) : arc(ftx, cy, 6, H, 3 * H))}"/>`);
  // Three-point line: corner lines, then the arc through the top of the key
  const c = Math.asin(Math.min(1, l.corner / l.arc));
  const cornerLen = RIM + Math.sqrt(Math.max(0, l.arc ** 2 - l.corner ** 2));
  const arcPts = right ? arc(rimX, cy, l.arc, Math.PI + c, Math.PI - c, 60) : arc(rimX, cy, l.arc, -c, c, 60);
  floor.push(`<path class="ln" d="${path([[X(0), cy - l.corner, 0], [X(cornerLen), cy - l.corner, 0], ...arcPts, [X(cornerLen), cy + l.corner, 0], [X(0), cy + l.corner, 0]])}"/>`);
  // Restricted area
  floor.push(`<path class="ln thin" d="${path(arc(rimX, cy, l.restricted, right ? Math.PI / 2 : -Math.PI / 2, right ? Math.PI * 1.5 : Math.PI / 2, 24))}"/>`);

  // Uprights: stanchion behind the baseline, arm, backboard, rim (hardware scaled by K).
  const upright: string[] = [];
  const boardX = X(4);
  const baseX = bx - s * 4;
  const rr = 0.75 * K;
  const bw = 3 * K;
  const bBot = 10 - 1 * K;
  const bTop = 10 + 2.5 * K;
  upright.push(`<path class="stanchion" d="${path([[baseX, cy - 0.5 * K, 0], [baseX, cy + 0.5 * K, 0], [baseX, cy + 0.5 * K, bBot], [baseX, cy - 0.5 * K, bBot]], true)}"/>`);
  upright.push(`<path class="arm" d="${path([[baseX, cy, bBot], [boardX, cy, bBot + 0.6]])}"/>`);
  upright.push(`<path class="board" d="${path([[boardX, cy - bw, bBot], [boardX, cy + bw, bBot], [boardX, cy + bw, bTop], [boardX, cy - bw, bTop]], true)}"/>`);
  upright.push(`<path class="board-box" d="${path([[boardX, cy - K, 10], [boardX, cy + K, 10], [boardX, cy + K, 10 + 1.5 * K], [boardX, cy - K, 10 + 1.5 * K]], true)}"/>`);
  const endId = right ? 'right' : 'left';
  upright.push(`<path class="rim3d" data-end="${endId}" d="${path(arc(rimX, cy, rr, 0, Math.PI * 2, 32).map(([x, y]) => [x, y, 10] as V3), true)}"/>`);
  // Drawn AFTER the ball: the net and the rim's near edge, so a make drops through.
  const front: string[] = [];
  const nearA = right ? Math.PI / 2 : -Math.PI / 2;
  front.push(`<path class="net" data-end="${endId}" d="${netPath(rimX, cy)}"/>`);
  front.push(`<path class="rim3d" data-end="${endId}" d="${path(arc(rimX, cy, rr, nearA, nearA + Math.PI, 16).map(([x, y]) => [x, y, 10] as V3))}"/>`);
  return { floor, upright, front };
}

function netPath(rx: number, ry: number): string {
  const top = arc(rx, ry, 0.75 * K, 0, Math.PI * 2, 16).map(([x, y]) => [x, y, 10] as V3);
  const bot = arc(rx, ry, 0.45 * K, 0, Math.PI * 2, 16).map(([x, y]) => [x, y, 10 - 1.5 * K] as V3);
  let d = '';
  for (let i = 0; i < top.length - 1; i += 2) {
    const t = top[i];
    const b = bot[i];
    if (t && b) d += path([t, b]);
  }
  d += path(bot, true);
  return d;
}

export function court3dMarkup(league: League, view: View = currentView): string {
  setView(view);
  const cx = LEN / 2;
  const cy = WID / 2;
  const ends = view === 'full' ? [end(league, false), end(league, true)] : [end(league, view === 'right')];
  // Half views show only the attacked half (the other end is behind the camera).
  const x0 = view === 'right' ? cx : 0;
  const x1 = view === 'left' ? cx : LEN;
  const floorRect: V3[] = [[x0, 0, 0], [x1, 0, 0], [x1, WID, 0], [x0, WID, 0]];
  const centre = view === 'full'
    ? arc(cx, cy, 6, 0, Math.PI * 2, 48)
    : view === 'right' ? arc(cx, cy, 6, -Math.PI / 2, Math.PI / 2, 24) : arc(cx, cy, 6, Math.PI / 2, Math.PI * 1.5, 24);
  return [
    `<defs><linearGradient id="floorShade" x1="0" y1="0" x2="0" y2="1">
       <stop class="fs-a" offset="0"/><stop class="fs-b" offset="1"/></linearGradient></defs>`,
    `<path class="floor3d" d="${path(floorRect, true)}"/>`,
    `<g id="l3-poss"></g>`,
    ...ends.flatMap((e) => e.floor),
    `<path class="ln" d="${path([[cx, 0, 0], [cx, WID, 0]])}"/>`,
    `<path class="ln" d="${path(centre, view === 'full')}"/>`,
    view === 'full' ? `<path class="ln thin" d="${path(arc(cx, cy, 2, 0, Math.PI * 2, 24), true)}"/>` : '',
    `<path class="edge" d="${path(floorRect, true)}"/>`,
    `<g id="l3-tags"></g>`,
    `<g id="l3-shots"></g>`,
    ...ends.flatMap((e) => e.upright),
    `<g id="l3-ball"></g>`,
    ...ends.flatMap((e) => e.front),
    `<g id="l3-fx"></g>`,
  ].join('');
}

// ── floor overlays ───────────────────────────────────────────────────────

export function floorPoly(pts: Array<[number, number]>): string {
  return path(pts.map(([x, y]) => [x, y, 0] as V3), true);
}

// ── ball animation ───────────────────────────────────────────────────────

export type ShotStyle = 'dunk' | 'layup' | 'jumper' | 'three' | 'ft';

export interface ShotAnim {
  from: [number, number];     // court feet
  right: boolean;             // basket on the right
  made: boolean;
  blocked: boolean;
  seed: number;               // deterministic miss direction
  /** Shapes the flight: a dunk is a short low slam, a three a high rainbow, a free throw a soft set shot. */
  style?: ShotStyle;
}

/** Flight time (s) and apex height (ft) for a shot: the play's own tempo, not one generic arc. */
function flightOf(a: ShotAnim, dist: number): { flight: number; apex: number } {
  switch (a.style) {
    case 'dunk': return { flight: 0.42, apex: 11.2 };
    case 'layup': return { flight: 0.6, apex: 12.5 };
    case 'ft': return { flight: 0.95, apex: 15 };
    case 'three': return { flight: 1.05 + Math.min(0.35, (dist - 22) / 40), apex: 17 + Math.min(4, (dist - 22) * 0.3) };
    default: return { flight: 0.75 + Math.min(0.6, dist / 50), apex: 10 + Math.min(8, 2.5 + dist * 0.28) };
  }
}

export type V3pt = V3;

let rafId = 0;

const ease = (t: number): number => t;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The moment (s) the ball reaches the rim, or is swatted. */
function impactAt(a: ShotAnim): number {
  const rim: V3 = [a.right ? LEN - RIM : RIM, WID / 2, 10];
  const dist = Math.hypot(rim[0] - a.from[0], rim[1] - a.from[1]);
  const { flight } = flightOf(a, dist);
  return a.blocked ? flight * 0.3 : flight;
}

/** Ball position at time t (seconds) — returns null when the animation is over. */
function ballAt(a: ShotAnim, t: number): V3 | null {
  const rim: V3 = [a.right ? LEN - RIM : RIM, WID / 2, 10];
  const start: V3 = [a.from[0], a.from[1], 7];
  const dist = Math.hypot(rim[0] - start[0], rim[1] - start[1]);
  const { flight, apex } = flightOf(a, dist);

  if (a.blocked) {
    const tb = flight * 0.3;
    if (t <= tb) {
      const u = t / flight;
      return [lerp(start[0], rim[0], u), lerp(start[1], rim[1], u), arcZ(start[2], rim[2], apex, u)];
    }
    const u0 = tb / flight;
    const p0: V3 = [lerp(start[0], rim[0], u0), lerp(start[1], rim[1], u0), arcZ(start[2], rim[2], apex, u0)];
    const k = t - tb;
    if (k > 0.9) return null;
    const dir = a.seed % 2 ? 1 : -1;
    return [p0[0] - (a.right ? 1 : -1) * 9 * k, p0[1] + dir * 12 * k, Math.max(0.4, p0[2] + 6 * k - 22 * k * k)];
  }

  if (t <= flight) {
    const u = ease(t / flight);
    return [lerp(start[0], rim[0], u), lerp(start[1], rim[1], u), arcZ(start[2], rim[2], apex, u)];
  }
  const k = t - flight;
  if (a.made) {
    if (k <= 0.35) return [rim[0], rim[1], 10 - (k / 0.35) * (1.5 * K + 1.5)]; // through the net
    const k2 = k - 0.35;
    if (k2 > 0.7) return null;
    return [rim[0], rim[1], Math.max(0.4, 8.5 - 1.5 * K - 32 * k2 * k2)];     // drop to the floor
  }
  // Miss: clank off the rim and kick out.
  if (k > 1.0) return null;
  const ang = ((a.seed % 7) / 7) * Math.PI - Math.PI / 2;                    // spread toward the court
  const out = a.right ? -1 : 1;
  const vx = out * (6 + (a.seed % 3) * 2) * Math.cos(ang * 0.6);
  const vy = 9 * Math.sin(ang);
  return [rim[0] + vx * k, rim[1] + vy * k, Math.max(0.4, 10.3 + 9 * k - 24 * k * k)];
}

function arcZ(z0: number, z1: number, apex: number, u: number): number {
  // Parabola through z0 at u=0, apex near the middle, z1 at u=1.
  const base = lerp(z0, z1, u);
  const lift = apex - (z0 + z1) / 2;
  return base + 4 * lift * u * (1 - u);
}

/** Animate one shot into the l3-ball layer. Cancels any animation in flight. */
/** Deepest start point shown in a half-court view, in feet from the baseline. */
const HALF_VIEW_DEPTH = 34;

/** The flight in progress, so an interruption can still settle its caller. */
let inFlight: { done?: () => void } | null = null;

/**
 * Animate one shot. `speed` > 1 plays it faster when the queue has a backlog.
 * A trail of recent positions is drawn behind the ball, tapering and fading
 * (the "shooting star"), so a fast flight on a small screen is easy to follow.
 */
export interface FlightHooks {
  /** Rim contact or the block, with the ball's position then. Once per flight. */
  onImpact?: (p: V3) => void;
  /** Flight over (or interrupted); the last ball position, so a rebound chip can land where the ball did. */
  onDone?: (rest: V3 | null) => void;
}

export function playShot(a: ShotAnim, colour: string, hooks: FlightHooks = {}, speed = 1): void {
  const onDone = hooks.onDone;
  // Half-court view: a shot from deeper than the frame (a heave from the backcourt)
  // starts where its path enters the picture, so the ball flies in from the bottom edge.
  if (currentView !== 'full') {
    const rimX = a.right ? LEN - RIM : RIM;
    const bx = a.right ? LEN : 0;
    const depth = Math.abs(a.from[0] - bx);
    if (depth > HALF_VIEW_DEPTH) {
      const t = (depth - HALF_VIEW_DEPTH) / Math.max(1, depth - RIM);
      a = { ...a, from: [a.from[0] + (rimX - a.from[0]) * t, a.from[1] + (WID / 2 - a.from[1]) * t] };
    }
  }
  clearBall();
  const g = document.getElementById('l3-ball');
  if (!g) { onDone?.(null); return; }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { g.innerHTML = ''; onDone?.(null); return; }
  let last: V3 | null = null;
  const me = { done: (): void => onDone?.(last) };
  inFlight = me;
  const finish = (): void => { if (inFlight === me) inFlight = null; g.innerHTML = ''; onDone?.(last); };
  const t0 = performance.now();
  const tImpact = impactAt(a);
  let impacted = false;
  const trail: Array<[number, number, number]> = [];   // screen x, y, radius
  const frame = (now: number): void => {
    const t = ((now - t0) / 1000) * speed;
    const p = ballAt(a, t);
    if (!p) { finish(); return; }
    last = p;
    if (!impacted && t >= tImpact) { impacted = true; hooks.onImpact?.(p); }
    const [sx, sy] = project(p);
    const [hx, hy] = project([p[0], p[1], 0]);
    const s = scaleAt(p);
    const r = Math.max(4, 0.5 * rimRadius() * s * 1.25);
    const shadowA = Math.max(0.12, 0.45 - p[2] * 0.02);
    trail.push([sx, sy, r]);
    if (trail.length > 14) trail.shift();
    const tail = trail.length > 2
      ? trail.slice(0, -1).map(([tx, ty, tr], i) => {
          const k = (i + 1) / trail.length;             // 0 = oldest
          return `<circle cx="${r1(tx)}" cy="${r1(ty)}" r="${r1(tr * (0.25 + 0.6 * k))}" fill="${colour}" opacity="${(0.05 + 0.4 * k).toFixed(2)}"/>`;
        }).join('')
      : '';
    g.innerHTML =
      `<ellipse cx="${r1(hx)}" cy="${r1(hy)}" rx="${r1(r * 1.05)}" ry="${r1(r * 0.4)}" fill="#000" opacity="${shadowA.toFixed(2)}"/>` +
      `<g class="trail">${tail}</g>` +
      `<g transform="translate(${r1(sx)} ${r1(sy)}) rotate(${r1(t * 540)})">` +
      `<circle r="${r1(r)}" class="ball"/>` +
      `<path class="seam" d="M${r1(-r)} 0 H${r1(r)} M0 ${r1(-r)} V${r1(r)}"/>` +
      `<circle r="${r1(r)}" class="ball-ring" style="stroke:${colour}"/></g>`;
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

/** Stop any flight. The interrupted flight's callback still fires, so the queue never wedges. */
export function clearBall(): void {
  cancelAnimationFrame(rafId);
  const g = document.getElementById('l3-ball');
  if (g) g.innerHTML = '';
  const f = inFlight;
  inFlight = null;
  f?.done?.();
}

// ── hardware reaction ────────────────────────────────────────────────────
// A make ripples the net; a miss rattles the rim. Class replays on the
// static paths, so nothing is rebuilt.

export function hoopReact(right: boolean, made: boolean): void {
  const end = right ? 'right' : 'left';
  const svg = document.getElementById('court');
  if (!svg) return;
  const cls = made ? 'swish' : 'rattle';
  for (const el of Array.from(svg.querySelectorAll<SVGElement>(made ? `.net[data-end="${end}"]` : `.rim3d[data-end="${end}"]`))) {
    el.classList.remove(cls);
    void (el as unknown as HTMLElement).getBoundingClientRect?.();   // restart the keyframes
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 700);
  }
}
