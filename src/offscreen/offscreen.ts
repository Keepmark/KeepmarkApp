// Chromium offscreen document: tells the service worker whether the browser
// theme is dark, so the toolbar ribbon can switch to its white variant
// (canvas "BxRibbon"). Sends on load and on every change, and answers the
// worker's query after a worker restart (the document outlives the worker).

import browser from 'webextension-polyfill';
import { THEME_QUERY, THEME_REPORT } from '../shared/theme.js';

const query = matchMedia('(prefers-color-scheme: dark)');
const report = (): void => void browser.runtime.sendMessage({ type: THEME_REPORT, dark: query.matches }).catch(() => undefined);

query.addEventListener('change', report);
browser.runtime.onMessage.addListener((msg: unknown) => {
  if ((msg as { type?: string } | null)?.type !== THEME_QUERY) return undefined;
  return Promise.resolve({ dark: query.matches });
});
report();
