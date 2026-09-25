// Chromium MV3 build, part 1: popup page.
import { defineConfig } from 'vite';
import { copyStatic, platformAlias, root } from './vite.shared';

const outDir = `${root}/build/chromium`;

export default defineConfig({
  root: `${root}/src`,
  base: './',
  publicDir: false,
  resolve: { alias: platformAlias('chromium') },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: `${root}/src/popup.html`,
        manager: `${root}/src/manager.html`,
      },
    },
  },
  plugins: [copyStatic('chromium', outDir)],
});
