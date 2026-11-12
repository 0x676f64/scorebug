// src/client/basketball/live.ts — LIFTED VERBATIM from nba-hub/src/client/live.ts (Nov 2026); imports rewired only.
// src/client/live.ts — the live court (3-D camera, ball flight, possession,
// event banner, run chip), the lead tracker, and the top-down shot chart.

import type { GameView, ShotView, Side } from '../../shared/basketball.ts';
import { courtMarkup, fu, LEN, RIM, toCourt, WID } from './court.ts';
import { clearBall, court3dMarkup, floorPoly, hoopReact, playShot, project, rimRadius, scaleAt, viewHeight, VIEW_W, type ShotStyle, type View } from './court3d.ts';
import { $, brand, esc, identity, ink, isLight, logoSrc, onColor, periodShort, replay, setHtml, teamLogo } from './ui.ts';

// ── state ────────────────────────────────────────────────────────────────

let courtKey = '';
let lastBannerId = '';
/** Half court (attacked end, broadcast angle) or the whole court. Phones default to half. */
let camPref: 'half' | 'full' = loadCamPref() ?? (window.innerWidth < 560 ? 'half' : 'full');
/** While a shot flies the camera stays on that basket even if possession flips. */
let animLock: 'left' | 'right' | null = null;
let rerender: () => void = () => {};

function loadCamPref(): 'half' | 'full' | null {
  try { const v = localStorage.getItem('courtView'); return v === 'half' || v === 'full' ? v : null; } catch { return null; }
}
function saveCamPref(v: 'half' | 'full'): void {
  try { localStorage.setItem('courtView', v); } catch { /* not persisted */ }
}

export function toggleCamera(): void {
  camPref = camPref === 'half' ? 'full' : 'half';
  saveCamPref(camPref);
  animLock = null;
}

/** scorebug: the surface picks the camera from its URL (?cam=half|full). */
export function setCamera(v: 'half' | 'full'): void { camPref = v; animLock = null; courtKey = ''; }

/** Called once by the shell so a finished ball flight can re-render. */
export function onRerender(fn: () => void): void { rerender = fn; }

/** Drop the cached court so it redraws (theme change). */
export function invalidateCourt(): void { courtKey = ''; }

// ── camera choice ────────────────────────────────────────────────────────

function desiredView(v: GameView): View {
  if (camPref === 'full') return 'full';
  if (animLock) return animLock;
  const side = v.possession ?? v.last?.side ?? null;
  if (side != null) return v.teams[side].attacksRight ? 'right' : 'left';
  return v.teams[1].attacksRight ? 'right' : 'left';
}

function shownEnd(v: GameView): 'left' | 'right' | null {
  const d = desiredView(v);
  return d === 'full' ? null : d;
}

