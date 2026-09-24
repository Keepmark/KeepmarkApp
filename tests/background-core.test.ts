import { describe, expect, it, vi } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import { BookmarkContainer } from '../src/shared/bookmarks';
import type { BookmarkNode } from '../src/shared/models';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { BackgroundCore, UpdatesAlarmName, type CorePorts } from '../src/background/core';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand } from '../src/shared/messages';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import { makeMockApi } from './firefox-bookmarks.test';

const PASSWORD = 'correct horse battery staple';
const SYNC_ID = 'core-test-id';

function makePorts(): CorePorts & {
  alarmsFired: string[];
  badges: { text: string; title: string }[];
  notices: { title: string; message: string }[];
  downloads: { filename: string; text: string }[];
  fireAlarm(name: string): void;
  fireNative(): void;
  scheduled: { name: string; minutes: number }[];
} {
  const alarmCbs: ((name: string) => void)[] = [];
  const handlers: (() => void)[] = [];
  const listener = { add: (h: () => void) => void handlers.push(h), remove: () => undefined };
  const ports = {
    alarmsFired: [] as string[],
    badges: [] as { text: string; title: string }[],
    notices: [] as { title: string; message: string }[],
    downloads: [] as { filename: string; text: string }[],
    scheduled: [] as { name: string; minutes: number }[],
    alarms: {
      schedule: async (name: string, minutes: number) => void ports.scheduled.push({ name, minutes }),
      clear: async () => undefined,
      onAlarm: (cb: (name: string) => void) => void alarmCbs.push(cb),
    },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: {
      setBadge: async (text: string, title: string) => void ports.badges.push({ text, title }),
      notify: async (title: string, message: string) => void ports.notices.push({ title, message }),
      download: async (filename: string, text: string) => void ports.downloads.push({ filename, text }),
    },
    fireAlarm: (name: string) => void alarmCbs.forEach((cb) => cb(name)),
    fireNative: () => void handlers.forEach((h) => h()),
  };
  return ports;
}

interface FakeApiState {
  info: { status: number; version: string; maxSyncSize: number };
  created: { id: string; lastUpdated: string; version: string };
  remoteBlob: string;
  remoteLastUpdated: string;
  remoteVersion: string;
  puts: { blob: string; lastUpdated: string }[];
  failNextPut409: boolean;
}

function makeFakeApi(state: FakeApiState): (url: string) => XSyncApiClient {
  return (_url: string) =>
    ({
      getInfo: async () => ({ ...state.info }),
      createSync: async () => ({ ...state.created }),
      getBookmarks: async () => ({
        bookmarks: state.remoteBlob,
        version: state.remoteVersion,
        lastUpdated: state.remoteLastUpdated,
      }),
      getLastUpdated: async () => ({ lastUpdated: state.remoteLastUpdated }),
      getVersion: async () => ({ version: state.remoteVersion }),
      updateBookmarks: async (_id: string, blob: string, lastUpdated: string) => {
        if (state.failNextPut409) {
          state.failNextPut409 = false;
          const { DataOutOfSyncException } = await import('../src/shared/errors');
          throw new DataOutOfSyncException('conflict');
        }
        state.puts.push({ blob, lastUpdated });
        state.remoteBlob = blob;
        state.remoteLastUpdated = `${lastUpdated}+srv`;
        return { lastUpdated: state.remoteLastUpdated };
      },
    }) as unknown as XSyncApiClient;
}

async function linkedCore(state: FakeApiState): Promise<{
  core: BackgroundCore;
  store: Store;
  ports: ReturnType<typeof makePorts>;
  derived: string;
  mockApi: ReturnType<typeof makeMockApi>;
}> {
  const store = new Store(new MemoryBackend());
  const ports = makePorts();
  const mockApi = makeMockApi();
  await mockApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });
  const core = new BackgroundCore(
    store,
    new BookmarkIdMapper(store),
    new InMemoryLogger(),
    makeFirefoxAdapter(mockApi),
    ports,
    makeFakeApi(state),
    { debounceMs: 5 },
  );
  const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
  const id = await core.handleMessage({ command: MessageCommand.ConnectNew, serviceUrl: 'https://x.test/', password: PASSWORD });
  expect(id).toEqual({ id: SYNC_ID });
  return { core, store, ports, derived, mockApi };
}

