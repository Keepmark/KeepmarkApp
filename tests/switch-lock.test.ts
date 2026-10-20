// Switch lock: the short password that gates multi-sync activation.
// One random vault key wraps every row's derived key; the password wraps the
// vault. These tests pin the contract the background relies on: wrong password
// is a distinct error, a password change keeps the same vault (rows untouched),
// and a reset mints a brand-new vault (old rows can no longer be opened).

import { describe, expect, it } from 'vitest';
import { deriveKey } from '../src/shared/crypto';
import { InvalidSwitchPasswordException } from '../src/shared/errors';
import { SyncClientVersion } from '../src/shared/constants';
import {
  changeSwitchLockPassword,
  createSwitchLock,
  isSwitchLock,
  SwitchLockIterations,
  SwitchLockKeyLength,
  SwitchLockSaltLength,
  SwitchLockVersion,
  unlockSwitchLock,
  unwrapCredential,
  wrapCredential,
} from '../src/shared/switch-lock';

const syncKey = (): Promise<string> => deriveKey('sync password', 'sync-id', SyncClientVersion);

describe('switch lock', () => {
  it('creates a well-formed lock and unlocks with the same password', async () => {
    const { lock } = await createSwitchLock('1234');
    expect(lock.v).toBe(SwitchLockVersion);
    expect(lock.iterations).toBe(SwitchLockIterations);
    expect(lock.vault.iv).toBeTruthy();
    expect(lock.vault.ct).toBeTruthy();
    expect(isSwitchLock(lock)).toBe(true);
    // The password is never persisted, not even a hash of it.
    expect(JSON.stringify(lock)).not.toContain('1234');
    await expect(unlockSwitchLock(lock, '1234')).resolves.toBeDefined();
  });

  it('rejects a wrong password with its own exception (UI says so)', async () => {
    const { lock } = await createSwitchLock('1234');
    await expect(unlockSwitchLock(lock, '12345')).rejects.toBeInstanceOf(InvalidSwitchPasswordException);
    await expect(unlockSwitchLock(lock, '')).rejects.toBeInstanceOf(InvalidSwitchPasswordException);
    await expect(unlockSwitchLock(lock, '1234 ')).rejects.toBeInstanceOf(InvalidSwitchPasswordException);
  });

  it('accepts PINs of any length (no policy on the secret itself)', async () => {
    for (const password of ['1', '12', '0', 'a', '   ', 'p'.repeat(200)]) {
      const { lock } = await createSwitchLock(password);
      await expect(unlockSwitchLock(lock, password)).resolves.toBeDefined();
    }
  });

  it('produces a different salt and vault every time, even with the same password', async () => {
    const a = await createSwitchLock('same');
    const b = await createSwitchLock('same');
    expect(a.lock.salt).not.toBe(b.lock.salt);
    expect(a.lock.vault.ct).not.toBe(b.lock.vault.ct);
    expect(a.lock.salt).toHaveLength(Math.ceil(SwitchLockSaltLength / 3) * 4);
  });

  it('wraps a sync key so only the vault key can read it back', async () => {
    const key = await syncKey();
    const { lock, vaultKey } = await createSwitchLock('pin');
    const credential = await wrapCredential(vaultKey, key);
    expect(credential.iv).toBeTruthy();
    expect(credential.ct).not.toContain(key);
    // A fresh unlock (as after a background restart) reads the same key.
    const reopened = await unlockSwitchLock(lock, 'pin');
    expect(await unwrapCredential(reopened, credential)).toBe(key);
    // A different vault cannot open it.
    const other = await createSwitchLock('pin');
    await expect(unwrapCredential(other.vaultKey, credential)).rejects.toThrow();
  });

  it('refuses a key that is not 32 bytes', async () => {
    const { vaultKey } = await createSwitchLock('pin');
    await expect(wrapCredential(vaultKey, btoa('short'))).rejects.toThrow();
    expect(SwitchLockKeyLength).toBe(32);
  });

  it('changing the password keeps the vault: rows need no rewrap', async () => {
    const key = await syncKey();
    const first = await createSwitchLock('1111');
    const credential = await wrapCredential(first.vaultKey, key);

    const changed = await changeSwitchLockPassword(first.lock, '1111', '2222');
    // Same password key for the rows still opens the untouched credential.
    expect(await unwrapCredential(changed.vaultKey, credential)).toBe(key);
    // Old password no longer unlocks; the new one does.
    await expect(unlockSwitchLock(changed.lock, '1111')).rejects.toBeInstanceOf(
      InvalidSwitchPasswordException,
    );
    const reopened = await unlockSwitchLock(changed.lock, '2222');
    expect(await unwrapCredential(reopened, credential)).toBe(key);
  });

  it('changing with a wrong current password changes nothing', async () => {
    const { lock } = await createSwitchLock('1111');
    await expect(changeSwitchLockPassword(lock, '0000', '2222')).rejects.toBeInstanceOf(
      InvalidSwitchPasswordException,
    );
  });

  it('a reset-style new lock cannot open credentials of the old vault', async () => {
    const key = await syncKey();
    const old = await createSwitchLock('1111');
    const credential = await wrapCredential(old.vaultKey, key);
    const reset = await createSwitchLock('3333');
    await expect(unwrapCredential(reset.vaultKey, credential)).rejects.toThrow(/key|cannot|open/i);
    expect(await unwrapCredential(reset.vaultKey, await wrapCredential(reset.vaultKey, key))).toBe(key);
  });

  it('isSwitchLock rejects edited storage instead of trusting it', () => {
    const base = {
      v: SwitchLockVersion,
      salt: 'AAAA',
      iterations: SwitchLockIterations,
      vault: { iv: 'BBBB', ct: 'CCCC' },
      setAt: '2026-10-20T00:00:00.000Z',
    };
    expect(isSwitchLock(base)).toBe(true);
    expect(isSwitchLock(null)).toBe(false);
    expect(isSwitchLock('lock')).toBe(false);
    expect(isSwitchLock({ ...base, v: 2 })).toBe(false);
    expect(isSwitchLock({ ...base, salt: '' })).toBe(false);
    expect(isSwitchLock({ ...base, iterations: 0 })).toBe(false);
    expect(isSwitchLock({ ...base, vault: { iv: 'x' } })).toBe(false);
    expect(isSwitchLock({ ...base, setAt: 3 })).toBe(false);
  });
});
