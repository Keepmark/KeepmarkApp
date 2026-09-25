// Live E2E: real KeepmarkApp client (XSyncApiClient + sync flows + background
// core) against a real KeepmarkApi. Guarded by KEEPMARK_E2E_URL so the default
// suite stays offline-green. Run with:
//   KEEPMARK_E2E_URL=http://localhost:8090 npm test -- tests/e2e-live.test.ts
// Requires a raised DailyNewSyncsLimit (each lifecycle creates 1-2 syncs).
import { describe, expect, it } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import { decryptData, deriveKey } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import {
  DataOutOfSyncException,
  InvalidCredentialsException,
  SyncNotFoundException,
} from '../src/shared/errors';
import { InMemoryLogger } from '../src/shared/logging';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import {
  checkServiceV12,
  createNewSync,
  deleteRemoteSync,
  getStoredHash,
  getStoredRevision,
  pullExistingSync,
  pushBookmarks,
  v12Usable,
  type SyncDeps,
} from '../src/shared/sync';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { BackgroundCore, type CorePorts } from '../src/background/core';
import { MessageCommand } from '../src/shared/messages';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getNativeBookmarksAsBookmarks,
} from '../src/firefox/bookmarks';
import { makeMockApi } from './firefox-bookmarks.test';

const URL = process.env.KEEPMARK_E2E_URL ?? '';
const live = describe.skipIf(!URL);
const PW = (tag: string): string => `e2e live ${tag} ${Date.now()}`;

function liveApi(): XSyncApiClient {
  return new XSyncApiClient(URL, new InMemoryLogger());
}

function makeDeps(api: XSyncApiClient): { deps: SyncDeps; store: Store; mockApi: ReturnType<typeof makeMockApi> } {
  const store = new Store(new MemoryBackend());
  const mockApi = makeMockApi();
  const deps: SyncDeps = {
    api,
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
    syncToolbar: true,
  };
  return { deps, store, mockApi };
}

function stubPorts(): CorePorts {
  const noop = { add: (): void => undefined, remove: (): void => undefined };
  return {
    alarms: { schedule: async () => undefined, clear: async () => undefined, once: async () => undefined, onAlarm: () => undefined },
    listeners: { created: noop, changed: noop, removed: noop, moved: noop },
    chrome: { setBadge: async () => undefined, notify: async () => undefined, download: async () => undefined },
  };
}

live('e2e probe', () => {
  it('advertises v1.2 on the extended contract, frozen shape on legacy', async () => {
    const api = liveApi();
    expect(await api.supportsV12()).toBe(true);
    const legacy = await api.getInfo();
    expect(legacy.capabilities).toBeUndefined();
    expect(legacy.version).toBe('1.2.0');
    const v12 = await api.checkServiceV12();
    expect(v12.capabilities?.revision).toBe(true);
    const svc = await checkServiceV12(api, new InMemoryLogger());
    expect(svc.version).toBe('1.2.0');
  });
});

live('e2e v1.2 link lifecycle', () => {
  it('create -> 304 -> push -> stale 409 -> delete -> gone', async () => {
    const api = liveApi();
    const { deps, store, mockApi } = makeDeps(api);
    const password = PW('lifecycle');
    await mockApi.create({ parentId: 'unfiled_____', title: 'Live', url: 'https://live.test' });

    const { id } = await createNewSync(deps, password, URL, true);
    const info = await store.get<{ id: string; password: string; supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(v12Usable(info)).toBe(true);
    const rev = await getStoredRevision(store);
    expect(rev).toBeGreaterThan(0);
    const hash = await getStoredHash(store);
    expect(hash).toHaveLength(64);

    // Same content: conditional GET short-circuits.
    expect(await api.getBookmarksIfChanged(id, hash!)).toBeNull();

    // Revision push advances; a stale base loses honestly.
    const derived = await deriveKey(password, id, SyncClientVersion);
    const tree = [{ id: 1, title: '[xbs] Other', children: [{ id: 2, title: 'Two', url: 'https://two.test' }] }];
    const next = await pushBookmarks(api, store, id, derived, tree as never, false, rev);
    expect(next).toBeTruthy();
    expect(await getStoredRevision(store)).toBe((rev as number) + 1);
    await expect(pushBookmarks(api, store, id, derived, tree as never, false, rev)).rejects.toBeInstanceOf(
      DataOutOfSyncException,
    );

    // Pull the winning tree back through the public flow.
    const pulled = await pullExistingSync(deps, id, password, URL, true);
    expect(JSON.stringify(pulled.bookmarks)).toContain('https://two.test');

    await deleteRemoteSync(api, id);
    await expect(api.getBookmarksV12(id)).rejects.toBeInstanceOf(SyncNotFoundException);
  });
});

live('e2e legacy path on the v1.2 server', () => {
  it('links without meta; the delete gate stays client-side', async () => {
    const api = liveApi();
    const { deps, store, mockApi } = makeDeps(api);
    await mockApi.create({ parentId: 'unfiled_____', title: 'Legacy', url: 'https://legacy.test' });
    const { id } = await createNewSync(deps, PW('legacy'), URL, false);
    expect(await getStoredRevision(store)).toBeUndefined();
    const info = await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(info?.supportsV12).toBe(false);
    // The v1.2-only UI stays gated off for this link…
    expect(v12Usable(info)).toBe(false);
    // …while the wire call itself carries Accept-Version 1.2.0, so a v1.2
    // server honors it. A legacy server would answer 412 here (unit-covered).
    await deleteRemoteSync(api, id);
    await expect(api.getBookmarks(id)).rejects.toBeInstanceOf(SyncNotFoundException);
  });
});

live('e2e background core', () => {
  it('connect -> wrong current rejected -> change -> server delete unlinks', async () => {
    const log = new InMemoryLogger();
    const store = new Store(new MemoryBackend());
    const mockApi = makeMockApi();
    await mockApi.create({ parentId: 'unfiled_____', title: 'Core', url: 'https://core.test' });
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      log,
      makeFirefoxAdapter(mockApi),
      stubPorts(),
      (url) => new XSyncApiClient(url, log),
      {},
    );
    const password = PW('core');
    const { id } = (await core.handleMessage({
      command: MessageCommand.ConnectNew,
      serviceUrl: URL,
      password,
    })) as { id: string };
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      syncEnabled: boolean;
      supportsV12?: boolean;
      serviceVersion?: string;
    };
    expect(status.syncEnabled).toBe(true);
    expect(status.supportsV12).toBe(true);
    expect(status.serviceVersion).toBe('1.2.0');

    await expect(
      core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: 'wrong', newPassword: 'x' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);

    const next = `e2e rotated ${Date.now()}`;
    await core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: password, newPassword: next });
    const blob = await store.get<string>(StoreKey.Bookmarks);
    const newDerived = await deriveKey(next, id, SyncClientVersion);
    expect(JSON.parse(await decryptData(blob!, newDerived))).toBeTruthy();

    await core.handleMessage({ command: MessageCommand.DeleteRemoteSync });
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    await expect(liveApi().getBookmarksV12(id)).rejects.toBeInstanceOf(SyncNotFoundException);
  });
});
