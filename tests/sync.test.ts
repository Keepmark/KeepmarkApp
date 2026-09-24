import { describe, expect, it } from 'vitest';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import { createNewSync, pullExistingSync, pushBookmarks, type SyncDeps } from '../src/shared/sync';
import type { XSyncApiClient } from '../src/shared/api';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import { makeMockApi } from './firefox-bookmarks.test';

function makeDeps(api: Partial<XSyncApiClient>, syncToolbar = true): { deps: SyncDeps; store: Store } {
  const store = new Store(new MemoryBackend());
  const deps: SyncDeps = {
    api: api as XSyncApiClient,
    store,
    bookmarksApi: makeMockApi(),
    idMapper: new BookmarkIdMapper(store),
    log: new InMemoryLogger(),
    syncToolbar,
  };
  return { deps, store };
}

describe('first-sync flows', () => {
  it('createNewSync uploads the native tree and stores credentials', async () => {
    const password = 'correct horse battery staple';
    const { deps, store } = makeDeps({
      createSync: async () => ({ id: 'new-id', lastUpdated: 't0', version: SyncClientVersion }),
      updateBookmarks: async () => ({ lastUpdated: 't1' }),
    });
    await deps.bookmarksApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });

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
    const { deps, store } = makeDeps({
      getVersion: async () => ({ version: SyncClientVersion }),
      getBookmarks: async () => ({ bookmarks: blob, version: SyncClientVersion, lastUpdated: 't9' }),
    });

    const res = await pullExistingSync(deps, syncId, password);
    expect(res.updateRemote).toBe(true); // Menu/Toolbar containers added
    expect(res.lastUpdated).toBe('t9');
    const children = await deps.bookmarksApi.getChildren('unfiled_____');
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
