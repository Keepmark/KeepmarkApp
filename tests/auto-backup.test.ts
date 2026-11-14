// Automatic backups: scheduled copies of the local bookmarks, stored with the
// safety backups under their own retention. Silent on success; a failure is
// kept for the manager's Status and retried on the next tick.
import { describe, expect, it } from 'vitest';
import { SyncClientVersion } from '../src/shared/constants';
import { deriveKey } from '../src/shared/crypto';
import type { BookmarkNode } from '../src/shared/models';
import { MemoryBackend, safetyFileKey, Store, StoreKey } from '../src/shared/store';
import { deleteSafety, listSafety, pruneSafety, readSafetyTree, writeSafety } from '../src/shared/safety';
import {
  AutoBackupDefaults,
  autoBackupDue,
  autoBackupState,
  runAutoBackup,
  sanitizeAutoBackup,
  treeFingerprint,
} from '../src/shared/auto-backup';
import { AutoBackupAlarmName, BackgroundCore, type CorePorts } from '../src/background/core';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand, type AutoBackupResponse, type StatusResponse } from '../src/shared/messages';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import { makeMockApi } from './firefox-bookmarks.test';

const tree = (title = 'A'): BookmarkNode[] => [
  { title: '[xbs] Other', children: [{ id: 1, title, url: 'https://a.test' }] },
];
const autos = async (store: Store) => (await listSafety(store)).filter((e) => e.operation === 'auto');
const day = 24 * 60 * 60 * 1000;

describe('automatic backup settings and schedule', () => {
  it('defaults to on, daily, 7 copies and rejects unknown values', () => {
    expect(AutoBackupDefaults).toEqual({ enabled: true, everyDays: 1, keep: 7 });
    expect(sanitizeAutoBackup(undefined)).toEqual(AutoBackupDefaults);
    expect(sanitizeAutoBackup({ enabled: false, everyDays: 7, keep: 30 })).toEqual({ enabled: false, everyDays: 7, keep: 30 });
    expect(sanitizeAutoBackup({ enabled: 'yes', everyDays: 2, keep: 1000 })).toEqual(AutoBackupDefaults);
  });

  it('is due on the first run, after the period, and never while off', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    const at = (ms: number) => ({ lastCheckUtc: new Date(ms).toISOString() });
    expect(autoBackupDue(AutoBackupDefaults, {}, now)).toBe(true);
    expect(autoBackupDue(AutoBackupDefaults, at(now - day / 2), now)).toBe(false);
    expect(autoBackupDue(AutoBackupDefaults, at(now - day), now)).toBe(true);
    expect(autoBackupDue({ ...AutoBackupDefaults, everyDays: 7 }, at(now - 6 * day), now)).toBe(false);
    expect(autoBackupDue({ ...AutoBackupDefaults, everyDays: 7 }, at(now - 7 * day), now)).toBe(true);
    // A clock set back must not silence the schedule.
    expect(autoBackupDue(AutoBackupDefaults, at(now + 30 * day), now)).toBe(true);
    expect(autoBackupDue({ ...AutoBackupDefaults, enabled: false }, {}, now)).toBe(false);
  });
});

