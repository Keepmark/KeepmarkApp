import { isDerivedKey } from './connect-qr.js';
import { isShareServiceUrl, ShareLinkMaxLength, ShareLinkPrefix } from './share-link.js';

/**
 * One-time shared link (format 2): a short-lived, single-use voucher stored by
 * the service (KeepmarkApi v1.2 `capabilities.handoff`). The link carries a
 * random 32-byte secret `V`, never a credential; the service holds only
 * ciphertext it cannot open. Protocol: KeepmarkApi `docs/DEVELOPMENT.md`
 * "Handoff vouchers" (HKDF-SHA256, AES-256-GCM, bound AAD). Keepmark for
 * Android (`SyncHandoff`) implements the same contract;
 * `tests/handoff.test.ts` pins the server's reference vector.
 *
 * `keepmark://sync?v=2&s=<service, EscapeDataString>&t=<V, base64url>[&c=1]`
 */
export const HandoffLinkVersion = 2;
export const HandoffCodeLength = 6;
export const HandoffLabelMax = 40;

export interface HandoffSecret {
  serviceUrl: string;
  /** base64url of the 32-byte secret, exactly as in the link. */
  token: string;
  codeRequired: boolean;
}

/** What the voucher hands over: the same material as a v1 link. */
export interface HandoffContent {
  serviceUrl: string;
  id: string;
  /** Canonical base64 of the 32-byte derived key. */
  key: string;
  label?: string;
}

export interface CreatedHandoff {
  link: string;
  handoffId: string;
  payload: string;
  authHash?: string;
}

const enc = new TextEncoder();
const SyncIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const LinkPattern = /keepmark:\/\/sync\?[A-Za-z0-9._~%&=+-]+/i;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Strict decode: URL-safe alphabet, no padding, canonical tail bits. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bin: string;
  try { bin = atob(b64); } catch { return undefined; }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return toBase64Url(bytes) === text ? bytes : undefined;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function ikmFor(secret: Uint8Array, code: string | undefined): Uint8Array {
  if (!code) return secret;
  const tail = enc.encode(code);
  const out = new Uint8Array(secret.length + tail.length);
  out.set(secret);
  out.set(tail, secret.length);
  return out;
}

/** handoffId (never depends on the code), encryption key and, with a code, `auth`. */
export async function handoffKeys(secret: Uint8Array, code?: string): Promise<{ handoffId: string; encKey: Uint8Array; auth?: string }> {
  const handoffId = toBase64Url(await hkdf(secret, 'keepmark-handoff-id'));
  const ikm = ikmFor(secret, code);
  const encKey = await hkdf(ikm, 'keepmark-handoff-enc');
  const auth = code ? toBase64Url(await hkdf(ikm, 'keepmark-handoff-auth')) : undefined;
  return { handoffId, encKey, ...(auth ? { auth } : {}) };
}

/** Lowercase hex SHA-256 of the raw `auth` bytes: what the service stores. */
export async function authHashOf(auth: string): Promise<string> {
  const raw = fromBase64Url(auth);
  if (!raw) throw new TypeError('auth is not base64url');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource)));
}

function aadFor(handoffId: string, serviceUrl: string): Uint8Array {
  return enc.encode(`keepmark-handoff-v1|${handoffId}|${serviceUrl}`);
}

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);
}

/** Uniform 6-digit code (rejection sampling, CSPRNG). */
export function generateHandoffCode(random: (buf: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)): string {
  const limit = 4_294_000_000; // largest multiple of 10^6 below 2^32
  const buf = new Uint32Array(1);
  for (;;) {
    const value = random(buf)[0];
    if (value < limit) return String(value % 1_000_000).padStart(HandoffCodeLength, '0');
  }
}

export function isHandoffCode(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

/** Display label: trimmed, control characters dropped, at most 40 characters. */
export function cleanHandoffLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, HandoffLabelMax).trim();
  return clean || undefined;
}

