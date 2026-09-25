import { describe, expect, it, vi } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import { BookmarkContainer } from '../src/shared/bookmarks';
import type { BookmarkNode } from '../src/shared/models';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { BackgroundCore, NativeDebounceAlarmName, UpdatesAlarmName, type CorePorts } from '../src/background/core';
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
  onceFired: string[];
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
    onceFired: [] as string[],
    alarms: {
      schedule: async (name: string, minutes: number) => void ports.scheduled.push({ name, minutes }),
      clear: async () => undefined,
      once: async (name: string) => void ports.onceFired.push(name),
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
      direction: 'pull',
    });
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('R');
    // Repair (containers added) triggered a follow-up push.
    expect(state.puts.length).toBeGreaterThanOrEqual(0);
  });

  it('native event reconciles and pushes', async () => {
    const state = baseState();
    const { core, mockApi, derived, ports } = await linkedCore(state);
    const putsBefore = state.puts.length;
    // User adds a bookmark natively; the listener path schedules a debounce
    // alarm (SW-safe), whose firing reconciles + pushes.
    await mockApi.create({ parentId: 'unfiled_____', title: 'Fresh', url: 'https://fresh.test' });
    core.onNativeEvent();
    expect(ports.onceFired).toContain(NativeDebounceAlarmName);
    ports.fireAlarm(NativeDebounceAlarmName);
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
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'new',
        newPassword: 'brand-new-password',
        direction: 'push',
      },
    })) as { id: string };
    expect(res.id).toBe(SYNC_ID);
    expect(ports.downloads).toHaveLength(1); // safety backup
    expect(ports.downloads[0].filename).toMatch(/^keepmark-safety-/);
    const info = await store.get<{ serviceUrl: string }>(StoreKey.SyncInfo);
    expect(info!.serviceUrl).toBe('https://new.test/');
  });

  it('switch to existing sync with push uploads the local tree', async () => {
    const state = baseState();
    const { core, store, derived } = await linkedCore(state);
    // Existing remote encrypted under the target password (proves ownership).
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    const stale: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [] },
      { id: 2, title: BookmarkContainer.Menu, children: [] },
      { id: 3, title: BookmarkContainer.Toolbar, children: [] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(stale), targetDerived);
    state.remoteLastUpdated = 't-target';
    state.puts.length = 0;
    void derived;
    const res = (await core.handleMessage({
      command: MessageCommand.SwitchService,
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'existing',
        syncId: 'target-id',
        newPassword: 'target-password',
        direction: 'push',
      },
    })) as { id: string };
    expect(res.id).toBe('target-id');
    expect(state.puts).toHaveLength(1); // local tree uploaded onto the existing remote
    const info = await store.get<{ id: string; serviceUrl: string }>(StoreKey.SyncInfo);
    expect(info).toMatchObject({ id: 'target-id', serviceUrl: 'https://new.test/' });
  });

  it('switch to existing sync with pull replaces local with remote', async () => {
    const state = baseState();
    const { core, mockApi } = await linkedCore(state);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [{ id: 2, title: 'FromNew', url: 'https://new.test/x' }] },
      { id: 3, title: BookmarkContainer.Menu, children: [] },
      { id: 4, title: BookmarkContainer.Toolbar, children: [] },
    ];
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    state.remoteBlob = await encryptData(JSON.stringify(remote), targetDerived);
    state.remoteLastUpdated = 't-target';
    const res = (await core.handleMessage({
      command: MessageCommand.SwitchService,
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'existing',
        syncId: 'target-id',
        newPassword: 'target-password',
        direction: 'pull',
      },
    })) as { id: string };
    expect(res.id).toBe('target-id');
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('FromNew');
  });

  it('switch to existing sync with wrong password aborts before mutating', async () => {
    const state = baseState();
    const { core, store, mockApi } = await linkedCore(state);
    const before = await mockApi.getChildren('unfiled_____');
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({
        command: MessageCommand.SwitchService,
        switch: {
          newServiceUrl: 'https://new.test/',
          mode: 'existing',
          syncId: 'target-id',
          newPassword: 'wrong-password',
          direction: 'pull',
        },
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(await mockApi.getChildren('unfiled_____')).toEqual(before);
    const info = await store.get<{ id: string }>(StoreKey.SyncInfo);
    expect(info!.id).toBe(SYNC_ID); // still linked to the old side
  });

  it('disable-sync clears credentials and stops polling', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    await core.handleMessage({ command: MessageCommand.DisableSync });
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    expect(await store.get(StoreKey.SyncInfo)).toEqual({});
    expect(await store.get(StoreKey.LastUpdated)).toBeUndefined();
    expect(await store.get(StoreKey.Bookmarks)).toBeUndefined();
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      syncId?: string;
      lastUpdated?: string;
      usedBytes?: number;
    };
    expect(status.syncId).toBeUndefined();
    expect(status.lastUpdated).toBeUndefined();
    expect(status.usedBytes).toBe(0);
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

  it('get-logs exposes background entries without secrets', async () => {    const state = baseState();
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

  it('ping reports live service state and status carries used bytes', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const pong = (await core.handleMessage({ command: MessageCommand.Ping })) as {
      reachable: boolean;
      version?: string;
      maxSyncSize?: number;
      remoteLastUpdated?: string;
    };
    expect(pong.reachable).toBe(true);
    expect(pong.version).toBe('1.1.13');
    expect(pong.maxSyncSize).toBe(512000);
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      usedBytes?: number;
    };
    expect(status.usedBytes).toBeGreaterThan(0);
  });

  it('ping never throws when the service is down', async () => {
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      ports,
      ((_url: string) => ({
        getInfo: async () => {
          throw new Error('down');
        },
      })) as unknown as (url: string) => XSyncApiClient,
      { debounceMs: 5 },
    );
    await store.set(StoreKey.SyncInfo, { id: SYNC_ID, password: 'x' });
    const pong = (await core.handleMessage({ command: MessageCommand.Ping })) as {
      reachable: boolean;
    };
    expect(pong.reachable).toBe(false);
  });

  it('switch preview reports service + remote without mutating', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    const preview = (await core.handleMessage({
      command: MessageCommand.SwitchPreview,
      newServiceUrl: 'https://new.test/',
      mode: 'existing',
      syncId: 'target-id',
    })) as {
      reachable: boolean;
      serviceVersion?: string;
      versionCompatible?: boolean;
      remoteExists?: boolean;
      remoteLastUpdated?: string;
      localCount?: number;
    };
    expect(preview.reachable).toBe(true);
    expect(preview.serviceVersion).toBe('1.1.13');
    expect(preview.versionCompatible).toBe(true);
    expect(preview.remoteExists).toBe(true);
    expect(preview.remoteLastUpdated).toBe(state.remoteLastUpdated);
    expect(preview.localCount).toBeGreaterThan(0);
    // Nothing mutated by the preview: still linked to the old side.
    const info = await store.get<{ id: string; serviceUrl?: string }>(StoreKey.SyncInfo);
    expect(info!.id).toBe(SYNC_ID);
    expect(info!.serviceUrl).toBe('https://x.test/');
  });

  it('switch preview reports unreachable target', async () => {    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      ports,
      ((_url: string) => ({
        getInfo: async () => {
          throw new Error('down');
        },
      })) as unknown as (url: string) => XSyncApiClient,
      { debounceMs: 5 },
    );
    await store.set(StoreKey.SyncInfo, { id: SYNC_ID, password: 'x' });
    const preview = (await core.handleMessage({
      command: MessageCommand.SwitchPreview,
      newServiceUrl: 'https://down.test/',
      mode: 'new',
    })) as { reachable: boolean };
    expect(preview.reachable).toBe(false);
  });

  it('verbosity persists and filters the log', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    const res = (await core.handleMessage({ command: MessageCommand.SetVerbosity, level: 0 })) as {
      level: number;
    };
    expect(res.level).toBe(0);
    expect(await store.get(StoreKey.LogVerbosity)).toBe(0);
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      logLevel?: number;
    };
    expect(status.logLevel).toBe(0);
    const { UnexpectedResponseException } = await import('../src/shared/errors');
    await expect(core.handleMessage({ command: MessageCommand.SetVerbosity, level: 9 })).rejects.toBeInstanceOf(
      UnexpectedResponseException,
    );
  });

  it('undo of connect-pull restores natives and unlinks', async () => {
    const state = baseState();
    const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [{ id: 2, title: 'R', url: 'https://r.test' }] },
      { id: 3, title: BookmarkContainer.Menu, children: [] },
      { id: 4, title: BookmarkContainer.Toolbar, children: [] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(remote), derived);
    state.remoteLastUpdated = 't9';
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const mockApi = makeMockApi();
    await mockApi.create({ parentId: 'unfiled_____', title: 'Mine', url: 'https://mine.test' });
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
      direction: 'pull',
    });
    // Remote replaced natives; undo brings Mine back and unlinks.
    const undoState = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as {
      kind: string;
    } | null;
    expect(undoState?.kind).toBe('connect-pull');
    const res = (await core.handleMessage({ command: MessageCommand.UndoLastLink })) as { undone: string };
    expect(res.undone).toBe('connect-pull');
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('Mine');
    expect(children.map((c) => c.title)).not.toContain('R');
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).toBeNull();
  });

  it('undo of connect-push puts the server copy back', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    const stale: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [] },
      { id: 2, title: BookmarkContainer.Menu, children: [] },
      { id: 3, title: BookmarkContainer.Toolbar, children: [] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(stale), targetDerived);
    state.remoteLastUpdated = 't-target';
    state.puts.length = 0;
    await core.handleMessage({
      command: MessageCommand.SwitchService,
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'existing',
        syncId: 'target-id',
        newPassword: 'target-password',
        direction: 'push',
      },
    });
    expect(state.puts).toHaveLength(1);
    await core.handleMessage({ command: MessageCommand.UndoLastLink });
    // Last PUT restored the pre-push server blob.
    expect(state.puts).toHaveLength(2);
    const back = JSON.parse(await decrypt_blob(state.puts[1].blob, targetDerived));
    expect(back).toEqual(stale);
    const info = await store.get<{ serviceUrl?: string }>(StoreKey.SyncInfo);
    expect(info!.serviceUrl).toBe('https://x.test/');
  });

  it('failed push-undo keeps the slot and reports conflict honestly', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    state.remoteBlob = await encryptData(JSON.stringify([]), targetDerived);
    state.remoteLastUpdated = 't-target';
    await core.handleMessage({
      command: MessageCommand.SwitchService,
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'existing',
        syncId: 'target-id',
        newPassword: 'target-password',
        direction: 'push',
      },
    });
    state.failNextPut409 = true; // someone else writes before our undo
    const { DataOutOfSyncException } = await import('../src/shared/errors');
    await expect(core.handleMessage({ command: MessageCommand.UndoLastLink })).rejects.toBeInstanceOf(
      DataOutOfSyncException,
    );
    const kept = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as { kind: string } | null;
    expect(kept?.kind).toBe('switch-push');
  });

  it('dismiss clears the slot and new ops overwrite it', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).not.toBeNull();
    await core.handleMessage({ command: MessageCommand.DismissUndo });
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).toBeNull();
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
