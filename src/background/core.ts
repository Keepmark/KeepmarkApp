// Background core: owns the sync queue, alarms, native listeners and all
// popup message handling. Platform-agnostic (works in a MV2 background page
// and in a MV3 service worker — no DOM access here).
//
// Queue discipline mirrors app/sync.service.ts: the queue lives only in this
// context; the popup talks to it exclusively through messages.

import { XSyncApiClient } from '../shared/api.js';
import { decryptData } from '../shared/crypto.js';
import { DefaultServiceUrl } from '../shared/constants.js';
import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  SyncNotFoundException,
  UnexpectedResponseException,
} from '../shared/errors.js';
import type { IXbsLogger } from '../shared/logging.js';
import { XbsLogLevel } from '../shared/logging.js';
import type { BookmarkNode } from '../shared/models.js';
import { ensureContainersExist } from '../shared/bookmarks.js';
import { BookmarkContainer } from '../shared/bookmarks.js';
import { countNodes, exportBackup, importBackup } from '../shared/backup.js';
import { getDuplicateGroups } from '../shared/duplicates.js';
import { BookmarkIdMapper } from '../shared/id-mapper.js';
import {
  MessageCommand,
  type DuplicateGroup,
  type MessagePayload,
  type StatusResponse,
  type SyncJobType,
} from '../shared/messages.js';
import { reconcileContainer } from '../shared/reconcile.js';
import { Store, StoreKey, type SyncInfo } from '../shared/store.js';
import {
  checkService,
  createNewSync,
  pullExistingSync,
  pullWithDerivedKey,
  pushBookmarks,
  switchService,
  type SyncDeps,
} from '../shared/sync.js';
import { SyncQueue, type SyncJob } from '../shared/sync-queue.js';
import { overwriteAll, type NativeAdapter } from './adapter.js';

export const UpdatesAlarmName = 'xbs-sync-updates-check';

export interface AlarmPort {
  schedule(name: string, periodMinutes: number): Promise<void>;
  clear(name: string): Promise<void>;
  onAlarm(cb: (name: string) => void): void;
}

export interface ListenerPort {
  add(handler: () => void): void;
  remove(handler: () => void): void;
}

export interface NativeListenerPort {
  created: ListenerPort;
  changed: ListenerPort;
  removed: ListenerPort;
  moved: ListenerPort;
}

export interface ChromePort {
  setBadge(text: string, title: string): Promise<void>;
  notify(title: string, message: string): Promise<void>;
  download(filename: string, text: string): Promise<void>;
}

export interface CorePorts {
  alarms: AlarmPort;
  listeners: NativeListenerPort;
  chrome: ChromePort;
}

export interface CoreOptions {
  debounceMs?: number;
  pollMinutes?: number;
}

interface Creds {
  info: SyncInfo;
  syncToolbar: boolean;
}

export class BackgroundCore {
  readonly queue: SyncQueue;
  private suspended = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;

  constructor(
    private store: Store,
    private idMapper: BookmarkIdMapper,
    private log: IXbsLogger,
    private adapter: NativeAdapter,
    private ports: CorePorts,
    private makeApi: (serviceUrl: string) => XSyncApiClient = (url) => new XSyncApiClient(url, this.log),
    private options: CoreOptions = {},
  ) {
    this.queue = new SyncQueue((job) => this.runJob(job), log, (err) => this.disableSync(err));
    const onEvent = (): void => this.onNativeEvent();
    ports.listeners.created.add(onEvent);
    ports.listeners.changed.add(onEvent);
    ports.listeners.removed.add(onEvent);
    ports.listeners.moved.add(onEvent);
    ports.alarms.onAlarm((name) => {
      if (name === UpdatesAlarmName) void this.checkForUpdates().catch((err) => this.onBackgroundError(err));
    });
  }

  // ---------------------------------------------------------------- messages

  async handleMessage(msg: MessagePayload): Promise<unknown> {
    switch (msg.command) {
      case MessageCommand.SyncBookmarks:
        return this.queueSync(msg.sync.type, msg.sync.bookmarks);
      case MessageCommand.RestoreBookmarks:
        return this.queueSync('localAndRemote', msg.bookmarks);
      case MessageCommand.ConnectNew:
        return this.connectNew(msg.serviceUrl, msg.password);
      case MessageCommand.ConnectExisting:
        return this.connectExisting(msg.serviceUrl, msg.syncId, msg.password);
      case MessageCommand.AddBookmark:
        return this.addBookmark(msg);
      case MessageCommand.RemoveBookmark:
        return this.removeBookmark(msg.id);
      case MessageCommand.DisableSync:
        return this.disableSync();
      case MessageCommand.GetStatus:
        return this.getStatus();
      case MessageCommand.GetLogs:
        return this.getLogs();
      case MessageCommand.GetDuplicates:
        return this.getDuplicates();
      case MessageCommand.ExportBackup:
        return this.exportBackup(msg.password);
      case MessageCommand.ImportBackup:
        return this.importBackup(msg.json, msg.password);
      case MessageCommand.SwitchService:
        return this.switchService(msg.newServiceUrl, msg.newPassword);
      case MessageCommand.DownloadFile:
        return this.ports.chrome.download(msg.filename, msg.text);
    }
  }

