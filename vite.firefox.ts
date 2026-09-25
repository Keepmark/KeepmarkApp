// Firefox MV2 build: popup page + background page.
import { defineConfig } from 'vite';
import { copyStatic, platformAlias, root } from './vite.shared';

const outDir = `${root}/build/firefox`;

export default defineConfig({
  root: `${root}/src`,
  base: './',
  publicDir: false,
  resolve: { alias: platformAlias('firefox') },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: `${root}/src/popup.html`,
        background: `${root}/src/background.html`,
        manager: `${root}/src/manager.html`,
      },
    },
  },
  plugins: [copyStatic('firefox', outDir)],
});