function ensureLiveCourt(v: GameView): void {
  const view = desiredView(v);
  const key = `${v.league}:live:${view}:${isLight() ? 'L' : 'D'}`;
  if (courtKey === key) return;
  const swapping = courtKey.startsWith(`${v.league}:live:`);
  courtKey = key;
  const svg = $('court');
  clearBall();
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${viewHeight(view)}`);
  setHtml(svg, court3dMarkup(v.league, view));
  svg.classList.add('c3d');
  svg.classList.toggle('half', view !== 'full');
  if (swapping) replay(svg, 'swap');
  $('view-toggle').textContent = camPref === 'half' ? 'Full court' : 'Half court';
}

// ── possession + shots on the 3-D floor ──────────────────────────────────

function floorLine(pts: Array<[number, number]>): string {
  return pts.map(([x, y], i) => { const [sx, sy] = project([x, y, 0]); return `${i ? 'L' : 'M'}${sx.toFixed(1)} ${sy.toFixed(1)}`; }).join('');
}

function renderPossession(v: GameView): void {
  const g = document.getElementById('l3-poss');
  const tags = document.getElementById('l3-tags');
  if (!g || !tags) return;
  const end = shownEnd(v);
  if (end) {
    // Half court: the logo badge in team colours says who has the ball; no label needed.
    setHtml(tags, '');
  } else {
    setHtml(tags, ([0, 1] as Side[]).map((s) => {
      const t = v.teams[s];
      const right = t.attacksRight;
      const [x, y] = project([right ? LEN - 0.5 : 0.5, WID + 3.4, 0]);
      return `<text class="end-tag3" x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${ink(v, s)}" text-anchor="${right ? 'end' : 'start'}">${esc(t.abbr)}</text>`;
    }).join(''));
  }

  if (v.possession == null) { setHtml(g, ''); return; }
  const t = v.teams[v.possession];
  const id = identity(v, v.possession);
  const c = id.ink;
  const glow = brand(v, v.possession);
  const right = t.attacksRight;
  if (end && end !== (right ? 'right' : 'left')) { setHtml(g, ''); return; }
  const [mx, my] = project([LEN / 2, WID / 2, 0]);
  const [bx, by] = project([right ? LEN : 0, WID / 2, 0]);
  const half = floorPoly(right ? [[LEN / 2, 0], [LEN, 0], [LEN, WID], [LEN / 2, WID]] : [[0, 0], [LEN / 2, 0], [LEN / 2, WID], [0, WID]]);
  const d = right ? 1 : -1;
  const x0 = end ? (right ? LEN - 29 : 29) : LEN / 2;
  // Two-tone chevrons: ink fill, trim edge, so a red team still reads against a red team.
  const chev = (dx: number): string => {
    const x = x0 + d * (end ? dx - 7 : dx);
    const pts: Array<[number, number]> = [[x - d * 1.6, WID / 2 - 3.2], [x + d * 1.6, WID / 2], [x - d * 1.6, WID / 2 + 3.2], [x - d * 0.4, WID / 2]];
    return `<path class="chev2" d="${floorLine(pts)}Z" fill="${c}" stroke="${id.trim}"/>`;
  };
  // Glow on the attacked rim: the ball is going THIS way.
  const [rx, ry] = project([right ? LEN - RIM : RIM, WID / 2, 10]);
  const rr = Math.max(26, rimRadius() * scaleAt([right ? LEN - RIM : RIM, WID / 2, 10]) * 4.5);
  // Possession badge: the team's logo in a two-tone ring at the near corner of the attacking half.
  // Identity-proof regardless of colours. In the half-court camera the near sideline is y=1.5 for
  // the right end and y=WID-1.5 for the left end (the camera turns with the basket).
  const [lx, ly] = end
    ? project([right ? LEN - 24 : 24, right ? 5 : WID - 5, 0])
    : project([right ? LEN - 7 : 7, WID - 3.5, 0]);
  const br = end ? 30 : 19;
  setHtml(g, `
    <defs>
      <linearGradient id="possGrad3" gradientUnits="userSpaceOnUse" x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}">
        <stop offset="0" stop-color="${glow}" stop-opacity="0.03"/><stop offset="1" stop-color="${glow}" stop-opacity="${isLight() ? 0.26 : 0.3}"/>
      </linearGradient>
      <radialGradient id="rimGlow3"><stop offset="0" stop-color="${glow}" stop-opacity="0.7"/><stop offset="0.55" stop-color="${glow}" stop-opacity="0.25"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
      <clipPath id="badgeClip"><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${br - 3}"/></clipPath>
    </defs>
    <path d="${half}" fill="url(#possGrad3)"/>
    <circle class="rim-glow" cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="${rr.toFixed(1)}" fill="url(#rimGlow3)"/>
    <g class="chevs">${chev(7)}${chev(11)}${chev(15)}</g>
    <g class="badge">
      <circle class="badge-ring" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${br}" fill="${c}" stroke="${id.trim}" stroke-width="2.5"/>
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${br - 3}" fill="${isLight() ? '#ffffff' : '#0a1828'}"/>
      <image x="${(lx - br + 5).toFixed(1)}" y="${(ly - br + 5).toFixed(1)}" width="${(br - 5) * 2}" height="${(br - 5) * 2}" clip-path="url(#badgeClip)" preserveAspectRatio="xMidYMid meet"/>
    </g>`);
  // The logo's src is set apart from the markup: once the image settles on a fallback file the src
  // changes, and a rewrite of the whole group for that would restart the rim and ring pulses.
  const img = g.querySelector('image');
  const src = logoSrc(t);
  if (img && img.getAttribute('href') !== src) img.setAttribute('href', src);
}

function renderFloorShots(v: GameView): void {
  const g = document.getElementById('l3-shots');
  if (!g) return;
  const end = shownEnd(v);
  const shots = v.shots.filter((s) => s.period === v.period && (!end || ((v.teams[s.side].attacksRight ? 'right' : 'left') === end && s.y <= 36)));
  setHtml(g, shots.map((s) => {
    const t = v.teams[s.side];
    const [cx, cy] = toCourt(s.x, s.y, t.attacksRight);
    const c = ink(v, s.side);
    const r = 0.8;
    if (s.made) {
      const ring: Array<[number, number]> = [];
      for (let i = 0; i < 18; i++) ring.push([cx + r * Math.cos((i / 18) * Math.PI * 2), cy + r * Math.sin((i / 18) * Math.PI * 2)]);
      return `<path class="m3 made" d="${floorPoly(ring)}" fill="${c}"/>`;
    }
    const k = r * 0.8;
    return `<path class="m3 miss" d="${floorLine([[cx - k, cy - k], [cx + k, cy + k]])}${floorLine([[cx + k, cy - k], [cx - k, cy + k]])}" stroke="${c}"/>`;
  }).join(''));
}

