import { describe, expect, it } from 'vitest';
import { buildConnectQrPayload, isDerivedKey, serializeConnectQrPayload } from '../src/shared/connect-qr';
import { isConnectQrSender } from '../src/background/connect-qr-sender';
import { t } from '../src/shared/i18n';

const key = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='; // 32 synthetic bytes
const input = {
  serviceUrl: 'https://sync.example.test:8443/prefix',
  id: '0123456789abcdef0123456789abcdef',
  version: '1.8.0',
  key,
};

describe('connect QR contract (format 2)', () => {
  it('serializes only seven ordered fields: the derived key, never a password', () => {
    const payload = buildConnectQrPayload({ ...input, password: 'DO-NOT-EXPORT', revision: 42 } as typeof input);
    expect(payload).toEqual({ app: 'Keepmark', format: 2, serviceType: 'xbrowsersync', ...input });
    expect(Object.keys(payload)).toEqual(['app', 'format', 'serviceType', 'serviceUrl', 'id', 'version', 'key']);
    expect(serializeConnectQrPayload(payload)).toBe(JSON.stringify(payload));
    expect(serializeConnectQrPayload(payload)).not.toContain('DO-NOT-EXPORT');
  });

  it.each([
    '', 'x', key.slice(0, -1), `${key}=`, key.replace('=', 'A'),
    'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw==', // 31 bytes
    'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyB=', // stray bits in the last char
    'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e-_A=', // base64url alphabet
  ])('rejects a key that is not canonical base64 of 32 bytes %j', (bad) => {
    expect(isDerivedKey(bad)).toBe(false);
    expect(() => buildConnectQrPayload({ ...input, key: bad })).toThrow(t('err.syncInfoIncomplete'));
  });

  it('accepts every canonical 32-byte key', () => {
    for (let i = 0; i < 64; i++) {
      const bytes = new Uint8Array(32).map((_, j) => (i * 37 + j * 11) & 0xff);
      const encoded = btoa(String.fromCharCode(...bytes));
      expect(isDerivedKey(encoded)).toBe(true);
    }
  });

  it.each(['', '../secret', 'id?x', 'id#x', 'id%2f', 'a/b', 'with space', '日本語', 'a'.repeat(129)])('rejects unsafe ID %j', (id) => {
    expect(() => buildConnectQrPayload({ ...input, id })).toThrow();
  });

  it.each(['', '2.0.0', '1.9.0', '1.8', 'v1.8.0', '1.8.0-beta', '-1.0.0'])('rejects unsupported or malformed version %j', (version) => {
    expect(() => buildConnectQrPayload({ ...input, version })).toThrow();
  });

  it.each([
    'http://sync.example.test', 'https://user:secret@sync.example.test',
    'https://sync.example.test?query=1', 'https://sync.example.test#fragment',
    'https://sync.example.test?', 'https://sync.example.test#',
    'https://sync.example.test\\evil', 'https://sync.example.test/with space',
    'https://sync.example.test/\ncontrol', 'relative/path', 'https://@sync.example.test', 'https://sync.example.test/%0a', 'https://sync.example.test/%5c',
  ])('rejects unsafe service URL %j', (serviceUrl) => {
    expect(() => buildConnectQrPayload({ ...input, serviceUrl })).toThrow();
  });

  it('enforces the 1800-byte limit using UTF-8 bytes rather than characters', () => {
    const overhead = new TextEncoder().encode(serializeConnectQrPayload(buildConnectQrPayload({ ...input, serviceUrl: 'https://a.test/' }))).length - 'https://a.test/'.length;
    const fits = 'https://a.test/' + 'p'.repeat(1800 - overhead - 'https://a.test/'.length);
    expect(new TextEncoder().encode(serializeConnectQrPayload(buildConnectQrPayload({ ...input, serviceUrl: fits })))).toHaveLength(1800);
    expect(() => buildConnectQrPayload({ ...input, serviceUrl: `${fits}p` })).toThrow(t('qr.tooLarge'));
  });

  it('names the HTTPS requirement instead of the generic incomplete-info error', () => {
    // The user-facing copy differs: an http service is a fixable setup issue,
    // a missing version/id is not.
    for (const serviceUrl of ['http://sync.example.test', 'http://sync.example.test:8090/']) {
      expect(() => buildConnectQrPayload({ ...input, serviceUrl })).toThrow(t('qr.httpsRequired'));
    }
    expect(() => buildConnectQrPayload({ ...input, version: '2.0.0' })).toThrow(t('err.syncInfoIncomplete'));
    expect(() => buildConnectQrPayload({ ...input, id: 'a/b' })).toThrow(t('err.syncInfoIncomplete'));
  });

  it('never puts the key in an error message', () => {
    try {
      buildConnectQrPayload({ ...input, key: `${key}x` });
      expect.fail('malformed key was accepted');
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });
});

describe('connect QR sender gate', () => {
  const runtimeId = 'keepmark-test';
  const managerUrl = 'moz-extension://extension-origin/manager.html';
  it('allows only the internal manager including its query string', () => {
    expect(isConnectQrSender({ id: runtimeId, url: managerUrl }, runtimeId, managerUrl)).toBe(true);
    expect(isConnectQrSender({ id: runtimeId, url: `${managerUrl}?section=status` }, runtimeId, managerUrl)).toBe(true);
  });
  it.each([
    {},
    { id: runtimeId },
    { url: managerUrl },
    { id: 'other-extension', url: managerUrl },
    { id: runtimeId, url: 'https://example.test/manager.html' },
    { id: runtimeId, url: 'moz-extension://other-origin/manager.html' },
    { id: runtimeId, url: 'moz-extension://extension-origin/popup.html' },
    { id: runtimeId, url: 'moz-extension://extension-origin/sub/manager.html' },
    { id: runtimeId, url: 'not a URL' },
  ])('rejects untrusted sender %j', (sender) => {
    expect(isConnectQrSender(sender, runtimeId, managerUrl)).toBe(false);
  });
});
