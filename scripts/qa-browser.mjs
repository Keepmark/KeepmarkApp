// Browser QA: drives the REAL built extension in Firefox (MV2) and Chromium
// (MV3) against a live KeepmarkApi (v1.2) — the manual-QA scenarios of
// docs/SPEC.md §11.3 that unit tests cannot reach: connect new/existing,
// native auto-push, every manager section, a real two-browser conflict
// (merge in Firefox), MV3 service-worker stop + persisted conflict + take
// remote in Chromium, convergence, server delete, log redaction, dark mode.
//
// Usage: npm run qa:browser   (builds first; exit non-zero on any failure)
// Needs: a running KeepmarkApi with a generous per-IP daily new-sync limit
// (KeepmarkApi .env: DAILY_NEW_SYNCS_LIMIT=100) — each run creates 1 sync and
// deletes it at the end. Throwaway browser profiles, generated test password.
//
// Env: KEEPMARK_QA_URL (default http://localhost:8090), FIREFOX_BIN
// (/usr/bin/firefox), CHROMIUM_BIN (/usr/bin/chromium), QA_SHOTS
// (build/qa — screenshots + results.json).
import puppeteer from 'puppeteer-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'build');
const SERVICE = (process.env.KEEPMARK_QA_URL ?? 'http://localhost:8090').replace(/\/$/, '');
const FIREFOX_BIN = process.env.FIREFOX_BIN ?? '/usr/bin/firefox';
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';
const SHOTS = path.resolve(ROOT, process.env.QA_SHOTS ?? 'build/qa');
// Fixed moz-extension UUID so Firefox pages have a predictable origin.
const FF_UUID = '5f0c1a2e-7b3d-4e8a-9c11-0a1b2c3d4e5f';
const PASSWORD = `qa-${crypto.randomBytes(6).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [];

process.on('unhandledRejection', (e) => console.log('UNHANDLED', String(e?.message ?? e).split('\n')[0]));
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const allErrors = {};

// ---------------------------------------------------------------- preflight
for (const [what, p] of [['Firefox', FIREFOX_BIN], ['Chromium', CHROMIUM_BIN],
  ['Firefox build', path.join(APP, 'firefox/manifest.json')], ['Chromium build', path.join(APP, 'chromium/manifest.json')]]) {
  if (!fs.existsSync(p)) {
    console.error(`qa:browser: ${what} not found at ${p}`);
    process.exit(2);
  }
}
try {
  const info = await (await fetch(`${SERVICE}/info`, { headers: { 'Accept-Version': '1.2.0' } })).json();
  if (info?.capabilities?.revision !== true || info.status !== 1) {
    console.error(`qa:browser: ${SERVICE} must be an online KeepmarkApi speaking v1.2 accepting new syncs (got ${JSON.stringify(info)})`);
    process.exit(2);
  }
} catch (e) {
  console.error(`qa:browser: service ${SERVICE} unreachable (${e.message}) — start KeepmarkApi (docker compose up -d)`);
  process.exit(2);
}

// ---------------------------------------------------------------- browsers
async function launchChromium() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kqa-c-'));
  profiles.push(userDataDir);
  const browser = await puppeteer.launch({
    browser: 'chrome', executablePath: CHROMIUM_BIN, headless: true, pipe: true, userDataDir,
    enableExtensions: [`${APP}/chromium`], args: ['--no-first-run', '--no-default-browser-check'],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  return { browser, kind: 'chromium', base: sw.url().replace(/\/[^/]*$/, '/') };
}

async function launchFirefox() {
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: FIREFOX_BIN, headless: true, args: ['--remote-allow-system-access'],
    extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ 'keepmark@proton.me': FF_UUID }) },
  });
  await browser.installExtension(`${APP}/firefox`);
  const tree = await browser.connection.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
  return { browser, kind: 'firefox', base: `moz-extension://${FF_UUID}/`, chromeCtx: tree.result.contexts[0].context };
}

