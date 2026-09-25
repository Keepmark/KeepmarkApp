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

/** Collect id="..." from an HTML file. */
function htmlIds(file) {
  const html = readFileSync(path.join(root, file), 'utf8');
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

/** Collect $('...') / getElementById('...') / querySelector('#...') refs from TS. */
function tsIdRefs(file) {
  const ts = readFileSync(path.join(root, file), 'utf8');
  const refs = new Set();
  for (const re of [/\$\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g, /querySelector\('#([^']+)'\)/g]) {
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
  const files = execFileSync('git', ['ls-files', dir], { cwd: root, encoding: 'utf8' }).trim().split('\n');
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
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const bad = files.filter((f) => {
    if (!f.endsWith('.ts')) return false;
    const src = readFileSync(path.join(root, f), 'utf8').replace(/:\s*import\([^)]*\)/g, ':TYPEIMPORT');
    return /await\s+import\s*\(|[^.:A-Za-z_$]import\s*\(/.test(src);
  });
  if (bad.length > 0) fail(`dynamic import() in: ${bad.join(', ')}`);
  else ok('no dynamic import() in src');
}

// 4. No console.log / debugger leftovers in shipped code.
{
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const bad = files.filter((f) => f.endsWith('.ts') && /(console\.(log|debug|trace)|debugger;)/.test(readFileSync(path.join(root, f), 'utf8')));
  if (bad.length > 0) fail(`console/debugger leftovers in: ${bad.join(', ')}`);
  else ok('no console/debugger leftovers');
}

// 5. Every MessageCommand has a handler case in core (and vice versa).
{
  const messages = readFileSync(path.join(root, 'src/shared/messages.ts'), 'utf8');
  const commands = [...messages.matchAll(/^\s*(\w+) = '[^']+',?$/gm)].map((m) => m[1]);
  const core = readFileSync(path.join(root, 'src/background/core.ts'), 'utf8');
  const missing = commands.filter((c) => !core.includes(`MessageCommand.${c}`));
  if (missing.length > 0) fail(`unhandled commands in core: ${missing.join(', ')}`);
  else ok(`all ${commands.length} commands handled in core`);
}

// 6. StoreKey: no string-literal storage access outside store.ts.
{
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const bad = [];
  for (const f of files.filter((x) => x.endsWith('.ts') && !x.endsWith('src/shared/store.ts'))) {
    const src = readFileSync(path.join(root, f), 'utf8');
    if (/storage\.local\.(get|set|remove)\(\s*['"`][a-zA-Z]/i.test(src)) bad.push(f);
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
  const srcFiles = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const src = srcFiles.filter((f) => f.endsWith('.ts')).map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
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
  const sw = readFileSync(path.join(root, 'build/chromium/background.js'), 'utf8');
  const localImports = [...sw.matchAll(/(?:import|export)[^;'"]*from\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  if (localImports.length > 0) fail(`SW bundle has local imports: ${localImports.join(', ')}`);
  else ok('chromium SW bundle self-contained');
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
