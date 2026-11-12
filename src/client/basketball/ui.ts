// src/client/basketball/ui.ts — nba-hub/src/client/ui.ts helpers (DOM, escaping, team colours, formatting) verbatim;
// the logo section is scorebug's (ESPN files through /api/img; no bundled sprites, no blob hydration).

import type { GameView, Side, TeamView } from '../../shared/basketball.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── flicker-free DOM writes ──────────────────────────────────────────────
// Every render rebuilds markup from the GameView, but the DOM is only touched
// when the markup actually changed. Rewriting identical HTML re-creates every
// <img> and restarts every CSS animation, which is the blink seen on polls.
const lastHtml = new WeakMap<Element, string>();

/** Replace an element's children only when the markup differs. Returns true when it wrote. */
export function setHtml(el: Element | null, html: string): boolean {
  if (!el) return false;
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

/**
 * Empty an element AND forget what it held. A raw `el.innerHTML = ''` leaves the memory
 * above believing the old markup is still there, so the next setHtml of identical markup
 * (the same final game reopened from a megathread slate) is skipped and the pane stays
 * blank. Every reset that empties a setHtml-managed element goes through here.
 */
export function clearHtml(el: Element | null): void {
  if (!el) return;
  lastHtml.delete(el);
  el.innerHTML = '';
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const isLight = (): boolean => document.documentElement.dataset.theme === 'light';

// ── team colours ─────────────────────────────────────────────────────────
// Each side gets one "ink": readable on the current floor AND distinct from
// the other team. Home keeps its first readable choice; away yields.

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function mix(hex: string, toward: string, t: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (sh: number): string => Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * t).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function candidates(t: TeamView): [string, ...string[]] {
  const light = isLight();
  const ok = (c: string): boolean => (light ? lum(c) <= 0.35 : lum(c) >= 0.09 && lum(c) <= 0.85);
  const readable: string[] = [];
  if (ok(t.color)) readable.push(t.color);
  if (ok(t.alt)) readable.push(t.alt);
  const fallback = light ? mix(t.color, '#000000', 0.4) : mix(t.color, '#ffffff', 0.45);
  const [first = fallback, ...rest] = readable;
  return [first, ...rest, ...(readable.length ? [fallback] : []), light ? mix(t.color, '#000000', 0.6) : mix(t.color, '#ffffff', 0.65)];
}

function dist(a: string, b: string): number {
  const p = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

let inkCache: { key: string; inks: [string, string] } | null = null;

export function inks(v: GameView): [string, string] {
  const key = `${isLight() ? 'L' : 'D'}${v.teams[0].color}${v.teams[0].alt}${v.teams[1].color}${v.teams[1].alt}`;
  if (inkCache && inkCache.key === key) return inkCache.inks;
  const home = candidates(v.teams[1])[0];
  const awayC = candidates(v.teams[0]);
  const away = awayC.find((c) => dist(c, home) >= 150) ?? awayC.reduce((a, b) => (dist(b, home) > dist(a, home) ? b : a));
  const result: [string, string] = [away, home];
  inkCache = { key, inks: result };
  return result;
}

export const ink = (v: GameView, side: Side): string => inks(v)[side]!;

/**
 * Two-tone identity: the ink plus a trim colour from the team's own palette
 * (Bulls red + black, Knicks orange + blue). The trim is readable on the
 * floor and visibly different from the ink; when the team's other colour is
 * too close (navy on navy), the trim falls back to a theme-neutral edge so
 * the pair still reads as two tones.
 */
/**
 * The team's brand colour for things only ONE team shows at a time (the
 * attacked rim's glow, the floor wash). Identity is carried by the logo badge
 * and the two-tone chevrons, so this can stay the true colour even when both
 * teams wear red; it is only nudged when it would vanish on the floor.
 */
export function brand(v: GameView, side: Side): string {
  const c = v.teams[side].color;
  const light = isLight();
  if (light && lum(c) > 0.5) return mix(c, '#000000', 0.35);
  if (!light && lum(c) < 0.06) return mix(c, '#ffffff', 0.3);
  return c;
}

export function identity(v: GameView, side: Side): { ink: string; trim: string } {
  const primary = ink(v, side);
  const t = v.teams[side];
  const light = isLight();
  const edge = light ? '#0b1a2e' : '#ffffff';
  const readable = (c: string): boolean => (light ? lum(c) <= 0.5 : lum(c) >= 0.12);
  const pick = [t.alt, t.color].find((c) => c !== primary && readable(c) && dist(c, primary) >= 110);
  return { ink: primary, trim: pick ?? edge };
}

/**
 * Text colour that reads on a solid team-colour fill: whichever of white and the dark ink
 * has the higher WCAG contrast on it. The old fixed cut (lum > 0.4) left white on the
 * mid-tone inks dark mode makes from navy teams (#738aa5: white 3.6:1, dark ink 4.7:1).
 */
export function onColor(hex: string): string {
  const l = lum(hex);
  const white = 1.05 / (l + 0.05);
  const dark = (l + 0.05) / (lum('#0b1a2e') + 0.05);
  return dark > white ? '#0b1a2e' : '#ffffff';
}

// ── formatting ───────────────────────────────────────────────────────────

export function periodName(v: GameView, period: number): string {
  if (period > v.regPeriods) return period - v.regPeriods === 1 ? 'OT' : `${period - v.regPeriods}OT`;
  return v.regPeriods === 2 ? `${period === 1 ? '1st' : '2nd'} Half` : `Q${period}`;
}

export function periodShort(v: GameView, period: number): string {
  if (period > v.regPeriods) return period - v.regPeriods === 1 ? 'OT' : `${period - v.regPeriods}OT`;
  return v.regPeriods === 2 ? `H${period}` : `Q${period}`;
}

export function fmtDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

export function fmtTime(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── images ───────────────────────────────────────────────────────────────
// The Devvit web view routes fetch() to the app server but a bare <img> GET
// goes straight to the network, where third-party hosts are blocked. So:
//   team logos  = bundled files under public/teams/<league>/<id>[-dark].png
//                 (tools/pull-logos.mjs), with the ESPN file proxied through
//                 /api/img as a fallback when a bundled one is missing.
//   headshots   = always proxied: fetch -> blob -> object URL.
// Inline onerror attributes do not fire in the production web view, so the

// ── images (scorebug) ────────────────────────────────────────────────────
// Logos are ESPN's own files through the same-origin proxy: the light file on
// white/light floors, the dark variant on the dark theme when ESPN has one.

const proxy = (u: string): string => (u && /^https:\/\//i.test(u) ? `/api/img?u=${encodeURIComponent(u)}` : '');

export function logoSrc(t: TeamView): string {
  const want = isLight() ? t.logo || t.logoDark : t.logoDark || t.logo;
  return proxy(want);
}

export const teamLogo = (t: TeamView, cls = 'logo', onWhite = false): string => {
  const src = proxy(onWhite ? t.logo || t.logoDark : (isLight() ? t.logo || t.logoDark : t.logoDark || t.logo));
  if (!src) return `<span class="${cls} logo-badge">${esc(t.abbr)}</span>`;
  return `<img class="${cls}" src="${esc(src)}" alt="" data-abbr="${esc(t.abbr)}" onerror="this.outerHTML='<span class=&quot;${cls} logo-badge&quot;>'+this.dataset.abbr+'</span>'">`;
};

/** Re-run a class-based animation from the start. */
export function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** The surname for a tight label: the last word, skipping generational suffixes. */
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/).filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w));
  return parts[parts.length - 1] ?? name;
}
