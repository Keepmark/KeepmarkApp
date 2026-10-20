// Multi-sync: the saved-syncs registry + activation through real messages.
// One sync is active at a time; the others are dormant rows. Activating a row
// reuses the switch pipeline (persist active → verify target password → apply
// target tree), so these tests drive it end-to-end through handleMessage.

import { describe, expect, it } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import { deriveKey, decryptData, encryptData } from '../src/shared/crypto';
import { SyncClientVersion } from '../src/shared/constants';
import { BookmarkContainer, eachBookmark, repairBookmarkIds } from '../src/shared/bookmarks';
import type { BookmarkNode } from '../src/shared/models';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { BackgroundCore, type CorePorts } from '../src/background/core';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand, type SavedSyncsResponse } from '../src/shared/messages';
import {
  DataOutOfSyncException,
  SyncNotFoundException,
  UnsupportedVersionException,
} from '../src/shared/errors';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import { makeMockApi } from './firefox-bookmarks.test';

const PASSWORD_A = 'correct horse battery staple';
const PASSWORD_B = 'second sync password';
/** The short switch password: gates activation, wraps the dormant keys. */
const SWITCH = '1234';

interface Doc {
  blob: string;
  lastUpdated: string;
  version: string;
}

interface MultiState {
  info: { status: number; version: string; maxSyncSize: number };
  docs: Map<string, Doc>;
  created: string[];
  puts: { id: string; blob: string }[];
}

function state(): MultiState {
  return {
    info: { status: 1, version: '1.1.13', maxSyncSize: 512000 },
    docs: new Map(),
    created: [],
    puts: [],
  };
}

/** One fake service holding N independent sync documents, keyed by sync id. */
function makeMultiApi(s: MultiState): (url: string) => XSyncApiClient {
  const doc = (id: string): Doc => {
    const found = s.docs.get(id);
    if (!found) throw new SyncNotFoundException('no such sync');
    return found;
  };
  let seq = 0;
  return (_url: string) =>
    ({
      getInfo: async () => ({ ...s.info }),
      // Legacy contract: keeps every path on the v1.1 timestamp branch.
      getInfoV12: async () => {
        throw new UnsupportedVersionException('legacy service');
      },
      supportsV12: async () => false,
      getVersion: async (id: string) => ({ version: doc(id).version }),
      getBookmarks: async (id: string) => {
        const d = doc(id);
        return { bookmarks: d.blob, version: d.version, lastUpdated: d.lastUpdated };
      },
      getLastUpdated: async (id: string) => ({ lastUpdated: doc(id).lastUpdated }),
      createSync: async () => {
        seq += 1;
        const id = `sync-${seq}`;
        const d: Doc = { blob: '', lastUpdated: `t-${id}`, version: SyncClientVersion };
        s.docs.set(id, d);
        s.created.push(id);
        return { id, version: d.version, lastUpdated: d.lastUpdated };
      },
      updateBookmarks: async (id: string, blob: string, lastUpdated: string) => {
        const d = doc(id);
        if (lastUpdated !== d.lastUpdated) throw new DataOutOfSyncException('conflict');
        s.puts.push({ id, blob });
        d.blob = blob;
        d.lastUpdated = `${lastUpdated}+`;
        return { lastUpdated: d.lastUpdated };
      },
      deleteBookmarks: async (id: string) => {
        s.docs.delete(id);
      },
    }) as unknown as XSyncApiClient;
}

function makePorts(): CorePorts {
  const listener = { add: () => undefined, remove: () => undefined };
  return {
    alarms: {
      schedule: async () => undefined,
      clear: async () => undefined,
      once: async () => undefined,
      onAlarm: () => undefined,
    },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: {
      setBadge: async () => undefined,
      notify: async () => undefined,
      download: async () => undefined,
    },
  };
}

/** A valid synced tree: three containers, one bookmark under Other. */
function makeTree(label: string, url: string): BookmarkNode[] {
  return repairBookmarkIds([
    { title: BookmarkContainer.Menu, children: [] },
    { title: BookmarkContainer.Other, children: [{ title: label, url }] },
    { title: BookmarkContainer.Toolbar, children: [] },
  ] as BookmarkNode[]);
}