describe('automatic backup run', () => {
  it('writes an encrypted, restorable copy and skips an unchanged tree', async () => {
    const store = new Store(new MemoryBackend());
    const derived = await deriveKey('correct horse battery staple', 'auto-test-id', SyncClientVersion);
    const link = { syncId: 'auto-test-id', derivedKey: derived };

    expect(await runAutoBackup(store, { tree: tree(), ...link })).toBe('written');
    const [entry] = await autos(store);
    expect(entry).toMatchObject({ operation: 'auto', side: 'local', enc: 'derived', items: 2 });
    await expect(readSafetyTree(store, entry!, derived)).resolves.toEqual(tree());

    expect(await runAutoBackup(store, { tree: tree(), ...link })).toBe('unchanged');
    expect(await autos(store)).toHaveLength(1);
    expect(await runAutoBackup(store, { tree: tree('B'), ...link })).toBe('written');
    expect(await autos(store)).toHaveLength(2);
    expect((await autoBackupState(store)).error).toBeUndefined();
  });

  it('takes a fresh copy when the key changes or the last copy was deleted', async () => {
    const store = new Store(new MemoryBackend());
    const key = await deriveKey('correct horse battery staple', 'auto-test-id', SyncClientVersion);
    expect(await treeFingerprint(tree())).not.toBe(await treeFingerprint(tree(), key));

    await runAutoBackup(store, { tree: tree() });
    expect((await autos(store))[0]?.enc).toBeNull(); // unlinked: plaintext, flagged
    expect(await runAutoBackup(store, { tree: tree(), syncId: 'auto-test-id', derivedKey: key })).toBe('written');

    // Deleting the copy of the CURRENT tree (an older automatic backup still
    // exists) must save that tree again, not report it as unchanged.
    const link = { syncId: 'auto-test-id', derivedKey: key };
    expect(await runAutoBackup(store, { tree: tree(), ...link })).toBe('unchanged');
    const newest = (await autos(store))[0]!;
    expect(await deleteSafety(store, newest.fileName)).toBe(true);
    expect(await autos(store)).toHaveLength(1);
    expect(await runAutoBackup(store, { tree: tree(), ...link })).toBe('written');
    expect(await autos(store)).toHaveLength(2);
  });

  it('concurrent writers never lose an index row', async () => {
    const store = new Store(new MemoryBackend());
    const slow = store.set.bind(store);
    // Yield on every write so unsynchronized read-modify-write cycles would interleave.
    store.set = async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return slow(key, value);
    };
    await Promise.all([
      runAutoBackup(store, { tree: tree('auto') }),
      writeSafety(store, { operation: 'sync-pull', side: 'local', tree: tree('pull') }),
      writeSafety(store, { operation: 'import-backup', side: 'local', tree: tree('import') }),
    ]);
    const rows = await listSafety(store);
    expect(rows.map((e) => e.operation).sort()).toEqual(['auto', 'import-backup', 'sync-pull']);
    for (const row of rows) expect(await store.get(safetyFileKey(row.fileName))).toBeDefined();
  });

  it('keeps its own retention: automatic and safety backups never evict each other', async () => {
    const store = new Store(new MemoryBackend());
    await store.set(StoreKey.SafetyKeep, 3);
    await store.set(StoreKey.AutoBackup, { enabled: true, everyDays: 1, keep: 3 });
    for (let i = 0; i < 5; i++) await runAutoBackup(store, { tree: tree(`auto-${i}`) });
    for (let i = 0; i < 5; i++) await writeSafety(store, { operation: 'import-backup', side: 'local', tree: tree(`s-${i}`) });

    const rows = await listSafety(store);
    expect(rows.filter((e) => e.operation === 'auto')).toHaveLength(3);
    expect(rows.filter((e) => e.operation !== 'auto')).toHaveLength(3);

    // Lowering one budget leaves the other alone.
    await store.set(StoreKey.AutoBackup, { enabled: true, everyDays: 1, keep: 7 });
    expect(await pruneSafety(store, 3)).toBe(0);
    await store.set(StoreKey.SafetyKeep, 5);
    expect(await pruneSafety(store)).toBe(0);
    expect(await listSafety(store)).toHaveLength(6);
  });
});

function makePorts(): CorePorts & { scheduled: string[]; cleared: string[]; notices: string[]; fire(name: string): void } {
  const cbs: ((name: string) => void)[] = [];
  const listener = { add: () => undefined, remove: () => undefined };
  const ports = {
    scheduled: [] as string[],
    cleared: [] as string[],
    notices: [] as string[],
    alarms: {
      schedule: async (name: string) => void ports.scheduled.push(name),
      clear: async (name: string) => void ports.cleared.push(name),
      once: async () => undefined,
      onAlarm: (cb: (name: string) => void) => void cbs.push(cb),
    },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: {
      setBadge: async () => undefined,
      notify: async (title: string) => void ports.notices.push(title),
      download: async () => undefined,
    },
    fire: (name: string) => void cbs.forEach((cb) => cb(name)),
  };
  return ports;
}

