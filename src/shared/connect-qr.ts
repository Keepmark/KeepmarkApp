import { compareVersions, SyncClientVersion } from './constants.js';
import { t } from './i18n.js';

export const ConnectQrMaxBytes = 1800;

/** One saved sync a QR can be built for: the active one or a dormant row. */
export interface ConnectQrTarget {
  serviceUrl: string;
  syncId: string;
}
/**
 * Format 2: the sync's derived key (base64 of the 32-byte AES key) replaces
 * the long password, so the password never leaves this browser and showing
 * the code needs nothing typed (only the sync lock password, when one is
 * set). Keepmark for Android reads it from 1.0.247; format 1 (password) is
 * still accepted there but no longer produced here.
 */
export interface ConnectQrPayload {
  app: 'Keepmark';
  format: 2;
  serviceType: 'xbrowsersync';
  serviceUrl: string;
  id: string;
  version: string;
  key: string;
}

/** Canonical base64 of exactly 32 bytes. */
export function isDerivedKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  // The last character before '=' may only carry 4 data bits.
  return 'AEIMQUYcgkosw048'.includes(value[42]!);
}

export function buildConnectQrPayload(input: { serviceUrl: string; id: string; version: string; key: string }): ConnectQrPayload {
  // Distinct reasons: "incomplete sync info" is a structural failure, a plain
  // HTTP service URL is a policy refusal the user can act on (the user-facing
  // copy differs), and both would otherwise surface as the same generic error.
  const fail = (key: 'err.syncInfoIncomplete' | 'qr.httpsRequired' = 'err.syncInfoIncomplete'): never => { throw new Error(t(key)); };
  if (typeof input.id !== 'string' || typeof input.version !== 'string' || typeof input.serviceUrl !== 'string') fail();
  if (!isDerivedKey(input.key) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) fail();
  if (!/^\d+\.\d+\.\d+$/.test(input.version) || !input.version.split('.').every(part => Number.isSafeInteger(Number(part))) || compareVersions(input.version, SyncClientVersion) > 0) fail();
  const raw = input.serviceUrl;
  if (!raw || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) fail();
  if (!/^https:\/\//i.test(raw)) fail('qr.httpsRequired');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('qr.httpsRequired'); }
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#') || raw.split('/')[2]?.includes('@') || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)) fail('qr.httpsRequired');
  const payload: ConnectQrPayload = {
    app: 'Keepmark', format: 2, serviceType: 'xbrowsersync',
    serviceUrl: raw, id: input.id, version: input.version, key: input.key,
  };
  serializeConnectQrPayload(payload);
  return payload;
}

export function serializeConnectQrPayload(payload: ConnectQrPayload): string {
  const json = JSON.stringify({ app: payload.app, format: payload.format, serviceType: payload.serviceType,
    serviceUrl: payload.serviceUrl, id: payload.id, version: payload.version, key: payload.key });
  if (new TextEncoder().encode(json).byteLength > ConnectQrMaxBytes) throw new Error(t('qr.tooLarge'));
  return json;
}
