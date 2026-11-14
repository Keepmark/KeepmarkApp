import { isDerivedKey } from './connect-qr.js';

/**
 * Shared sync link, the text form of the connect QR (format 2):
 * `keepmark://sync?v=1&s=<service URL, percent-encoded>&id=<sync ID>&k=<derived key, base64url>`.
 *
 * It carries the derived key, never the password. Unlike the QR it is a
 * lasting credential (it stays in chats and clipboards): anyone holding it
 * can read and change the bookmarks until the sync password is changed.
 * Keepmark for Android (`SyncShareLink`) builds and reads the same format;
 * `tests/share-link.test.ts` pins the shared vector.
 */
export const ShareLinkPrefix = 'keepmark://sync?';
export const ShareLinkFormatVersion = 1;
export const ShareLinkMaxLength = 2048;

export interface ShareLinkPayload {
  serviceUrl: string;
  id: string;
  /** Canonical base64 of the 32-byte derived key. */
  key: string;
}

const SyncIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const LinkPattern = /keepmark:\/\/sync\?[A-Za-z0-9._~%&=+-]+/i;

/** Same rule as Android: absolute https/http, no credentials, query,
 *  fragment, backslash, whitespace or control characters. Whether plain
 *  http is usable here is decided later by the connect form. */
export function isShareServiceUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return false;
  if (/[\s\\\u0000-\u001f\u007f]/u.test(raw) || raw.includes('?') || raw.includes('#')) return false;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw) || raw.split('/')[2]?.includes('@')) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!url.hostname || url.username || url.password) return false;
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/** RFC 3986 unreserved set only, like .NET Uri.EscapeDataString. */
function escapeData(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Builds the link from a saved sync's derived key. Throws on anything
 *  the parser would refuse. */
export function buildShareLink(input: ShareLinkPayload): string {
  if (!isShareServiceUrl(input.serviceUrl) || typeof input.id !== 'string' || !SyncIdPattern.test(input.id) || !isDerivedKey(input.key)) {
    throw new TypeError('Sync link input is not valid');
  }
  const key = input.key.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const link = `${ShareLinkPrefix}v=${ShareLinkFormatVersion}&s=${escapeData(input.serviceUrl)}&id=${input.id}&k=${key}`;
  if (link.length > ShareLinkMaxLength) throw new TypeError('Sync link too long');
  return link;
}

/** True when the text holds something that looks like a sync link (valid
 *  or not), so the form can say "invalid link" instead of ignoring it. */
export function looksLikeShareLink(text: unknown): boolean {
  return typeof text === 'string' && text.toLowerCase().includes(ShareLinkPrefix);
}

/** Finds the first sync link in the text (a pasted message may carry words
 *  around it) and validates it strictly: exactly the four parameters once
 *  each, format 1, safe ID, canonical 32-byte key, absolute https/http
 *  service URL. Nothing touches the network. */
export function parseShareLink(text: unknown): ShareLinkPayload | undefined {
  if (typeof text !== 'string' || !text || text.length > ShareLinkMaxLength * 4) return undefined;
  const match = LinkPattern.exec(text);
  if (!match || match[0].length > ShareLinkMaxLength) return undefined;
  const values = new Map<string, string>();
  for (const part of match[0].slice(ShareLinkPrefix.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const name = part.slice(0, eq);
    if (!['v', 's', 'id', 'k'].includes(name) || values.has(name)) return undefined;
    values.set(name, part.slice(eq + 1));
  }
  if (values.size !== 4 || values.get('v') !== String(ShareLinkFormatVersion)) return undefined;
  let serviceUrl: string;
  try { serviceUrl = decodeURIComponent(values.get('s')!); } catch { return undefined; }
  const id = values.get('id')!;
  const raw = values.get('k')!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const key = `${raw.replace(/-/g, '+').replace(/_/g, '/')}=`;
  if (!SyncIdPattern.test(id) || !isDerivedKey(key) || !isShareServiceUrl(serviceUrl)) return undefined;
  return { serviceUrl, id, key };
}
