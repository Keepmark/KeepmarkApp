// Switch lock: the short password that gates multi-sync activation.
//
// One random vault key wraps the derived key of every dormant sync; the vault
// key is itself wrapped with a PBKDF2 key derived from the short password. So:
// - unlocking once gives access to every row's key without rewrapping them;
// - changing the password rewraps only the vault (rows stay untouched);
// - losing the password means the wrapped row keys are gone, which is why the
//   reset mints a fresh vault and keeps only the active sync (its key lives in
//   StoreKey.SyncInfo, not here).
//
// Same envelope as every other blob: AES-GCM-256, 16-byte IV prepended, base64.
// Pure + WebCrypto, no DOM and no storage: safe in the MV3 worker and testable.

import { GcmNonceLength } from './constants.js';
import { base64ToBytes, bytesToBase64 } from './crypto.js';
import {
  IncompleteSyncInfoException,
  InvalidSwitchPasswordException,
  UnexpectedResponseException,
} from './errors.js';
import { t } from './i18n.js';

export const SwitchLockVersion = 1 as const;
export const SwitchLockIterations = 200_000;
export const SwitchLockSaltLength = 16;
export const SwitchLockKeyLength = 32;

/** AES-GCM blob with the IV kept beside the ciphertext (base64 both). */
export interface WrappedSecret {
  iv: string;
  ct: string;
}

/** Persisted in StoreKey.SwitchLock. Never contains the password. */
export interface SwitchLock {
  v: typeof SwitchLockVersion;
  salt: string;
  iterations: number;
  /** Random 32-byte vault key, wrapped with the password-derived key. */
  vault: WrappedSecret;
  setAt: string;
}

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error('WebCrypto subtle is not available in this context.');
  return c;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const imported = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    imported,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, bytes: Uint8Array): Promise<WrappedSecret> {
  const iv = randomBytes(GcmNonceLength);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes as BufferSource);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

async function open(key: CryptoKey, secret: WrappedSecret): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(secret.iv) },
    key,
    base64ToBytes(secret.ct),
  );
  return new Uint8Array(pt);
}

async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== SwitchLockKeyLength) throw new Error('Invalid vault key length.');
  return subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** True for a well-formed persisted lock (storage can be edited by hand). */
export function isSwitchLock(value: unknown): value is SwitchLock {
  if (!value || typeof value !== 'object') return false;
  const lock = value as Partial<SwitchLock>;
  return (
    lock.v === SwitchLockVersion &&
    typeof lock.salt === 'string' &&
    !!lock.salt &&
    typeof lock.iterations === 'number' &&
    lock.iterations > 0 &&
    !!lock.vault &&
    typeof lock.vault === 'object' &&
    typeof lock.vault.iv === 'string' &&
    typeof lock.vault.ct === 'string' &&
    typeof lock.setAt === 'string'
  );
}

/** A new lock (new salt, new vault key) for `password`. */
export async function createSwitchLock(
  password: string,
): Promise<{ lock: SwitchLock; vaultKey: CryptoKey }> {
  const salt = randomBytes(SwitchLockSaltLength);
  const vaultRaw = randomBytes(SwitchLockKeyLength);
  const passwordKey = await derivePasswordKey(password, salt, SwitchLockIterations);
  return {
    lock: {
      v: SwitchLockVersion,
      salt: bytesToBase64(salt),
      iterations: SwitchLockIterations,
      vault: await seal(passwordKey, vaultRaw),
      setAt: new Date().toISOString(),
    },
    vaultKey: await importVaultKey(vaultRaw),
  };
}

/**
 * Derive the vault key from `password`. A wrapped key that does not open means
 * a wrong password (or a damaged lock): both are reported the same way, since
 * the user cannot act differently.
 */
export async function unlockSwitchLock(lock: SwitchLock, password: string): Promise<CryptoKey> {
  try {
    const passwordKey = await derivePasswordKey(
      password,
      base64ToBytes(lock.salt),
      lock.iterations,
    );
    return await importVaultKey(await open(passwordKey, lock.vault));
  } catch {
    throw new InvalidSwitchPasswordException(t('core.switchWrongPassword'));
  }
}

/** Re-wrap the same vault key under a new password: rows need no rewrap. */
export async function changeSwitchLockPassword(
  lock: SwitchLock,
  currentPassword: string,
  nextPassword: string,
): Promise<{ lock: SwitchLock; vaultKey: CryptoKey }> {
  let vaultRaw: Uint8Array;
  try {
    vaultRaw = await open(
      await derivePasswordKey(currentPassword, base64ToBytes(lock.salt), lock.iterations),
      lock.vault,
    );
  } catch {
    throw new InvalidSwitchPasswordException(t('core.switchWrongPassword'));
  }
  const salt = randomBytes(SwitchLockSaltLength);
  return {
    lock: {
      v: SwitchLockVersion,
      salt: bytesToBase64(salt),
      iterations: lock.iterations,
      vault: await seal(await derivePasswordKey(nextPassword, salt, lock.iterations), vaultRaw),
      setAt: new Date().toISOString(),
    },
    vaultKey: await importVaultKey(vaultRaw),
  };
}

/** Wrap one sync's derived key (base64, 32 bytes) under the vault key. */
export async function wrapCredential(
  vaultKey: CryptoKey,
  derivedKeyB64: string,
): Promise<WrappedSecret> {
  const raw = base64ToBytes(derivedKeyB64);
  if (raw.length !== SwitchLockKeyLength) {
    throw new IncompleteSyncInfoException(t('err.storedKeyCorrupt'));
  }
  return seal(vaultKey, raw);
}

/** Read a row's derived key back. A failure means the row and the vault do not
 *  belong together (stale credential after a reset, edited storage): honest
 *  error, never a silent wrong key. */
export async function unwrapCredential(
  vaultKey: CryptoKey,
  credential: WrappedSecret,
): Promise<string> {
  try {
    const raw = await open(vaultKey, credential);
    if (raw.length !== SwitchLockKeyLength) throw new Error('Invalid credential length.');
    return bytesToBase64(raw);
  } catch {
    throw new UnexpectedResponseException(t('core.savedCredentialUnreadable'));
  }
}
