// src/client/overlay/clock.ts — the game clock between polls.
//
// The server's clock arrives every couple of seconds; shown raw it jumps 2–3 s at a time. This
// counts down in real time toward the LATEST value the server gave and stops there. It never
// runs past that value, so it cannot tick through a stoppage (a dead ball, a timeout) and never
// has to step backwards afterwards; the price is that the display trails the feed by at most
// one poll. A change it cannot walk to — a new period, an official's reset, a gap of more than
// SNAP_S — is shown at once.

const SNAP_S = 6;          // further behind than this: jump, don't chase
const TICK_MS = 100;

const el = (): HTMLElement | null => document.getElementById('clock');

function parse(text: string): number {
  const s = text.trim();
  if (!s) return NaN;
  if (s.includes(':')) { const [m, x] = s.split(':'); return Number(m) * 60 + Number(x); }
  return Number(s);
}

/** Seconds → the feed's own format: "M:SS", or tenths under a minute when the feed uses them ("45.3"). */
function format(secs: number, tenths: boolean): string {
  if (tenths && secs < 60) return (Math.ceil(secs * 10 - 1e-6) / 10).toFixed(1);
  const whole = Math.ceil(secs - 1e-6);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

let key = '';              // game + period the running clock belongs to
let target = NaN;          // seconds, the server's latest
let targetText = '';
let shown = NaN;           // seconds on screen
let tenths = false;
let running = false;
let last = 0;

function write(text: string): void { const e = el(); if (e && e.textContent !== text) e.textContent = text; }

function tick(): void {
  if (!running || !Number.isFinite(shown) || !Number.isFinite(target)) return;
  const now = performance.now();
  const dt = Math.min(1, (now - last) / 1000);      // a throttled timer must not make one giant step
  last = now;
  if (shown <= target) return;
  // Real time, a touch faster when it has fallen behind, so the lag closes without a jump.
  const gap = shown - target;
  shown = Math.max(target, shown - dt * (gap > 2.5 ? 1.35 : 1));
  write(shown === target ? targetText : format(shown, tenths));
}
window.setInterval(tick, TICK_MS);

export const clock = {
  /** A running game clock: `text` is the server's display clock, `periodKey` changes with the period. */
  run(text: string, periodKey: string): void {
    const secs = parse(text);
    if (!Number.isFinite(secs)) { clock.show(text); return; }
    const fresh = !running || periodKey !== key || !Number.isFinite(shown);
    tenths = text.includes('.') || (tenths && periodKey === key && secs < 60);
    key = periodKey; target = secs; targetText = text;
    // Jump when there is nothing to walk from, when the clock went UP (a reset), or when the
    // gap is too wide to chase.
    if (fresh || secs > shown || shown - secs > SNAP_S) { shown = secs; write(text); }
    if (!running) { running = true; last = performance.now(); }
  },
  /** Anything that is not a running clock: a kickoff time, FINAL, HALFTIME. */
  show(text: string): void {
    running = false; shown = NaN; target = NaN; key = '';
    write(text);
  },
};