/** RFC 3986 unreserved set only, like .NET Uri.EscapeDataString. */
function escapeData(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildHandoffLink(serviceUrl: string, token: string, codeRequired: boolean): string {
  return `${ShareLinkPrefix}v=${HandoffLinkVersion}&s=${escapeData(serviceUrl)}&t=${token}${codeRequired ? '&c=1' : ''}`;
}

/**
 * Encrypts the content for a new voucher. `secret` and `nonce` are random
 * unless a test pins them. The caller POSTs `{handoffId, payload, authHash?}`
 * and shares `link` only once the service accepted it.
 */
export async function createHandoff(
  content: HandoffContent,
  code?: string,
  pinned?: { secret?: Uint8Array; nonce?: Uint8Array },
): Promise<CreatedHandoff> {
  if (!isShareServiceUrl(content.serviceUrl) || !SyncIdPattern.test(content.id) || !isDerivedKey(content.key)) {
    throw new TypeError('Handoff input is not valid');
  }
  if (code !== undefined && !isHandoffCode(code)) throw new TypeError('Handoff code must be 6 digits');
  const secret = pinned?.secret ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = pinned?.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const { handoffId, encKey, auth } = await handoffKeys(secret, code);
  const label = cleanHandoffLabel(content.label);
  const plaintext = JSON.stringify({ v: 1, s: content.serviceUrl, id: content.id, k: content.key, ...(label ? { l: label } : {}) });
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aadFor(handoffId, content.serviceUrl) as BufferSource, tagLength: 128 },
    await aesKey(encKey, 'encrypt'),
    enc.encode(plaintext),
  ));
  const payload = new Uint8Array(nonce.length + sealed.length);
  payload.set(nonce);
  payload.set(sealed, nonce.length);
  const link = buildHandoffLink(content.serviceUrl, toBase64Url(secret), code !== undefined);
  if (link.length > ShareLinkMaxLength) throw new TypeError('Sync link too long');
  return {
    link,
    handoffId,
    payload: toBase64Url(payload),
    ...(auth ? { authHash: await authHashOf(auth) } : {}),
  };
}

/** Finds the first sync link in the text and accepts only a valid format 2:
 *  `v=2`, `s` and `t` once each, optional `c=1`, canonical 32-byte secret,
 *  absolute https/http service URL. Nothing touches the network. */
export function parseHandoffLink(text: unknown): HandoffSecret | undefined {
  if (typeof text !== 'string' || !text || text.length > ShareLinkMaxLength * 4) return undefined;
  const match = LinkPattern.exec(text);
  if (!match || match[0].length > ShareLinkMaxLength) return undefined;
  const values = new Map<string, string>();
  for (const part of match[0].slice(ShareLinkPrefix.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const name = part.slice(0, eq);
    if (!['v', 's', 't', 'c'].includes(name) || values.has(name)) return undefined;
    values.set(name, part.slice(eq + 1));
  }
  if (values.get('v') !== String(HandoffLinkVersion) || !values.has('s') || !values.has('t')) return undefined;
  if (values.has('c') && values.get('c') !== '1') return undefined;
  let serviceUrl: string;
  try { serviceUrl = decodeURIComponent(values.get('s')!); } catch { return undefined; }
  const token = values.get('t')!;
  if (token.length !== 43 || fromBase64Url(token)?.length !== 32 || !isShareServiceUrl(serviceUrl)) return undefined;
  return { serviceUrl, token, codeRequired: values.has('c') };
}

/** Request material for `POST /handoffs/:handoffId/redeem`. */
export async function redeemRequest(link: HandoffSecret, code?: string): Promise<{ handoffId: string; auth?: string }> {
  const secret = fromBase64Url(link.token);
  if (!secret || secret.length !== 32) throw new TypeError('Handoff secret is not valid');
  if (link.codeRequired && !isHandoffCode(code)) throw new TypeError('Handoff code must be 6 digits');
  const { handoffId, auth } = await handoffKeys(secret, link.codeRequired ? code : undefined);
  return { handoffId, ...(auth ? { auth } : {}) };
}

/**
 * Opens a redeemed payload. Undefined when it does not decrypt (wrong code
 * slipped through, tampering) or does not hold a valid sync for the link's
 * own service: a payload naming another service is refused.
 */
export async function openHandoff(link: HandoffSecret, payload: string, code?: string): Promise<HandoffContent | undefined> {
  const secret = fromBase64Url(link.token);
  const raw = fromBase64Url(payload);
  if (!secret || secret.length !== 32 || !raw || raw.length < 12 + 16 + 1) return undefined;
  const { handoffId, encKey } = await handoffKeys(secret, link.codeRequired ? code : undefined);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource, additionalData: aadFor(handoffId, link.serviceUrl) as BufferSource, tagLength: 128 },
      await aesKey(encKey, 'decrypt'),
      raw.slice(12) as BufferSource,
    );
  } catch {
    return undefined;
  }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } catch { return undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || d.s !== link.serviceUrl || typeof d.id !== 'string' || !SyncIdPattern.test(d.id) || !isDerivedKey(d.k)) return undefined;
  const label = cleanHandoffLabel(d.l);
  return { serviceUrl: link.serviceUrl, id: d.id, key: d.k as string, ...(label ? { label } : {}) };
}