async function seedSync(s: MultiState, id: string, password: string, tree: BookmarkNode[]): Promise<void> {
  const key = await deriveKey(password, id, SyncClientVersion);
  s.docs.set(id, {
    blob: await encryptData(JSON.stringify(tree), key),
    lastUpdated: `t-${id}`,
    version: SyncClientVersion,
  });
}

async function docUrls(s: MultiState, id: string, password: string): Promise<string[]> {
  const key = await deriveKey(password, id, SyncClientVersion);
  const tree = JSON.parse(await decryptData(s.docs.get(id)!.blob, key)) as BookmarkNode[];
  const urls: string[] = [];
  eachBookmark((n) => {
    if (n.url) urls.push(n.url);
  }, tree);
  return urls;
}

function nativeUrls(tree: BookmarkNode[]): string[] {
  const urls: string[] = [];
  eachBookmark((n) => {
    if (n.url) urls.push(n.url);
  }, tree);
  return urls;
}

async function setup(s: MultiState): Promise<{
  core: BackgroundCore;
  store: Store;
  native: ReturnType<typeof makeMockApi>;
  adapter: ReturnType<typeof makeFirefoxAdapter>;
}> {
  const store = new Store(new MemoryBackend());
  const native = makeMockApi();
  const adapter = makeFirefoxAdapter(native);
  // One bookmark this browser already had: connect-new uploads it, so the
  // first sync has content to lose (and to restore when switching back).
  await native.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });
  const core = new BackgroundCore(
    store,
    new BookmarkIdMapper(store),
    new InMemoryLogger(),
    adapter,
    makePorts(),
    makeMultiApi(s),
    { debounceMs: 5 },
  );
  return { core, store, native, adapter };
}

const saved = (core: BackgroundCore): Promise<SavedSyncsResponse> =>
  core.handleMessage({ command: MessageCommand.GetSavedSyncs }) as Promise<SavedSyncsResponse>;

async function setSwitch(core: BackgroundCore, password = SWITCH): Promise<void> {
  await core.handleMessage({
    command: MessageCommand.SetSwitchPassword,
    password,
    confirm: password,
  });
}

async function connectA(core: BackgroundCore): Promise<string> {
  const { id } = (await core.handleMessage({
    command: MessageCommand.ConnectNew,
    serviceUrl: 'https://api.xbrowsersync.org',
    password: PASSWORD_A,
  })) as { id: string };
  return id;
}