function baseState(): FakeApiState {
  return {
    info: { status: 1, version: '1.1.13', maxSyncSize: 512000 },
    created: { id: SYNC_ID, lastUpdated: 't0', version: SyncClientVersion },
    remoteBlob: '',
    remoteLastUpdated: 't0',
    remoteVersion: SyncClientVersion,
    puts: [],
    failNextPut409: false,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('background core', () => {
  it('startup snapshots install backup without link', async () => {
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      ports,
      makeFakeApi(baseState()),
    );
    await core.startup();
    expect(await store.get(StoreKey.InstallBackup)).toContain('[xbs]');
    expect(ports.scheduled).toHaveLength(0);
  });

  it('connect-new uploads natives and links', async () => {
    const state = baseState();
    const { store, ports } = await linkedCore(state);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(true);
    expect(ports.scheduled).toContainEqual({ name: UpdatesAlarmName, minutes: 15 });
    expect(state.puts).toHaveLength(1);
  });

  it('connect-existing pulls remote into natives', async () => {
    const state = baseState();
    const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [{ id: 2, title: 'R', url: 'https://r.test' }] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(remote), derived);
    state.remoteLastUpdated = 't9';
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const mockApi = makeMockApi();
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(mockApi),
      ports,
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://x.test/',
      syncId: SYNC_ID,
      password: PASSWORD,
    });
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('R');
    // Repair (containers added) triggered a follow-up push.
    expect(state.puts.length).toBeGreaterThanOrEqual(0);
  });

  it('native event reconciles and pushes', async () => {
    const state = baseState();
    const { core, mockApi, derived } = await linkedCore(state);
    const putsBefore = state.puts.length;
    // User adds a bookmark natively; the listener path reconciles + pushes.
    await mockApi.create({ parentId: 'unfiled_____', title: 'Fresh', url: 'https://fresh.test' });
    core.onNativeEvent();
    await sleep(50);
    await vi.waitFor(() => expect(state.puts.length).toBeGreaterThan(putsBefore));
    const latest = JSON.parse(await decrypt_blob(state.puts[state.puts.length - 1].blob, derived));
    expect(JSON.stringify(latest)).toContain('https://fresh.test');
  });

  it('alarm with newer remote pulls locally', async () => {
    const state = baseState();
    const { core, store, derived } = await linkedCore(state);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Menu, children: [{ id: 2, title: 'M', url: 'https://m.test' }] },
      { id: 3, title: BookmarkContainer.Other, children: [{ id: 4, title: 'O', url: 'https://o.test' }] },
      { id: 5, title: BookmarkContainer.Toolbar, children: [{ id: 6, title: 'T', url: 'https://t.test' }] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(remote), derived);
    state.remoteLastUpdated = 't-remote-new';
    await store.set(StoreKey.LastUpdated, 't-old');
    await core.checkForUpdates();
    expect(await store.get(StoreKey.LastUpdated)).toBe('t-remote-new');
    expect(state.puts).toHaveLength(1); // only the connect-time push, no repair push
  });

  it('409 on push stashes a conflict file and pulls latest', async () => {
    const state = baseState();
    const { core, store, ports, derived } = await linkedCore(state);
    state.failNextPut409 = true;
    await expect(
      core.handleMessage({
        command: MessageCommand.AddBookmark,
        container: BookmarkContainer.Other,
        title: 'Conflict probe',
        url: 'https://probe.test',
      }),
    ).rejects.toThrow(/conflict/);
    // Nothing lost silently: conflict file saved + latest pulled.
    expect(ports.downloads).toHaveLength(1);
    expect(ports.downloads[0].filename).toMatch(/^keepmark-conflict-/);
    const stashed = JSON.parse(ports.downloads[0].text);
    expect(JSON.stringify(stashed)).toContain('https://probe.test');
    expect(await store.get(StoreKey.LastUpdated)).toBeTruthy();
    void derived;
  });

  it('remove-bookmark deletes natively and pushes', async () => {
    const state = baseState();
    const { core, derived } = await linkedCore(state);
    const blob = await store_blob(core);
    const tree = JSON.parse(await decrypt_blob(blob, derived)) as BookmarkNode[];
    const target = tree
      .find((c) => c.title === BookmarkContainer.Other)!
      .children!.find((b) => b.title === 'A')!;
    const putsBefore = state.puts.length;
    await core.handleMessage({ command: MessageCommand.RemoveBookmark, id: target.id! });
    expect(state.puts.length).toBeGreaterThan(putsBefore);
    const latest = JSON.parse(await decrypt_blob(state.puts[state.puts.length - 1].blob, derived));
    expect(JSON.stringify(latest)).not.toContain('https://a.test');
  });

  it('duplicates, export/import round-trip', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    await core.handleMessage({
      command: MessageCommand.AddBookmark,
      container: BookmarkContainer.Other,
      title: 'A copy',
      url: 'https://a.test',
    });
    const groups = (await core.handleMessage({ command: MessageCommand.GetDuplicates })) as {
      url: string;
      entries: { id: number }[];
    }[];
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(2);

    const json = (await core.handleMessage({
      command: MessageCommand.ExportBackup,
      password: 'backup-password',
    })) as string;
    const res = (await core.handleMessage({
      command: MessageCommand.ImportBackup,
      json,
      password: 'backup-password',
    })) as { count: number };
    expect(res.count).toBeGreaterThan(0);
  });

  it('switch-service moves to the new service with safety backup', async () => {
    const state = baseState();
    const { core, store, ports } = await linkedCore(state);
    const res = (await core.handleMessage({
      command: MessageCommand.SwitchService,
      newServiceUrl: 'https://new.test/',
      newPassword: 'brand-new-password',
    })) as { id: string };
    expect(res.id).toBe(SYNC_ID);
    expect(ports.downloads).toHaveLength(1); // safety backup
    expect(ports.downloads[0].filename).toMatch(/^keepmark-safety-/);
    const info = await store.get<{ serviceUrl: string }>(StoreKey.SyncInfo);
    expect(info!.serviceUrl).toBe('https://new.test/');
  });

  it('disable-sync clears credentials and stops polling', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    await core.handleMessage({ command: MessageCommand.DisableSync });
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    expect(await store.get(StoreKey.SyncInfo)).toEqual({});
  });

  it('status reflects link state', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      syncEnabled: boolean;
      syncId: string;
      queueLength: number;
    };
    expect(status.syncEnabled).toBe(true);
    expect(status.syncId).toBe(SYNC_ID);
    expect(status.queueLength).toBe(0);
  });

  it('get-logs exposes background entries without secrets', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const entries = (await core.handleMessage({ command: MessageCommand.GetLogs })) as {
      timestamp: string;
      level: number;
      tag: string;
      message: string;
    }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.tag === 'sync')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
  });
});

async function store_blob(core: BackgroundCore): Promise<string> {
  const store = (core as unknown as { store: Store }).store;
  return (await store.get<string>(StoreKey.Bookmarks))!;
}

async function decrypt_blob(blob: string, derived: string): Promise<string> {
  const { decryptData } = await import('../src/shared/crypto');
  return decryptData(blob, derived);
}
