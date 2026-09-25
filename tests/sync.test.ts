import { describe, expect, it } from 'vitest';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import {
  createNewSync,
  deleteRemoteSync,
  getStoredHash,
  getStoredRevision,
  persistMeta,
  pullExistingSync,
  pushBookmarks,
  v12Usable,
  type SyncDeps,
} from '../src/shared/sync';
import { UnsupportedVersionException } from '../src/shared/errors';
import type { XSyncApiClient } from '../src/shared/api';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getNativeBookmarksAsBookmarks,
} from '../src/firefox/bookmarks';
import { makeMockApi } from './firefox-bookmarks.test';

type MockBookmarksApi = ReturnType<typeof makeMockApi>;

function makeDeps(
  api: Partial<XSyncApiClient>,
  syncToolbar = true,
): { deps: SyncDeps; store: Store; mockApi: MockBookmarksApi } {
  const store = new Store(new MemoryBackend());
  const mockApi = makeMockApi();
  const deps: SyncDeps = {
    api: api as XSyncApiClient,
    store,
    native: {
      readAll: (t) => getNativeBookmarksAsBookmarks(mockApi, t),
      clearAndPopulate: async (b, t) => {
        await clearNativeBookmarks(mockApi, t);
        await createNativeBookmarksFromBookmarks(mockApi, b, t);
      },
      rebuildMappings: (b, t) => buildIdMappings(mockApi, b, t),
    },
    idMapper: new BookmarkIdMapper(store),
    log: new InMemoryLogger(),
    syncToolbar,
  };
  return { deps, store, mockApi };
}

describe('first-sync flows', () => {
  it('createNewSync uploads the native tree and stores credentials', async () => {
    const password = 'correct horse battery staple';
    const { deps, store, mockApi } = makeDeps({
      createSync: async () => ({ id: 'new-id', lastUpdated: 't0', version: SyncClientVersion }),
      updateBookmarks: async () => ({ lastUpdated: 't1' }),
    });
    await mockApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });

    const { id } = await createNewSync(deps, password);
    expect(id).toBe('new-id');
    expect(await store.get(StoreKey.SyncEnabled)).toBe(true);
    expect(await store.get<string>(StoreKey.LastUpdated)).toBe('t1');
    const info = await store.get<{ id: string; password: string }>(StoreKey.SyncInfo);
    expect(info!.id).toBe('new-id');
    expect(info!.password).toBe(await deriveKey(password, 'new-id', SyncClientVersion));
    expect(await deps.idMapper.all()).toHaveLength(1);
  });

  it('pullExistingSync populates native containers and stores state', async () => {
    const password = 'pw';
    const syncId = 'existing-id';
    const derived = await deriveKey(password, syncId, SyncClientVersion);
    const remote = [{ id: 1, title: '[xbs] Other', children: [{ id: 2, title: 'R', url: 'https://r.test' }] }];
    const blob = await encryptData(JSON.stringify(remote), derived);
    const { deps, store, mockApi } = makeDeps({
      getVersion: async () => ({ version: SyncClientVersion }),
      getBookmarks: async () => ({ bookmarks: blob, version: SyncClientVersion, lastUpdated: 't9' }),
    });

    const res = await pullExistingSync(deps, syncId, password);
    expect(res.updateRemote).toBe(true); // Menu/Toolbar containers added
    expect(res.lastUpdated).toBe('t9');
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('R');
    expect(await store.get(StoreKey.SyncEnabled)).toBe(true);
  });

  it('pull rejects newer remote versions', async () => {
    const { deps } = makeDeps({ getVersion: async () => ({ version: '99.0.0' }) });
    await expect(pullExistingSync(deps, 'id', 'pw')).rejects.toThrow(/newer than this client/);
  });

  it('pushBookmarks encrypts and advances lastUpdated', async () => {
    const derived = await deriveKey('pw', 'sid', SyncClientVersion);
    const { deps, store } = makeDeps({
      updateBookmarks: async (_id: string, _blob: string, lastUpdated: string) => ({
        lastUpdated: `${lastUpdated}+1`,
      }),
    });
    await store.set(StoreKey.LastUpdated, 't0');
    const next = await pushBookmarks(
      deps.api,
      store,
      'sid',
      derived,
      [{ id: 1, title: '[xbs] Other', children: [] }],
    );
    expect(next).toBe('t0+1');
    expect(await store.get(StoreKey.LastUpdated)).toBe('t0+1');
  });
});

