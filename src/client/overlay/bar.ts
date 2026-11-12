// src/client/overlay/bar.ts — the two bar primitives both sports paint with.

const lastHtml = new WeakMap<Element, string>();

/** A bar logo: fixed box, fades in when the file has loaded, collapses if there is none. */
export function barLogo(holder: HTMLElement, src: string): void {
  const html = src ? `<img class="bug-logo" src="${src.replace(/"/g, '&quot;')}" alt="" onload="this.dataset.ok='1'" onerror="this.parentNode.dataset.broken='1'">` : '';
  if (lastHtml.get(holder) !== html) { lastHtml.set(holder, html); holder.innerHTML = html; delete holder.dataset.broken; }
  holder.style.display = src ? '' : 'none';
}

/** Set a score cell; `flash` pulses it once when the number actually changed. */
export function setScore(el: HTMLElement, value: number, flash: boolean): void {
  const s = String(value);
  if (el.textContent === s) return;
  el.textContent = s;
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}
