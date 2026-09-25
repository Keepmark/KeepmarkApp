// Firefox platform specifics. Mirrors firefox-platform.service.ts:
// fixed root ids, all three containers, about: pages.

export const FirefoxRootIds = {
  menu: 'menu________',
  other: 'unfiled_____',
  toolbar: 'toolbar_____',
} as const;

export function getNewTabUrl(): string {
  return 'about:newtab';
}

export function urlIsNativeConfigPage(url?: string): boolean {
  return !!url && /^about:/.test(url);
}

/** Firefox supports everything except chrome:/data: urls (case-insensitive like upstream). */
export function urlIsSupported(url: string): boolean {
  return /^(?!chrome|data)[\w-]+:/i.test(url);
}

export function getSupportedUrl(url: string | undefined): string {
  if (url === undefined) return '';
  return urlIsSupported(url) ? url : getNewTabUrl();
}
