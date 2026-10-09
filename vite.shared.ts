// Shared vite bits: '@platform' alias selects the firefox|chromium adapter,
// 'copy-static' drops manifest.json + assets/ into the output dir.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
      const manifestPath = path.join(root, 'res', `manifest.${platform}.json`);
      cpSync(manifestPath, path.join(outDir, 'manifest.json'));
      cpSync(path.join(root, 'res', 'assets'), path.join(outDir, 'assets'), { recursive: true });
      // Manifest name/description/title only; UI texts ship in the JS bundles.
      cpSync(path.join(root, 'res', '_locales'), path.join(outDir, '_locales'), { recursive: true });
      // Fail the build (not QA, not install time) when the manifest points
      // at files that are not in the output.
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        icons?: Record<string, string>;
        action?: { default_popup?: string; default_icon?: Record<string, string> };
        browser_action?: { default_popup?: string; default_icon?: Record<string, string> };
        background?: { page?: string; service_worker?: string };
      };
      const referenced: string[] = [
        ...Object.values(manifest.icons ?? {}),
        ...Object.values(manifest.action?.default_icon ?? {}),
        ...Object.values(manifest.browser_action?.default_icon ?? {}),
      ];
      if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
      if (manifest.browser_action?.default_popup) referenced.push(manifest.browser_action.default_popup);
      // NOTE: background.page is validated here; background.service_worker is
      // produced by the separate SW build step (see vite.chromium-sw.ts),
      // which validates its own output.
      if (manifest.background?.page) referenced.push(manifest.background.page);
      const missing = referenced.filter((f) => !existsSync(path.join(outDir, f)));
      if (missing.length > 0) {
        throw new Error(`copy-static: manifest references missing output files: ${missing.join(', ')}`);
      }
    },
  };
}

// lzutf8's debug logger does `document.body.innerHTML += ...`, which AMO's
// validator flags ("Unsafe assignment to innerHTML"). Dead code for us
// (appendToDocument is never set); drop the write at bundle time.
export function stripLzutf8InnerHtml(): Plugin {
  const needle = 'document.body.innerHTML += message + "<br/>";';
  return {
    name: 'strip-lzutf8-innerhtml',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]lzutf8[\\/]/.test(id) || !code.includes('document.body.innerHTML')) return null;
      if (!code.includes(needle)) {
        throw new Error('strip-lzutf8-innerhtml: lzutf8 changed, update the needle');
      }
      return { code: code.replace(needle, ';'), map: null };
    },
  };
}

export { root };