/** Spot a new shot or free throw; lock the camera on its basket and queue the flight. */
// ── shot animation queue ─────────────────────────────────────────────────
// A poll can bring several plays at once (shot, rebound, foul). Only the
// newest used to be considered, so a shot followed by a rebound never
// animated. Now every unseen shot or free throw is queued and played in
// order, but the court represents NOW: when a poll lands with a burst (a
// run, a feed catch-up, a tab that was in the background), only the newest
// two attempts fly; the rest settle straight onto the floor as marks. A
// viewer should never watch a replay of the last minute at double speed.

interface Queued {
  id: string; from: [number, number]; right: boolean; made: boolean; blocked: boolean; seed: number; side: Side; kind: string;
  /** Shooter (athlete id, '' when unknown) and what the play was, for the on-court tags. */
  player: string; text: string; pts: number; andOne: boolean; style: ShotStyle; ft: string;
}

/** The flight's shape from the play text: a dunk slams, a three rainbows, a free throw floats. */
function styleOf(text: string, pts: number, ft: boolean): ShotStyle {
  if (ft) return 'ft';
  if (/dunk|alley.?oop/i.test(text)) return 'dunk';
  if (/layup|lay-up|tip|finger roll|hook|putback|put back|floater/i.test(text)) return 'layup';
  return pts === 3 ? 'three' : 'jumper';
}

/** "FT 1 OF 2" from "... makes free throw 1 of 2"; technical and flagrant throws say so. */
function ftLabel(text: string): string {
  const m = text.match(/(\d)\s+of\s+(\d)/i);
  if (m) return `FT ${m[1]} OF ${m[2]}`;
  if (/technical/i.test(text)) return 'TECHNICAL FT';
  if (/flagrant/i.test(text)) return 'FLAGRANT FT';
  return 'FREE THROW';
}

/** Match a play's leading "First Last" to the roster's "F. Last" when the feed names no athlete id. */
function playerFromText(v: GameView, text: string, side: Side): string {
  const m = text.match(/^([A-Z][^\s]*)\s+([A-Z][^\s]*(?:\s+(?:Jr\.|Sr\.|II|III|IV))?)/);
  if (!m) return '';
  const first = m[1]!.charAt(0);
  const last = m[2]!.toLowerCase();
  for (const [id, p] of Object.entries(v.players)) {
    if (p.side !== side) continue;
    const parts = p.name.split(' ');
    if (parts.length < 2) continue;
    if (parts.slice(1).join(' ').toLowerCase() === last && parts[0]!.charAt(0) === first) return id;
  }
  return '';
}
const queue: Queued[] = [];
let playing = false;
let playingSince = 0;
let primed = false;
const seen = new Set<string>();     // shot / free-throw play ids already animated or skipped
const MAX_QUEUE = 2;
const WATCHDOG_MS = 4000;

/**
 * Queue every unseen field-goal attempt (from the full shot list, which the
 * light view carries) and every unseen free throw (from the recent list).
 * Diffing the shot list instead of the six-play recent list means a burst of
 * plays between polls can no longer push a shot out of view before we see it.
 */
function enqueueShots(v: GameView): void {
  if (!primed) {
    primed = true;
    for (const x of v.shots) seen.add(x.id);
    for (const r of v.recent) seen.add(r.id);
    return;
  }
  const fresh: Queued[] = [];
  const half = Math.ceil(v.regPeriods / 2);
  /** attacksRight is for the CURRENT period; a play from the other half of the game went the other way. */
  const rightFor = (side: Side, period: number): boolean => {
    const flip = (period <= half) !== (v.period <= half);
    return v.teams[side].attacksRight !== flip;
  };
  for (const x of v.shots) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const right = rightFor(x.side, x.period);
    const play = v.recent.find((r) => r.id === x.id);
    const text = play?.text ?? x.text;
    fresh.push({
      id: x.id, side: x.side, kind: play?.kind ?? (x.made ? 'made' : 'miss'), from: toCourt(x.x, x.y, right), right, made: x.made, blocked: play?.kind === 'block', seed: Number(x.id.slice(-4)) || 3,
      player: x.player || playerFromText(v, text, x.side), text, pts: x.pts, andOne: x.andOne, style: styleOf(text, x.pts, false), ft: '',
    });
  }
  for (const r of [...v.recent].reverse()) {
    if (seen.has(r.id) || r.side == null) continue;
    seen.add(r.id);
    if (r.kind !== 'ft' && r.kind !== 'ftmiss') continue;
    const right = rightFor(r.side, r.period);
    fresh.push({
      id: r.id, side: r.side, kind: r.kind, from: [right ? LEN - 19 : 19, WID / 2], right, made: r.kind === 'ft', blocked: false, seed: Number(r.id.slice(-4)) || 3,
      player: playerFromText(v, r.text, r.side), text: r.text, pts: 1, andOne: false, style: 'ft', ft: ftLabel(r.text),
    });
  }
  if (!fresh.length) return;
  // Shots and free throws arrive from two lists; order by id (ESPN ids ascend within a game).
  // The ids are unpadded decimal strings, so a shorter id is always the earlier play: compare
  // length first, then the text (captures/wnba/summary-401857214-post.json: play 9 is 40185721419, play 10 is 40185721420,
  // play 100 is 401857214154 — a plain string compare puts 401857214154 before 40185721419).
  fresh.sort((p, q) => (p.id.length - q.id.length) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  queue.push(...fresh);
  while (queue.length > MAX_QUEUE) queue.shift();
}

