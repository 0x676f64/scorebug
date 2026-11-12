// tools/audit.mjs — measure the overlay against the viewing rules (see overlay/main.ts).
//   npm run replay   (in another terminal)      node tools/audit.mjs [baseUrl]
// Each check drives the real overlay page in Chromium against replayed games and asserts on
// what a viewer would see: boxes that move, DOM that is rewritten, animations cut short,
// results that arrive before the ball, a clock that jumps or runs backwards, extra polls.
import { chromium } from 'playwright';
import { build } from 'esbuild';

const BASE = process.argv[2] ?? 'http://localhost:8090';
const results = [];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !only || only.includes(String(n));
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`); };
await fetch(`${BASE}/replay/reset`).catch(() => { console.error(`no replay server at ${BASE} — run: npm run replay`); process.exit(2); });   // every run sees the same plays
const browser = await chromium.launch();
const newPage = async () => { const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); p.on('pageerror', (e) => console.log('  [pageerror]', e.message)); return p; };
const ready = (p) => p.waitForFunction(() => window.__scorebug?.revealed() && document.getElementById('bug').classList.contains('ready'), null, { timeout: 15000 });

/** Sample bounding boxes every 100 ms; report any element whose box changed. */
async function layout(p, ids, ms) {
  return p.evaluate(async ({ ids, ms }) => {
    // LAYOUT position and size (offset*), which transforms do not touch: a score's flash pulse and a
    // banner's pop-in scale the element on purpose and must not read as the box having moved.
    const box = (id) => {
      const e = id.startsWith('.') ? document.querySelector(id) : document.getElementById(id);
      if (!e || getComputedStyle(e).display === 'none') return null;
      let x = 0, y = 0; for (let n = e; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      return [x, y, e.offsetWidth, e.offsetHeight];
    };
    const first = {}, moved = {};
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      for (const id of ids) {
        const b = box(id); if (!b) continue;
        if (!first[id]) first[id] = b;
        else if (b.some((n, i) => Math.abs(n - first[id][i]) > 0.5)) (moved[id] ??= new Set()).add(JSON.stringify(b));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { first, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, [...v].slice(0, 4)])) };
  }, { ids, ms });
}

/** Count DOM rewrites under each root for `ms` (childList + characterData), ignoring `skip` ids. */
async function mutations(p, roots, skip, ms) {
  return p.evaluate(async ({ roots, skip, ms }) => {
    const counts = {};
    const obs = [];
    for (const id of roots) {
      const el = id.startsWith('.') ? document.querySelector(id) : document.getElementById(id); if (!el) continue;
      counts[id] = 0;
      const o = new MutationObserver((list) => { for (const m of list) { let n = m.target; let skipIt = false; while (n && n !== el) { if (n.id && skip.includes(n.id)) { skipIt = true; break; } n = n.parentNode; } if (!skipIt && !(m.target.id && skip.includes(m.target.id))) counts[id]++; } });
      o.observe(el, { childList: true, characterData: true, subtree: true });
      obs.push(o);
    }
    await new Promise((r) => setTimeout(r, ms));
    obs.forEach((o) => o.disconnect());
    return counts;
  }, { roots, skip, ms });
}

// ── 1. football: layout holds still through live play ─────────────────────
if (want(1)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=nfl&event=401873272&start=62&every=5000`); await ready(p);
  const r = await layout(p, ['bar', 'score-away', 'score-home', 'mid', 'fieldwrap', 'last-play', 'bug'], 45000);
  check('football: bar, scores, field and last-play boxes never move (45 s, 9 plays)', Object.keys(r.moved).length === 0, Object.keys(r.moved).length ? JSON.stringify(r.moved) : `boxes: ${JSON.stringify(r.first)}`);
  await p.close();
}

