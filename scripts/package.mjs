// Zip the built extensions into dist/. Uses the system `zip` when present,
// otherwise the python3 fallback. Refuses to package a build whose manifest
// is missing from the root or points at absent files, or whose manifest
// version differs from package.json (a stale build zipped under a new name).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

let haveZip = true;
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
} catch {
  haveZip = false;
}

let havePython = true;
try {
  execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' });
} catch {
  havePython = false;
}

for (const platform of ['firefox', 'chromium']) {
  const dir = path.join(root, 'build', platform);
  if (!existsSync(dir)) {
    console.error(`missing ${dir} — run npm run build:${platform} first`);
    process.exitCode = 1;
    continue;
  }
  // Assert packageability before zipping: manifest in root + referenced files present.
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`missing ${manifestPath} — refusing to package ${platform}`);
    process.exitCode = 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    console.error(
      `${platform} build is version ${manifest.version}, package.json is ${version} — run npm run build first`,
    );
    process.exitCode = 1;
    continue;
  }
  const bg = manifest.background?.page ?? manifest.background?.service_worker;
  const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.browser_action?.default_icon ?? {}),
  ];
  if (popup) referenced.push(popup);
  if (bg) referenced.push(bg);
  const missing = referenced.filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length > 0) {
    console.error(`${platform} references missing files: ${missing.join(', ')} — refusing to package`);
    process.exitCode = 1;
    continue;
  }
  if (!haveZip && !havePython) {
    console.error('no zip tool (zip or python3) — refusing to leave the release unpackaged');
    process.exitCode = 1;
    continue;
  }
  const out = path.join(dist, `keepmark-${platform}-${version}.zip`);
  // Drop stale unversioned zips from previous releases.
  rmSync(path.join(dist, `keepmark-${platform}.zip`), { force: true });
  rmSync(out, { force: true });
  if (haveZip) {
    execFileSync('zip', ['-r', '-X', out, '.'], { cwd: dir, stdio: 'inherit' });
  } else if (havePython) {
    execFileSync(
      'python3',
      ['-c', 'import sys, zipfile, pathlib; ' +
        'd = pathlib.Path(sys.argv[1]); out = sys.argv[2]; ' +
        'z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED); ' +
        '[z.write(p, p.relative_to(d)) for p in sorted(d.rglob("*")) if p.is_file()]; ' +
        'z.close()', dir, out],
      { stdio: 'inherit' },
    );
  } else {
    console.error('no zip tool (zip or python3) — refusing to leave the release unpackaged');
    process.exitCode = 1;
    continue;
  }
  // Read the manifest back from the zip: the file name must not lie.
  if (!havePython) {
    console.log(`wrote ${out} (manifest version not re-read: no python3)`);
    continue;
  }
  const zipped = execFileSync(
    'python3',
    ['-c', 'import sys, zipfile, json; ' +
      'print(json.loads(zipfile.ZipFile(sys.argv[1]).read("manifest.json"))["version"])', out],
    { encoding: 'utf8' },
  ).trim();
  if (zipped !== version) {
    console.error(`${out} contains manifest version ${zipped}, expected ${version}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`wrote ${out} (manifest version ${zipped})`);
}
