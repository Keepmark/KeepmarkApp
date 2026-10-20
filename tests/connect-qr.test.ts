import { describe, expect, it } from 'vitest';
import { buildConnectQrPayload, serializeConnectQrPayload } from '../src/shared/connect-qr';
import { isConnectQrSender } from '../src/background/connect-qr-sender';
import { t } from '../src/shared/i18n';

const input = {
  serviceUrl: 'https://sync.example.test:8443/prefix',
  id: '0123456789abcdef0123456789abcdef',
  version: '1.8.0',
  password: ' Example only: è+日本語 "\\ 😀 ',
};

describe('connect QR contract', () => {
  it('serializes only seven ordered fields and preserves the literal Unicode password', () => {
    const payload = buildConnectQrPayload({ ...input, derivedKey: 'DO-NOT-EXPORT', revision: 42 } as typeof input);
    expect(payload).toEqual({ app: 'Keepmark', format: 1, serviceType: 'xbrowsersync', ...input });
    expect(Object.keys(payload)).toEqual(['app', 'format', 'serviceType', 'serviceUrl', 'id', 'version', 'password']);
    expect(serializeConnectQrPayload(payload)).toBe(JSON.stringify(payload));
    expect(serializeConnectQrPayload(payload)).not.toContain('DO-NOT-EXPORT');
  });

  it('accepts short existing passwords and literal whitespace', () => {
    expect(buildConnectQrPayload({ ...input, password: 'x' }).password).toBe('x');
    expect(buildConnectQrPayload({ ...input, password: ' ' }).password).toBe(' ');
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
    const overhead = new TextEncoder().encode(serializeConnectQrPayload(buildConnectQrPayload({ ...input, password: 'x' }))).length - 1;
    const boundary = buildConnectQrPayload({ ...input, password: 'x'.repeat(1800 - overhead) });
    expect(new TextEncoder().encode(serializeConnectQrPayload(boundary))).toHaveLength(1800);
    expect(() => buildConnectQrPayload({ ...input, password: 'x'.repeat(1801 - overhead) })).toThrow();
    expect(() => buildConnectQrPayload({ ...input, password: '日'.repeat(600) })).toThrow();
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

  it('rejects empty passwords without including their content in errors', () => {
    expect(() => buildConnectQrPayload({ ...input, password: '' })).toThrow();
    const secret = 'sensitive-synthetic-value'.repeat(100);
    try {
      buildConnectQrPayload({ ...input, password: secret });
      expect.fail('oversized payload was accepted');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
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
