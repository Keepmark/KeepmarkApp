import { describe, expect, it, vi } from 'vitest';
import { BackgroundCore, NativeDebounceAlarmName, type CorePorts } from '../src/background/core';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { makeChromiumAdapter } from '../src/chromium/adapter';
import { BookmarkContainer as C } from '../src/shared/bookmarks';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand } from '../src/shared/messages';
import { reconcileContainer } from '../src/shared/reconcile';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import { makeMockApi } from './firefox-bookmarks.test';
import { makeChromiumMockApi } from './chromium-bookmarks.test';

async function setup(chromium = false) {
  const api = chromium ? makeChromiumMockApi() : makeMockApi();
  const adapter = chromium ? makeChromiumAdapter(api) : makeFirefoxAdapter(api);
  const store = new Store(new MemoryBackend());
  const mapper = new BookmarkIdMapper(store);
  const key = await deriveKey('long enough password', 'upgrade-id', '1.8.0');
  const tree = [
    { title: C.Menu, children: [] },
    { title: C.Other, children: [
      { id: 100, title: 'A', url: 'https://a.test', description: 'Keep A', tags: ['a'] },
      { id: 200, title: 'B', url: 'https://b.test', description: 'Keep B', tags: ['b'] },
    ] },
    { title: C.Toolbar, children: [{ id: 300, title: 'Remote', url: 'https://remote.test', tags: ['toolbar'] }] },
  ];
  await adapter.clearAndPopulate(tree);
  await mapper.set(await adapter.rebuildMappings(tree));
  const before = await mapper.all();
  const root = (await adapter.readContainer(C.Other));
  // Pending offline reorder: cached positions no longer describe native order.
  root.reverse();
  const parent = chromium ? '2' : 'unfiled_____';
  const [nativeOther] = await api.getSubTree(parent);
  nativeOther.children = root;
  const toolbarParent = chromium ? '1' : 'toolbar_____';
  const [nativeToolbar] = await api.getSubTree(toolbarParent);
  nativeToolbar.children![0].title = 'Stale';
  await store.set(StoreKey.SyncInfo, { id: 'upgrade-id', password: key, serviceUrl: 'https://test' });
  await store.set(StoreKey.SyncEnabled, true);
  await store.set(StoreKey.Bookmarks, await encryptData(JSON.stringify(tree), key));
  await store.set(StoreKey.SyncBookmarksToolbar, false);
  let alarm: (name: string) => void = () => undefined;
  const listener = { add: () => undefined, remove: () => undefined };
  const ports: CorePorts = {
    alarms: { schedule: async () => undefined, clear: async () => undefined, once: async () => undefined, onAlarm: (cb) => { alarm = cb; } },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: { setBadge: async () => undefined, notify: async () => undefined, download: async () => undefined },
  };
  const makeApi = vi.fn(() => { throw new Error('Unexpected network'); });
  const core = new BackgroundCore(store, mapper, new InMemoryLogger(), adapter, ports, makeApi);
  return { api, adapter, store, mapper, tree, before, core, makeApi, fireAlarm: () => alarm(NativeDebounceAlarmName) };
}

describe('toolbar upgrade integrity', () => {
  for (const chromium of [false, true]) {
    it(`preserves cached metadata and offline reordered IDs on ${chromium ? 'Chromium' : 'Firefox'}`, async () => {
      const s = await setup(chromium);
      // A direct native event wakes a worker without startup().
      await expect(s.core.pushAfterNativeChange()).rejects.toThrow('Unexpected network');
      expect(await s.store.get(StoreKey.SyncBookmarksToolbar)).toBeUndefined();
      const mappings = await s.mapper.all();
      expect(mappings.filter((m) => m.syncedId !== 300)).toEqual(s.before.filter((m) => m.syncedId !== 300));
      let result = s.tree;
      for (const container of [C.Other, C.Toolbar]) {
        result = reconcileContainer(await s.adapter.readContainer(container), container, result, mappings, s.adapter.newTabUrl).bookmarks as typeof result;
      }
      expect(result.find((n) => n.title === C.Other)?.children).toEqual([...s.tree[1].children].reverse());
      expect(result.find((n) => n.title === C.Toolbar)?.children).toEqual(s.tree[2].children);
    });
  }

  it('blocks all wake-up sync paths after backup failure and retries successfully', async () => {
    const s = await setup();
    const set = s.store.set.bind(s.store);
    const fail = vi.spyOn(s.store, 'set').mockImplementation(async (key, value) => {
      if (String(key).startsWith('safety')) throw new Error('Storage full');
      return set(key, value);
    });
    await expect(s.core.startup()).rejects.toThrow('Storage full');
    await expect(s.core.pushAfterNativeChange()).rejects.toThrow('Storage full');
    await expect(s.core.checkForUpdates()).rejects.toThrow('Storage full');
    await expect(s.core.drain()).rejects.toThrow('Storage full');
    await expect(s.core.handleMessage({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote' } })).rejects.toThrow('Storage full');
    s.fireAlarm();
    await vi.waitFor(() => expect(fail.mock.calls.length).toBeGreaterThan(4));
    expect(s.makeApi).not.toHaveBeenCalled();
    expect((await s.adapter.readContainer(C.Toolbar))[0].title).toBe('Stale');
    expect(await s.store.get(StoreKey.SyncBookmarksToolbar)).toBe(false);
    await expect(s.core.handleMessage({ command: MessageCommand.GetLogs })).resolves.toBeDefined();
    fail.mockRestore();
    await expect(s.core.pushAfterNativeChange()).rejects.toThrow('Unexpected network');
    expect(await s.store.get(StoreKey.SyncBookmarksToolbar)).toBeUndefined();
    expect((await s.adapter.readContainer(C.Toolbar))[0].title).toBe('Remote');
  });
});