// ── 2. football: an animation is never cut; the result lands with the ball ─
if (want(2)) {
  const p = await newPage();
  // Snapshots 105–112 hold two punts, a kickoff and a return: chains well past one poll interval.
  await p.goto(`${BASE}/overlay?league=nfl&event=401873272&start=105&every=7000`); await ready(p);
  const r = await p.evaluate(async () => {
    const log = [];   // { t, what }
    const watch = (id, what) => new MutationObserver(() => log.push({ t: Date.now(), what })).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    watch('fv-play', 'field'); watch('last-play', 'lastplay'); watch('dd', 'dd'); watch('score-away', 'score'); watch('score-home', 'score');
    const chains = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 58000) { const c = window.__scorebug.chain(); if (c.key && !chains.some((x) => x.key === c.key)) chains.push(c); await new Promise((r) => setTimeout(r, 50)); }
    return { log, chains };
  });
  const animated = r.chains.filter((c) => c.ms >= 400);
  let cuts = 0, early = 0, late = 0; const notes = [];
  for (const c of animated) {
    const end = c.at + c.ms;
    const cut = r.log.filter((m) => m.what === 'field' && m.t > c.at + 60 && m.t < end);
    if (cut.length) { cuts++; notes.push(`play ${c.key.slice(-4)}: field rewritten ${cut[0].t - c.at} ms into a ${c.ms} ms chain`); }
    const res = r.log.filter((m) => m.what !== 'field' && m.t > c.at - 100 && m.t < end + 2500);
    const firstRes = res[0];
    if (firstRes && firstRes.t < end) { early++; notes.push(`play ${c.key.slice(-4)}: ${firstRes.what} changed ${end - firstRes.t} ms BEFORE the ball landed`); }
    if (firstRes && firstRes.t > end + 700) { late++; notes.push(`play ${c.key.slice(-4)}: ${firstRes.what} changed ${firstRes.t - end} ms after landing`); }
  }
  const longest = Math.round(Math.max(0, ...animated.map((c) => c.ms)));
  check(`football: no animation cut by a poll (${animated.length} animated plays, ${animated.filter((c) => c.ms > 2000).length} longer than the 2 s poll, longest ${longest} ms)`, animated.length >= 3 && longest > 2500 && cuts === 0, notes.filter((n) => n.includes('rewritten')).join('; '));
  check('football: score, down & distance and last-play text change when the ball lands, not before', animated.length >= 3 && early === 0 && late === 0, notes.filter((n) => !n.includes('rewritten')).join('; ') || `${animated.length} plays, each result within 700 ms after its chain ended`);
  await p.close();
}

// ── 3. football: an unchanged view rewrites nothing ───────────────────────
if (want(3)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=nfl&event=401873272&start=112&speed=0`); await ready(p);
  await p.waitForTimeout(8000);     // let the opening play's animation and reveal finish
  const m = await mutations(p, ['bar', 'last-play', 'fieldwrap'], ['clock'], 12000);
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  check('football: 6 polls of an unchanged game rewrite no DOM (bar, field, last play)', total === 0, JSON.stringify(m));
  await p.close();
}

// ── 4. basketball: layout holds still; court camera swaps included ────────
if (want(4)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=ncaam&event=401805215&start=300&every=2500`); await ready(p);
  const r = await layout(p, ['bar', 'score-away', 'score-home', 'mid', '.court-wrap', 'banner', 'bug'], 45000);
  check('basketball: bar, scores, court and event banner boxes never move (45 s, 18 plays)', Object.keys(r.moved).length === 0, Object.keys(r.moved).length ? JSON.stringify(r.moved) : `boxes: ${JSON.stringify(r.first)}`);
  await p.close();
}

// ── 5. basketball: an unchanged view rewrites nothing in the bar/banner ───
if (want(5)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=nba&event=401909287&start=200&speed=0`); await ready(p);
  await p.waitForTimeout(6000);
  const m = await mutations(p, ['bar', 'banner', 'court'], ['clock'], 12000);
  check('basketball: 6 polls of an unchanged game rewrite no DOM (bar, banner, court)', Object.values(m).reduce((a, b) => a + b, 0) === 0, JSON.stringify(m));
  await p.close();
}

// ── 6. basketball: the bar's score lands with the ball ────────────────────
if (want(6)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=nba&event=401909287&start=205&every=3000`); await ready(p);
  const r = await p.evaluate(async () => {
    const scores = [], lands = [];
    for (const id of ['score-away', 'score-home']) new MutationObserver(() => scores.push(Date.now())).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.classList?.contains('fx-float') || n.querySelector?.('.fx-float'))) lands.push(Date.now()); }).observe(document.getElementById('court'), { childList: true, subtree: true });
    await new Promise((res) => setTimeout(res, 60000));
    return { scores, lands };
  });
  // Every score change should sit within 300 ms of a made shot reaching the rim.
  const off = r.scores.map((t) => Math.min(...r.lands.map((l) => Math.abs(t - l)), Infinity));
  const loose = off.filter((d) => d > 300);
  check(`basketball: bar score changes as the shot goes in (${r.scores.length} score changes, ${r.lands.length} made shots landed)`, r.scores.length >= 4 && loose.length <= Math.floor(r.scores.length * 0.15),
    `offset from the ball reaching the rim, ms: ${off.map((d) => (Number.isFinite(d) ? Math.round(d) : 'none')).join(', ')}`);
  await p.close();
}

// ── 7. the live clock on screen: runs down smoothly, never backwards ──────
if (want(7)) {
  const p = await newPage();
  await p.goto(`${BASE}/overlay?league=nba&event=401909287&start=140&every=4000`); await ready(p);
  const r = await p.evaluate(async () => {
    const out = []; const t0 = performance.now();
    while (performance.now() - t0 < 50000) { out.push([Math.round(performance.now() - t0), document.getElementById('period').textContent, document.getElementById('clock').textContent]); await new Promise((r) => setTimeout(r, 50)); }
    return out;
  });
  const secs = (s) => (s.includes(':') ? Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]) : Number(s));
  let back = 0, bigSteps = [], changes = 0, prev = null;
  for (const [, per, txt] of r) {
    const v = secs(txt); if (!Number.isFinite(v)) { prev = null; continue; }
    if (prev && prev.per === per && v !== prev.v) { changes++; const d = prev.v - v; if (d < 0) back++; else if (d > 1.05) bigSteps.push(Math.round(d * 10) / 10); }
    prev = { per, v };
  }
  const distinct = new Set(r.map((x) => x[2])).size;
  check(`clock: never steps backwards within a period (${changes} changes, ${distinct} distinct readings in 50 s)`, back === 0, back ? `${back} backward steps` : '');
  check('clock: counts in steps of a second or less; a jump only when the feed moved more than 6 s', bigSteps.every((d) => d > 6), `steps larger than 1 s: ${bigSteps.length ? bigSteps.join(', ') + ' s' : 'none'}`);
  await p.close();
}

