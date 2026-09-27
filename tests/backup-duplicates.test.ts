import { describe, expect, it } from 'vitest';
import { decryptData, deriveKey, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import { BookmarkContainer } from '../src/shared/bookmarks';
import {
  countNodes,
  exportBackup,
  importBackup,
  validateTree,
} from '../src/shared/backup';
import {
  defaultMarkedIds,
  deleteByIds,
  getDuplicateGroups,
  isSelectionLocked,
  normalizeUrl,
  planDuplicateDeletion,
} from '../src/shared/duplicates';
import { switchService } from '../src/shared/sync';
import type { XSyncApiClient } from '../src/shared/api';
import type { BookmarkNode } from '../src/shared/models';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';

const tree: BookmarkNode[] = [
  {
    title: BookmarkContainer.Other,
    children: [
      { id: 1, title: 'A', url: 'https://a.test/' },
      { id: 2, title: 'A dup', url: 'HTTPS://A.TEST' },
      { id: 3, title: 'A third', url: 'https://a.test' },
      { id: 4, title: 'B', url: 'https://b.test' },
    ],
  },
];

describe('backup envelope', () => {
  it('round-trips through export/import', async () => {
    const json = await exportBackup(tree, 'backup-password');
    const parsed = JSON.parse(json);
    // Shared family tag: readable by the Android client too.
    expect(parsed.app).toBe('xBrowserSyncNg');
    expect(parsed.format).toBe(1);
    const back = await importBackup(json, 'backup-password');
    expect(back).toEqual(tree);
  });

  it('still imports the legacy KeepmarkApp tag', async () => {
    const json = await exportBackup(tree, 'backup-password');
    const legacy = { ...JSON.parse(json), app: 'KeepmarkApp' };
    const back = await importBackup(JSON.stringify(legacy), 'backup-password');
    expect(back).toEqual(tree);
  });

  it('rejects short passwords', async () => {
    await expect(exportBackup(tree, 'short')).rejects.toThrow(/at least 8/);
    await expect(importBackup('{}', 'short')).rejects.toThrow(/at least 8/);
  });

  it('rejects wrong password and bad format', async () => {
    const json = await exportBackup(tree, 'backup-password');
    await expect(importBackup(json, 'wrong-password')).rejects.toThrow(/Wrong backup password/);
    await expect(importBackup('{"format":999}', 'backup-password')).rejects.toThrow(/Unsupported backup/);
    await expect(importBackup('not json', 'backup-password')).rejects.toThrow(/valid JSON/);
  });

  it('rejects foreign apps and corrupted payloads', async () => {
    const json = await exportBackup(tree, 'backup-password');
    const foreign = { ...JSON.parse(json), app: 'OtherApp' };
    await expect(importBackup(JSON.stringify(foreign), 'backup-password')).rejects.toThrow(/Unsupported backup/);
    // Valid envelope shape but garbage blob under the right password path:
    // craft by re-encrypting non-JSON plaintext with the same salt.
    const { salt } = JSON.parse(json);
    const { encryptData } = await import('../src/shared/crypto');
    const key = await deriveKey('backup-password', salt, SyncClientVersion);
    const badBlob = await encryptData('not-json{{{', key);
    const bad = JSON.stringify({ app: 'KeepmarkApp', format: 1, salt, blob: badBlob });
    await expect(importBackup(bad, 'backup-password')).rejects.toThrow(/corrupted/);
  });

  it('uses a fresh random salt per export', async () => {
    const a = JSON.parse(await exportBackup(tree, 'backup-password'));
    const b = JSON.parse(await exportBackup(tree, 'backup-password'));
    expect(a.salt).not.toBe(b.salt);
    expect(a.blob).not.toBe(b.blob);
  });

  it('rejects malformed nodes by type', () => {
    expect(() => validateTree([{ id: 'x' }] as never)).toThrow(/invalid id/);
    expect(() => validateTree([{ url: 123 }] as never)).toThrow(/invalid url/);
    expect(() => validateTree([{ tags: ['ok', 7] }] as never)).toThrow(/invalid tags/);
  });

  it('validateTree rejects null nodes and counts nodes', () => {
    expect(countNodes(tree)).toBe(5);
    expect(() => validateTree([null as never])).toThrow(/invalid node/);
    expect(() => validateTree('nope' as never)).toThrow(/bookmark tree/);
  });

  it('blob is opaque without the password (uses crypto envelope)', async () => {
    const json = await exportBackup(tree, 'backup-password');
    const { blob, salt } = JSON.parse(json);
    const otherKey = await deriveKey('other-password', salt, SyncClientVersion);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(decryptData(blob, otherKey)).rejects.toBeInstanceOf(InvalidCredentialsException);
    // Sanity: blob really encrypts the tree, not plaintext.
    expect(blob).not.toContain('https');
  });
});

describe('duplicates', () => {
  it('groups by normalized url, sorted by size', () => {
    const groups = getDuplicateGroups(tree);
    expect(groups).toHaveLength(1);
    expect(groups[0].url).toBe('https://a.test/');
    expect(groups[0].entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(normalizeUrl('HTTPS://X.test/')).toBe('https://x.test/');
    expect(normalizeUrl('https://x.test/?utm_source=feed#frag')).toBe('https://x.test/');
    expect(normalizeUrl('http://x.test:80/a/')).toBe('http://x.test/a');
    expect(normalizeUrl('https://x.test/a?b=1&utm_medium=x')).toBe('https://x.test/a?b=1');
  });

  it('plan locks the last copy', () => {
    const groups = getDuplicateGroups(tree);
    expect(planDuplicateDeletion(groups)).toEqual([1, 2]);
    expect(planDuplicateDeletion(groups, new Set([2, 3]))).toEqual([2]); // 3 locked
  });

  it('default selection marks all but newest; last unmarked copy locks', () => {
    const groups = getDuplicateGroups(tree);
    expect([...defaultMarkedIds(groups)].sort()).toEqual([1, 2]);
    // 3 is the lone survivor: marking it would wipe the link.
    expect(isSelectionLocked(groups, new Set([1, 2]), 3)).toBe(true);
    expect(isSelectionLocked(groups, new Set([1]), 3)).toBe(false);
    expect(isSelectionLocked(groups, new Set([1]), 2)).toBe(false);
    expect(isSelectionLocked(groups, new Set([1, 2, 3]), 3)).toBe(false); // already marked
    expect(isSelectionLocked(groups, new Set(), 999)).toBe(false); // unknown id
  });

  it('ignores separators, keeps path case, and sees top-level nodes', () => {
    expect(normalizeUrl('https://x.test/Page')).toBe('https://x.test/Page');
    const sepTree: BookmarkNode[] = [
      {
        title: BookmarkContainer.Other,
        children: [
          { id: 1, title: 'S1', url: 'xbs:separator' },
          { id: 2, title: 'S2', url: 'xbs:separator' },
          { id: 3, title: 'A', url: 'https://a.test/Page' },
          { id: 4, title: 'A lower', url: 'https://a.test/page' },
        ],
      },
    ];
    // Separators excluded; case-differing paths are distinct syncs.
    expect(getDuplicateGroups(sepTree)).toHaveLength(0);
    const topLevel: BookmarkNode[] = [
      { id: 5, title: 'T', url: 'https://t.test/' },
      { id: 6, title: 'T dup', url: 'https://t.test/' },
    ];
    expect(getDuplicateGroups(topLevel).map((g) => g.entries.map((e) => e.id))).toEqual([[5, 6]]);
    // Deletion plan uses max id even for unsorted input.
    expect(planDuplicateDeletion([{ url: 'u', entries: [{ id: 9, path: '' }, { id: 7, path: '' }] }])).toEqual([7]);
    expect(planDuplicateDeletion([{ url: 'u', entries: [] }])).toEqual([]);
  });

  it('deleteByIds removes a new tree', () => {
    const out = deleteByIds(tree, new Set([1, 2]));
    expect(out[0].children!.map((b) => b.id)).toEqual([3, 4]);
    expect(tree[0].children).toHaveLength(4); // input untouched
  });

  it('keeps legit params and rejects over-deep trees', () => {
    expect(normalizeUrl('https://x.test/?mcfitting=1')).toBe('https://x.test/?mcfitting=1');
    expect(normalizeUrl('https://x.test/?mc_cid=1&a=2')).toBe('https://x.test/?a=2');
    // Build a 1005-deep chain (over the 1000 nesting limit).
    const chain: BookmarkNode[] = [];
    let cur: BookmarkNode = { id: 1, title: 'd1' };
    chain.push(cur);
    for (let i = 2; i <= 1005; i++) {
      const next: BookmarkNode = { id: i, title: `d${i}` };
      cur.children = [next];
      cur = next;
    }
    expect(() => validateTree(chain)).toThrow(/nesting/);
    expect(() => validateTree([{ ...chain[0], children: [] }])).not.toThrow();
  });
});

describe('switchService', () => {
  it('creates on the new service and uploads the tree', async () => {
    const seen: { blob: string } = { blob: '' };
    const newApi = {
      createSync: async () => ({ id: 'moved-id', lastUpdated: 'm0', version: SyncClientVersion }),
      updateBookmarks: async (_id: string, blob: string, _lu: string, _v: boolean) => {
        seen.blob = blob;
        return { lastUpdated: 'm1' };
      },
    } as unknown as XSyncApiClient;
    const store = new Store(new MemoryBackend());
    const { id } = await switchService(newApi, store, tree, 'new-password', 'https://new.example/');
    expect(id).toBe('moved-id');
    const info = await store.get<{ id: string; serviceUrl: string }>(StoreKey.SyncInfo);
    expect(info).toMatchObject({ id: 'moved-id', serviceUrl: 'https://new.example/' });
    const derived = await deriveKey('new-password', 'moved-id', SyncClientVersion);
    expect(JSON.parse(await decryptData(seen.blob, derived))).toEqual(tree);
    expect(await encryptData(JSON.stringify(tree), derived)).not.toBe('');
  });
});