/** Off the live pane: keep the seen set current so returning never replays old shots. */
export function markSeen(v: GameView): void {
  primed = true;
  for (const x of v.shots) seen.add(x.id);
  for (const r of v.recent) seen.add(r.id);
  queue.length = 0;
}

function pump(v: GameView): void {
  if (playing && Date.now() - playingSince < WATCHDOG_MS) return;
  if (playing) console.warn('[anim] watchdog released a stuck flight');
  const q = queue.shift();
  if (!q) { playing = false; if (animLock) { animLock = null; window.setTimeout(rerender, 300); } return; }
  clearBall();                 // a stale flight settles NOW, before this one claims the queue
  playing = true;
  playingSince = Date.now();
  const speed = queue.length >= 1 ? 1.35 : 1;
  if (camPref === 'half') {
    animLock = q.right ? 'right' : 'left';
    const before = courtKey;
    ensureLiveCourt(v);
    if (courtKey !== before) { renderPossession(v); renderFloorShots(v); }   // the swap rebuilt the SVG
  }
  fly(v, q, speed, () => {
    playing = false;
    window.setTimeout(() => { if (lastView) pump(lastView); }, queue.length ? 120 : 250);
  });
}

/** One flight with its on-court grammar: shooter tag at launch, hoop reaction and result at the rim, chip after. */
function fly(v: GameView, q: Queued, speed: number, done: () => void): void {
  lastPlayed = q;
  $('replay-btn').hidden = false;
  cutFoulFlash();              // a foul's overlay sits over the lane: it would hide the free throw it caused
  showShooterTag(v, q);
  playShot({ from: q.from, right: q.right, made: q.made, blocked: q.blocked, seed: q.seed, style: q.style }, ink(v, q.side), {
    onImpact: (p) => {
      if (q.blocked) { chipAt(v, p, 'BLOCK', (1 - q.side) as Side, 1500); return; }
      hoopReact(q.right, q.made);
      if (q.made) floatScore(v, q);
    },
    onDone: (rest) => {
      settled = { at: Date.now(), p: rest, right: q.right, made: q.made };
      fadeShooterTag();
      done();
    },
  }, speed);
}

/** Replay the last flight on demand (the seen set is untouched, so nothing else changes). */
export function replayLast(): void {
  if (!lastPlayed || !lastView || playing) return;
  const v = lastView;
  const q = lastPlayed;
  playing = true;
  playingSince = Date.now();
  clearBall();
  // Same camera rule as pump(): possession may have flipped since the shot, so the half-court
  // camera could be on the other basket and the flight would leave the frame. Lock on the
  // shot's end, rebuild the court if that swapped it, and release the lock once the ball rests.
  if (camPref === 'half') {
    animLock = q.right ? 'right' : 'left';
    const before = courtKey;
    ensureLiveCourt(v);
    if (courtKey !== before) { renderPossession(v); renderFloorShots(v); }
  }
  fly(v, q, 1, () => { playing = false; animLock = null; window.setTimeout(rerender, 300); });
}

// ── on-court play grammar ────────────────────────────────────────────────
// The court shows WHO and WHAT, not just a ball: a shooter tag at the launch
// spot, "+3" lifting off the rim on a make, a chip for the block, the
// rebound and the steal. All drawn in the court's own 3-D space.

let lastPlayed: Queued | null = null;
let settled: { at: number; p: [number, number, number] | null; right: boolean; made: boolean } | null = null;
let tagTimer: number | undefined;
let fxSeq = 0;

const fxLayer = (): HTMLElement | null => document.getElementById('l3-fx');
const half = (): boolean => $('court').classList.contains('half');
/** Type sizes in viewBox units: the half view is roughly twice the size on a phone, so its type is smaller. */
const fxFont = (): number => (half() ? 30 : 22);

/** A rounded pill with a text label, in team ink. Returns markup for the fx layer. */
function pill(x: number, y: number, text: string, bg: string, fg: string, cls: string, key: string): string {
  const fs = fxFont();
  const w = text.length * fs * 0.62 + fs * 1.1;
  const h = fs * 1.5;
  return `<g class="fx ${cls}" data-fx="${key}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><g class="fx-in">
    <rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${bg}" stroke="${fg}" stroke-opacity="0.35" stroke-width="1.5"/>
    <text font-size="${fs}" fill="${fg}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text></g></g>`;
}

function removeFx(key: string, fade = true): void {
  const g = fxLayer();
  if (!g) return;
  for (const el of Array.from(g.querySelectorAll<SVGElement>(`[data-fx="${key}"]`))) {
    if (!fade) { el.remove(); continue; }
    el.classList.add('fx-out');
    window.setTimeout(() => el.remove(), 320);
  }
}

