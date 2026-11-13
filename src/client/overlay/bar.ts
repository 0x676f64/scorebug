// src/client/overlay/bar.ts — the bar primitives both sports paint with.

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * innerHTML only when it changed. What was last written is kept ON the element, so every
 * writer of a bar element shares one truth (two caches on one element is how down & distance
 * once stayed blank after a break).
 */
export function setInner(el: HTMLElement, html: string): boolean {
  const e = el as HTMLElement & { __h?: string };
  if (e.__h === html) return false;
  e.__h = html;
  el.innerHTML = html;
  return true;
}

/**
 * A bar logo: fixed box, fades in when the file has loaded. `src` is the dark-background
 * variant where ESPN has one; if that file is missing it falls back to `fallback` (the
 * standard logo) before giving up and collapsing.
 */
export function barLogo(holder: HTMLElement, src: string, fallback = ''): void {
  const fb = fallback && fallback !== src ? fallback : '';
  const onerr = fb
    ? `if(this.dataset.fb){this.parentNode.dataset.broken='1'}else{this.dataset.fb='1';this.src='${fb.replace(/'/g, '%27')}'}`
    : `this.parentNode.dataset.broken='1'`;
  const html = src ? `<img class="bug-logo" src="${esc(src)}" alt="" onload="this.dataset.ok='1'" onerror="${esc(onerr)}">` : '';
  if (setInner(holder, html)) delete holder.dataset.broken;
  holder.style.display = src ? '' : 'none';
}

/** Set a score cell; `flash` pulses it once when the number actually changed. */
export function setScore(el: HTMLElement, value: number, flash: boolean): void {
  el.classList.remove('rec');
  const s = String(value);
  if (el.textContent === s) return;
  el.textContent = s;
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

/** Before the game the score cell carries the team's record instead of a meaningless 0. */
export function setRecord(el: HTMLElement, record: string): void {
  el.classList.add('rec'); el.classList.remove('flash');
  if (el.textContent !== record) el.textContent = record;
}

/** Final: an arrow beside the winning score, the loser dimmed. Anything else clears both. */
export function setOutcome(awayScore: number, homeScore: number, final: boolean): void {
  const w = !final ? '' : awayScore > homeScore ? 'away' : homeScore > awayScore ? 'home' : '';
  for (const side of ['away', 'home'] as const) {
    const el = $(`side-${side}`);
    el.classList.toggle('won', w === side);
    el.classList.toggle('lost', !!w && w !== side);
  }
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The centre cell before a game. Inside a day of the start it counts down, with the start time
 * and network beneath; further out it shows the day and time. `word` is Kickoff / Tipoff.
 */
export function pregameStatus(at: number, network: string, word: string): { main: string; sub: string } {
  if (!Number.isFinite(at) || !at) return { main: '', sub: network };
  const ms = at - Date.now();
  if (ms > 0 && ms < 24 * 3600_000) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return { main: `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, sub: [`${word} ${timeOf(at)}`, network].filter(Boolean).join(' · ') };
  }
  if (ms <= 0) return { main: timeOf(at), sub: [`${word} soon`, network].filter(Boolean).join(' · ') };
  return { main: new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }), sub: network };
}

/** "Thu, Nov 12" for the centre cell of a final. */
export function gameDate(at: number): string {
  return Number.isFinite(at) && at ? new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
}
