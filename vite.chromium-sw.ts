// Chromium MV3 build, part 2: background service worker as a single ESM file.
import { defineConfig } from 'vite';
import { platformAlias, root } from './vite.shared';

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
});
