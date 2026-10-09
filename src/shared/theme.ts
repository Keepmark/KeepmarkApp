// Browser-theme messages between the Chromium offscreen document and the
// background worker. Not core messages: the background routes them before
// BackgroundCore.handleMessage.
export const THEME_REPORT = 'km-theme';
export const THEME_QUERY = 'km-theme-query';

export function isThemeReport(msg: unknown): msg is { type: typeof THEME_REPORT; dark: boolean } {
  const m = msg as { type?: unknown; dark?: unknown } | null;
  return m?.type === THEME_REPORT && typeof m.dark === 'boolean';
}