  // ---------------------------------------------------------------- sync jobs

  private async runJob(job: SyncJob): Promise<void> {
    await this.setBadge(true);
    try {
      if (job.type === 'local') await this.doLocalJob();
      else if (job.type === 'remote') await this.pushAfterNativeChange();
      else await this.doRestoreJob(job.bookmarks);
    } finally {
      await this.setBadge(false);
    }
  }

  /** Enqueue through the real queue to keep FIFO order with native events. */
  private async queueSync(type: SyncJobType, bookmarks?: BookmarkNode[]): Promise<{ queued: boolean }> {
    // "Sync now" semantics for manual remote syncs: pull first when the
    // remote moved, then push — a single round trip from the popup.
    if (type === 'remote') {
      await this.checkForUpdates();
    }
    this.queue.enqueue(type, false, bookmarks);
    const err = await this.drain();
    if (err) throw err;
    return { queued: true };
  }

  /** Drain the queue; returns the last error (if the queue is empty). */
  async drain(): Promise<Error | undefined> {
    let last: Error | undefined;
    for (let i = 0; i < 10 && (this.queue.length > 0 || this.queue.syncing); i++) {
      try {
        await this.queue.execute();
      } catch (err) {
        last = err as Error;
      }
      if (this.queue.length === 0 && !this.queue.syncing) break;
    }
    return this.queue.length === 0 ? last : new Error('Sync queue did not drain.');
  }

  private async doLocalJob(): Promise<void> {
    const { info, syncToolbar } = await this.requireCreds();
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    const res = await api.getBookmarks(info.id!);
    const deps = this.depsFor(api, syncToolbar);
    const pulled = await this.withSuspended(() =>
      pullWithDerivedKey(deps, {
        syncId: info.id!,
        derivedKey: info.password!,
        blob: res.bookmarks ?? '',
        lastUpdated: res.lastUpdated!,
        remoteVersion: res.version ?? undefined,
      }, info.serviceUrl),
    );
    if (pulled.updateRemote) {
      await pushBookmarks(api, this.store, info.id!, info.password!, pulled.bookmarks);
    }
  }

  /** Reconcile native -> synced and push when anything changed. */
  async pushAfterNativeChange(): Promise<{ pushed: boolean }> {
    const { info, syncToolbar } = await this.requireCreds();
    if (this.suspended > 0) return { pushed: false };
    const tree = await this.cachedTree(info);
    let mappings = await this.idMapper.all();
    let changed = false;
    let next = tree;
    const containers = this.adapter.syncContainers.filter(
      (c) => syncToolbar || c !== BookmarkContainer.Toolbar,
    );
    for (const container of containers) {
      const natives = await this.adapter.readContainer(container);
      const r = reconcileContainer(natives, container, next, mappings, this.adapter.newTabUrl);
      next = r.bookmarks;
      mappings = r.mappings;
      changed = changed || r.changed;
    }
    if (!changed) {
      this.log.log(XbsLogLevel.Debug, 'sync', 'Native change resolved to no-op');
      return { pushed: false };
    }
    next = ensureContainersExist(next);
    await this.idMapper.set(mappings);
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    try {
      await pushBookmarks(api, this.store, info.id!, info.password!, next);
    } catch (err) {
      if (err instanceof DataOutOfSyncException) {
        // Remote moved under us: stash our uncommitted tree before the
        // queued local job overwrites natives, so nothing is lost silently.
        await this.ports.chrome
          .download(`keepmark-conflict-${Date.now()}.json`, JSON.stringify(next))
          .catch(() => undefined);
        await this.ports.chrome
          .notify('Sync conflict', 'Remote changed first; latest was pulled and your version saved as a conflict file.')
          .catch(() => undefined);
      }
      throw err;
    }
    return { pushed: true };
  }

