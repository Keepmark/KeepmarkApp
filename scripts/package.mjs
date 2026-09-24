// Zip the built extensions into dist/. Uses the system `zip` when present,
// otherwise leaves the build dirs in place.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

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
  if (!haveZip && !havePython) {
    console.log(`no zip tool; leaving ${dir}`);
    continue;
  }
  const out = path.join(dist, `keepmark-${platform}.zip`);
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
    console.log(`no zip tool; leaving ${dir}`);
    continue;
  }
  console.log(`wrote ${out}`);
}
