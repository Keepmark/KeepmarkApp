// AES-GCM envelope compatible with the original JS client (app/crypto.service.ts)
// and Keepmark XCryptoService: PBKDF2-SHA256/250k -> AES-GCM-256, 16-byte IV
// prepended to ciphertext, lzutf8 compress before encrypt, base64 on the wire.
// Port intentionally async (WebCrypto) — same bytes as Keepmark blobs.

import lzutf8 from 'lzutf8';
import { GcmNonceLength, KeyDerivationIterations } from './constants.js';
import {
  IncompleteSyncInfoException,
  InvalidCredentialsException,
  UnsupportedSyncVersionException,
} from './errors.js';

const enc = new TextEncoder();
const dec = new TextDecoder(undefined, { fatal: true });

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error('WebCrypto subtle is not available in this context.');
  return c;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  // atob is available in browsers, workers and Node >= 16.
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(bin);
}

/**
 * Mirrors getPasswordHash(password, syncId): PBKDF2-SHA256, 250k, salt = sync ID.
 * Legacy syncs without a version are rejected (open once in the original client).
 */
export async function deriveKey(password: string, syncId: string, syncVersion?: string): Promise<string> {
  if (!syncVersion) {
    throw new UnsupportedSyncVersionException(
      'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
    );
  }
  if (!password || !syncId) {
    throw new IncompleteSyncInfoException('Password and sync ID are required to derive the sync key.');
  }
  const imported = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const derived = await subtle().deriveKey(
    { name: 'PBKDF2', salt: enc.encode(syncId), iterations: KeyDerivationIterations, hash: 'SHA-256' },
    imported,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await subtle().exportKey('raw', derived);
  return bytesToBase64(new Uint8Array(raw));
}

export async function encryptData(plain: string, derivedKeyB64: string): Promise<string> {
  if (!plain) return '';
  try {
    const keyBytes = base64ToBytes(derivedKeyB64);
    if (keyBytes.length !== 32) {
      throw new IncompleteSyncInfoException('Stored sync key is corrupt (expected 32 bytes). Relink the sync.');
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(GcmNonceLength));
    const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const compressed = lzutf8.compress(plain) as Uint8Array;
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, compressed as BufferSource);
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), iv.length);
    return bytesToBase64(combined);
  } catch (err) {
    if (err instanceof IncompleteSyncInfoException) throw err;
    throw new InvalidCredentialsException('Encryption failed.', { cause: err });
  }
}

export async function decryptData(blob: string, derivedKeyB64: string): Promise<string> {
  if (!blob) return '';
  try {
    const keyBytes = base64ToBytes(derivedKeyB64);
    const combined = base64ToBytes(blob);
    // 16B nonce + 16B GCM tag + >= 1B payload, mirrors Keepmark length guard.
    if (combined.length < GcmNonceLength + 16 + 1) {
      throw new InvalidCredentialsException('Invalid credentials.');
    }
    const iv = combined.slice(0, GcmNonceLength);
    const ct = combined.slice(GcmNonceLength);
    const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct as BufferSource);
    return lzutf8.decompress(new Uint8Array(pt)) as string;
  } catch (err) {
    if (err instanceof InvalidCredentialsException) throw err;
    throw new InvalidCredentialsException('Invalid credentials.', { cause: err });
  }
}
