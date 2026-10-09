// Static QA that needs no browser: HTML/TS id cross-check, MV3 safety
// rules, manifest coherence, message exhaustiveness, linter.
// Usage: node scripts/qa.mjs (exit non-zero on any failure).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const fail = (msg) => {
  console.error(`QA FAIL: ${msg}`);
  failures += 1;
};
const ok = (msg) => console.log(`QA ok: ${msg}`);
const version = () =>
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/** Tracked + untracked (but not ignored) source files: `git ls-files` alone
 * is blind to new files until `git add`, which would let violations in. */
function srcFiles(...dirs) {
  const out = new Set();
  for (const args of [dirs, [...dirs, '--others', '--exclude-standard']]) {
    try {
      const list = execFileSync('git', ['ls-files', ...args], { cwd: root, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const f of list) out.add(f);
    } catch {
      // Not a git checkout (e.g. exported tarball): fall back to tracked only.
    }
  }
  return [...out];
}

// 0. Release versions in sync: package.json == both manifests.
{
  const pkg = version();
  for (const p of ['res/manifest.firefox.json', 'res/manifest.chromium.json']) {
    const mv = JSON.parse(readFileSync(path.join(root, p), 'utf8')).version;
    if (mv !== pkg) fail(`${p} version ${mv} != package.json ${pkg} (keep them in sync on release)`);
  }
  if (failures === 0) ok('release versions in sync');
}

/** Collect id="..." from an HTML file. */
function htmlIds(file) {
  const html = readFileSync(path.join(root, file), 'utf8');
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

/** Collect $(...) / getElementById(...) / querySelector(...) refs from TS.
 * Single, double and plain backtick quotes; interpolated `${...}` templates
 * are skipped (they cannot be resolved statically). */
function tsIdRefs(file) {
  const ts = readFileSync(path.join(root, file), 'utf8');
  const refs = new Set();
  for (const re of [
    /\$\(\s*'([^']+)'\s*\)/g,
    /\$\(\s*"([^"]+)"\s*\)/g,
    /\$\(\s*`([^'`$]+)`\s*\)/g,
    /getElementById\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
    /querySelector\(\s*['"`]#([^'"`$]+)['"`]\s*\)/g,
  ]) {
    for (const m of ts.matchAll(re)) refs.add(m[1]);
  }
  return refs;
}

// 1. Every DOM id referenced from popup/manager TS must exist in its HTML.
for (const [ts, html] of [
  ['src/popup/popup.ts', 'src/popup.html'],
  ['src/popup/ui.ts', 'src/popup.html'], // ui.ts is shared: ids may live in either page
  ['src/manager/manager.ts', 'src/manager.html'],
]) {
  const ids = ts === 'src/popup/ui.ts'
    ? new Set([...htmlIds('src/popup.html'), ...htmlIds('src/manager.html')])
    : htmlIds(html);
  const missing = [...tsIdRefs(ts)].filter((id) => !ids.has(id));
  if (missing.length > 0) fail(`${ts} references missing ids in ${html}: ${missing.join(', ')}`);
  else ok(`${ts} ids all present`);
}

