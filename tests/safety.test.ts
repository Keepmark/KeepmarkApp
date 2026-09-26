import { describe, expect, it } from 'vitest';
import { SyncClientVersion } from '../src/shared/constants';
import { deriveKey } from '../src/shared/crypto';
import type { BookmarkNode } from '../src/shared/models';
import { MemoryBackend, safetyFileKey, Store } from '../src/shared/store';
import {
  buildFileName,
  deleteSafety,
  listSafety,
  readSafetyTree,
  rekeySafety,
  writeSafety,
} from '../src/shared/safety';

const PASSWORD = 'correct horse battery staple';
const SYNC_ID = 'safety-test-id';

const tree: BookmarkNode[] = [
  { title: '[xbs] Other', children: [{ id: 1, title: 'A', url: 'https://a.test' }] },
];

async function linked() {
  const store = new Store(new MemoryBackend());
  const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
  return { store, derived };
}

describe('safety backups', () => {
  it('builds timestamped operation names', () => {
    expect(buildFileName('take-remote', new Date('2026-09-27T12:00:00Z'))).toBe(
      'safety-20260927-120000-take-remote.json',
    );
  });

  it('round-trips an encrypted snapshot with truncated sync id', async () => {
    const { store, derived } = await linked();
    const entry = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree: structuredClone(tree),
      syncId: SYNC_ID,
      derivedKey: derived,
    });
    expect(entry.fileName).toMatch(/^safety-.*-take-remote\.json$/);
    expect(entry.items).toBe(2);
    expect(entry.enc).toBe('derived');
    expect(entry.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(entry.syncId).not.toBe(SYNC_ID);
    expect(await listSafety(store)).toHaveLength(1);
    await expect(readSafetyTree(store, entry, derived)).resolves.toEqual(tree);
  });

  it('writes plaintext pre-link snapshots flagged enc:null', async () => {
    const store = new Store(new MemoryBackend());
    const entry = await writeSafety(store, { operation: 'import-backup', side: 'local', tree });
    expect(entry.enc).toBeNull();
    await expect(readSafetyTree(store, entry)).resolves.toEqual(tree);
    // Encrypted entries refuse without a key.
    const { store: s2, derived } = await linked();
    const enc = await writeSafety(s2, { operation: 'take-remote', side: 'local', tree, derivedKey: derived });
    await expect(readSafetyTree(s2, enc)).rejects.toThrow(/relink/);
  });

  it('refuses restores under a rotated key', async () => {
    const { store, derived } = await linked();
    const entry = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree,
      syncId: SYNC_ID,
      derivedKey: derived,
    });
    const other = await deriveKey('another password here', SYNC_ID, SyncClientVersion);
    await expect(readSafetyTree(store, entry, other)).rejects.toThrow(/locked to another/);
  });

  it('prunes to the newest 5 (payload + row together)', async () => {
    const { store, derived } = await linked();
    for (let i = 0; i < 7; i++) {
      await writeSafety(store, {
        operation: 'take-remote',
        side: 'local',
        tree: [{ ...tree[0], children: [{ id: i + 1, title: `A${i}`, url: 'https://a.test' }] }],
        derivedKey: derived,
      });
    }
    const rows = await listSafety(store);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(await store.get(safetyFileKey(r.fileName))).toBeDefined();
    }
  });

  it('refuses damaged payloads and count drift', async () => {
    const { store, derived } = await linked();
    const entry = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree,
      derivedKey: derived,
    });
    await store.set(safetyFileKey(entry.fileName), { app: 'nope', format: 999 });
    await expect(readSafetyTree(store, entry, derived)).rejects.toThrow(/damaged/);
    const entry2 = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree,
      derivedKey: derived,
    });
    entry2.items = 999;
    await expect(readSafetyTree(store, entry2, derived)).rejects.toThrow(/drift/);
  });

  it('treats a corrupt index as empty and deletes rows', async () => {
    const { store, derived } = await linked();
    await store.set('safetyIndex', 'garbage' as never);
    await expect(listSafety(store)).resolves.toEqual([]);
    const entry = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree,
      derivedKey: derived,
    });
    await expect(deleteSafety(store, 'missing.json')).resolves.toBe(false);
    await expect(deleteSafety(store, entry.fileName)).resolves.toBe(true);
    await expect(listSafety(store)).resolves.toEqual([]);
    expect(await store.get(safetyFileKey(entry.fileName))).toBeUndefined();
  });

  it('rekeys entries on password change without failing', async () => {
    const { store, derived } = await linked();
    const entry = await writeSafety(store, {
      operation: 'take-remote',
      side: 'local',
      tree,
      derivedKey: derived,
    });
    const next = await deriveKey('brand new password!!', SYNC_ID, SyncClientVersion);
    const res = await rekeySafety(store, derived, next);
    expect(res).toEqual({ rekeyed: 1, skipped: [] });
    await expect(readSafetyTree(store, entry, next)).resolves.toEqual(tree);
    await expect(readSafetyTree(store, entry, derived)).rejects.toThrow(/locked to another/);
  });
});
