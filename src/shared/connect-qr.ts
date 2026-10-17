import { compareVersions, SyncClientVersion } from './constants.js';
import { t } from './i18n.js';

export const ConnectQrMaxBytes = 1800;
export interface ConnectQrPayload {
  app: 'Keepmark';
  format: 1;
  serviceType: 'xbrowsersync';
  serviceUrl: string;
  id: string;
  version: string;
  password: string;
}

export function buildConnectQrPayload(input: { serviceUrl: string; id: string; version: string; password: string }): ConnectQrPayload {
  const fail = (): never => { throw new Error(t('err.syncInfoIncomplete')); };
  if (typeof input.id !== 'string' || typeof input.version !== 'string' || typeof input.serviceUrl !== 'string') fail();
  if (typeof input.password !== 'string' || !input.password || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) fail();
  if (!/^\d+\.\d+\.\d+$/.test(input.version) || !input.version.split('.').every(part => Number.isSafeInteger(Number(part))) || compareVersions(input.version, SyncClientVersion) > 0) fail();
  const raw = input.serviceUrl;
  if (!raw || /[\s\\\u0000-\u001f\u007f]/u.test(raw) || !/^https:\/\//i.test(raw)) fail();
  let url: URL;
  try { url = new URL(raw); } catch { return fail(); }
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#') || raw.split('/')[2]?.includes('@') || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)) fail();
  const payload: ConnectQrPayload = {
    app: 'Keepmark', format: 1, serviceType: 'xbrowsersync',
    serviceUrl: raw, id: input.id, version: input.version, password: input.password,
  };
  serializeConnectQrPayload(payload);
  return payload;
}

export function serializeConnectQrPayload(payload: ConnectQrPayload): string {
  const json = JSON.stringify({ app: payload.app, format: payload.format, serviceType: payload.serviceType,
    serviceUrl: payload.serviceUrl, id: payload.id, version: payload.version, password: payload.password });
  if (new TextEncoder().encode(json).byteLength > ConnectQrMaxBytes) throw new Error(t('qr.tooLarge'));
  return json;
}