// 2. No DOM access outside popup/manager (background + shared must stay SW-safe).
const domFree = ['src/background', 'src/shared', 'src/firefox', 'src/chromium'];
const domRe = /\b(window|document|navigator|localStorage)\s*\.\s*[A-Za-z]|\b(alert|confirm|prompt)\s*\(/;
for (const dir of domFree) {
  const files = srcFiles(dir);
  for (const f of files.filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(path.join(root, f), 'utf8');
    // window.confirm/prompt ARE allowed in UI handlers? No — UI lives in popup/manager only.
    if (domRe.test(src)) fail(`${f} touches DOM globals (must stay service-worker safe)`);
  }
}
ok('background/shared/platform DOM-free (if no failure above)');

// 3. No dynamic import() in shipped code (MV3 service worker must be one file).
// NOTE: `import('...')` in TYPE position (after a colon) is erased at compile
// time and is fine — only expression imports are banned.
{
  const files = srcFiles('src');
  const bad = files.filter((f) => {
    if (!f.endsWith('.ts')) return false;
    const src = readFileSync(path.join(root, f), 'utf8').replace(/:\s*import\([^)]*\)/g, ':TYPEIMPORT');
    return /await\s+import\s*\(|[^.:A-Za-z_$]import\s*\(/.test(src);
  });
  if (bad.length > 0) fail(`dynamic import() in: ${bad.join(', ')}`);
  else ok('no dynamic import() in src');
}

// 4. No console.* / debugger leftovers in shipped code.
{
  const files = srcFiles('src');
  const bad = files.filter((f) => f.endsWith('.ts') && /(console\.(log|debug|trace|info|warn|error)|debugger;)/.test(readFileSync(path.join(root, f), 'utf8')));
  if (bad.length > 0) fail(`console/debugger leftovers in: ${bad.join(', ')}`);
  else ok('no console/debugger leftovers');
}

// 5. Every MessageCommand has a handler case in core, and every handled
// command still exists in the enum (catches orphaned handlers).
{
  const messages = readFileSync(path.join(root, 'src/shared/messages.ts'), 'utf8');
  const commands = [...messages.matchAll(/^\s*(\w+) = '[^']+',?$/gm)].map((m) => m[1]);
  const core = readFileSync(path.join(root, 'src/background/core.ts'), 'utf8');
  const missing = commands.filter((c) => !core.includes(`MessageCommand.${c}`));
  if (missing.length > 0) fail(`unhandled commands in core: ${missing.join(', ')}`);
  else ok(`all ${commands.length} commands handled in core`);
  const handled = [...new Set([...core.matchAll(/MessageCommand\.(\w+)/g)].map((m) => m[1]))];
  const orphaned = handled.filter((c) => !commands.includes(c));
  if (orphaned.length > 0) fail(`core handles unknown commands: ${orphaned.join(', ')}`);
  else ok('no orphaned command handlers in core');
}

// 5b. i18n: every data-i18n* key used in the HTML exists in the English
// catalog, and every catalog key has a text in all four other languages.
{
  const catalog = (lang) => {
    const src = readFileSync(path.join(root, `src/shared/i18n/${lang}.ts`), 'utf8');
    return new Set([...src.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
  };
  const en = catalog('en');
  const used = new Set();
  for (const page of ['src/popup.html', 'src/manager.html']) {
    const html = readFileSync(path.join(root, page), 'utf8');
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  const unknown = [...used].filter((k) => !en.has(k));
  if (unknown.length > 0) fail(`HTML uses unknown i18n keys: ${unknown.join(', ')}`);
  else ok(`all ${used.size} HTML i18n keys exist in the catalog`);
  for (const lang of ['it', 'fr', 'es', 'de']) {
    const keys = catalog(lang);
    const lacking = [...en].filter((k) => !keys.has(k));
    if (lacking.length > 0) fail(`${lang} catalog lacks: ${lacking.slice(0, 5).join(', ')}`);
  }
  ok('catalogs complete in it/fr/es/de');
  for (const lang of ['en', 'it', 'fr', 'es', 'de']) {
    if (!existsSync(path.join(root, `res/_locales/${lang}/messages.json`))) fail(`missing _locales/${lang}`);
  }
}

// 6. StoreKey: no string-literal storage access outside store.ts.
{
  const files = srcFiles('src');
  const bad = [];
  for (const f of files.filter((x) => x.endsWith('.ts') && !x.endsWith('src/shared/store.ts'))) {
    const src = readFileSync(path.join(root, f), 'utf8');
    if (/storage\.(local|session|sync|managed)\.(get|set|remove)\(\s*['"`]/i.test(src)) bad.push(f);
  }
  // popup/manager read via StoreKey enum or single-key get with variable — check raw literals only
  if (bad.length > 0) fail(`raw storage keys in: ${bad.join(', ')}`);
  else ok('storage access goes through StoreKey/backend');
}

// 7. Build outputs coherent with manifests (missing build dir = clean FAIL).
for (const [platform, bg] of [['firefox', 'background.html'], ['chromium', 'background.js']]) {
  const dir = path.join(root, 'build', platform);
  if (!existsSync(path.join(dir, 'manifest.json'))) {
    fail(`${platform} build missing — run npm run build first`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const need = ['popup.html', 'manager.html', bg];
  const missing = need.filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length > 0) fail(`${platform} build missing: ${missing.join(', ')}`);
  const icons = Object.values(manifest.icons ?? {});
  const missingIcons = icons.filter((f) => !existsSync(path.join(dir, f)));
  if (missingIcons.length > 0) fail(`${platform} manifest icons missing: ${missingIcons.join(', ')}`);
  if (missing.length === 0 && missingIcons.length === 0) ok(`${platform} build coherent`);
}

// 7c. Pinned build invariants: relative asset base + dual tsconfig coverage.
{
  for (const cfg of ['vite.firefox.ts', 'vite.chromium.ts']) {
    const src = readFileSync(path.join(root, cfg), 'utf8');
    if (!src.includes("base: './'")) fail(`${cfg} must pin base: './' (absolute asset URLs break)`);
  }
  if (!existsSync(path.join(root, 'tsconfig.chromium.json'))) {
    fail('tsconfig.chromium.json missing — lint would be blind on Chromium');
  } else ok('build invariants pinned (base, dual tsconfig)');
}

// 7d. Permissions must be used: every manifest permission needs a matching
// browser.* usage in src (unlimitedStorage/host_permissions are documented
// in README instead of code-matched).
{
  const src = srcFiles('src').filter((f) => f.endsWith('.ts')).map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
  const usage = {
    alarms: 'browser.alarms',
    bookmarks: 'browser.bookmarks',
    downloads: 'browser.downloads',
    notifications: 'browser.notifications',
    storage: 'browser.storage',
  };
  for (const p of ['res/manifest.firefox.json', 'res/manifest.chromium.json']) {
    const manifest = JSON.parse(readFileSync(path.join(root, p), 'utf8'));
    for (const perm of manifest.permissions ?? []) {
      if (perm === 'unlimitedStorage') continue;
      if (usage[perm] && !src.includes(usage[perm])) fail(`${p}: permission "${perm}" has no matching usage`);
    }
  }
  ok('manifest permissions all used (if no failure above)');
}

// 7e. Chromium host grants stay minimal: https anywhere, http loopback only
// (mirrors validateServiceUrl — a broad http://*/* would over-claim).
{
  const manifest = JSON.parse(readFileSync(path.join(root, 'res/manifest.chromium.json'), 'utf8'));
  const hosts = manifest.host_permissions ?? [];
  const badHosts = hosts.filter((h) => h.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)\//.test(h));
  if (badHosts.length > 0) fail(`chromium host_permissions too broad: ${badHosts.join(', ')}`);
  else ok('chromium host_permissions minimal');
}

// 7b. Chromium MV3 specifics: no Firefox-only keys, SW entry valid,
// service worker bundle self-contained (no local chunk imports).
{
  const manifest = JSON.parse(readFileSync(path.join(root, 'res/manifest.chromium.json'), 'utf8'));
  if (manifest.browser_specific_settings) fail('chromium manifest must not contain browser_specific_settings');
  else ok('chromium manifest has no Firefox-only keys');
  if (manifest.browser_action) fail('chromium MV3 manifest must not contain browser_action');
  else ok('chromium manifest has no browser_action');
  if (manifest.background?.service_worker !== 'background.js') fail('chromium service_worker entry wrong');
  else ok('chromium service_worker entry ok');
  const swPath = path.join(root, 'build/chromium/background.js');
  if (!existsSync(swPath)) {
    fail('chromium background.js missing — run npm run build first');
  } else {
    const sw = readFileSync(swPath, 'utf8');
    const localImports = [...sw.matchAll(/(?:import|export)[^;'"]*from\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    if (localImports.length > 0) fail(`SW bundle has local imports: ${localImports.join(', ')}`);
    else ok('chromium SW bundle self-contained');
  }
}

// 8. Mozilla linter on the firefox zip (0 errors required). Local binary,
// versioned artifact name (see scripts/package.mjs).
try {
  const zip = `dist/keepmark-firefox-${version()}.zip`;
  if (!existsSync(path.join(root, zip))) {
    fail(`missing ${zip} — run npm run package first`);
  } else {
    const out = execFileSync('node_modules/.bin/addons-linter', [zip, '--self-hosted'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errors = out.match(/errors\s+(\d+)/)?.[1];
    if (errors !== '0') fail(`addons-linter reports ${errors} errors`);
    else ok('addons-linter: 0 errors');
  }
} catch (e) {
  fail(`addons-linter failed to run: ${(e.message ?? e).split('\n')[0]}`);
}

if (failures > 0) {
  console.error(`\nQA: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nQA: all green');