let tabSeq = 0;
async function open(ctx, file0) {
  // Unique URL per tab (Firefox screenshots locate the tab by URL).
  const file = `${file0}${file0.includes('?') ? '&' : '?'}qa=${++tabSeq}`;
  let page;
  if (ctx.kind === 'chromium') {
    page = await ctx.browser.newPage();
    wire(ctx, page, file0);
    await page.goto(ctx.base + file, { waitUntil: 'load' });
  } else {
    const before = new Set((await ctx.browser.pages()));
    await ctx.browser.connection.send('script.evaluate', {
      target: { context: ctx.chromeCtx }, awaitPromise: false,
      expression: `openTrustedLinkIn(${JSON.stringify(ctx.base + file)}, "tab")`,
    });
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(100);
      page = (await ctx.browser.pages()).find((p) => !before.has(p));
    }
    wire(ctx, page, file0);
    for (let i = 0; i < 50; i++) {
      const href = await page.evaluate(() => location.href).catch(() => '');
      if (href.startsWith('moz-extension') && (await page.evaluate(() => document.readyState)) === 'complete') break;
      await sleep(100);
    }
  }
  await sleep(800);
  return page;
}

function wire(ctx, page, file) {
  const key = `${ctx.kind}:${file}`;
  allErrors[key] ??= [];
  page.on('pageerror', (e) => allErrors[key].push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') allErrors[key].push(`console: ${m.text()}`); });
  page.on('dialog', async (d) => {
    (page.dialogs ??= []).push(d.message());
    try { await d.accept(); } catch (e) { console.log(`dialog accept failed (${ctx.kind}): ${e.message.split('\n')[0]}`); }
  });
}

// ---------------------------------------------------------------- helpers
const setVal = (p, sel, v) => p.evaluate((s, val) => {
  const el = document.querySelector(s);
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, sel, v);
/** Record + accept window.confirm in-page (Firefox BiDi does not surface
 *  prompts of privileged pages; same path in both browsers for parity). */
const armConfirm = (p) => p.evaluate(() => { window.__dialogs = []; window.confirm = (m) => { window.__dialogs.push(String(m)); return true; }; });
const confirms = (p) => p.evaluate(() => window.__dialogs ?? []);
const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
/** Answer an inline confirmInline block (`<anchor>-confirm`) with Yes;
 *  returns its text (question + implication), or null when none opened. */
async function confirmYes(p, anchorId) {
  const shown = await waitFor(async () => (await p.evaluate((id) => !!document.getElementById(`${id}-yes`), anchorId)) || undefined, 5000);
  if (!shown) return null;
  const said = await text(p, `#${anchorId}-confirm`);
  await click(p, `#${anchorId}-yes`);
  return said;
}
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.closest('[hidden]') && e.offsetParent !== null; }, sel);
async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => undefined); if (v) return v; await sleep(step); }
  return undefined;
}
async function shot(ctx, page, name) {
  const file = path.join(SHOTS, `${ctx.kind}-${name}.png`);
  if (ctx.kind === 'chromium') {
    await page.bringToFront();
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }
  // Firefox: BiDi refuses screenshots of privileged (moz-extension) pages;
  // draw the tab from the parent process instead.
  const href = await page.evaluate(() => location.href);
  const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 2400));
  const r = await ctx.browser.connection.send('script.evaluate', {
    target: { context: ctx.chromeCtx }, awaitPromise: true,
    expression: `(async () => {
      const b = gBrowser.browsers.find((x) => x.currentURI.spec === ${JSON.stringify(href)});
      gBrowser.selectedTab = gBrowser.getTabForBrowser(b);
      const img = await b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, b.clientWidth, ${h}), 1, 'white');
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    })()`,
  });
  const data = r.result?.result?.value ?? '';
  fs.writeFileSync(file, Buffer.from(data.split(',')[1] ?? '', 'base64'));
  return file;
}
const addNative = (p, title, url) => p.evaluate(async (t, u) => {
  const b = globalThis.browser ?? globalThis.chrome;
  // "Other bookmarks": Firefox unfiled_____, Chromium id 2.
  const other = (await b.bookmarks.get(navigator.userAgent.includes('Firefox') ? 'unfiled_____' : '2'))[0];
  return (await b.bookmarks.create({ parentId: other.id, title: t, url: u })).id;
}, title, url);
const nativeUrls = (p) => p.evaluate(async () => {
  const b = globalThis.browser ?? globalThis.chrome;
  const out = [];
  const walk = (n) => { if (n.url) out.push(n.url); (n.children ?? []).forEach(walk); };
  (await b.bookmarks.getTree()).forEach(walk);
  return out;
});
const storage = (p, key) => p.evaluate(async (k) => (await (globalThis.browser ?? globalThis.chrome).storage.local.get(k))[k], key);
async function head(id) {
  const r = await fetch(`${SERVICE}/bookmarks/${id}`, { method: 'HEAD', headers: { 'Accept-Version': '1.2.0' } });
  return { status: r.status, rev: Number(r.headers.get('x-sync-revision')) };
}
async function section(p, name) { await click(p, `#sidebar button[data-section="${name}"]`); await sleep(700); }

