import { describe, expect, it } from 'vitest';
import {
  authHashOf,
  createHandoff,
  fromBase64Url,
  generateHandoffCode,
  handoffKeys,
  openHandoff,
  parseHandoffLink,
  redeemRequest,
  toBase64Url,
} from '../src/shared/handoff';
import { parseShareLink } from '../src/shared/share-link';

// Reference vector: KeepmarkApi HandoffTests.ClientVector_* (and Android SyncHandoffTests).
const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const handoffId = 'tGggaQeJDZf0F3QGzcz8iro8a28lqeDJlyvuhXEP6ys';
const encKey = '1030d5c122b6aa162a6c7661491fe21f7d1506e1f5906ef4267f02d864f505fe';
const encKeyNoCode = '4b96080ce8f6b3acf759b2d7521fa391c123675a31bef4be967a503df0c9c692';
const auth = '5MgSvJvzkiItQgb54bdjmJXprBtSWLThiXDGISEiBRc';
const authHash = 'f00e72ccdcc85e56bacee9e012694482fd1b5abaf8d5b0f6d93e34b6198eacdc';
const service = 'https://sync.example.com/api';
const content = { serviceUrl: service, id: '0123456789abcdef0123456789abcdef', key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', label: 'Laptop' };
const payload =
  'oKGio6SlpqeoqaqrpzCWtg5_WbR5gSWr_KBfQOO5mQ6CE_s-xiw9HZFjd7L4k_payhKpkeDsu8Tx7EU-CtiiLM-Pzlc0uB4jNhlXHXoxrHof0iF4e-aDwKJ5OIl1N4OgA7cLZvgRboF3IYHKdvMhUKdXf06pB9w1HlOC5_7ju0ORthRTbWS2MYYpNBJ4U9wo7Kz639Ku2eBWKk7n4-vI_ptRCBZDOsGtfENv8KgI';
const link = 'keepmark://sync?v=2&s=https%3A%2F%2Fsync.example.com%2Fapi&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&c=1';
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('handoff voucher (format 2)', () => {
  it('derives the server reference vector', async () => {
    const withCode = await handoffKeys(secret, '123456');
    expect(withCode.handoffId).toBe(handoffId);
    expect(hex(withCode.encKey)).toBe(encKey);
    expect(withCode.auth).toBe(auth);
    expect(await authHashOf(auth)).toBe(authHash);
    const noCode = await handoffKeys(secret);
    expect(noCode.handoffId).toBe(handoffId);
    expect(hex(noCode.encKey)).toBe(encKeyNoCode);
    expect(noCode.auth).toBeUndefined();
  });

  it('builds the payload and link vector byte for byte', async () => {
    const made = await createHandoff(content, '123456', { secret, nonce });
    expect(made).toEqual({ link, handoffId, payload, authHash });
  });

  it('parses the link, rebuilds the redeem request and opens the payload', async () => {
    const parsed = parseHandoffLink(`Open this: ${link} (code by phone)`);
    expect(parsed).toEqual({ serviceUrl: service, token, codeRequired: true });
    expect(await redeemRequest(parsed!, '123456')).toEqual({ handoffId, auth });
    expect(await openHandoff(parsed!, payload, '123456')).toEqual(content);
    expect(await openHandoff(parsed!, payload, '654321')).toBeUndefined();
    expect(parseShareLink(link)).toBeUndefined();
  });

  it('round-trips without a code and sends no auth', async () => {
    const made = await createHandoff({ ...content, label: undefined });
    expect(made.authHash).toBeUndefined();
    expect(made.link).not.toContain('&c=1');
    const parsed = parseHandoffLink(made.link)!;
    expect(parsed.codeRequired).toBe(false);
    expect(await redeemRequest(parsed)).toEqual({ handoffId: made.handoffId });
    expect(await openHandoff(parsed, made.payload)).toEqual({ serviceUrl: service, id: content.id, key: content.key });
  });

  it('refuses a payload replayed under another service', async () => {
    const made = await createHandoff(content);
    const parsed = parseHandoffLink(made.link)!;
    expect(await openHandoff({ ...parsed, serviceUrl: 'https://evil.example.com/api' }, made.payload)).toBeUndefined();
  });

  it.each([
    'keepmark://sync?v=2&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh',
    'keepmark://sync?v=2&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9',
    'keepmark://sync?v=2&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&c=2',
    'keepmark://sync?v=2&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&id=x',
    'keepmark://sync?v=2&s=ftp%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'keepmark://sync?v=2&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'keepmark://sync?v=3&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'keepmark://sync?v=2&v=2&s=https%3A%2F%2Fa.test&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  ])('rejects %s', (text) => {
    expect(parseHandoffLink(text)).toBeUndefined();
  });

  it('generates uniform six-digit codes and skips the biased tail', () => {
    expect(generateHandoffCode()).toMatch(/^\d{6}$/);
    const values = [4_294_967_295, 4_294_000_000, 7];
    expect(generateHandoffCode((buf) => { buf[0] = values.shift()!; return buf; })).toBe('000007');
  });

  it('decodes base64url strictly', () => {
    expect(fromBase64Url(token)).toEqual(secret);
    expect(toBase64Url(secret)).toBe(token);
    expect(fromBase64Url(`${token}=`)).toBeUndefined();
    expect(fromBase64Url('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9')).toBeUndefined();
  });
});