describe('v1.2 sync paths', () => {
  it('createNewSync v12 stores revision/hash and the capability flag', async () => {
    const { deps, store, mockApi } = makeDeps({
      createSyncV12: async () => ({ id: 'v12-id', lastUpdated: 't0', version: SyncClientVersion, meta: { revision: 1, hash: 'h1' } }),
      updateBookmarksV12: async (_id: string, _blob: string, base: number) => {
        expect(base).toBe(1); // revision CAS seeded from the create meta
        return { lastUpdated: 't1', meta: { revision: 2, hash: 'h2' } };
      },
    });
    await mockApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });

    const { id } = await createNewSync(deps, 'correct horse battery staple', 'https://x.test/', true);
    expect(id).toBe('v12-id');
    expect(await getStoredRevision(store)).toBe(2);
    expect(await getStoredHash(store)).toBe('h2');
    const info = await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(info?.supportsV12).toBe(true);
  });

  it('createNewSync legacy stores no revision and flags v1.1', async () => {
    const { deps, store, mockApi } = makeDeps({
      createSync: async () => ({ id: 'old-id', lastUpdated: 't0', version: SyncClientVersion }),
      updateBookmarks: async () => ({ lastUpdated: 't1' }),
    });
    await mockApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });

    await createNewSync(deps, 'correct horse battery staple', 'https://x.test/', false);
    expect(await getStoredRevision(store)).toBeUndefined();
    expect(await getStoredHash(store)).toBeUndefined();
    const info = await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(info?.supportsV12).toBe(false);
  });

  it('pushBookmarks with a baseRevision uses revision CAS and persists meta', async () => {
    const derived = await deriveKey('pw', 'sid', SyncClientVersion);
    const { deps, store } = makeDeps({
      updateBookmarksV12: async (_id: string, _blob: string, base: number) => {
        expect(base).toBe(7);
        return { lastUpdated: 't8', meta: { revision: 8, hash: 'h8' } };
      },
    });
    await store.set(StoreKey.LastUpdated, 't7');
    const next = await pushBookmarks(deps.api, store, 'sid', derived, [], false, 7);
    expect(next).toBe('t8');
    expect(await getStoredRevision(store)).toBe(8);
    expect(await getStoredHash(store)).toBe('h8');
  });

  it('legacy push clears stale revision/hash (downgrade safety)', async () => {
    const derived = await deriveKey('pw', 'sid', SyncClientVersion);
    const { deps, store } = makeDeps({
      updateBookmarks: async () => ({ lastUpdated: 't9' }),
    });
    await store.set(StoreKey.LastUpdated, 't8');
    await store.set(StoreKey.SyncRevision, 8);
    await store.set(StoreKey.SyncHash, 'h8');
    await pushBookmarks(deps.api, store, 'sid', derived, []);
    expect(await getStoredRevision(store)).toBeUndefined();
    expect(await getStoredHash(store)).toBeUndefined();
  });

  it('persistMeta keeps zero revisions (pre-v1.2 syncs start at 0)', async () => {
    const { store } = makeDeps({});
    await persistMeta(store, { revision: 0, hash: undefined });
    expect(await getStoredRevision(store)).toBe(0);
    expect(await getStoredHash(store)).toBeUndefined();
    await persistMeta(store, undefined);
    expect(await getStoredRevision(store)).toBeUndefined();
  });

  it('pullExistingSync v12 reads the extended shape, 412 falls back to legacy', async () => {
    const password = 'pw';
    const syncId = 'v12-pull';
    const derived = await deriveKey(password, syncId, SyncClientVersion);
    const remote = [{ id: 1, title: '[xbs] Other', children: [{ id: 2, title: 'R', url: 'https://r.test' }] }];
    const blob = await encryptData(JSON.stringify(remote), derived);
    const { deps, store } = makeDeps({
      getVersion: async () => ({ version: SyncClientVersion }),
      getBookmarksV12: async () => ({ bookmarks: blob, version: SyncClientVersion, lastUpdated: 't9', meta: { revision: 4, hash: 'h4' } }),
      getBookmarks: async () => {
        throw new Error('legacy GET must not run on a v1.2 link');
      },
    });
    await pullExistingSync(deps, syncId, password, 'https://x.test/', true);
    expect(await getStoredRevision(store)).toBe(4);
    expect((await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(true);

    const fb = makeDeps({
      getVersion: async () => ({ version: SyncClientVersion }),
      getBookmarksV12: async () => {
        throw new UnsupportedVersionException('downgraded');
      },
      getBookmarks: async () => ({ bookmarks: blob, version: SyncClientVersion, lastUpdated: 't9' }),
    });
    await pullExistingSync(fb.deps, syncId, password, 'https://x.test/', true);
    expect(await getStoredRevision(fb.store)).toBeUndefined();
    expect((await fb.store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(false);
  });

  it('deleteRemoteSync performs the DELETE and renames a 412 honestly', async () => {
    let deleted: string | undefined;
    const { deps } = makeDeps({
      deleteBookmarks: async (id: string) => {
        deleted = id;
      },
    });
    await deleteRemoteSync(deps.api, 'gone-id');
    expect(deleted).toBe('gone-id');

    const legacy = makeDeps({
      deleteBookmarks: async () => {
        throw new UnsupportedVersionException('x');
      },
    });
    const err: unknown = await deleteRemoteSync(legacy.deps.api, 'gone-id').catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnsupportedVersionException);
    expect((err as Error).message).toBe('Not supported (requires service v1.2).');
  });

  it('v12Usable is true only for linked v1.2 services', () => {
    expect(v12Usable(undefined)).toBe(false);
    expect(v12Usable({})).toBe(false);
    expect(v12Usable({ id: 'x' })).toBe(false);
    expect(v12Usable({ id: 'x', supportsV12: false })).toBe(false);
    expect(v12Usable({ id: 'x', supportsV12: true })).toBe(true);
  });
});