/** Shooter tag: "#24 D. MALONGA" (plus "FT 1 OF 2") floating above the launch spot with a stem to the floor. */
function showShooterTag(v: GameView, q: Queued): void {
  const g = fxLayer();
  if (!g) return;
  window.clearTimeout(tagTimer);
  removeFx('tag', false);
  const p = q.player ? v.players[q.player] : undefined;
  const who = p ? `${p.jersey ? `#${p.jersey} ` : ''}${p.name}` : '';
  const text = [who, q.ft].filter(Boolean).join(' · ').toUpperCase();
  if (!text) return;
  const id = identity(v, q.side);
  const fs = fxFont();
  const [fx, fy] = project([q.from[0], q.from[1], 0]);
  const rimX = q.right ? LEN - RIM : RIM;
  const [rx] = project([rimX, WID / 2, 10]);
  // A tag at the rim would sit on the hoop (layups, dunks): slide it sideways, stem angled back to the spot.
  // "Near" is measured on the floor, in feet: in the half-court camera the rim and the free-throw line
  // are close in screen x, so a screen test slid every FT tag off the court (seen at 360 half).
  const w = text.length * fs * 0.62 + fs * 1.1;
  const nearRim = Math.hypot(q.from[0] - rimX, q.from[1] - WID / 2) < 6;
  const px = Math.max(w / 2 + 8, Math.min(VIEW_W - w / 2 - 8, nearRim ? fx + Math.sign(fx - rx || 1) * (w / 2 + fs * 1.4) : fx));
  const py = fy - fs * 2.6;
  g.insertAdjacentHTML('beforeend',
    `<g class="fx fx-stem" data-fx="tag"><line x1="${fx.toFixed(1)}" y1="${fy.toFixed(1)}" x2="${px.toFixed(1)}" y2="${(py + fs * 0.75).toFixed(1)}" stroke="${id.ink}" stroke-width="2" opacity="0.7"/>
     <circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="${(fs * 0.22).toFixed(1)}" fill="${id.ink}"/></g>` +
    pill(px, py, text, id.ink, onColor(id.ink), 'fx-tag', 'tag'));
}

function fadeShooterTag(): void {
  window.clearTimeout(tagTimer);
  tagTimer = window.setTimeout(() => removeFx('tag'), 900);
}

/** "+3" (or "+2 AND-1") lifting off the rim in the scoring team's ink. */
function floatScore(v: GameView, q: Queued): void {
  const g = fxLayer();
  if (!g) return;
  const id = identity(v, q.side);
  const [rx, ry] = project([q.right ? LEN - RIM : RIM, WID / 2, 10]);
  const text = q.ft ? '+1' : q.andOne ? `+${q.pts} AND-1` : `+${q.pts}`;
  const key = `score${++fxSeq}`;
  g.insertAdjacentHTML('beforeend', pill(rx, ry - fxFont() * 1.6, text, id.ink, onColor(id.ink), 'fx-float', key));
  window.setTimeout(() => removeFx(key, false), 1300);
}

/** A labelled chip at a court point (ft, with height), in a team's ink, for `ms`. */
function chipAt(v: GameView, p: [number, number, number], text: string, side: Side, ms: number): void {
  const g = fxLayer();
  if (!g) return;
  const id = identity(v, side);
  const [x, y] = project(p);
  const key = `chip${++fxSeq}`;
  g.insertAdjacentHTML('beforeend', pill(x, y - fxFont() * 1.2, text, id.ink, onColor(id.ink), 'fx-chip', key));
  window.setTimeout(() => removeFx(key), ms);
}

/** Rebound, steal and turnover chips, once per play, where the action is. */
let lastChipId = '';
function renderPlayChips(v: GameView): void {
  const p = v.last;
  if (!p || p.id === lastChipId || p.side == null || !primed) return;
  const end = shownEnd(v);
  if (p.kind === 'rebound') {
    lastChipId = p.id;
    // Off the ball's resting spot when it just settled; else beside the rim being attacked.
    const fresh = settled && Date.now() - settled.at < 4000 && settled.p;
    const right = fresh ? settled!.right : (end ? end === 'right' : v.teams[p.side].attacksRight);
    if (end && (right ? 'right' : 'left') !== end) return;
    const at: [number, number, number] = fresh ? [settled!.p![0], settled!.p![1], 0] : [right ? LEN - RIM - 5 : RIM + 5, WID / 2 + 4, 0];
    const offensive = /offensive/i.test(p.text) || /offensive/i.test(p.label);
    chipAt(v, at, offensive ? 'OFF REB' : 'DEF REB', p.side, 1600);
  } else if (p.kind === 'steal' || p.kind === 'turnover') {
    lastChipId = p.id;
    // The turnover happened in the half the OFFENCE was attacking: the stealing side's opponent.
    const off = p.kind === 'steal' ? ((1 - p.side) as Side) : p.side;
    const right = v.teams[off].attacksRight;
    if (end && (right ? 'right' : 'left') !== end) return;
    chipAt(v, [right ? LEN - RIM - 20 : RIM + 20, WID / 2, 0], p.kind === 'steal' ? 'STEAL' : 'TURNOVER', p.kind === 'steal' ? p.side : ((1 - p.side) as Side), 1600);
  }
}

