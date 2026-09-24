// Shared vite bits: '@platform' alias selects the firefox|chromium adapter,
// 'copy-manifest' drops the right manifest.json into the output dir.
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

export function copyManifest(platform: 'firefox' | 'chromium', outDir: string): Plugin {
  return {
    name: 'copy-manifest',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      cpSync(path.join(root, 'res', `manifest.${platform}.json`), path.join(outDir, 'manifest.json'));
    },
  };
}

export { root };
