// Chromium MV3 build, part 2: background service worker as a single ESM file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { platformAlias, stripLzutf8InnerHtml, root } from './vite.shared';

/** Fail unless the SW bundle (and the manifest pointing at it) is in place. */
function checkSw(): Plugin {
  return {
    name: 'check-sw',
    closeBundle() {
      const outDir = path.join(root, 'build/chromium');
      if (!existsSync(path.join(outDir, 'background.js'))) {
        throw new Error('check-sw: background.js missing from build/chromium');
      }
      if (!existsSync(path.join(outDir, 'manifest.json'))) {
        throw new Error('check-sw: manifest.json missing — run the popup build first');
      }
    },
  };
}

export default defineConfig({
  resolve: { alias: platformAlias('chromium') },
  build: {
    outDir: `${root}/build/chromium`,
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: `${root}/src/background/background.ts`,
      formats: ['es'],
      fileName: () => 'background.js',
    },
  },
  plugins: [stripLzutf8InnerHtml(), checkSw()],
});