// ---------------------------------------------------------------- flows
async function connectNew(ctx) {
  const p = await open(ctx, 'popup.html?fullpage=1');
  await click(p, 'input[name="conn-mode"][value="new"]');
  await setVal(p, '#service-url', SERVICE);
  await setVal(p, '#password', PASSWORD);
  await setVal(p, '#confirm-password', PASSWORD);
  await click(p, '#btn-connect');
  const ok = await waitFor(() => visible(p, '#view-main'), 30000);
  const err = await text(p, '#connect-error');
  check(`${ctx.kind}: connect new sync`, ok, ok ? '' : `error box: ${err}`);
  const pwLeft = await p.evaluate(() => document.querySelector('#password').value.length + document.querySelector('#confirm-password').value.length);
  check(`${ctx.kind}: password fields cleared after connect`, pwLeft === 0);
  return p;
}

async function connectExisting(ctx, id) {
  const p = await open(ctx, 'popup.html?fullpage=1');
  await click(p, 'input[name="conn-mode"][value="existing"]');
  await setVal(p, '#service-url', SERVICE);
  await setVal(p, '#sync-id', id);
  await click(p, 'input[name="conn-direction"][value="pull"]');
  await setVal(p, '#password', PASSWORD);
  await click(p, '#btn-connect');
  const asked = await confirmYes(p, 'btn-connect');
  check(`${ctx.kind}: connect existing asks inline first`, (asked ?? '').includes('Yes, download'), asked ?? 'no confirm');
  const ok = await waitFor(() => visible(p, '#view-main'), 30000);
  check(`${ctx.kind}: connect existing (download)`, ok, ok ? '' : `error box: ${await text(p, '#connect-error')}`);
  return p;
}

async function statusCard(ctx, p) {
  await waitFor(async () => (await text(p, '#p-pill')) && !(await text(p, '#p-pill')).includes('…'), 8000);
  return { pill: await text(p, '#p-pill'), badge: await text(p, '#p-service-badge'), id: await text(p, '#p-syncid'), space: await text(p, '#p-space') };
}

async function tourManager(ctx) {
  const m = await open(ctx, 'manager.html');
  await waitFor(async () => !((await text(m, '#m-pill')) ?? '…').includes('…'), 8000);
  await shot(ctx, m, 'manager-status');
  for (const s of ['backup', 'duplicates', 'move', 'logs', 'settings', 'about']) {
    await section(m, s);
    const h2 = await m.evaluate(() => [...document.querySelectorAll('main section:not([hidden]) h2')].map((e) => e.textContent.trim()));
    check(`${ctx.kind}: manager section ${s} renders`, h2.length === 1, h2.join(','));
    if (s === 'duplicates') { await click(m, '#m-btn-duplicates'); await sleep(1500); }
    if (s === 'logs') { await click(m, '#m-btn-logs'); await sleep(1000); }
    await shot(ctx, m, `manager-${s}`);
  }
  // Leak checks in the rendered logs viewer (sync IDs truncated, no password).
  await section(m, 'logs');
  await click(m, '#m-btn-logs');
  await sleep(1000);
  const logText = (await text(m, '#m-log-list')) ?? '';
  const info = await storage(m, 'syncInfo');
  check(`${ctx.kind}: logs never contain the full sync ID`, !!info?.id && !logText.includes(info.id), `${logText.split('\n').length} lines`);
  check(`${ctx.kind}: logs never contain the password`, !logText.includes(PASSWORD));
  if (ctx.kind === 'chromium') {
    await m.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await section(m, 'status');
    await shot(ctx, m, 'manager-status-dark');
    await m.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }
  await section(m, 'status');
  return m;
}

