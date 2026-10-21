// Browser QA: drives the REAL built extension in Firefox (MV2) and Chromium
// (MV3) against a live KeepmarkApi (v1.2) — the manual-QA scenarios of
// docs/SPEC.md §11.3 that unit tests cannot reach: connect new/existing,
// native auto-push, every manager section, the multi-sync registry (add a
// second sync, switch password, popup activation dialog, QR), a real
// two-browser conflict (merge in Firefox), MV3 service-worker stop + persisted
// conflict + take remote in Chromium, convergence, server delete, log
// redaction, dark mode.
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
/** Every wired page, so the storage trail can be dumped at the end. */
const tracked = [];
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
  tracked.push({ key, page });
  allErrors[key] ??= [];
  page.on('pageerror', (e) => allErrors[key].push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') allErrors[key].push(`console: ${m.text()}`); });
  // Diagnostic trail: every write to the link state, with the id it landed on.
  // A silent "the active sync changed back" is otherwise invisible.
  void page.evaluate(() => {
    const b = globalThis.browser ?? globalThis.chrome;
    globalThis.__qaStorageLog = [];
    b.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const entry = { at: new Date().toISOString(), page: location.pathname, keys: Object.keys(changes) };
      if (changes.syncInfo) entry.syncInfo = changes.syncInfo.newValue?.id ?? null;
      if (changes.syncEnabled) entry.enabled = changes.syncEnabled.newValue;
      if (changes.savedSyncs) entry.saved = (changes.savedSyncs.newValue ?? []).map((r) => r.label ?? `id:${(r.syncId ?? '').slice(0, 8)}`);
      globalThis.__qaStorageLog.push(entry);
    });
  }).catch(() => undefined);
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
const click = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  // Name the page in the failure: a missing id is otherwise indistinguishable
  // from a click on the wrong tab.
  if (!el) throw new Error(`click: ${s} not found in ${location.href} (${document.readyState})`);
  el.click();
}, sel);
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
async function chooseService(p) {
  await click(p, '.service-picker-menu > summary');
  await click(p, 'input[name="service-url-provider"][value="custom"]');
  await setVal(p, '#service-url', SERVICE);
  await click(p, '#service-url-check');
  const ready = await waitFor(() => p.evaluate(() => !document.querySelector('#btn-connect').disabled), 15000);
  check('service selector: custom URL verified before continuing', ready);
}
async function connectNew(ctx) {
  const p = await open(ctx, 'popup.html?fullpage=1');
  // A freshly opened popup focuses the first visible field: the URL input is
  // hidden behind a remembered/default service, so the name gets the caret
  // (typing right away must not fall on the page body).
  const popupFocus = await waitFor(() => p.evaluate(() => document.activeElement?.id === 'sync-name'), 5000);
  check(`${ctx.kind}: popup focuses the name field (no lost typing)`, popupFocus);
  await click(p, 'input[name="conn-mode"][value="new"]');
  await chooseService(p);
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
  await chooseService(p);
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
  for (const s of ['backup', 'duplicates', 'syncs', 'logs', 'settings', 'about']) {
    await section(m, s);
    const h2 = await m.evaluate(() => [...document.querySelectorAll('main section:not([hidden]) h2')].map((e) => e.textContent.trim()));
    check(`${ctx.kind}: manager section ${s} renders`, h2.length === 1, h2.join(','));
    if (s === 'duplicates') { await click(m, '#m-btn-duplicates'); await sleep(1500); }
    if (s === 'logs') { await click(m, '#m-btn-logs'); await sleep(1000); }
    if (s === 'settings') {
      // v1.2 /info capabilities.syncExpiryDays -> "Unused syncs" row (KeepmarkApi always advertises it).
      const row = async () => m.evaluate(() => {
        const dts = [...document.querySelectorAll('#m-service-info dt')];
        const dt = dts.find((e) => e.textContent.trim() === 'Unused syncs');
        return dt?.nextElementSibling?.textContent.trim() ?? null;
      });
      await waitFor(async () => (await row()) !== null, 8000);
      const expiry = await row();
      check(`${ctx.kind}: settings shows the service's sync expiry`, /^(kept forever|deleted after \d+ days? without use)$/.test(expiry ?? ''), expiry ?? 'missing');
    }
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
  await click(m, `#conflict-btn-${direction}`);
  const asked = await confirmYes(m, `conflict-btn-${direction}`);
  check(`${ctx.kind}: ${direction} asked for confirmation inline`, !!asked, asked?.slice(0, 70));
  const res = await waitFor(async () => {
    if (await visible(m, '#conflict-result') && /Conflict resolved/.test((await text(m, '#conflict-result')) ?? '')) return 'ok';
    if (await visible(m, '#conflict-error')) return `error: ${await text(m, '#conflict-error')}`;
    return undefined;
  }, 30000);
  check(`${ctx.kind}: resolve conflict via ${direction}`, res === 'ok', res === 'ok' ? await text(m, '#conflict-result') : res);
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

// ------------------------------------------------------- multi-sync (registry)
const managerRows = (m) => m.evaluate(() => [...document.querySelectorAll('#m-syncs-list .saved-row')].map((li) => ({
  name: li.querySelector('strong')?.textContent ?? '',
  active: li.classList.contains('saved-active'),
  sub: li.querySelector('.saved-sub')?.textContent ?? '',
  actions: [...li.querySelectorAll('button')].map((b) => b.id || b.dataset.action || ''),
})));
const popupRows = (p) => p.evaluate(() => [...document.querySelectorAll('#p-saved-list .saved-row')].map((li) => ({
  name: li.querySelector('strong')?.textContent ?? '',
  active: li.classList.contains('saved-active'),
  sub: li.querySelector('small')?.textContent ?? '',
  actions: [...li.querySelectorAll('button')].map((b) => b.id),
})));
const dialogOpen = (p, id) => p.evaluate((s) => !!document.querySelector(s)?.open, id);

/** Add a second sync from the manager, then exercise the switch password, the
 *  popup activation dialog (empty, wrong then right password) and the QR
 *  dialog. Leaves the browser back on the QA sync. */
async function multiSync(ctx, m, pop, activeId) {
  await section(m, 'syncs');
  const first = await managerRows(m);
  check(`${ctx.kind}: syncs section lists the active sync`, first.length === 1 && first[0].active, JSON.stringify(first));
  check(`${ctx.kind}: active row offers unlink + server delete, no activate`,
    first[0]?.actions.includes('m-syncs-unlink') &&
    first[0]?.actions.some((a) => a.startsWith('m-syncs-delete-')) &&
    !first[0]?.actions.some((a) => a.startsWith('m-syncs-act-')), JSON.stringify(first[0]?.actions));
  await shot(ctx, m, 'manager-syncs');

  // + Add new sync → a NEW sync on the same service (uploads the live tree).
  await click(m, '#m-btn-add-sync');
  check(`${ctx.kind}: add-sync form opens`, await visible(m, '#m-link-form'));
  // A remembered service hides the URL input: the form must focus the name
  // field (not leave the caret on the body, where typing is silently lost).
  const addFocus = await m.evaluate(() => document.activeElement?.id ?? '');
  check(`${ctx.kind}: add-sync focuses the name field (no lost typing)`, addFocus === 'm-link-name', addFocus);
  await shot(ctx, m, 'manager-syncs-add');
  await click(m, 'input[name="m-link-url-provider"][value="custom"]');
  await setVal(m, '#m-link-url', SERVICE);
  await click(m, '#m-link-url-check');
  const gate = await waitFor(() => visible(m, '#m-link-direct'), 15000);
  check(`${ctx.kind}: add-sync enables the create button only after the service check`, gate);
  await setVal(m, '#m-link-name', 'QA second');
  await setVal(m, '#m-link-password', PASSWORD);
  await setVal(m, '#m-link-confirm', PASSWORD);
  await click(m, '#m-btn-link-direct');
  const created = await waitFor(async () => {
    if (await visible(m, '#link-error')) return `error: ${await text(m, '#link-error')}`;
    const shown = await text(m, '#m-syncs-result');
    return shown && shown.includes('QA second') ? shown : undefined;
  }, 45000);
  check(`${ctx.kind}: adding a sync creates it and reports the upload`,
    typeof created === 'string' && !created.startsWith('error'), String(created).slice(0, 120));
  const rows2 = await managerRows(m);
  check(`${ctx.kind}: registry lists two rows, the new one active`,
    rows2.length === 2 && rows2.filter((r) => r.active).length === 1 &&
    rows2.some((r) => r.active && r.name === 'QA second'),
    JSON.stringify(rows2.map((r) => [r.name, r.active])));
  const second = ((await storage(m, 'savedSyncs')) ?? []).find((r) => r.syncId !== activeId);
  const secondId = second?.syncId;
  if (secondId) qaExtraIds.add(secondId);
  await shot(ctx, m, 'manager-syncs-rows');

  // Optional sync-change password: the rows become wrapped.
  await setVal(m, '#m-link-lock-new', 'pin-qa');
  await setVal(m, '#m-link-lock-confirm', 'pin-qa');
  await click(m, '#m-btn-link-lock-set');
  const lockSet = await waitFor(async () => {
    if (await visible(m, '#switch-pw-error')) return `error: ${await text(m, '#switch-pw-error')}`;
    return (await text(m, '#switch-pw-result')) || undefined;
  }, 20000);
  check(`${ctx.kind}: sync-change password set`,
    typeof lockSet === 'string' && !lockSet.startsWith('error'), String(lockSet).slice(0, 100));
  await shot(ctx, m, 'manager-syncs-lock');

  // Popup: read-only list with Activate on the dormant row only.
  await pop.reload({ waitUntil: 'load' });
  await waitFor(() => visible(pop, '#view-main'), 15000);
  const pRows = await waitFor(async () => {
    const rows = await popupRows(pop);
    return rows.length === 2 ? rows : undefined;
  }, 15000);
  check(`${ctx.kind}: popup lists both syncs, one tagged active`,
    Array.isArray(pRows) && pRows.filter((r) => r.active).length === 1, JSON.stringify(pRows));
  check(`${ctx.kind}: popup offers Activate only on the dormant row`,
    Array.isArray(pRows) &&
    pRows.filter((r) => !r.active).every((r) => r.actions.some((a) => a.includes('-act-'))) &&
    pRows.filter((r) => r.active).every((r) => r.actions.length === 0), JSON.stringify(pRows));
  await shot(ctx, pop, 'popup-saved-syncs');

  // Regression: a closed <dialog> must not be laid out (an author `display`
  // rule on .saved-dialog once left the activation form inline at the bottom).
  check(`${ctx.kind}: the activation dialog is hidden until requested`,
    !(await visible(pop, '#p-saved-dialog')) && !(await dialogOpen(pop, '#p-saved-dialog')));

  const dormantBtn = await pop.evaluate(() =>
    document.querySelector('#p-saved-list .saved-row:not(.saved-active) button')?.id ?? null);
  await click(pop, `#${dormantBtn}`);
  check(`${ctx.kind}: popup activation opens a modal`, await dialogOpen(pop, '#p-saved-dialog'));
  check(`${ctx.kind}: the modal asks for the sync-change password`, await visible(pop, '#p-saved-password'));
  await shot(ctx, pop, 'popup-activate-dialog');
  await click(pop, '#p-saved-activate');
  check(`${ctx.kind}: an empty switch password is rejected`, await visible(pop, '#p-saved-error'),
    (await text(pop, '#p-saved-error')) ?? '');
  await setVal(pop, '#p-saved-password', 'wrong-pin');
  await click(pop, '#p-saved-activate');
  const wrong = await waitFor(async () => (await text(pop, '#p-saved-error')) || undefined, 15000);
  check(`${ctx.kind}: a wrong switch password is rejected and nothing switched`,
    !!wrong && (await dialogOpen(pop, '#p-saved-dialog')), wrong ?? '');
  await setVal(pop, '#p-saved-password', 'pin-qa');
  await click(pop, '#p-saved-activate');
  // Wait on the BACKGROUND state, not on the rendered card: the popup repaints
  // when the switch lands, and a reload mid-switch would race the test.
  const switched = await waitFor(async () => {
    const info = await storage(pop, 'syncInfo');
    return info?.id === secondId ? info.id : undefined;
  }, 45000);
  check(`${ctx.kind}: the right switch password activates the dormant sync`,
    switched === secondId, `${switched} (wanted ${secondId}) / ${await text(pop, '#p-saved-error')}`);
  await sleep(1500);
  await shot(ctx, pop, 'popup-switched');

  // Back to the QA sync. After the switch the dormant row is the original one.
  await pop.reload({ waitUntil: 'load' });
  await waitFor(async () => (await popupRows(pop)).length === 2, 15000);
  const backBtn = await pop.evaluate(() =>
    document.querySelector('#p-saved-list .saved-row:not(.saved-active) button')?.id ?? null);
  await click(pop, `#${backBtn}`);
  await setVal(pop, '#p-saved-password', 'pin-qa');
  await click(pop, '#p-saved-activate');
  const back = await waitFor(async () => {
    const info = await storage(pop, 'syncInfo');
    if (info?.id !== activeId) return undefined;
    return `ok: ${await text(pop, '#p-sync-name')}`;
  }, 45000);
  check(`${ctx.kind}: switching back restores the original sync`,
    String(back).startsWith('ok'), `${back} / ${await text(pop, '#p-saved-error')}`);
  await sleep(2000);

  // QR: the QA service runs on plain HTTP, which the payload refuses by design
  // (the Android app re-validates the URL). The card must therefore say why
  // instead of offering a button that can only fail. Payload building,
  // rendering and the password gate are pinned by the unit suites
  // (connect-qr*.test.ts, render-connect-qr.test.ts).
  await section(m, 'status');
  await m.bringToFront();
  await sleep(300);
  const qrCard = {
    shown: await visible(m, '#connect-qr'),
    disabled: await m.evaluate(() => document.querySelector('#qr-open').disabled),
    // The reason must be visible on the card: the dialog cannot open while the
    // button is disabled, so a reason hidden inside it would be unreadable.
    reasonShown: await visible(m, '#qr-feedback'),
    reason: await text(m, '#qr-feedback'),
  };
  check(`${ctx.kind}: the QR card explains a plain-HTTP service instead of failing on click`,
    qrCard.shown && qrCard.disabled && qrCard.reasonShown && /HTTPS/.test(qrCard.reason ?? ''),
    JSON.stringify(qrCard));
  await shot(ctx, m, 'manager-status-qr-http');
  await section(m, 'syncs');
}

/** The end of the multi-sync story: forget the extra row, unlink the active
 *  sync, empty the registry, then come back with the same sync. Checks both
 *  what the UI says and that the link really works again. */
async function unlinkAndRelink(ctx, m, pop, activeId) {
  const linked = async (p) => !!(await storage(p, 'syncEnabled'));
  const syncIdNow = async (p) => (await storage(p, 'syncInfo'))?.id;
  const exampleUrls = (p) => nativeUrls(p);

  // 1. Forget the dormant row: the active link must not move. Force a fresh
  //    render first (status → syncs) so the list cannot be a stale snapshot of
  //    a link that changed elsewhere, and prove the row marked active is the
  //    sync the background is really on.
  await section(m, 'status');
  await section(m, 'syncs');
  const activeBefore = await syncIdNow(m);
  const rowsBefore = await managerRows(m);
  check(`${ctx.kind}: the sync list marks the sync the browser is really on`,
    rowsBefore.length === 2 && rowsBefore.filter((r) => r.active).length === 1 &&
    (rowsBefore.find((r) => r.active)?.sub ?? '').includes(String(activeBefore).slice(0, 8)),
    JSON.stringify({ activeBefore, rows: rowsBefore.map((r) => [r.name, r.active, r.sub]) }));
  const dormantRm = await m.evaluate(() =>
    document.querySelector('#m-syncs-list .saved-row:not(.saved-active) button[id^="m-syncs-rm-"]')?.id ?? null);
  await click(m, `#${dormantRm}`);
  const rmAsked = await confirmYes(m, dormantRm);
  check(`${ctx.kind}: removing a dormant row only forgets it`,
    !/stops syncing/i.test(rmAsked ?? ''), rmAsked?.slice(0, 90));
  const afterRm = await waitFor(async () => {
    const rows = await managerRows(m);
    return rows.length === 1 ? rows : undefined;
  }, 15000);
  check(`${ctx.kind}: removing a dormant row keeps the active link`,
    !!afterRm && afterRm[0].active && (await syncIdNow(m)) === activeBefore,
    JSON.stringify({ active: await syncIdNow(m), rows: afterRm?.map((r) => [r.name, r.active]) }));

  // 2. Unlink the active sync: the row stays, the browser stops syncing.
  await click(m, '#m-syncs-unlink');
  const unlinkAsked = await confirmYes(m, 'm-syncs-unlink');
  check(`${ctx.kind}: unlink asks first and says how to come back`,
    /reconnect/i.test(unlinkAsked ?? '') && /sync ID/i.test(unlinkAsked ?? ''),
    unlinkAsked?.slice(0, 120));
  const off = await waitFor(async () => !(await linked(m)), 20000);
  check(`${ctx.kind}: unlink stops syncing this browser`, off);
  const doneText = await waitFor(async () => (await visible(m, '#m-syncs-result')) ? await text(m, '#m-syncs-result') : undefined, 10000);
  check(`${ctx.kind}: unlink result says where to link again`,
    !!doneText && /link again/i.test(doneText), doneText?.slice(0, 120));
  const rowsOff = await managerRows(m);
  check(`${ctx.kind}: the unlinked sync stays in the list as inactive`,
    rowsOff.length === 1 && !rowsOff[0].active && rowsOff[0].actions.some((a) => a.startsWith('m-syncs-act-')),
    JSON.stringify(rowsOff.map((r) => [r.name, r.active, r.actions])));
  await section(m, 'status');
  check(`${ctx.kind}: status says it is not connected and how to reconnect`,
    (await visible(m, '#m-notlinked-hint')) && /popup/i.test((await text(m, '#m-notlinked-hint')) ?? ''),
    (await text(m, '#m-notlinked-hint')) ?? 'missing');
  check(`${ctx.kind}: sync now and refresh are disabled while unlinked`,
    await m.evaluate(() => document.querySelector('#m-btn-sync-now').disabled &&
      document.querySelector('#m-btn-refresh').disabled));
  check(`${ctx.kind}: the QR card is not offered while unlinked`,
    await m.evaluate(() => document.querySelector('#connect-qr').hidden));
  await shot(ctx, m, 'manager-status-unlinked');

  // 3. The popup lands on Connect and offers the saved sync back.
  await pop.reload({ waitUntil: 'load' });
  const popOff = await waitFor(() => visible(pop, '#view-connect'), 20000);
  check(`${ctx.kind}: popup returns to the Connect view when unlinked`, popOff);
  const popSaved = await waitFor(async () => (await visible(pop, '#c-saved-card')) ? true : undefined, 15000);
  check(`${ctx.kind}: popup lists the inactive sync for one-click reconnect`, popSaved);
  check(`${ctx.kind}: the server-removed card is NOT shown for an unlink`,
    !(await visible(pop, '#p-removed')));
  await shot(ctx, pop, 'popup-unlinked');

  // 4. Reconnect from the popup with the sync-change password. The row that is
  //    left is the one picked in step 1 (the second sync), not `activeId`
  //    (that id belonged to the row forgotten above).
  const popRowId = ((await storage(pop, 'savedSyncs')) ?? [])[0]?.syncId;
  await click(pop, '#c-saved-list .saved-row button');
  await setVal(pop, '#c-saved-password', 'pin-qa');
  await click(pop, '#c-saved-activate');
  const backId = await waitFor(async () => {
    const now = await syncIdNow(pop);
    return now === popRowId ? now : undefined;
  }, 45000);
  check(`${ctx.kind}: the inactive sync reconnects from the popup`,
    !!backId && backId === popRowId,
    JSON.stringify({ backId: backId ?? null, popRowId, activeId }));
  check(`${ctx.kind}: the popup is back on the status view`,
    await waitFor(() => visible(pop, '#view-main'), 20000));
  await shot(ctx, pop, 'popup-reconnected');

  // 5. Remove the last row: the registry must empty and the browser unlink.
  await section(m, 'syncs');
  const lastRm = await m.evaluate(() =>
    document.querySelector('#m-syncs-list .saved-row.saved-active button[id^="m-syncs-rm-"]')?.id ?? null);
  await click(m, `#${lastRm}`);
  const removeAsked = await confirmYes(m, lastRm);
  check(`${ctx.kind}: removing the active row warns that this browser stops syncing`,
    /stops syncing/i.test(removeAsked ?? ''), removeAsked?.slice(0, 120));
  const emptied = await waitFor(async () => (await managerRows(m)).length === 0, 20000);
  check(`${ctx.kind}: the registry is empty after the last row is removed`, emptied);
  check(`${ctx.kind}: an empty registry still explains how to start over`,
    await visible(m, '#m-syncs-empty'));
  check(`${ctx.kind}: an empty registry disables server-side actions`,
    await m.evaluate(() => !document.querySelector('#m-syncs-list .saved-row')));
  await shot(ctx, m, 'manager-syncs-empty');
  await pop.reload({ waitUntil: 'load' });
  const popEmpty = await waitFor(() => visible(pop, '#view-connect'), 20000);
  check(`${ctx.kind}: popup has no sync list once the registry is empty`,
    popEmpty && !(await visible(pop, '#c-saved-card')));

  // 6. Come back with the same sync, from the manager, with the lock gate.
  await section(m, 'syncs');
  await click(m, '#m-btn-add-sync');
  await click(m, 'input[name="m-link-mode"][value="existing"]');
  const relinkForm = await m.evaluate(() => ({
    form: !document.querySelector('#m-link-form').hidden,
    mode: document.querySelector('input[name="m-link-mode"]:checked')?.value,
    idRow: !document.querySelector('#m-link-id-row').hidden,
    dirRow: !document.querySelector('#m-link-direction-row').hidden,
    idVisible: !!document.querySelector('#m-link-id').offsetParent,
  }));
  check(`${ctx.kind}: relinking asks for the sync ID and a direction`,
    relinkForm.form && relinkForm.mode === 'existing' && relinkForm.idRow &&
    relinkForm.dirRow && relinkForm.idVisible, JSON.stringify(relinkForm));
  await click(m, 'input[name="m-link-url-provider"][value="custom"]');
  await setVal(m, '#m-link-url', SERVICE);
  await click(m, '#m-link-url-check');
  check(`${ctx.kind}: the add form verifies the service before it connects`,
    await waitFor(() => m.evaluate(() => !document.querySelector('#m-btn-link-direct').disabled), 20000));
  await setVal(m, '#m-link-id', activeId);
  await setVal(m, '#m-link-name', 'Ritorno');
  await setVal(m, '#m-link-password', PASSWORD);
  check(`${ctx.kind}: the add form asks for the sync-change password while a lock is set`,
    await visible(m, '#m-link-lock-pw-row'));
  await setVal(m, '#m-link-lock-pw', 'pin-qa');
  await shot(ctx, m, 'manager-relink-form');
  await click(m, '#m-btn-link-direct');
  const relinkAsked = await confirmYes(m, 'm-btn-link-direct');
  check(`${ctx.kind}: relinking asks for the direction confirmation`, !!relinkAsked, relinkAsked?.slice(0, 90));
  const relinked = await waitFor(async () => (await syncIdNow(m)) === activeId, 60000);
  check(`${ctx.kind}: the first sync is linked again`, relinked);
  const rowsBack = await waitFor(async () => {
    const rows = await managerRows(m);
    return rows.length === 1 && rows[0].active ? rows : undefined;
  }, 20000);
  check(`${ctx.kind}: the registry shows the relinked sync as active`,
    !!rowsBack && rowsBack[0].name === 'Ritorno', JSON.stringify(rowsBack?.map((r) => [r.name, r.active])));
  const urlsBack = await waitFor(async () => {
    const urls = await exampleUrls(m);
    return urls.includes('https://ff-edit.example/') ? urls.sort() : undefined;
  }, 30000);
  check(`${ctx.kind}: relinking pulls the server tree back into the browser`,
    !!urlsBack, JSON.stringify(urlsBack ?? []));
  await sleep(1500);
  await shot(ctx, m, 'manager-syncs-relinked');
}

// ---------------------------------------------------------------- run
let qaSyncId;
const qaExtraIds = new Set();
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
  await crPop.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // 8. Multi-sync UX with the two browsers still on the same sync: second
  //    sync from the manager, switch password, popup activation, QR.
  await multiSync(cr, crM2, crPop, id);

  // 9. Unlink the active sync, empty the registry, then link the same sync
  //    again from scratch: the "no syncs left" case must stay recoverable.
  await unlinkAndRelink(cr, crM2, crPop, id);

  // 10. Cleanup: delete the QA sync from the server (v1.2) from its own row.
  await section(crM2, 'syncs');
  const activeId = (await storage(crM2, 'syncInfo'))?.id;
  check('chromium: the relinked sync is the active one', activeId === id, `${activeId} vs ${id}`);
  const delId = await crM2.evaluate(() =>
    document.querySelector('#m-syncs-list .saved-row.saved-active button[data-action="delete"]')?.id ?? null);
  check('chromium: server delete offered on the active row', !!delId, String(delId));
  if (delId) {
    await click(crM2, `#${delId}`);
    const asked = await confirmYes(crM2, delId);
    check('chromium: server delete states the implication', /other devices/.test(asked ?? ''), asked?.slice(0, 90));
    const done = await waitFor(async () => {
      if (await visible(crM2, '#m-syncs-error')) return `error: ${await text(crM2, '#m-syncs-error')}`;
      const shown = await visible(crM2, '#m-syncs-result') ? await text(crM2, '#m-syncs-result') : null;
      return shown?.startsWith('Sync deleted from the server') ? shown : undefined;
    }, 30000);
    const gone = await waitFor(async () => (await head(id)).status === 401, 20000);
    check('chromium: server delete removed the QA sync',
      String(done).startsWith('Sync deleted from the server') && !!gone,
      `${String(done).slice(0, 70)} | head ${(await head(id)).status} | linked ${(await storage(crM2, 'syncInfo'))?.id} | active ${activeId}`);

    // 11. A deliberate deletion keeps nothing: no plaintext copy in Backup,
    //     no safety entry, no popup notice.
    await section(crM2, 'backup');
    await waitFor(() => visible(crM2, '#m-safety-list'), 15000);
    const copyShown = await visible(crM2, '#m-removed-card');
    check('chromium: a deliberate delete keeps no plaintext copy in Backup', !copyShown);
    const safetyText = await text(crM2, '#m-safety-list');
    check('chromium: the delete-remote safety entry is pruned too', /No safety backups/i.test(safetyText), safetyText);
    await shot(cr, crM2, 'manager-backup-after-delete');
    await crPop.reload({ waitUntil: 'load' });
    await waitFor(() => visible(crPop, '#view-connect'), 20000);
    const noticeShown = await visible(crPop, '#p-removed');
    check('chromium: the popup shows no removed-sync notice after a deliberate delete', !noticeShown);
    await shot(cr, crPop, 'popup-after-delete');
  }
} catch (e) {
  check('script', false, e.stack);
} finally {
  // Never leave QA syncs behind on the operator's service.
  for (const extra of qaExtraIds) {
    if ((await head(extra)).status === 200) {
      await fetch(`${SERVICE}/bookmarks/${extra}`, { method: 'DELETE', headers: { 'Accept-Version': '1.2.0' } });
    }
  }
  if (qaSyncId && (await head(qaSyncId)).status === 200) {
    await fetch(`${SERVICE}/bookmarks/${qaSyncId}`, { method: 'DELETE', headers: { 'Accept-Version': '1.2.0' } });
  }
  for (const [k, v] of Object.entries(allErrors)) if (v.length) check(`no console/page errors in ${k}`, false, v.slice(0, 5).join(' | '));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== QA: ${pass}/${results.length} passed ===`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  const trail = [];
  const seen = new Set();
  for (const { key, page } of tracked) {
    const entries = await page.evaluate(() => globalThis.__qaStorageLog ?? []).catch(() => []);
    // Every open page records the same broadcast: keep the first occurrence.
    for (const entry of entries) {
      const fingerprint = JSON.stringify([entry.at, entry.keys, entry.syncInfo, entry.enabled, entry.saved]);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      trail.push({ tab: key, ...entry });
    }
  }
  trail.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  fs.writeFileSync(path.join(SHOTS, 'storage-log.json'), JSON.stringify(trail, null, 2));
  console.log(`screenshots + results.json in ${path.relative(ROOT, SHOTS) || SHOTS}`);
  await ff.browser.close().catch(() => undefined);
  await cr.browser.close().catch(() => undefined);
  for (const dir of profiles) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
