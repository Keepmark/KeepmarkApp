// Chromium platform specifics. Mirrors chromium-platform.service.ts:
// legacy root ids Other=2 + Toolbar=1 (fallback only: roots are resolved by
// folderType in bookmarks.ts, account storage uses other ids), no native Menu root (Menu ships as a
// folder inside Other), chrome:// or edge:// new tab.

export const ChromiumRootIds = {
  other: '2',
  toolbar: '1',
} as const;

export function getNewTabUrl(browserName: 'chrome' | 'edge' = 'chrome'): string {
  return browserName === 'edge' ? 'edge://newtab/' : 'chrome://newtab/';
}

export function urlIsNativeConfigPage(url?: string): boolean {
  return !!url && /(chrome|edge):\/\//i.test(url);
}

/** Chromium accepts any scheme (unsupported bookmark urls fall back to newtab at create time). */
export function urlIsSupported(url: string): boolean {
  return /^[\w-]+:/i.test(url ?? '');
}

export function getSupportedUrl(url: string | undefined, newTabUrl = getNewTabUrl()): string {
  if (url === undefined) return '';
  return urlIsSupported(url) ? url : newTabUrl;
}
