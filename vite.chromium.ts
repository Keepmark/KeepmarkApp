// Chromium MV3 build, part 1: popup, manager and theme offscreen pages.
import { defineConfig } from 'vite';
import { copyStatic, stripLzutf8InnerHtml, platformAlias, root } from './vite.shared';

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
        offscreen: `${root}/src/offscreen.html`,
      },
    },
  },
  plugins: [stripLzutf8InnerHtml(), copyStatic('chromium', outDir)],
});