let lastView: GameView | null = null;


function renderBanner(v: GameView): void {
  const b = $('banner');
  const p = v.last;
  if (!p) { b.hidden = true; return; }
  const t = p.side != null ? v.teams[p.side] : null;
  const c = p.side != null ? ink(v, p.side) : 'var(--text-muted)';
  b.hidden = false;
  b.classList.toggle('foul', p.kind === 'foul');
  if (p.kind === 'foul' && t) {
    setHtml(b, `
      <span class="bn-bar" style="background:${c}"></span>
      <span class="bn-foul">${teamLogo(t, 'bn-logo')}<span class="bn-foul-txt"><span class="bn-foul-big">${esc(p.label || 'FOUL')}</span><span class="bn-foul-sub">${esc(t.abbr)} · ${esc(p.text)}</span></span><span class="bn-clock">${esc(p.clock)}</span></span>`);
    if (p.id !== lastBannerId) { lastBannerId = p.id; replay(b, 'pop'); }
    return;
  }
  setHtml(b, `
    <span class="bn-bar" style="background:${c}"></span>
    <span class="bn-body">
      <span class="bn-top"><span class="bn-label kind-${p.kind}">${esc(p.label || 'PLAY')}</span>${t ? `<span class="bn-team">${esc(t.abbr)}</span>` : ''}<span class="bn-clock">${esc(periodShort(v, p.period))} ${esc(p.clock)}</span></span>
      <span class="bn-text">${esc(p.text)}</span>
    </span>`);
  if (p.id !== lastBannerId) { lastBannerId = p.id; replay(b, 'pop'); }
}

// ── foul flash ───────────────────────────────────────────────────────────
// A foul gets a large overlay on the court: the fouling team's logo and FOUL
// (or TECHNICAL / FLAGRANT / OFFENSIVE FOUL), for 2.4 s, once per play.
let lastFoulId = '';
let foulTimer: number | undefined;
let foulHide: number | undefined;

function renderFoulFlash(v: GameView): void {
  const el = $('foul-flash');
  const p = v.last;
  if (!p || p.kind !== 'foul' || p.side == null || p.id === lastFoulId) return;
  lastFoulId = p.id;
  const t = v.teams[p.side];
  const id = identity(v, p.side);
  setHtml(el, `<span class="ff-logo">${teamLogo(t, 'ff-img', true)}</span><span class="ff-text"><b>${esc(p.label || 'FOUL')}</b><i>${esc(t.abbr)} · ${esc(p.clock)}</i></span>`);
  el.style.setProperty('--team', id.ink);
  el.style.setProperty('--trim', id.trim);
  window.clearTimeout(foulTimer);
  window.clearTimeout(foulHide);
  el.classList.remove('out');
  el.hidden = false;
  replay(el, 'in');
  foulTimer = window.setTimeout(() => { el.classList.add('out'); foulHide = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 260); }, 2400);
}

/** Drop the foul overlay at once (no fade): a flight is about to use the lane it covers. */
function cutFoulFlash(): void {
  const el = document.getElementById('foul-flash');
  if (!el || el.hidden) return;
  window.clearTimeout(foulTimer);
  window.clearTimeout(foulHide);
  el.classList.add('out');
  el.hidden = true;
  el.classList.remove('out');      // renderFoulFlash() replays 'in' from a clean state next time
}

function renderRun(v: GameView): void {
  const el = $('run');
  if (!v.run) { el.hidden = true; return; }
  el.hidden = false;
  setHtml(el, `<span class="run-sw" style="background:${ink(v, v.run.side)}"></span>${esc(v.teams[v.run.side].abbr)} ${v.run.pts}-${v.run.opp} RUN <span class="run-span">${esc(v.run.span)}</span>`);
}

/** Render the live pane. Call only while the game is in progress. */
export function renderLive(v: GameView): void {
  lastView = v;
  enqueueShots(v);
  ensureLiveCourt(v);
  renderPossession(v);
  renderFloorShots(v);
  pump(v);
  renderPlayChips(v);
  renderBanner(v);
  renderFoulFlash(v);
  renderRun(v);
  renderLead(v, $('lead'));
}

export function stopLive(): void {
  clearBall();
  animLock = null;
  queue.length = 0;
  playing = false;
  courtKey = '';
  window.clearTimeout(tagTimer);
  // lastPlayed and the Replay button survive: leaving for another tab and coming back
  // still offers the last shot. forgetReplay() clears them when the game is no longer live.
  const lead = document.getElementById('lead');
  if (lead) setHtml(lead, '');           // its clipPath ids must not shadow the final wrap's
}