// ── 8. the clock's rules, on a fake timeline ──────────────────────────────
if (want(8)) {
  const out = await build({ entryPoints: ['src/client/overlay/clock.ts'], bundle: true, format: 'iife', globalName: 'SB', write: false, logLevel: 'silent' });
  const p = await newPage();
  await p.clock.install({ time: 0 });
  await p.setContent('<span id="clock"></span>');
  await p.addScriptTag({ content: out.outputFiles[0].text });
  const txt = () => p.evaluate(() => document.getElementById('clock').textContent);
  const run = (t, k = 'g|1') => p.evaluate(([t, k]) => SB.clock.run(t, k), [t, k]);
  const seen = async (ms) => { const s = new Set(); for (let i = 0; i < ms / 100; i++) { await p.clock.runFor(100); s.add(await txt()); } return [...s]; };
  const fails = [];
  await run('5:00'); await p.clock.runFor(4000);
  if (await txt() !== '5:00') fails.push(`ran past the server's value with no new reading: ${await txt()}`);
  await run('4:57'); const walk = await seen(3500);
  if (!(walk.includes('4:59') && walk.includes('4:58') && walk.at(-1) === '4:57')) fails.push(`did not count 4:59 → 4:58 → 4:57: ${walk.join(' ')}`);
  await p.clock.runFor(6000);
  if (await txt() !== '4:57') fails.push(`kept running through a stoppage: ${await txt()}`);
  await run('5:02'); if (await txt() !== '5:02') fails.push(`an official's reset upward not shown at once: ${await txt()}`);
  await run('4:40'); if (await txt() !== '4:40') fails.push(`a gap over 6 s not shown at once: ${await txt()}`);
  await run('12:00', 'g|2'); if (await txt() !== '12:00') fails.push(`a new period not shown at once: ${await txt()}`);
  await run('45.3', 'g|4'); await run('43.1', 'g|4'); const tenths = await seen(3000);
  const tv = tenths.map(Number);
  if (!(tenths.at(-1) === '43.1' && tenths.length > 10 && tv.every((v, i) => i === 0 || v <= tv[i - 1]) && tenths.every((s) => /^\d+\.\d$/.test(s)))) fails.push(`tenths under a minute not smooth: ${tenths.slice(0, 6).join(' ')} … ${tenths.at(-1)}`);
  await p.evaluate(() => SB.clock.show('HALFTIME')); await p.clock.runFor(3000);
  if (await txt() !== 'HALFTIME') fails.push(`a label was overwritten by the ticker: ${await txt()}`);
  check('clock rules: stops at the last known value, counts by the second, tenths under a minute, jumps only on reset / new period / wide gap', fails.length === 0, fails.join('; '));
  await p.close();
}

// ── 9. one poll chain, whatever the page is told ──────────────────────────
if (want(9)) {
  const p = await newPage();
  let n = 0; p.on('request', (q) => { if (q.url().includes('/api/game')) n++; });
  await p.goto(`${BASE}/overlay?league=nba&event=401909287&start=200&speed=0`); await ready(p);
  n = 0;
  for (let i = 0; i < 8; i++) { await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(2500); }
  check(`polling: one chain — ${n} requests in 20 s at a 2 s interval, through 8 visibility events`, n <= 20, '');
  await p.close();
}

// ── 10. football: the score on screen never drops through a blanked feed ───
if (want(10)) {
  const p = await newPage();
  // Snapshot 56 is a touchdown (3 → 10); 57 is the official timeout where ESPN's header reads 0–0.
  await p.goto(`${BASE}/overlay?league=nfl&event=401873272&start=55&every=4000`); await ready(p);
  const seen = await p.evaluate(async () => { const out = []; const t0 = Date.now(); while (Date.now() - t0 < 22000) { const s = `${document.getElementById('score-away').textContent}-${document.getElementById('score-home').textContent}`; if (out.at(-1) !== s) out.push(s); await new Promise((r) => setTimeout(r, 50)); } return out; });
  const nums = seen.map((s) => s.split('-').map(Number));
  const drops = nums.filter((v, i) => i > 0 && (v[0] < nums[i - 1][0] || v[1] < nums[i - 1][1]));
  check('football: score on screen through a touchdown and a blanked 0–0 feed update never drops', drops.length === 0 && seen.includes('0-10'), `shown: ${seen.join(' → ')}`);
  await p.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