describe('multi-sync (saved syncs)', () => {
  it('connect-new registers the linked sync as the active row', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    const list = await saved(core);
    expect(list.syncs).toHaveLength(1);
    expect(list.syncs[0]).toMatchObject({
      syncId: idA,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncVersion: SyncClientVersion,
    });
    expect(list.active).toEqual({ serviceUrl: 'https://api.xbrowsersync.org/', syncId: idA });
  });

  it('upgraded installs get their linked sync as the first row (startup migration)', async () => {
    const s = state();
    await seedSync(s, 'legacy', PASSWORD_A, makeTree('Legacy', 'https://legacy.test'));
    const { core, store } = await setup(s);
    const key = await deriveKey(PASSWORD_A, 'legacy', SyncClientVersion);
    await store.set(StoreKey.SyncInfo, {
      id: 'legacy',
      password: key,
      serviceUrl: 'https://old.example/',
      version: SyncClientVersion,
    });
    await store.set(StoreKey.SyncEnabled, true);
    await core.startup();
    expect(await store.get(StoreKey.SavedSyncs)).toHaveLength(1);
  });

  it('connecting a second sync keeps the first in the list and makes the new one active', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);

    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });

    const list = await saved(core);
    expect(list.syncs.map((r) => r.syncId).sort()).toEqual([idA, 'B'].sort());
    expect(list.active).toEqual({ serviceUrl: 'https://other.example/', syncId: 'B' });
    // A is dormant: its key is gone, only B's derived key is stored.
    const info = await core.handleMessage({ command: MessageCommand.GetStatus });
    expect((info as { syncId: string }).syncId).toBe('B');
  });

  it('activates a saved sync back and forth (natives follow the active tree)', async () => {
    const s = state();
    const { core, adapter } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    expect(nativeUrls(await adapter.readAll(true))).toContain('https://b.test');

    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: SWITCH,
    });
    const list = await saved(core);
    expect(list.active?.syncId).toBe(idA);
    const urls = nativeUrls(await adapter.readAll(true));
    expect(urls).toContain('https://a.test');
    expect(urls).not.toContain('https://b.test');
    expect((await core.handleMessage({ command: MessageCommand.GetStatus })) as { syncId: string }).toMatchObject({
      syncId: idA,
    });

    // …and back to B, which is still listed and still decrypts with its own key.
    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://other.example/',
      syncId: 'B',
      switchPassword: SWITCH,
    });
    expect(nativeUrls(await adapter.readAll(true))).toContain('https://b.test');
    expect((await saved(core)).syncs).toHaveLength(2);
  });

  it('a wrong switch password aborts before mutating anything', async () => {
    const s = state();
    const { core, adapter } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    const before = nativeUrls(await adapter.readAll(true));
    const putsBefore = s.puts.length;

    await expect(
      core.handleMessage({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: idA,
        switchPassword: '0000',
      }),
    ).rejects.toThrow(/password|credentials|decrypt/i);

    expect((await saved(core)).active?.syncId).toBe('B');
    expect(nativeUrls(await adapter.readAll(true))).toEqual(before);
    expect(s.puts).toHaveLength(putsBefore);
  });

  it('refuses to activate the already-active sync (never a self-pull)', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    await setSwitch(core);
    await expect(
      core.handleMessage({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: idA,
        switchPassword: SWITCH,
      }),
    ).rejects.toThrow(/already active/i);
  });

  it('pushes unpushed native edits before switching away (fail-closed)', async () => {
    const s = state();
    const { core, native, adapter } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });

    // Native edit the queue never saw (no listener fired, no debounce).
    await native.create({ parentId: 'unfiled_____', title: 'Late', url: 'https://late.test' });

    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: SWITCH,
    });

    // B kept the edit it would otherwise have lost to the switch.
    expect(await docUrls(s, 'B', PASSWORD_B)).toContain('https://late.test');
    // And the natives now hold A's tree.
    expect(nativeUrls(await adapter.readAll(true))).toContain('https://a.test');
  });

  it('a pending conflict blocks the switch with nothing rewritten', async () => {
    const s = state();
    const { core, native, adapter } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    const info = (await core.handleMessage({ command: MessageCommand.GetStatus })) as { syncId: string };
    // Capture a real conflict: the next push loses the timestamp CAS in a way
    // the queue persists, then a local edit arrives.
    s.docs.get('B')!.lastUpdated = 'server-moved';
    await native.create({ parentId: 'unfiled_____', title: 'Conflict', url: 'https://conflict.test' });
    // Pull-first sees the unpushed edit against a moved remote: conflict
    // captured (the signal stops the queue, hence the catch).
    await core
      .handleMessage({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } })
      .catch(() => undefined);
    expect((await core.handleMessage({ command: MessageCommand.GetStatus })) as { conflict?: boolean }).toMatchObject({
      conflict: true,
    });

    const before = nativeUrls(await adapter.readAll(true));
    await expect(
      core.handleMessage({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: idA,
        switchPassword: SWITCH,
      }),
    ).rejects.toThrow(/conflict/i);

    expect((await saved(core)).active?.syncId).toBe(info.syncId);
    expect(nativeUrls(await adapter.readAll(true))).toEqual(before);
  });

  it('removing any row is local-only; removing the active one also unlinks', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });

    // B is active: removing its row necessarily unlinks this browser, while
    // A stays dormant and both server copies stay untouched.
    await expect(
      core.handleMessage({ command: MessageCommand.RemoveSavedSync, serviceUrl: 'https://other.example/', syncId: 'B' }),
    ).resolves.toEqual({ removed: true, unlinked: true });
    let list = await saved(core);
    expect(list.syncs.map((r) => r.syncId)).toEqual([idA]);
    expect(list.active).toBeUndefined();
    expect(s.docs.has('B')).toBe(true);
    const status = await core.handleMessage({ command: MessageCommand.GetStatus }) as { syncEnabled: boolean };
    expect(status.syncEnabled).toBe(false);

    // A is dormant now: only the row goes, no link change.
    await expect(
      core.handleMessage({ command: MessageCommand.RemoveSavedSync, serviceUrl: 'https://api.xbrowsersync.org/', syncId: idA }),
    ).resolves.toEqual({ removed: true, unlinked: false });
    list = await saved(core);
    expect(list.syncs).toHaveLength(0);
    expect(list.active).toBeUndefined();
    expect(s.docs.has(idA)).toBe(true);
  });

  it('unlinking keeps the rows, and activating one re-links without retyping the ID', async () => {
    const s = state();
    const { core, adapter } = await setup(s);
    const idA = await connectA(core);
    await setSwitch(core);

    await core.handleMessage({ command: MessageCommand.DisableSync });
    let list = await saved(core);
    expect(list.active).toBeUndefined();
    expect(list.syncs.map((r) => r.syncId)).toEqual([idA]);

    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: SWITCH,
    });
    list = await saved(core);
    expect(list.active?.syncId).toBe(idA);
    expect(nativeUrls(await adapter.readAll(true))).toContain('https://a.test');
  });

  it('a wrong switch password changes nothing, even with unpushed edits on the active sync', async () => {
    const s = state();
    const { core, store, native, adapter } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    // Unpushed edit on the ACTIVE sync: the pre-flight must not touch it.
    await native.create({ parentId: 'unfiled_____', title: 'Late', url: 'https://late.test' });
    const beforeNative = nativeUrls(await adapter.readAll(true));
    const beforePuts = s.puts.length;
    const beforeUndo = await store.get(StoreKey.UndoSlot);

    await expect(
      core.handleMessage({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: idA,
        switchPassword: '0000',
      }),
    ).rejects.toThrow(/password|credentials|decrypt/i);

    expect(s.puts).toHaveLength(beforePuts); // no push of the active side
    expect(nativeUrls(await adapter.readAll(true))).toEqual(beforeNative);
    expect((await saved(core)).active?.syncId).toBe('B');
    expect(await store.get(StoreKey.UndoSlot)).toEqual(beforeUndo); // slot intact
  });

  it('a conflict left by a previous link does not block the switch', async () => {
    const s = state();
    const { core, store } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    // A switch made from the manager never clears ConflictState: the stale
    // record must not block activation of another sync.
    await store.set(StoreKey.ConflictState, {
      syncId: 'previous-sync',
      localEnc: 'stale',
      localCount: 0,
      remoteLastUpdated: '',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });

    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: SWITCH,
    });

    expect((await saved(core)).active?.syncId).toBe(idA);
    expect(await store.get(StoreKey.ConflictState)).toBeUndefined();
  });

  it('links a second sync without a switch password and keeps the rows in clear', async () => {
    const s = state();
    const { core, store } = await setup(s);
    await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
    });
    const list = await saved(core);
    expect(list.syncs).toHaveLength(2);
    expect(list.switchLockSet).toBe(false);
    // Connecting while linked activates the new sync; the old one stays.
    expect(list.active?.syncId).toBe('B');
    const rows = (await store.get(StoreKey.SavedSyncs)) as { credential: { scheme: string } }[];
    expect(rows.every((row) => row.credential.scheme === 'plain')).toBe(true);
    expect(await store.get(StoreKey.SwitchLock)).toBeUndefined();
  });

  it('setting the switch password wraps the active key (never the password)', async () => {
    const s = state();
    const { core, store } = await setup(s);
    await connectA(core);
    await setSwitch(core);
    const rows = (await store.get(StoreKey.SavedSyncs)) as { credential?: { iv: string; ct: string } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].credential?.iv).toBeTruthy();
    expect(rows[0].credential?.ct).toBeTruthy();
    const lock = (await store.get(StoreKey.SwitchLock)) as { salt: string; vault: { ct: string } };
    expect(lock.salt).toBeTruthy();
    expect(JSON.stringify(lock)).not.toContain(SWITCH);
    expect((await saved(core)).switchLockSet).toBe(true);
  });

  it('activates a saved sync without a password when no switch password is set', async () => {
    const s = state();
    const { core, adapter } = await setup(s);
    const idA = await connectA(core);
    await core.handleMessage({ command: MessageCommand.DisableSync });
    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
    });
    const list = await saved(core);
    expect(list.active?.syncId).toBe(idA);
    expect(nativeUrls(await adapter.readAll(true))).toContain('https://a.test');
  });

  it('changing the switch password keeps the saved keys usable', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    await core.handleMessage({
      command: MessageCommand.ChangeSwitchPassword,
      current: SWITCH,
      next: '999',
      confirm: '999',
    });
    await expect(
      core.handleMessage({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: idA,
        switchPassword: SWITCH,
      }),
    ).rejects.toThrow(/sync-change password/i);
    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: '999',
    });
    expect((await saved(core)).active?.syncId).toBe(idA);
  });

  it('resetting the switch password keeps only the active sync', async () => {
    const s = state();
    const { core } = await setup(s);
    await connectA(core);
    await seedSync(s, 'B', PASSWORD_B, makeTree('B', 'https://b.test'));
    await setSwitch(core);
    await core.handleMessage({
      command: MessageCommand.ConnectExisting,
      serviceUrl: 'https://other.example',
      syncId: 'B',
      password: PASSWORD_B,
      direction: 'pull',
      switchPassword: SWITCH,
    });
    const res = await core.handleMessage({
      command: MessageCommand.ResetSwitchPassword,
      next: '555',
      confirm: '555',
    });
    expect(res).toEqual({ removed: 1, kept: 1 });
    let list = await saved(core);
    expect(list.syncs.map((r) => r.syncId)).toEqual(['B']);
    expect(list.active?.syncId).toBe('B');
    expect(list.switchLockSet).toBe(true);
    // The dormant key is gone with the old vault; the new password still
    // unlocks the active row (wrapped fresh from SyncInfo).
    await core.handleMessage({ command: MessageCommand.DisableSync });
    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://other.example/',
      syncId: 'B',
      switchPassword: '555',
    });
    list = await saved(core);
    expect(list.active?.syncId).toBe('B');
  });

  it('resetting while unlinked empties the list and keeps the new password', async () => {
    const { core } = await setup(state());
    await connectA(core);
    await setSwitch(core);
    await core.handleMessage({ command: MessageCommand.DisableSync });
    const res = await core.handleMessage({
      command: MessageCommand.ResetSwitchPassword,
      next: '777',
      confirm: '777',
    });
    expect(res).toEqual({ removed: 1, kept: 0 });
    const list = await saved(core);
    expect(list.syncs).toHaveLength(0);
    expect(list.switchLockSet).toBe(true);
  });

  it('a password rotation while locked rewraps the row (no dead key)', async () => {
    const s = state();
    const { core } = await setup(s);
    const idA = await connectA(core);
    await setSwitch(core);
    const ROTATED = 'rotated sync password';
    await expect(
      core.handleMessage({
        command: MessageCommand.ChangePassword,
        currentPassword: PASSWORD_A,
        newPassword: ROTATED,
      }),
    ).rejects.toThrow(/sync-change password/i);
    await core.handleMessage({
      command: MessageCommand.ChangePassword,
      currentPassword: PASSWORD_A,
      newPassword: ROTATED,
      switchPassword: SWITCH,
    });
    // Unlink, then reactivate with the short password only: the row was
    // rewrapped with the rotated key, so the remote copy still decrypts.
    await core.handleMessage({ command: MessageCommand.DisableSync });
    await core.handleMessage({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://api.xbrowsersync.org/',
      syncId: idA,
      switchPassword: SWITCH,
    });
    expect((await saved(core)).active?.syncId).toBe(idA);
  });

  it('removing a row that is not in the list is a no-op', async () => {
    const { core } = await setup(state());
    await connectA(core);
    await expect(
      core.handleMessage({
        command: MessageCommand.RemoveSavedSync,
        serviceUrl: 'https://api.xbrowsersync.org/',
        syncId: 'never-linked',
      }),
    ).resolves.toEqual({ removed: false, unlinked: false });
  });
});
