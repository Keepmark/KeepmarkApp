import { describe, expect, it } from 'vitest';
import vectors from './vectors.json';
import { decryptData, deriveKey, encryptData } from '../src/shared/crypto';
import { InvalidCredentialsException, UnsupportedSyncVersionException } from '../src/shared/errors';

const { password, salt, derivedKey, cases } = vectors as {
  password: string;
  salt: string;
  derivedKey: string;
  cases: { name: string; plainB64: string; ivB64: string; blob: string }[];
};

function b64ToText(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(globalThis.atob(b64), (c) => c.charCodeAt(0)));
}

describe('crypto interop (Node vectors -> WebCrypto)', () => {
  it('deriveKey matches the Node PBKDF2 vector', async () => {
    await expect(deriveKey(password, salt, '1.8.0')).resolves.toBe(derivedKey);
  }, 30000);

  it.each(cases.map((c) => [c.name, c] as const))('decrypts Node blob %s', async (_name, c) => {
    const expected = b64ToText(c.plainB64);
    await expect(decryptData(c.blob, derivedKey)).resolves.toBe(expected);
  });

  it('wrong password throws InvalidCredentials', async () => {
    const wrong = await deriveKey('wrong password', salt, '1.8.0');
    await expect(decryptData(cases[0].blob, wrong)).rejects.toBeInstanceOf(InvalidCredentialsException);
  }, 30000);

  it('legacy sync without version is rejected', async () => {
    await expect(deriveKey(password, salt, undefined)).rejects.toBeInstanceOf(
      UnsupportedSyncVersionException,
    );
  });

  it('empty string round-trips as empty', async () => {
    await expect(encryptData('', derivedKey)).resolves.toBe('');
    await expect(decryptData('', derivedKey)).resolves.toBe('');
  });

  it('self round-trip incl. unicode payload', async () => {
    const plain = 'Caffè & cornetto àèìòù — 日本語 emoji 🍩 123'.repeat(20);
    const blob = await encryptData(plain, derivedKey);
    expect(blob).not.toBe(plain);
    await expect(decryptData(blob, derivedKey)).resolves.toBe(plain);
  });
});
