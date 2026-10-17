import { describe, expect, it, vi } from 'vitest';
import { BackgroundCore, type CorePorts } from '../src/background/core';
import type { NativeAdapter } from '../src/background/adapter';
import type { XSyncApiClient } from '../src/shared/api';
import { deriveKey, encryptData } from '../src/shared/crypto';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand } from '../src/shared/messages';
import { MemoryBackend, Store, StoreKey, type SyncInfo } from '../src/shared/store';
import { InvalidServiceException, ServiceOfflineException, SyncNotFoundException } from '../src/shared/errors';

const password = ' Synthetic è+日本語 😀 ';
const id = '0123456789abcdef0123456789abcdef';

async function setup() {
  const backend = new MemoryBackend();
  const store = new Store(backend);
  const derived = await deriveKey(password, id, '1.8.0');
  const info: SyncInfo = { id, password: derived, serviceUrl: 'https://sync.example.test:8443/prefix', version: '1.8.0' };
  await store.set(StoreKey.SyncInfo, info);
  await store.set(StoreKey.SyncEnabled, true);
  await store.set(StoreKey.Bookmarks, 'local-cache-must-not-be-read-or-replaced');
  const remote = { bookmarks: await encryptData('[]', derived), version: '1.8.0', lastUpdated: 'remote-newer' };
  const api = {
    getBookmarks: vi.fn(async () => remote),
    getInfo: vi.fn(), getInfoV12: vi.fn(), supportsV12: vi.fn(),
    getBookmarksV12: vi.fn(), getBookmarksIfChanged: vi.fn(),
    createSync: vi.fn(), createSyncV12: vi.fn(),
    updateBookmarks: vi.fn(), updateBookmarksV12: vi.fn(), deleteBookmarks: vi.fn(),
  };
  const listener = { add: vi.fn(), remove: vi.fn() };
  const ports: CorePorts = {
    alarms: { schedule: vi.fn(), clear: vi.fn(), once: vi.fn(), onAlarm: vi.fn() },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: { setBadge: vi.fn(), notify: vi.fn(), download: vi.fn() },
  };
  const adapter = {
    readAll: vi.fn(), clearAndPopulate: vi.fn(), rebuildMappings: vi.fn(), readContainer: vi.fn(),
    removeBySyncedId: vi.fn(), addNative: vi.fn(), rootKey: vi.fn(),
  };
  const makeApi = vi.fn(() => api as unknown as XSyncApiClient);
  const core = new BackgroundCore(store, new BookmarkIdMapper(store), new InMemoryLogger(), adapter as unknown as NativeAdapter, ports, makeApi);
  const writes = vi.spyOn(backend, 'set');
  const removes = vi.spyOn(backend, 'remove');
  async function unchanged() {
    expect(writes).not.toHaveBeenCalled();
    expect(removes).not.toHaveBeenCalled();
    expect(await store.get(StoreKey.SyncInfo)).toEqual(info);
    expect(await store.get(StoreKey.SyncEnabled)).toBe(true);
    expect(await store.get(StoreKey.Bookmarks)).toBe('local-cache-must-not-be-read-or-replaced');
    for (const mock of Object.values(api)) if (mock !== api.getBookmarks) expect(mock).not.toHaveBeenCalled();
    for (const mock of Object.values(adapter)) expect(mock).not.toHaveBeenCalled();
    expect(ports.chrome.download).not.toHaveBeenCalled();
  }
  return { core, store, api, info, remote, makeApi, writes, unchanged };
}

const request = (currentPassword = password) => ({ command: MessageCommand.PrepareConnectQr, currentPassword } as const);