  private async doRestoreJob(bookmarks?: BookmarkNode[]): Promise<void> {
    if (!bookmarks) throw new UnexpectedResponseException('Nothing to restore.');
    const tree = bookmarks;
    const { info, syncToolbar } = await this.requireCreds();
    await this.withSuspended(async () => {
      const mappings = await overwriteAll(this.adapter, tree, syncToolbar);
      await this.idMapper.set(mappings);
    });
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    await pushBookmarks(api, this.store, info.id!, info.password!, tree);
  }

  // ---------------------------------------------------------- native events

  onNativeEvent(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => {
        this.queue.enqueue('remote', false);
        void this.drain().catch((err) => this.onBackgroundError(err));
      },
      this.options.debounceMs ?? 300,
    );
  }

  async checkForUpdates(): Promise<void> {
    const enabled = await this.store.get<boolean>(StoreKey.SyncEnabled);
    if (!enabled) return;
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (!info?.id) return;
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    const remote = await api.getLastUpdated(info.id);
    const local = await this.store.get<string>(StoreKey.LastUpdated);
    if (remote.lastUpdated && remote.lastUpdated !== local) {
      this.log.log(XbsLogLevel.Info, 'sync', 'Remote is newer, queueing local sync');
      this.queue.enqueue('local', false);
      const err = await this.drain();
      if (err) throw err;
    }
  }

  // ---------------------------------------------------------------- connect

  private async connectNew(serviceUrl: string, password: string): Promise<{ id: string }> {
    if (this.connecting) throw new UnexpectedResponseException('Connect already in progress.');
    this.connecting = true;
    await this.setBadge(true);
    try {
      const api = this.makeApi(serviceUrl);
      await checkService(api, this.log);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      const { id } = await this.withSuspended(() =>
        createNewSync(this.depsFor(api, syncToolbar), password, serviceUrl),
      );
      await this.afterLink();
      return { id };
    } finally {
      this.connecting = false;
      await this.setBadge(false);
    }
  }

  private async connectExisting(serviceUrl: string, syncId: string, password: string): Promise<{ id: string }> {
    if (this.connecting) throw new UnexpectedResponseException('Connect already in progress.');
    this.connecting = true;
    await this.setBadge(true);
    try {
      const api = this.makeApi(serviceUrl);
      await checkService(api, this.log);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      const pulled = await this.withSuspended(() =>
        pullExistingSync(this.depsFor(api, syncToolbar), syncId, password, serviceUrl),
      );
      if (pulled.updateRemote) {
        const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
        await pushBookmarks(api, this.store, syncId, info!.password!, pulled.bookmarks);
      }
      await this.afterLink();
      return { id: syncId };
    } finally {
      this.connecting = false;
      await this.setBadge(false);
    }
  }

  private async afterLink(): Promise<void> {
    await this.ports.alarms.schedule(UpdatesAlarmName, (this.options.pollMinutes ?? 15));
    await this.setBadge(false);
  }

  // -------------------------------------------------------------- mutations

  private async addBookmark(msg: { container: string; parentId?: number; title: string; url?: string }): Promise<{ nativeId: string }> {
    await this.requireCreds();
    const mappings = await this.idMapper.all();
    const nativeId = await this.adapter.addNative(
      { container: msg.container as BookmarkContainer, parentSyncedId: msg.parentId, title: msg.title, url: msg.url },
      mappings,
    );
    // The native listener will reconcile+push; run it eagerly for a faster response.
    const err = await this.pushNow();
    if (err) throw err;
    return { nativeId };
  }

  private async removeBookmark(id: number): Promise<void> {
    await this.requireCreds();
    const mappings = await this.idMapper.all();
    await this.adapter.removeBySyncedId(id, mappings);
    const err = await this.pushNow();
    if (err) throw err;
  }

  private async pushNow(): Promise<Error | undefined> {
    this.queue.enqueue('remote', false);
    return this.drain();
  }

  // ---------------------------------------------------------------- backup

  private async exportBackup(password: string): Promise<string> {
    const { info } = await this.requireCreds();
    const tree = await this.cachedTree(info);
    return exportBackup(tree, password);
  }

  private async importBackup(json: string, password: string): Promise<{ count: number }> {
    const { syncToolbar } = await this.requireCreds();
    const tree = await importBackup(json, password);
    const count = countNodes(tree);
    await this.withSuspended(async () => {
      const mappings = await overwriteAll(this.adapter, tree, syncToolbar);
      await this.idMapper.set(mappings);
    });
    this.queue.enqueue('remote', false);
    const err = await this.drain();
    if (err) throw err;
    return { count };
  }

  private async switchService(newServiceUrl: string, newPassword: string): Promise<{ id: string }> {
    const { info } = await this.requireCreds();
    const tree = await this.cachedTree(info);
    // Safety-backup of the scrapped side before moving (plaintext, like Keepmark).
    await this.ports.chrome.download(`keepmark-safety-${Date.now()}.json`, JSON.stringify(tree));
    const newApi = this.makeApi(newServiceUrl);
    await checkService(newApi, this.log);
    const { id } = await switchService(newApi, this.store, tree, newPassword, newServiceUrl);
    await this.afterLink();
    return { id };
  }

  private async getDuplicates(): Promise<DuplicateGroup[]> {
    const { info } = await this.requireCreds();
    return getDuplicateGroups(await this.cachedTree(info));
  }

  // ---------------------------------------------------------------- status

  /** Last background log entries for the popup log viewer (no secrets by design). */
  private async getLogs(): Promise<{ timestamp: string; level: number; tag: string; message: string }[]> {
    return this.log.entries.slice(-200).map((e) => ({
      timestamp: e.timestamp,
      level: e.level as number,
      tag: e.tag,
      message: e.message,
    }));
  }

  private async getStatus(): Promise<StatusResponse> {    const syncEnabled = (await this.store.get<boolean>(StoreKey.SyncEnabled)) ?? false;
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    const lastUpdated = await this.store.get<string>(StoreKey.LastUpdated);
    return {
      syncEnabled,
      syncId: info?.id,
      serviceUrl: info?.serviceUrl,
      lastUpdated,
      queueLength: this.queue.length,
      syncing: this.queue.syncing || this.connecting,
    };
  }

  async disableSync(err?: Error): Promise<void> {
    this.queue.clear();
    await this.ports.alarms.clear(UpdatesAlarmName);
    await this.store.remove(StoreKey.BookmarkIdMappings);
    await this.store.remove(StoreKey.Bookmarks);
    await this.store.set(StoreKey.SyncEnabled, false);
    await this.store.set(StoreKey.SyncInfo, {});
    await this.setBadge(false);
    if (err instanceof SyncNotFoundException) {
      await this.ports.chrome.notify('Sync removed', 'The sync was removed from the service.');
    } else if (err) {
      this.log.log(XbsLogLevel.Warning, 'sync', `Sync disabled: ${err.message}`);
    }
  }

  /** First-run / startup: snapshot install backup, resume polling when linked. */
  async startup(): Promise<void> {
    try {
      const snapshot = await this.adapter.readAll(true);
      await this.store.set(StoreKey.InstallBackup, JSON.stringify(snapshot));
    } catch (err) {
      this.log.log(XbsLogLevel.Warning, 'sync', `Install backup failed: ${(err as Error).message}`);
    }
    const enabled = await this.store.get<boolean>(StoreKey.SyncEnabled);
    if (enabled) {
      await this.ports.alarms.schedule(UpdatesAlarmName, this.options.pollMinutes ?? 15);
      await this.checkForUpdates().catch((err) => this.onBackgroundError(err));
    }
    await this.setBadge(false);
  }

  // ---------------------------------------------------------------- helpers

  private depsFor(api: XSyncApiClient, syncToolbar: boolean): SyncDeps {
    return { api, store: this.store, native: this.adapter, idMapper: this.idMapper, log: this.log, syncToolbar };
  }

  private async requireCreds(): Promise<Creds> {
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (!info?.id || !info.password) throw new IncompleteSyncInfoException('Sync is not connected.');
    const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
    return { info, syncToolbar };
  }

  private async cachedTree(info: SyncInfo): Promise<BookmarkNode[]> {
    const blob = await this.store.get<string>(StoreKey.Bookmarks);
    if (!blob) throw new IncompleteSyncInfoException('No cached bookmarks.');
    const plain = await decryptData(blob, info.password!);
    return (plain ? JSON.parse(plain) : []) as BookmarkNode[];
  }

  private async withSuspended<T>(fn: () => Promise<T>): Promise<T> {
    this.suspended += 1;
    try {
      return await fn();
    } finally {
      this.suspended -= 1;
    }
  }

  private async setBadge(syncing: boolean): Promise<void> {
    const enabled = await this.store.get<boolean>(StoreKey.SyncEnabled).catch(() => false);
    await this.ports.chrome
      .setBadge(syncing ? '…' : enabled ? '' : '!', syncing ? 'Syncing…' : enabled ? 'Synced' : 'Not synced')
      .catch(() => undefined);
  }

  private onBackgroundError(err: unknown): void {
    this.log.log(XbsLogLevel.Warning, 'sync', `Background error: ${(err as Error)?.message ?? err}`);
    void this.setBadge(false);
  }
}
