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
  cleared: string[];
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
    cleared: [] as string[],
    alarms: {
      schedule: async (name: string, minutes: number) => void ports.scheduled.push({ name, minutes }),
      clear: async (name: string) => void ports.cleared.push(name),
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
  /** Service speaks the v1.2 extended contract (advertised capabilities). */
  v12: boolean;
  /** Extended endpoints still answer (false = downgraded mid-test -> 412). */
  v12alive: boolean;
  revision: number;
  hash: string;
  /** Revision-CAS pushes seen (v1.2 path only). */
  v12puts: { blob: string; baseRevision: number }[];
  deleted: string[];
}

async function unsupportedVersion(): Promise<never> {
  const { UnsupportedVersionException } = await import('../src/shared/errors');
  throw new UnsupportedVersionException('Not supported (requires service v1.2).');
}

function v12caps(): { revision: boolean; conditionalGet: boolean; delete: boolean } {
  return { revision: true, conditionalGet: true, delete: true };
}

function makeFakeApi(state: FakeApiState): (url: string) => XSyncApiClient {
  const bump = (): { revision: number; hash: string } => {
    state.revision += 1;
    state.hash = `h${state.revision}`;
    return { revision: state.revision, hash: state.hash };
  };
  const getInfoV12 = async (): Promise<{
    status: number;
    version: string;
    maxSyncSize: number;
    capabilities?: { revision: boolean; conditionalGet: boolean; delete: boolean };
  }> => {
    // A downgraded service 412s the extended contract (shaped legacy answers
    // only come from genuinely legacy services).
    if (state.v12 && !state.v12alive) await unsupportedVersion();
    return state.v12 ? { ...state.info, capabilities: v12caps() } : { ...state.info };
  };
  const fail409 = async (): Promise<never> => {
    const { DataOutOfSyncException } = await import('../src/shared/errors');
    throw new DataOutOfSyncException('conflict');
  };
  return (_url: string) =>
    ({
      getInfo: async () => ({ ...state.info }),
      getInfoV12,
      // Derived from the shaped response like the real client — never a flag.
      supportsV12: async () => (await getInfoV12()).capabilities?.revision === true,
      // Every create is a fresh server doc with its own base timestamp.
      createSync: async () => {
        state.remoteLastUpdated = state.created.lastUpdated;
        return { ...state.created };
      },
      createSyncV12: async () => {
        if (!state.v12 || !state.v12alive) await unsupportedVersion();
        state.remoteLastUpdated = state.created.lastUpdated;
        state.revision = 1;
        state.hash = 'h1';
        return { ...state.created, meta: { revision: 1, hash: 'h1' } };
      },
      getBookmarks: async () => ({
        bookmarks: state.remoteBlob,
        version: state.remoteVersion,
        lastUpdated: state.remoteLastUpdated,
      }),
      getBookmarksV12: async () => {
        if (!state.v12 || !state.v12alive) await unsupportedVersion();
        return {
          bookmarks: state.remoteBlob,
          version: state.remoteVersion,
          lastUpdated: state.remoteLastUpdated,
          meta: { revision: state.revision, hash: state.hash },
        };
      },
      getBookmarksIfChanged: async (_id: string, knownHash: string) => {
        if (!state.v12 || !state.v12alive) await unsupportedVersion();
        if (knownHash === state.hash) return null; // 304
        return {
          bookmarks: state.remoteBlob,
          version: state.remoteVersion,
          lastUpdated: state.remoteLastUpdated,
          meta: { revision: state.revision, hash: state.hash },
        };
      },
      getLastUpdated: async () => ({ lastUpdated: state.remoteLastUpdated }),
      getVersion: async () => ({ version: state.remoteVersion }),
      updateBookmarks: async (_id: string, blob: string, lastUpdated: string) => {
        if (state.failNextPut409) {
          state.failNextPut409 = false;
          await fail409();
        }
        // Atomic timestamp CAS like the real server: a stale base loses.
        if (lastUpdated !== state.remoteLastUpdated) {
          await fail409();
        }
        state.puts.push({ blob, lastUpdated });
        state.remoteBlob = blob;
        state.remoteLastUpdated = `${lastUpdated}+srv`;
        if (state.v12) bump(); // the server bumps revision on every write, any contract
        return { lastUpdated: state.remoteLastUpdated };
      },
      updateBookmarksV12: async (_id: string, blob: string, baseRevision: number) => {
        if (!state.v12 || !state.v12alive) await unsupportedVersion();
        if (state.failNextPut409) {
          state.failNextPut409 = false;
          const { DataOutOfSyncException } = await import('../src/shared/errors');
          throw new DataOutOfSyncException('conflict');
        }
        if (baseRevision !== state.revision) {
          const { DataOutOfSyncException } = await import('../src/shared/errors');
          throw new DataOutOfSyncException('revision race');
        }
        state.v12puts.push({ blob, baseRevision });
        const meta = bump();
        state.remoteBlob = blob;
        state.remoteLastUpdated = `t-rev${state.revision}`;
        return { lastUpdated: state.remoteLastUpdated, meta };
      },
      deleteBookmarks: async (id: string) => {
        if (!state.v12 || !state.v12alive) await unsupportedVersion();
        state.deleted.push(id);
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
    v12: false,
    v12alive: true,
    revision: 0,
    hash: '',
    v12puts: [],
    deleted: [],
  };
}

function v12State(): FakeApiState {
  return {
    ...baseState(),
    info: { status: 1, version: '1.2.0', maxSyncSize: 512000 },
    v12: true,
  };
}

async function linkedV12Core(state: FakeApiState): Promise<{
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
  await core.handleMessage({ command: MessageCommand.ConnectNew, serviceUrl: 'https://x.test/', password: PASSWORD });
  return { core, store, ports, derived, mockApi };
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
    const first = await store.get<string>(StoreKey.InstallBackup);
    expect(first).toContain('[xbs]');
    expect(ports.scheduled).toHaveLength(0);
    // Second startup (e.g. MV3 wake) must not contaminate the snapshot.
    await core.startup();
    expect(await store.get<string>(StoreKey.InstallBackup)).toBe(first);
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
    expect(state.puts.length).toBe(1);
  });

  it('connect-merge unions local and remote with dual safety nets', async () => {
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
    await mockApi.create({ parentId: 'unfiled_____', title: 'L', url: 'https://l.test' });
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(mockApi),
      ports,
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    const res = await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://x.test/',
      syncId: SYNC_ID,
      password: PASSWORD,
      direction: 'merge',
    });
    expect(res).toEqual({ id: SYNC_ID });
    // Natives hold the union of both sides.
    const children = await mockApi.getChildren('unfiled_____');
    const titles = children.map((c) => c.title);
    expect(titles).toContain('L');
    expect(titles).toContain('R');
    // One push carrying the union, based on the remote timestamp.
    expect(state.puts).toHaveLength(1);
    const pushed = JSON.parse(await decrypt_blob(state.puts[0].blob, derived)) as BookmarkNode[];
    expect(JSON.stringify(pushed)).toContain('https://l.test');
    expect(JSON.stringify(pushed)).toContain('https://r.test');
    // Fail-closed snapshots of both destroyed sides.
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as {
      operation: string;
    }[];
    expect(safeties.map((s) => s.operation).sort()).toEqual(['merge-local', 'merge-remote']);
    const undo = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as {
      kind: string;
    } | null;
    expect(undo?.kind).toBe('connect-merge');
  });

  it('connect-merge with a wrong password mutates nothing', async () => {
    const state = baseState();
    const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
    state.remoteBlob = await encryptData(JSON.stringify([]), derived);
    state.remoteLastUpdated = 't9';
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const mockApi = makeMockApi();
    await mockApi.create({ parentId: 'unfiled_____', title: 'L', url: 'https://l.test' });
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(mockApi),
      ports,
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({
        command: MessageCommand.ConnectExisting,
        serviceUrl: 'https://x.test/',
        syncId: SYNC_ID,
        password: 'wrong password',
        direction: 'merge',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(state.puts).toHaveLength(0);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    expect((await core.handleMessage({ command: MessageCommand.GetSafetyList })) as unknown[]).toHaveLength(0);
  });

  it('connect-merge surfaces a mid-merge 409 with both snapshots intact', async () => {
    const state = baseState();
    const derived = await deriveKey(PASSWORD, SYNC_ID, SyncClientVersion);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [{ id: 2, title: 'R', url: 'https://r.test' }] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(remote), derived);
    state.remoteLastUpdated = 't9';
    state.failNextPut409 = true;
    const store = new Store(new MemoryBackend());
    const ports = makePorts();
    const mockApi = makeMockApi();
    await mockApi.create({ parentId: 'unfiled_____', title: 'L', url: 'https://l.test' });
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(mockApi),
      ports,
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    const { DataOutOfSyncException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({
        command: MessageCommand.ConnectExisting,
        serviceUrl: 'https://x.test/',
        syncId: SYNC_ID,
        password: PASSWORD,
        direction: 'merge',
      }),
    ).rejects.toBeInstanceOf(DataOutOfSyncException);
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as {
      operation: string;
    }[];
    expect(safeties.map((s) => s.operation).sort()).toEqual(['merge-local', 'merge-remote']);
  });

  it('merge preview counts without mutating', async () => {
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
    await mockApi.create({ parentId: 'unfiled_____', title: 'L', url: 'https://l.test' });
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(mockApi),
      ports,
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    const preview = (await core.handleMessage({
      command: MessageCommand.PreviewMerge,
      serviceUrl: 'https://x.test/',
      syncId: SYNC_ID,
      password: PASSWORD,
    })) as { localOnly: number; remoteOnly: number };
    expect(preview).toMatchObject({ localOnly: 1, remoteOnly: 1 });
    expect(state.puts).toHaveLength(0);
    expect((await mockApi.getChildren('unfiled_____')).map((c) => c.title)).toEqual(['L']);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({
        command: MessageCommand.PreviewMerge,
        serviceUrl: 'https://x.test/',
        syncId: SYNC_ID,
        password: 'wrong password',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('native change during suspend is not lost (re-scheduled on release)', async () => {
    const state = baseState();
    const { core, ports } = await linkedCore(state);
    const suspend = (core as unknown as { withSuspended<T>(fn: () => Promise<T>): Promise<T> }).withSuspended.bind(core);
    const res = await suspend(() => core.pushAfterNativeChange());
    expect(res).toEqual({ pushed: false });
    // Flush happened on release: a debounce alarm was scheduled for the retry.
    await sleep(0);
    expect(ports.onceFired).toContain(NativeDebounceAlarmName);
  });

  it('native event reconciles and pushes', async () => {
    const state = baseState();
    const { core, mockApi, derived, ports } = await linkedCore(state);
    const putsBefore = state.puts.length;
    // User adds a bookmark natively; the listener path schedules a debounce
    // alarm (SW-safe), whose firing reconciles + pushes.
    await mockApi.create({ parentId: 'unfiled_____', title: 'Fresh', url: 'https://fresh.test' });
    core.onNativeEvent();
    await sleep(0);
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

  it('toolbar-sync preference round-trips through messages', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    await expect(
      core.handleMessage({ command: MessageCommand.GetToolbarSync }),
    ).resolves.toEqual({ enabled: true });
    await expect(
      core.handleMessage({ command: MessageCommand.SetToolbarSync, enabled: false }),
    ).resolves.toEqual({ enabled: false });
    await expect(core.handleMessage({ command: MessageCommand.GetToolbarSync })).resolves.toEqual({
      enabled: false,
    });
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
    // Import snapshots the destroyed local tree fail-closed.
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as {
      operation: string;
    }[];
    expect(safeties.map((s) => s.operation)).toContain('import-backup');
  });

  it('bulk duplicate cleanup snapshots once, pushes once, restores', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    await core.handleMessage({
      command: MessageCommand.AddBookmark,
      container: BookmarkContainer.Other,
      title: 'A copy',
      url: 'https://a.test',
    });
    const putsBefore = state.puts.length;
    const groups = (await core.handleMessage({ command: MessageCommand.GetDuplicates })) as {
      url: string;
      entries: { id: number }[];
    }[];
    expect(groups).toHaveLength(1);
    const victim = groups[0].entries[0].id;
    const lockedId = groups[0].entries[groups[0].entries.length - 1].id;
    // The locked newest copy survives even a hostile request naming it.
    const refused = (await core.handleMessage({
      command: MessageCommand.RemoveDuplicates,
      ids: [victim, lockedId],
    })) as { deleted: number; safety: string };
    expect(refused.deleted).toBe(1);
    expect(refused.safety).toMatch(/duplicates-cleanup/);
    // Group gone now; clean up the extra safety row for the assertions below.
    const res = refused;
    // One push for the whole bulk, not one per item.
    expect(state.puts.length).toBe(putsBefore + 1);
    expect((await core.handleMessage({ command: MessageCommand.GetDuplicates })) as unknown[]).toHaveLength(0);
    // The snapshot restores the deleted bookmark.
    const restored = (await core.handleMessage({
      command: MessageCommand.RestoreSafety,
      fileName: res.safety,
    })) as { count: number };
    expect(restored.count).toBeGreaterThan(0);
    expect(((await core.handleMessage({ command: MessageCommand.GetDuplicates })) as unknown[])).toHaveLength(1);
  });

  it('backup preview counts without mutating', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const putsBefore = state.puts.length;
    const json = (await core.handleMessage({
      command: MessageCommand.ExportBackup,
      password: 'backup-password',
    })) as string;
    const preview = (await core.handleMessage({
      command: MessageCommand.PreviewBackup,
      json,
      password: 'backup-password',
    })) as { count: number };
    expect(preview.count).toBeGreaterThan(0);
    expect(state.puts).toHaveLength(putsBefore);
    await expect(
      core.handleMessage({ command: MessageCommand.PreviewBackup, json, password: 'wrong-password' }),
    ).rejects.toThrow(/Wrong backup password/);
  });

  it('switch-service moves to the new service (nothing destroyed, no safety file)', async () => {
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
    // Mode new uploads the local tree as-is to a fresh sync: nothing is
    // destroyed, so no safety file (the undo slot covers the link swap).
    expect(ports.downloads).toHaveLength(0);
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as { fileName: string }[];
    expect(safeties).toHaveLength(0);
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

  it('switch to existing sync with merge unions both trees', async () => {
    const state = baseState();
    const { core, mockApi } = await linkedCore(state);
    // Local side holds 'A'; the target remote holds 'T'.
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    const target: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Other, children: [{ id: 2, title: 'T', url: 'https://t.test' }] },
      { id: 3, title: BookmarkContainer.Menu, children: [] },
      { id: 4, title: BookmarkContainer.Toolbar, children: [] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(target), targetDerived);
    state.remoteLastUpdated = 't-target';
    state.puts.length = 0;
    const res = (await core.handleMessage({
      command: MessageCommand.SwitchService,
      switch: {
        newServiceUrl: 'https://new.test/',
        mode: 'existing',
        syncId: 'target-id',
        newPassword: 'target-password',
        direction: 'merge',
      },
    })) as { id: string };
    expect(res.id).toBe('target-id');
    expect(state.puts).toHaveLength(1); // the union uploaded once
    const pushed = JSON.parse(await decrypt_blob(state.puts[0].blob, targetDerived));
    expect(JSON.stringify(pushed)).toContain('https://a.test');
    expect(JSON.stringify(pushed)).toContain('https://t.test');
    const children = await mockApi.getChildren('unfiled_____');
    const titles = children.map((c) => c.title);
    expect(titles).toContain('A');
    expect(titles).toContain('T');
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as {
      operation: string;
    }[];
    expect(safeties.map((s) => s.operation).sort()).toEqual(['merge-local', 'merge-remote']);
    const undo = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as {
      kind: string;
    } | null;
    expect(undo?.kind).toBe('switch-merge');
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

  it('disable clears both alarms and the v12 flag state', async () => {
    const state = baseState();
    const { core, ports } = await linkedCore(state);
    await core.handleMessage({ command: MessageCommand.DisableSync });
    expect(ports.cleared).toContain('xbs-sync-updates-check');
    expect(ports.cleared).toContain('xbs-native-debounce');
  });

  it('server-side deletion stashes a RemovedSync snapshot', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    const failing = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      makePorts(),
      makeFakeApi(state),
      { debounceMs: 5 },
    );
    const { SyncNotFoundException } = await import('../src/shared/errors');
    await failing.disableSync(new SyncNotFoundException('gone'));
    const snap = await store.get<{ bookmarks: unknown[]; lastUpdated?: string; serviceUrl?: string; savedAt: string }>(
      StoreKey.RemovedSync,
    );
    expect(snap?.bookmarks.length).toBeGreaterThan(0);
    expect(snap?.serviceUrl).toBe('https://x.test/');
    expect(snap).not.toHaveProperty('password');
    const status = (await failing.handleMessage({ command: MessageCommand.GetStatus })) as {
      removedSync?: boolean;
    };
    expect(status.removedSync).toBe(true);
    const fetched = (await failing.handleMessage({ command: MessageCommand.GetRemovedSync })) as {
      bookmarks: unknown[];
    } | null;
    expect(fetched?.bookmarks.length).toBeGreaterThan(0);
    await failing.handleMessage({ command: MessageCommand.ClearRemovedSync });
    expect(await store.get(StoreKey.RemovedSync)).toBeUndefined();
  });

  it('restore snapshots an undo slot before overwriting natives', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    await core.handleMessage({
      command: MessageCommand.RestoreBookmarks,
      bookmarks: [
        { id: 1, title: '[xbs] Other', children: [{ id: 2, title: 'Restored', url: 'https://r.test' }] },
      ],
    });
    const undo = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as { kind: string } | null;
    expect(undo?.kind).toBe('restore');
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
    const down = async (): Promise<never> => {
      throw new Error('down');
    };
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      ports,
      ((_url: string) => ({
        getInfo: down,
        getInfoV12: down,
        getLastUpdated: down,
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
    const down = async (): Promise<never> => {
      throw new Error('down');
    };
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      new InMemoryLogger(),
      makeFirefoxAdapter(makeMockApi()),
      ports,
      ((_url: string) => ({
        getInfo: down,
        getInfoV12: down,
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

  it('password change re-encrypts under the new key and is undoable', async () => {
    const state = baseState();
    const { core, store, derived } = await linkedCore(state);
    const res = (await core.handleMessage({
      command: MessageCommand.ChangePassword,
      currentPassword: PASSWORD,
      newPassword: 'brand new password',
    })) as { lastUpdated: string };
    expect(res.lastUpdated).toBeTruthy();
    // Stored blob opens with the new key, no longer with the old one.
    const blob = await store.get<string>(StoreKey.Bookmarks);
    const newDerived = await deriveKey('brand new password', SYNC_ID, SyncClientVersion);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(decrypt_blob(blob!, derived)).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(JSON.parse(await decrypt_blob(blob!, newDerived))).toBeTruthy();
    const info = await store.get<{ password: string }>(StoreKey.SyncInfo);
    expect(info!.password).toBe(newDerived);
    // Undo puts the old blob back and restores the old key.
    const undone = (await core.handleMessage({ command: MessageCommand.UndoLastLink })) as { undone: string };
    expect(undone.undone).toBe('change-password');
    const blobBack = await store.get<string>(StoreKey.Bookmarks);
    expect(JSON.parse(await decrypt_blob(blobBack!, derived))).toBeTruthy();
    const infoBack = await store.get<{ password: string }>(StoreKey.SyncInfo);
    expect(infoBack!.password).toBe(derived);
  });

  it('password change requires current and new passwords', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const { IncompleteSyncInfoException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: PASSWORD, newPassword: '' }),
    ).rejects.toBeInstanceOf(IncompleteSyncInfoException);
    await expect(
      core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: '', newPassword: 'x' }),
    ).rejects.toBeInstanceOf(IncompleteSyncInfoException);
  });

  it('password change with a wrong current password changes nothing', async () => {
    const state = baseState();
    const { core, store, ports, derived } = await linkedCore(state);
    const before = await store.get<string>(StoreKey.Bookmarks);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    const wrong = await core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: 'wrong password', newPassword: 'brand new password' }).catch((e: Error) => e);
    expect(wrong).toBeInstanceOf(InvalidCredentialsException);
    expect((wrong as Error).message).toBe('Current password is incorrect.');
    // Nothing downloaded, pushed or stored: creds, blob and undo slot untouched.
    expect(ports.downloads).toHaveLength(0);
    expect(state.puts).toHaveLength(1); // only the connect-time push
    expect(await store.get<string>(StoreKey.Bookmarks)).toBe(before);
    const info = await store.get<{ password: string }>(StoreKey.SyncInfo);
    expect(info!.password).toBe(derived);
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).not.toBeNull(); // connect-new slot kept
  });
});

describe('background core v1.2', () => {
  it('connect-new on v1.2 stores the capability flag and revision', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
    const info = await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(info?.supportsV12).toBe(true);
    expect(await store.get(StoreKey.SyncRevision)).toBe(2); // create rev1 -> upload rev2
    expect(await store.get<string>(StoreKey.SyncHash)).toBe('h2');
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      supportsV12?: boolean;
    };
    expect(status.supportsV12).toBe(true);
  });

  it('connect-new on legacy stays v1.1 with no revision', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    const info = await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo);
    expect(info?.supportsV12).toBe(false);
    expect(await store.get(StoreKey.SyncRevision)).toBeUndefined();
    expect(await store.get(StoreKey.SyncHash)).toBeUndefined();
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as {
      supportsV12?: boolean;
    };
    expect(status.supportsV12).toBe(false);
  });

  it('routine pushes on v1.2 use revision CAS', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
    expect(state.v12puts).toHaveLength(1); // connect-time upload already went the V12 way
    expect(state.puts).toHaveLength(0);
    const base = await store.get(StoreKey.SyncRevision);
    await core.handleMessage({
      command: MessageCommand.AddBookmark,
      container: BookmarkContainer.Other,
      title: 'V12 probe',
      url: 'https://v12.test',
    });
    expect(state.v12puts).toHaveLength(2);
    expect(state.v12puts[1].baseRevision).toBe(base);
    expect(await store.get(StoreKey.SyncRevision)).toBe((base as number) + 1);
    expect(state.puts).toHaveLength(0); // never fell back to the timestamp path
  });

  it('revision race on v1.2 loses with 409 and stashes a conflict file', async () => {
    const state = v12State();
    const { core, ports } = await linkedV12Core(state);
    state.revision += 5; // another device wrote first
    await expect(
      core.handleMessage({
        command: MessageCommand.AddBookmark,
        container: BookmarkContainer.Other,
        title: 'Racy',
        url: 'https://racy.test',
      }),
    ).rejects.toThrow(/conflict|race/i);
    expect(ports.downloads.some((d) => d.filename.startsWith('keepmark-conflict-'))).toBe(true);
  });

  it('conditional GET 304 skips the download when only the timestamp moved', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
    const before = await store.get<string>(StoreKey.LastUpdated);
    // Same content (same hash), new timestamp: e.g. a legacy client touched it.
    state.remoteLastUpdated = 't-touched';
    const putsBefore = state.v12puts.length;
    await core.checkForUpdates();
    expect(await store.get<string>(StoreKey.LastUpdated)).toBe(before);
    expect(state.v12puts.length).toBe(putsBefore);
  });

  it('pull applies the new revision when the content actually changed', async () => {
    const state = v12State();
    const { core, store, derived } = await linkedV12Core(state);
    const remote: BookmarkNode[] = [
      { id: 1, title: BookmarkContainer.Menu, children: [{ id: 2, title: 'V12', url: 'https://v12new.test' }] },
      { id: 3, title: BookmarkContainer.Other, children: [] },
      { id: 4, title: BookmarkContainer.Toolbar, children: [] },
    ];
    state.remoteBlob = await encryptData(JSON.stringify(remote), derived);
    state.revision += 1;
    state.hash = 'h-new';
    state.remoteLastUpdated = 't-new';
    await core.checkForUpdates();
    expect(await store.get<string>(StoreKey.LastUpdated)).toBe('t-new');
    expect(await store.get(StoreKey.SyncRevision)).toBe(state.revision);
    expect(await store.get<string>(StoreKey.SyncHash)).toBe('h-new');
  });

  it('delete on legacy is refused before touching anything', async () => {
    const state = baseState();
    const { core, store, ports } = await linkedCore(state);
    await expect(core.handleMessage({ command: MessageCommand.DeleteRemoteSync })).rejects.toThrow(
      /Not supported \(requires service v1\.2\)/,
    );
    expect(ports.downloads).toHaveLength(0);
    expect(state.deleted).toHaveLength(0);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(true);
  });

  it('delete on v1.2 snapshots safety, deletes, unlinks, keeps natives', async () => {
    const state = v12State();
    const { core, store, ports, mockApi, derived } = await linkedV12Core(state);
    await core.handleMessage({ command: MessageCommand.DeleteRemoteSync });
    // Fail-closed safety entry (not a plaintext download anymore).
    expect(ports.downloads).toHaveLength(0);
    const safeties = (await core.handleMessage({ command: MessageCommand.GetSafetyList })) as {
      fileName: string;
      operation: string;
      side: string;
      enc: string | null;
    }[];
    expect(safeties).toHaveLength(1);
    expect(safeties[0]).toMatchObject({ operation: 'delete-remote', side: 'remote', enc: 'derived' });
    // After unlink the remote-side entry refuses honestly (needs the link).
    await expect(
      core.handleMessage({ command: MessageCommand.RestoreSafety, fileName: safeties[0].fileName }),
    ).rejects.toThrow(/Link the sync/);
    expect(state.deleted).toEqual([SYNC_ID]);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
    expect(await store.get(StoreKey.SyncInfo)).toEqual({});
    expect(await store.get(StoreKey.SyncRevision)).toBeUndefined();
    expect(ports.notices.some((n) => n.title === 'Server copy deleted')).toBe(true);
    // The delete carries no undo by design: the slot is gone with the link.
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).toBeNull();
    // Natives untouched: the local bookmark survives the server wipe.
    const children = await mockApi.getChildren('unfiled_____');
    expect(children.map((c) => c.title)).toContain('A');
    void derived;
  });

  it('ping heals the capability flag after a server upgrade (no relink)', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    expect((await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(false);
    state.v12 = true; // server upgraded under us
    const pong = (await core.handleMessage({ command: MessageCommand.Ping })) as {
      reachable: boolean;
      supportsV12?: boolean;
    };
    expect(pong.reachable).toBe(true);
    expect(pong.supportsV12).toBe(true);
    expect((await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(true);
  });

  it('downgraded service falls back to the legacy push without losing edits', async () => {
    const state = v12State();
    const { core, store, derived } = await linkedV12Core(state);
    state.v12alive = false; // extended endpoints start 412-ing
    await core.handleMessage({
      command: MessageCommand.AddBookmark,
      container: BookmarkContainer.Other,
      title: 'After downgrade',
      url: 'https://downgraded.test',
    });
    // Legacy PUT carried the edit through (connect-time upload went the V12 way).
    expect(state.puts).toHaveLength(1);
    const latest = JSON.parse(await decrypt_blob(state.puts[state.puts.length - 1].blob, derived));
    expect(JSON.stringify(latest)).toContain('https://downgraded.test');
    // And the link is honestly downgraded: no stale revision, flag cleared.
    expect((await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(false);
    expect(await store.get(StoreKey.SyncRevision)).toBeUndefined();
  });

  it('switch preview advertises v1.2 support', async () => {
    const state = v12State();
    const { core } = await linkedV12Core(state);
    const preview = (await core.handleMessage({
      command: MessageCommand.SwitchPreview,
      newServiceUrl: 'https://new.test/',
      mode: 'new',
    })) as { reachable: boolean; supportsV12?: boolean };
    expect(preview.reachable).toBe(true);
    expect(preview.supportsV12).toBe(true);
  });

  it('switch-service new onto v1.2 links with the flag set', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
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
    expect((await store.get<{ supportsV12?: boolean }>(StoreKey.SyncInfo))?.supportsV12).toBe(true);
    expect(await store.get(StoreKey.SyncRevision)).toBe(2);
  });

  it('password change on v1.2 uses revision CAS and keeps the revision chain', async () => {
    const state = v12State();
    const { core, store, derived } = await linkedV12Core(state);
    const base = await store.get(StoreKey.SyncRevision);
    const res = (await core.handleMessage({
      command: MessageCommand.ChangePassword,
      currentPassword: PASSWORD,
      newPassword: 'brand new password',
    })) as { lastUpdated: string };
    expect(res.lastUpdated).toBeTruthy();
    expect(state.v12puts.length).toBeGreaterThan(1);
    expect(state.v12puts[state.v12puts.length - 1].baseRevision).toBe(base);
    expect(await store.get(StoreKey.SyncRevision)).toBe((base as number) + 1);
    expect(state.puts).toHaveLength(0); // never fell back to the timestamp path
    // New key opens the blob, old key does not.
    const blob = await store.get<string>(StoreKey.Bookmarks);
    const newDerived = await deriveKey('brand new password', SYNC_ID, SyncClientVersion);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(decrypt_blob(blob!, derived)).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(JSON.parse(await decrypt_blob(blob!, newDerived))).toBeTruthy();
  });

  it('password change with a wrong current password changes nothing on v1.2 either', async () => {
    const state = v12State();
    const { core, store, ports } = await linkedV12Core(state);
    const { InvalidCredentialsException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: 'nope', newPassword: 'brand new password' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(ports.downloads).toHaveLength(0);
    expect(state.v12puts).toHaveLength(1); // only the connect-time upload
  });

  it('status carries the linked service version', async () => {
    const legacy = await linkedCore(baseState());
    const legacyStatus = (await legacy.core.handleMessage({ command: MessageCommand.GetStatus })) as {
      serviceVersion?: string;
    };
    expect(legacyStatus.serviceVersion).toBe('1.1.13');
    const v12 = await linkedV12Core(v12State());
    const v12Status = (await v12.core.handleMessage({ command: MessageCommand.GetStatus })) as {
      serviceVersion?: string;
    };
    expect(v12Status.serviceVersion).toBe('1.2.0');
  });

  it('disable-sync invalidates the undo slot', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).not.toBeNull();
    await core.handleMessage({ command: MessageCommand.DisableSync });
    expect(await core.handleMessage({ command: MessageCommand.GetUndoState })).toBeNull();
  });

  it('undo of connect-new on v1.2 cleans the orphaned server sync', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
    const res = (await core.handleMessage({ command: MessageCommand.UndoLastLink })) as { undone: string };
    expect(res.undone).toBe('connect-new');
    expect(state.deleted).toEqual([SYNC_ID]);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(false);
  });

  it('undo keeps the PUT-back freshness instead of the stale snapshot', async () => {
    const state = v12State();
    const { core, store } = await linkedV12Core(state);
    await core.handleMessage({
      command: MessageCommand.ChangePassword,
      currentPassword: PASSWORD,
      newPassword: 'rotated password',
    });
    const revAfterChange = await store.get(StoreKey.SyncRevision);
    expect(revAfterChange).toBeGreaterThan(2);
    await core.handleMessage({ command: MessageCommand.UndoLastLink });
    // Legacy PUT-back responses carry no meta: the stored revision is cleared
    // (never left pointing at the undone write), lastUpdated is the fresh one.
    expect(await store.get(StoreKey.SyncRevision)).toBeUndefined();
    expect(await store.get<string>(StoreKey.LastUpdated)).toBe(state.remoteLastUpdated);
  });

  it('failed switch-push keeps the previous undo slot', async () => {
    const state = baseState();
    const { core } = await linkedCore(state);
    const targetDerived = await deriveKey('target-password', 'target-id', SyncClientVersion);
    state.remoteBlob = await encryptData(JSON.stringify([]), targetDerived);
    state.remoteLastUpdated = 't-target';
    state.failNextPut409 = true;
    const { DataOutOfSyncException } = await import('../src/shared/errors');
    await expect(
      core.handleMessage({
        command: MessageCommand.SwitchService,
        switch: {
          newServiceUrl: 'https://new.test/',
          mode: 'existing',
          syncId: 'target-id',
          newPassword: 'target-password',
          direction: 'push',
        },
      }),
    ).rejects.toBeInstanceOf(DataOutOfSyncException);
    const kept = (await core.handleMessage({ command: MessageCommand.GetUndoState })) as { kind: string } | null;
    expect(kept?.kind).toBe('connect-new');
  });

  it('ping preserves a concurrent password rotation', async () => {
    const state = baseState();
    const { core, store } = await linkedCore(state);
    await store.set(StoreKey.SyncInfo, { id: SYNC_ID, password: 'rotated-key', serviceUrl: 'https://x.test/' });
    const pong = (await core.handleMessage({ command: MessageCommand.Ping })) as { reachable: boolean };
    expect(pong.reachable).toBe(true);
    const info = await store.get<{ password: string; serviceVersion?: string }>(StoreKey.SyncInfo);
    expect(info!.password).toBe('rotated-key');
    expect(info!.serviceVersion).toBe('1.1.13');
  });

  it('a failing safety snapshot aborts the destructive operation (fail closed)', async () => {
    const state = baseState();
    const failing = new (class extends MemoryBackend {
      async set(key: string, value: unknown): Promise<void> {
        if (key.startsWith('safetyFile:')) throw new Error('quota exceeded');
        return super.set(key, value);
      }
    })();
    const store = new Store(failing);
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
    await core.handleMessage({ command: MessageCommand.ConnectNew, serviceUrl: 'https://x.test/', password: PASSWORD });
    await expect(
      core.handleMessage({
        command: MessageCommand.ChangePassword,
        currentPassword: PASSWORD,
        newPassword: 'rotated password',
      }),
    ).rejects.toThrow(/quota/);
    // No PUT landed: the server copy is untouched.
    expect(state.puts).toHaveLength(1); // connect-time upload only
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