describe('read-only prepare-connect-qr', () => {
  it('rejects wrong passwords before any remote request or mutation', async () => {
    const ctx = await setup();
    await expect(ctx.core.handleMessage(request('wrong'))).rejects.toThrow();
    expect(ctx.makeApi).not.toHaveBeenCalled();
    expect(ctx.api.getBookmarks).not.toHaveBeenCalled();
    await ctx.unchanged();
  });

  it('verifies the remote blob and returns the original password without adopting data', async () => {
    const ctx = await setup();
    expect(await ctx.core.handleMessage(request())).toEqual({ app: 'Keepmark', format: 1, serviceType: 'xbrowsersync',
      serviceUrl: ctx.info.serviceUrl, id, version: '1.8.0', password });
    expect(ctx.api.getBookmarks).toHaveBeenCalledOnce();
    expect(ctx.api.getBookmarks).toHaveBeenCalledWith(id);
    await ctx.unchanged();
  });

  it.each([new ServiceOfflineException('offline'), new SyncNotFoundException('401'), new InvalidServiceException('404')])('keeps credentials intact after remote failure %s', async (error) => {
    const ctx = await setup();
    ctx.api.getBookmarks.mockRejectedValueOnce(error);
    await expect(ctx.core.handleMessage(request())).rejects.toThrow();
    await ctx.unchanged();
  });

  it.each(['9.0.0', '', '1.8.0'])('rejects unsupported/legacy versions or an undecryptable remote blob (%s)', async (version) => {
    const ctx = await setup();
    ctx.remote.version = version;
    if (version === '1.8.0') ctx.remote.bookmarks = await encryptData('[]', await deriveKey('changed remotely', id, '1.8.0'));
    await expect(ctx.core.handleMessage(request())).rejects.toThrow();
    await ctx.unchanged();
  });

  it.each(['id', 'password', 'serviceUrl', 'version', 'disabled'])('discards a response after identity change: %s', async (field) => {
    const ctx = await setup();
    ctx.api.getBookmarks.mockImplementationOnce(async () => {
      if (field === 'disabled') await ctx.store.set(StoreKey.SyncEnabled, false);
      else await ctx.store.set(StoreKey.SyncInfo, { ...ctx.info, [field]: field === 'version' ? '1.7.0' : 'changed' });
      return ctx.remote;
    });
    await expect(ctx.core.handleMessage(request())).rejects.toThrow();
    expect(ctx.writes).toHaveBeenCalledOnce(); // only the simulated external change
  });

  it('rejects identity changed while password derivation is in flight, before GET', async () => {
    const ctx = await setup();
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'deriveKey').mockImplementation(async (...args) => {
      markStarted();
      await gate;
      return derive(...args);
    });
    try {
      const result = ctx.core.handleMessage(request());
      const rejected = expect(result).rejects.toThrow();
      await started;
      await ctx.store.set(StoreKey.SyncInfo, { ...ctx.info, id: 'changed-during-derive' });
      release();
      await rejected;
      expect(ctx.api.getBookmarks).not.toHaveBeenCalled();
      expect(ctx.writes).toHaveBeenCalledOnce();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('rejects QR preparation while credentials are already changing', async () => {
    const ctx = await setup();
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'deriveKey').mockImplementation(async (...args) => {
      markStarted();
      await gate;
      return derive(...args);
    });
    try {
      const change = ctx.core.handleMessage({ command: MessageCommand.ChangePassword, currentPassword: 'wrong', newPassword: 'synthetic replacement' });
      const rejectedChange = expect(change).rejects.toThrow();
      await started;
      await expect(ctx.core.handleMessage(request())).rejects.toThrow();
      expect(ctx.api.getBookmarks).not.toHaveBeenCalled();
      release();
      await rejectedChange;
      await ctx.unchanged();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('rejects an empty remote blob because it cannot verify credentials remotely', async () => {
    const ctx = await setup();
    ctx.remote.bookmarks = '';
    await expect(ctx.core.handleMessage(request())).rejects.toThrow();
    await ctx.unchanged();
  });

  it('never exposes QR credentials through GetStatus', async () => {
    const ctx = await setup();
    await ctx.core.handleMessage(request());
    const status = await ctx.core.handleMessage({ command: MessageCommand.GetStatus });
    const json = JSON.stringify(status);
    expect(json).not.toContain(password);
    expect(json).not.toContain(ctx.info.password);
    expect(status).not.toHaveProperty('password');
    expect(status).not.toHaveProperty('connectQr');
    expect(status).not.toHaveProperty('payload');
  });

  it('allows content metadata to change while identity stays the same', async () => {
    const ctx = await setup();
    ctx.api.getBookmarks.mockImplementationOnce(async () => {
      await ctx.store.set(StoreKey.LastUpdated, 'new timestamp');
      await ctx.store.set(StoreKey.SyncRevision, 42);
      return ctx.remote;
    });
    await expect(ctx.core.handleMessage(request())).resolves.toMatchObject({ id, password });
    expect(ctx.writes).toHaveBeenCalledTimes(2);
  });

  it('rejects a disabled sync before network access', async () => {
    const ctx = await setup();
    await ctx.store.set(StoreKey.SyncEnabled, false);
    await expect(ctx.core.handleMessage(request())).rejects.toThrow();
    expect(ctx.api.getBookmarks).not.toHaveBeenCalled();
  });
});