async function unlinkedCore() {
  const store = new Store(new MemoryBackend());
  const ports = makePorts();
  const mockApi = makeMockApi();
  await mockApi.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });
  const core = new BackgroundCore(store, new BookmarkIdMapper(store), new InMemoryLogger(), makeFirefoxAdapter(mockApi), ports);
  return { core, store, ports, mockApi };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('automatic backup in the background', () => {
  it('backs up on startup, stays silent, and waits a full period before the next one', async () => {
    const { core, store, ports, mockApi } = await unlinkedCore();
    await core.startup();
    expect(ports.scheduled).toContain(AutoBackupAlarmName);
    expect(await autos(store)).toHaveLength(1);
    expect(ports.notices).toEqual([]);

    await mockApi.create({ parentId: 'unfiled_____', title: 'B', url: 'https://b.test' });
    ports.fire(AutoBackupAlarmName);
    await settle();
    expect(await autos(store)).toHaveLength(1); // changed, but not due yet

    await store.set(StoreKey.AutoBackupState, { ...(await autoBackupState(store)), lastCheckUtc: new Date(Date.now() - 2 * day).toISOString() });
    ports.fire(AutoBackupAlarmName);
    await settle();
    expect(await autos(store)).toHaveLength(2);
  });

  it('does nothing before startup, and an automatic backup restores like any safety backup', async () => {
    const { core, store, ports, mockApi } = await unlinkedCore();
    ports.fire(AutoBackupAlarmName); // an alarm waking the worker before startup()
    await settle();
    expect(await autos(store)).toHaveLength(0);

    await core.startup();
    const [entry] = await autos(store);
    await mockApi.create({ parentId: 'unfiled_____', title: 'Later', url: 'https://later.test' });
    const res = (await core.handleMessage({ command: MessageCommand.RestoreSafety, fileName: entry!.fileName })) as { count: number };
    expect(res.count).toBe(entry!.items);
    const titles = JSON.stringify(await mockApi.getTree());
    expect(titles).toContain('https://a.test');
    expect(titles).not.toContain('https://later.test');
    // The replaced state was snapshotted first, under the safety budget.
    expect((await listSafety(store)).some((e) => e.operation === 'pre-restore')).toBe(true);
  });

  it('the settings message validates, prunes, and switches the alarm', async () => {
    const { core, store, ports } = await unlinkedCore();
    await core.startup();
    const get = () => core.handleMessage({ command: MessageCommand.GetAutoBackup }) as Promise<AutoBackupResponse>;
    expect(await get()).toMatchObject({ enabled: true, everyDays: 1, keep: 7, count: 1 });
    expect((await get()).lastBackupUtc).toBeTruthy();

    await expect(
      core.handleMessage({ command: MessageCommand.SetAutoBackup, enabled: true, everyDays: 2, keep: 7 }),
    ).rejects.toThrow();

    for (let i = 0; i < 4; i++) await runAutoBackup(store, { tree: tree(`x-${i}`) });
    const lowered = (await core.handleMessage({ command: MessageCommand.SetAutoBackup, enabled: true, everyDays: 7, keep: 3 })) as AutoBackupResponse;
    expect(lowered).toMatchObject({ everyDays: 7, keep: 3, count: 3, removed: 2 });

    const off = (await core.handleMessage({ command: MessageCommand.SetAutoBackup, enabled: false, everyDays: 7, keep: 3 })) as AutoBackupResponse;
    expect(off.enabled).toBe(false);
    expect(off.count).toBe(3); // turning it off deletes nothing
    expect(ports.cleared).toContain(AutoBackupAlarmName);
    // The safety-backup count the manager prompts with ignores automatic copies.
    expect(await core.handleMessage({ command: MessageCommand.GetSafetyKeep })).toMatchObject({ count: 0 });
  });

  it('a failed run is reported in Status and retried on the next tick', async () => {
    const { core, store, ports } = await unlinkedCore();
    const realSet = store.set.bind(store);
    let broken = true;
    store.set = (key, value) =>
      broken && String(key).startsWith('safetyFile:') ? Promise.reject(new Error('disk full')) : realSet(key, value);
    await core.startup();
    expect(await autos(store)).toHaveLength(0);
    const status = (await core.handleMessage({ command: MessageCommand.GetStatus })) as StatusResponse;
    expect(status.autoBackupError).toBe('disk full');
    expect(ports.notices).toEqual([]);

    broken = false;
    ports.fire(AutoBackupAlarmName);
    await settle();
    expect(await autos(store)).toHaveLength(1);
    expect(((await core.handleMessage({ command: MessageCommand.GetStatus })) as StatusResponse).autoBackupError).toBeUndefined();
  });
});