async function conflictPanel(ctx, m) {
  await click(m, '#m-btn-refresh');
  const shown = await waitFor(() => visible(m, '#m-conflict-section'), 15000);
  check(`${ctx.kind}: conflict panel shown in manager`, shown);
  const stats = {
    local: await text(m, '#conflict-stat-local'), remote: await text(m, '#conflict-stat-remote'),
    titles: await text(m, '#conflict-stat-titles'),
  };
  const lists = await m.evaluate(() => ({
    local: [...document.querySelectorAll('#conflict-list-local li')].map((l) => l.textContent),
    remote: [...document.querySelectorAll('#conflict-list-remote li')].map((l) => l.textContent),
    htmlInLists: document.querySelectorAll('[id^="conflict-list-"] li *').length,
  }));
  await shot(ctx, m, 'conflict-panel');
  if (ctx.kind === 'chromium') {
    await m.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await shot(ctx, m, 'conflict-panel-dark');
    await m.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }
  return { shown, stats, lists };
}

async function resolve(ctx, m, direction) {
  await armConfirm(m);
  await click(m, `#conflict-btn-${direction}`);
  const res = await waitFor(async () => {
    if (await visible(m, '#conflict-result') && /Conflict resolved/.test((await text(m, '#conflict-result')) ?? '')) return 'ok';
    if (await visible(m, '#conflict-error')) return `error: ${await text(m, '#conflict-error')}`;
    return undefined;
  }, 30000);
  check(`${ctx.kind}: resolve conflict via ${direction}`, res === 'ok', res === 'ok' ? await text(m, '#conflict-result') : res);
  const asked = await confirms(m);
  check(`${ctx.kind}: ${direction} asked for confirmation`, asked.length === 1, asked[0]?.slice(0, 70));
  const gone = await waitFor(async () => !(await visible(m, '#m-conflict-section')), 10000);
  check(`${ctx.kind}: conflict panel cleared after ${direction}`, gone);
  await sleep(1500);
  check(`${ctx.kind}: success evidence still visible after the panel closed`,
    /Safety backups/.test((await visible(m, '#conflict-result')) ? (await text(m, '#conflict-result')) ?? '' : ''));
  await shot(ctx, m, `conflict-resolved-${direction}`);
}

async function syncNow(ctx, m) {
  await section(m, 'status');
  await click(m, '#m-btn-sync-now');
  await sleep(4000);
}

