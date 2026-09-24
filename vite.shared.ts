// Shared vite bits: '@platform' alias selects the firefox|chromium adapter,
// 'copy-static' drops manifest.json + assets/ into the output dir.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';
import type { Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export function platformAlias(platform: 'firefox' | 'chromium') {
  return {
    '@platform': path.join(root, 'src', platform),
  };
}

export function copyStatic(platform: 'firefox' | 'chromium', outDir: string): Plugin {
  return {
    name: 'copy-static',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      cpSync(path.join(root, 'res', `manifest.${platform}.json`), path.join(outDir, 'manifest.json'));
      cpSync(path.join(root, 'res', 'assets'), path.join(outDir, 'assets'), { recursive: true });
    },
  };
}

export { root };