/**
 * Megathread: the viewer switched games. Everything this module remembers about the
 * previous game (seen shots, queue, banners, filters, court) is dropped so the next
 * game starts clean and never animates the last game's backlog.
 */
export function resetLive(): void {
  stopLive();
  forgetReplay();
  primed = false;
  seen.clear();
  lastBannerId = '';
  lastChipId = '';
  lastFoulId = '';
  lastView = null;
  settled = null;
  window.clearTimeout(foulTimer);
  window.clearTimeout(foulHide);
  for (const id of ['foul-flash', 'banner', 'run']) { const el = document.getElementById(id); if (el) el.hidden = true; }
  teamFilter = 'both';
  playerFilter = '';
  chartKey = '';
}

/** The game left the live state: nothing to replay any more, and the button goes with it. */
export function forgetReplay(): void {
  lastPlayed = null;
  const rb = document.getElementById('replay-btn');
  if (rb) rb.hidden = true;
}

// ── lead tracker ─────────────────────────────────────────────────────────

export function renderLead(v: GameView, el: HTMLElement): void {
  if (v.state === 'pre' || v.lead.length < 2) { setHtml(el, ''); return; }
  const W = 1000;
  const H = 60;
  const max = Math.max(8, ...v.lead.map(([, m]) => Math.abs(m)));
  const x = (e: number): number => (e / v.length) * W;
  const y = (m: number): number => H / 2 - (m / max) * (H / 2 - 3);
  let d = `M0 ${y(0)}`;
  let prev = 0;
  for (const [e, m] of v.lead) { d += ` L${x(e).toFixed(1)} ${y(prev).toFixed(1)} L${x(e).toFixed(1)} ${y(m).toFixed(1)}`; prev = m; }
  const endE = v.state === 'post' ? v.length : (v.lead[v.lead.length - 1]?.[0] ?? 0);
  d += ` L${x(endE).toFixed(1)} ${y(prev).toFixed(1)}`;
  const area = `${d} L${x(endE).toFixed(1)} ${H / 2} L0 ${H / 2} Z`;
  const periods: string[] = [];
  const reg = v.regPeriods;
  const perLen = (v.length - Math.max(0, v.period - reg) * 300) / reg;
  for (let i = 1; i < Math.max(reg, v.period); i++) {
    const e = i <= reg ? i * perLen : reg * perLen + (i - reg) * 300;
    periods.push(`<line class="lt-per" x1="${x(e)}" x2="${x(e)}" y1="0" y2="${H}"/>`);
  }
  const home = ink(v, 1);
  const away = ink(v, 0);
  const big: [number, number] = [0, 0];
  for (const [, m] of v.lead) { if (m > big[1]) big[1] = m; if (-m > big[0]) big[0] = -m; }
  setHtml(el, `
    <div class="lt-labels"><span style="color:${home}">${esc(v.teams[1].abbr)} <b>+${big[1]}</b></span><span class="lt-cap">Max lead</span><span style="color:${away}">${esc(v.teams[0].abbr)} <b>+${big[0]}</b></span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lt-svg">
      <defs>
        <clipPath id="ltTop-${el.id}"><rect x="0" y="0" width="${W}" height="${H / 2}"/></clipPath>
        <clipPath id="ltBot-${el.id}"><rect x="0" y="${H / 2}" width="${W}" height="${H / 2}"/></clipPath>
      </defs>
      ${periods.join('')}
      <line class="lt-zero" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>
      <path d="${area}" fill="${home}" fill-opacity="0.35" clip-path="url(#ltTop-${el.id})"/>
      <path d="${area}" fill="${away}" fill-opacity="0.35" clip-path="url(#ltBot-${el.id})"/>
      <path d="${d}" fill="none" stroke="${home}" stroke-width="1.6" clip-path="url(#ltTop-${el.id})" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="${away}" stroke-width="1.6" clip-path="url(#ltBot-${el.id})" vector-effect="non-scaling-stroke"/>
    </svg>`);
}

// ── shot chart (SHOTS tab) ───────────────────────────────────────────────

let teamFilter: 'both' | Side = 'both';
let playerFilter = '';
let chartKey = '';

export function setTeamFilter(f: 'both' | Side): void { teamFilter = f; }
export function setPlayerFilter(id: string): void { playerFilter = id; }
export function getPlayerFilter(): string { return playerFilter; }
export function getTeamFilter(): 'both' | Side { return teamFilter; }

function chartShots(v: GameView): ShotView[] {
  return v.shots.filter((s) => (teamFilter === 'both' || s.side === teamFilter) && (!playerFilter || s.player === playerFilter));
}