// ---------------------------------------------------------------- run
let qaSyncId;
const ff = await launchFirefox();
const cr = await launchChromium();
try {
  // 1. Firefox creates the sync with its natives.
  const ffMgrSeed = await open(ff, 'manager.html');
  await addNative(ffMgrSeed, 'FF seed', 'https://ff-seed.example/');
  const ffPop = await connectNew(ff);
  const ffCard = await statusCard(ff, ffPop);
  await shot(ff, ffPop, 'popup-linked');
  const id = (await storage(ffPop, 'syncInfo'))?.id;
  qaSyncId = id;
  check('firefox: status card shows the v1.2 service', /API v1\.2/.test(ffCard.badge ?? ''), JSON.stringify(ffCard));
  check('firefox: popup shows the sync ID', !!id && (ffCard.id ?? '').length > 0);
  const h0 = await head(id);
  check('server: sync exists (HEAD v1.2)', h0.status === 200, `rev ${h0.rev}`);

  // 2. Native edit in Firefox is pushed automatically (listener + debounce).
  await addNative(ffMgrSeed, 'FF auto push', 'https://ff-auto.example/');
  const pushed = await waitFor(async () => (await head(id)).rev > h0.rev, 15000);
  check('firefox: native edit auto-pushed', pushed, `rev ${(await head(id)).rev}`);

  // 3. Chromium links the same sync (download).
  const crSeed = await open(cr, 'manager.html');
  await addNative(crSeed, 'CR pre-link local', 'https://cr-prelink.example/');
  const crPop = await connectExisting(cr, id);
  await shot(cr, crPop, 'popup-linked');
  const crUrls = await nativeUrls(crSeed);
  check('chromium: downloaded Firefox bookmarks', crUrls.includes('https://ff-auto.example/') && crUrls.includes('https://ff-seed.example/'));
  check('chromium: pre-link local tree replaced (snapshot taken)', !crUrls.includes('https://cr-prelink.example/'));
  const crSafety = await storage(crSeed, 'safetyIndex');
  check('chromium: take-remote safety backup written', JSON.stringify(crSafety ?? '').includes('take-remote'));

  // 4. Tour every manager section in both browsers.
  const ffM = await tourManager(ff);
  const crM = await tourManager(cr);

  // 5. Real conflict: Chromium pushes first, then Firefox edits on a stale base.
  const r1 = (await head(id)).rev;
  await addNative(crSeed, 'CR edit', 'https://cr-edit.example/');
  await waitFor(async () => (await head(id)).rev > r1, 15000);
  await addNative(ffMgrSeed, 'FF edit', 'https://ff-edit.example/');
  const ffConflict = await waitFor(async () => !!(await storage(ffM, 'conflictState')), 15000);
  check('firefox: stale push → conflict persisted', ffConflict);
  const panel = await conflictPanel(ff, ffM);
  check('firefox: preview counts local-only/remote-only', panel.stats.local === '1' && panel.stats.remote === '1', JSON.stringify(panel.stats));
  check('firefox: preview lists are plain text (no markup)', panel.lists.htmlInLists === 0, JSON.stringify(panel.lists));
  // While pending, Sync now must not pull over the local edit.
  await syncNow(ff, ffM);
  check('firefox: Sync now while conflicted keeps the local edit', (await nativeUrls(ffM)).includes('https://ff-edit.example/'));
  await resolve(ff, ffM, 'merge');
  const ffAfter = await nativeUrls(ffM);
  check('firefox: merge → natives hold both edits', ffAfter.includes('https://ff-edit.example/') && ffAfter.includes('https://cr-edit.example/'));
  const safetyFF = JSON.stringify((await storage(ffM, 'safetyIndex')) ?? []);
  check('firefox: merge safety backups (local + remote)', (safetyFF.match(/conflict-merge/g) ?? []).length >= 2);

  // 6. Chromium: conflict + MV3 service-worker restart + take remote.
  await addNative(crSeed, 'CR stale edit', 'https://cr-stale.example/');
  const crConflict = await waitFor(async () => !!(await storage(crM, 'conflictState')), 15000);
  check('chromium: stale push → conflict persisted', crConflict);
  const cdp = await crM.createCDPSession();
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  const crM2 = await open(cr, 'manager.html');
  const panel2 = await conflictPanel(cr, crM2);
  check('chromium: conflict survives service-worker stop', panel2.shown);
  await resolve(cr, crM2, 'pull');
  const crAfter = await nativeUrls(crM2);
  check('chromium: take remote → natives = server (has FF edit, stale edit gone)',
    crAfter.includes('https://ff-edit.example/') && !crAfter.includes('https://cr-stale.example/'));

  // 7. Both browsers converge after a sync.
  await syncNow(ff, ffM);
  await syncNow(cr, crM2);
  const a = (await nativeUrls(ffM)).filter((u) => u.includes('.example/')).sort();
  const b = (await nativeUrls(crM2)).filter((u) => u.includes('.example/')).sort();
  check('both browsers converge on the same bookmarks', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
  await shot(ff, ffPop, 'popup-final');
  await shot(cr, crPop, 'popup-final');
  await crPop.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await shot(cr, crPop, 'popup-final-dark');

  // 8. Cleanup: delete the QA sync from the server (v1.2) via the manager.
  await section(crM2, 'status');
  const delEnabled = await crM2.evaluate(() => !document.querySelector('#m-btn-delete-remote').disabled);
  check('chromium: server delete enabled on v1.2', delEnabled);
  if (delEnabled) {
    await click(crM2, '#m-btn-delete-remote');
    const first = await confirmYes(crM2, 'm-btn-delete-remote');
    check('chromium: server delete states the implication', /other devices/.test(first ?? ''), first?.slice(0, 90));
    const second = await confirmYes(crM2, 'm-btn-delete-remote');
    await waitFor(async () => (await head(id)).status === 401, 15000);
    check('chromium: server delete (double confirm) removed the QA sync', !!second && (await head(id)).status === 401);
  }
} catch (e) {
  check('script', false, e.stack);
} finally {
  // Never leave QA syncs behind on the operator's service.
  if (qaSyncId && (await head(qaSyncId)).status === 200) {
    await fetch(`${SERVICE}/bookmarks/${qaSyncId}`, { method: 'DELETE', headers: { 'Accept-Version': '1.2.0' } });
  }
  for (const [k, v] of Object.entries(allErrors)) if (v.length) check(`no console/page errors in ${k}`, false, v.slice(0, 5).join(' | '));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== QA: ${pass}/${results.length} passed ===`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`screenshots + results.json in ${path.relative(ROOT, SHOTS) || SHOTS}`);
  await ff.browser.close().catch(() => undefined);
  await cr.browser.close().catch(() => undefined);
  for (const dir of profiles) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