export function renderShotChart(v: GameView): void {
  const svg = $('chart');
  const key = `${v.league}:${isLight() ? 'L' : 'D'}`;
  if (chartKey !== key) {
    chartKey = key;
    setHtml(svg, courtMarkup(v.league));
  }
  const tags = document.getElementById('layer-tags')!;
  setHtml(tags, ([0, 1] as Side[]).map((s) => {
    const x = s === 1 ? LEN + 1.2 : -1.2;
    return `<text class="end-tag" x="${fu(x)}" y="${fu(WID / 2)}" transform="rotate(${s === 1 ? 90 : -90} ${fu(x)} ${fu(WID / 2)})" fill="${ink(v, s)}">${esc(v.teams[s].abbr)}</text>`;
  }).join(''));

  const shots = chartShots(v);
  const g = document.getElementById('layer-shots')!;
  const r = 0.85;
  setHtml(g, shots.map((s) => {
    const [cx, cy] = toCourt(s.x, s.y, s.side === 1);
    const c = ink(v, s.side);
    const who = v.players[s.player]?.name ?? '';
    const title = `<title>${esc(`${s.made ? 'Made' : 'Missed'} ${s.pts}PT${s.andOne ? ' and-one' : ''} - ${who} ${s.clock}`)}</title>`;
    if (s.made) {
      return `<g class="shot made"><circle cx="${fu(cx)}" cy="${fu(cy)}" r="${fu(r)}" fill="${c}"/>${s.andOne ? `<circle class="and1" cx="${fu(cx)}" cy="${fu(cy)}" r="${fu(r + 0.55)}" stroke="${c}"/>` : ''}${title}</g>`;
    }
    const k = r * 0.8;
    return `<g class="shot miss" stroke="${c}"><path d="M${fu(cx - k)} ${fu(cy - k)} L${fu(cx + k)} ${fu(cy + k)} M${fu(cx + k)} ${fu(cy - k)} L${fu(cx - k)} ${fu(cy + k)}"/>${title}</g>`;
  }).join(''));

  // Controls
  const opts: Array<['both' | Side, string]> = [['both', 'Both'], [0, v.teams[0].abbr], [1, v.teams[1].abbr]];
  const tf = $('team-filter');
  setHtml(tf, `<span class="seg-thumb"></span>` + opts.map(([k, label]) =>
    `<button type="button" data-team="${k}" class="${teamFilter === k ? 'on' : ''}">${esc(label)}</button>`).join(''));
  tf.style.setProperty('--seg-i', String(opts.findIndex(([k]) => k === teamFilter)));
  const people = Object.entries(v.players).filter(([, p]) => teamFilter === 'both' || p.side === teamFilter);
  if (playerFilter && !people.some(([id]) => id === playerFilter)) playerFilter = '';
  const picked = playerFilter ? v.players[playerFilter] : null;
  $('pp-name').textContent = picked ? `${picked.name}${picked.jersey ? ` #${picked.jersey}` : ''}` : 'All players';
  $('pp-swatch').style.background = picked ? ink(v, picked.side) : 'transparent';
  $('player-pick').classList.toggle('has', !!picked);
  const fgm = shots.filter((s) => s.made).length;
  const t3 = shots.filter((s) => s.pts === 3);
  const t3m = t3.filter((s) => s.made).length;
  const pct = (m: number, a: number): string => (a ? `${Math.round((m / a) * 100)}%` : '-');
  setHtml($('shot-stats'), shots.length
    ? `<span><b>FG</b> ${fgm}-${shots.length} <em>${pct(fgm, shots.length)}</em></span>` +
      `<span><b>3PT</b> ${t3m}-${t3.length} <em>${pct(t3m, t3.length)}</em></span>` +
      `<span class="legend"><i class="lg-made"></i>Made <i class="lg-miss"></i>Missed</span>`
    : `<span class="muted">${v.state === 'pre' ? 'Shots appear once the game tips off.' : 'No shots yet.'}</span>`);

  // Zone breakdown: where the selected shots came from and how they fell.
  const zones: Array<[string, (s: ShotView) => boolean]> = [
    ['Rim', (s) => s.pts === 2 && Math.hypot(s.x - 25, s.y) < 5],
    ['Paint', (s) => s.pts === 2 && Math.hypot(s.x - 25, s.y) >= 5 && Math.abs(s.x - 25) <= 8 && s.y <= 14],
    ['Mid range', (s) => s.pts === 2 && !(Math.hypot(s.x - 25, s.y) < 5) && !(Math.abs(s.x - 25) <= 8 && s.y <= 14)],
    ['Corner 3', (s) => s.pts === 3 && s.y < 9],
    ['Arc 3', (s) => s.pts === 3 && s.y >= 9],
  ];
  setHtml($('zones'), shots.length ? zones.map(([label, test]) => {
    const z = shots.filter(test);
    const m = z.filter((s) => s.made).length;
    const p = z.length ? Math.round((m / z.length) * 100) : 0;
    return `<div class="zone"><span class="zone-l">${label}</span><span class="zone-bar"><i style="width:${p}%"></i></span><span class="zone-v">${m}-${z.length}</span><span class="zone-p">${z.length ? `${p}%` : '-'}</span></div>`;
  }).join('') : '');
}
