// Background core: owns the sync queue, alarms, native listeners and all
// popup message handling. Platform-agnostic (works in a MV2 background page
// and in a MV3 service worker — no DOM access here).
//
// Queue discipline mirrors app/sync.service.ts: the queue lives only in this
// context; the popup talks to it exclusively through messages.

import { XSyncApiClient } from '../shared/api.js';
import { decryptData, deriveKey, encryptData } from '../shared/crypto.js';
import { compareVersions, DefaultServiceUrl, MinApiVersion, ServiceProbeTimeoutMs, SyncClientVersion } from '../shared/constants.js';
import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  SyncNotFoundException,
  UnexpectedResponseException,
  UnsupportedSyncVersionException,
  UnsupportedVersionException,
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
  type PingResponse,
  type StatusResponse,
  type SwitchPreviewResult,
  type SwitchTarget,
  type SyncJobType,
  type UndoKind,
  type UndoState,
} from '../shared/messages.js';
import { reconcileContainer } from '../shared/reconcile.js';
import { Store, StoreKey, type SyncInfo } from '../shared/store.js';
import {
  checkService,
  createNewSync,
  deleteRemoteSync,
  getStoredHash,
  getStoredRevision,
  persistMeta,
  pullWithDerivedKey,
  pushBookmarks,
  switchService,
  v12Usable,
  type SyncDeps,
} from '../shared/sync.js';
import { SyncQueue, type SyncJob } from '../shared/sync-queue.js';
import { overwriteAll, type NativeAdapter } from './adapter.js';

export const UpdatesAlarmName = 'xbs-sync-updates-check';
export const NativeDebounceAlarmName = 'xbs-native-debounce';

/** Encrypted undo snapshot for one dangerous link operation. */
export interface UndoSlotData {
  kind: UndoKind;
  timestamp: number;
  /** Derived key of the operation side (decrypts localEnc, auths PUT-back). */
  opDerivedKey: string;
  opSyncId: string;
  opServiceUrl: string;
  prevSyncInfo: SyncInfo;
  prevLastUpdated?: string;
  prevBlob?: string;
  /** Encrypted pre-image of the native tree (when natives are overwritten). */
  localEnc?: string;
  localCount?: number;
  /** Encrypted pre-image of the remote blob (when remote is overwritten). */
  remotePreBlob?: string;
}

export interface AlarmPort {
  schedule(name: string, periodMinutes: number): Promise<void>;
  clear(name: string): Promise<void>;
  /** One-shot alarm (debounce-safe: same name overwrites). Survives MV3 SW sleep. */
  once(name: string, whenMs: number): Promise<void>;
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
  private connecting = false;
  /**
   * v1.2 capability per service URL (null = not probed yet). Probed via the
   * extended /info contract; any failure means legacy. Invalidated on 412 so
   * a downgraded service falls back to the timestamp path on retry.
   */
  private readonly v12cache = new Map<string, boolean>();

  constructor(
    private store: Store,
    private idMapper: BookmarkIdMapper,
    private log: IXbsLogger,
    private adapter: NativeAdapter,
    private ports: CorePorts,
    private makeApi: (serviceUrl: string, timeoutMs?: number) => XSyncApiClient = (url, timeoutMs) =>
      new XSyncApiClient(url, this.log, undefined, timeoutMs),
    private options: CoreOptions = {},
  ) {
    this.queue = new SyncQueue((job) => this.runJob(job), log, (err) => this.disableSync(err));
    const onEvent = (): void => this.onNativeEvent();
    ports.listeners.created.add(onEvent);
    ports.listeners.changed.add(onEvent);
    ports.listeners.removed.add(onEvent);
    ports.listeners.moved.add(onEvent);
    ports.alarms.onAlarm((name) => {
      if (name === UpdatesAlarmName) {
        void this.checkForUpdates().catch((err) => this.onBackgroundError(err));
      } else if (name === NativeDebounceAlarmName) {
        this.queue.enqueue('remote', false);
        void this.drain().catch((err) => this.onBackgroundError(err));
      }
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
        return this.connectExisting(msg.serviceUrl, msg.syncId, msg.password, msg.direction);
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
      case MessageCommand.Ping:
        return this.ping();
      case MessageCommand.GetDuplicates:
        return this.getDuplicates();
      case MessageCommand.ExportBackup:
        return this.exportBackup(msg.password);
      case MessageCommand.ImportBackup:
        return this.importBackup(msg.json, msg.password);
      case MessageCommand.SwitchService:
        return this.switchService(msg.switch);
      case MessageCommand.DeleteRemoteSync:
        return this.deleteRemoteSync();
      case MessageCommand.SwitchPreview:
        return this.switchPreview(msg.newServiceUrl, msg.mode, msg.syncId);
      case MessageCommand.SetVerbosity:
        return this.setVerbosity(msg.level);
      case MessageCommand.GetUndoState:
        return this.getUndoState();
      case MessageCommand.UndoLastLink:
        return this.undoLastLink();
      case MessageCommand.DismissUndo:
        return this.clearUndo();
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
    const usable = v12Usable(info);
    // v1.2: extended reads so meta flows (conditional GET when the hash is
    // known, full V12 GET otherwise). A 412 drops to the legacy path.
    if (usable) {
      try {
        const knownHash = await getStoredHash(this.store);
        const full = knownHash
          ? await api.getBookmarksIfChanged(info.id!, knownHash)
          : await api.getBookmarksV12(info.id!);
        if (full === null) {
          this.log.log(XbsLogLevel.Info, 'sync', 'Pull: unchanged (304)');
          return;
        }
        const deps = this.depsFor(api, syncToolbar);
        const pulled = await this.withSuspended(() =>
          pullWithDerivedKey(deps, {
            syncId: info.id!,
            derivedKey: info.password!,
            blob: full.bookmarks ?? '',
            lastUpdated: full.lastUpdated!,
            remoteVersion: full.version ?? undefined,
            meta: full.meta,
            supportsV12: true,
          }, info.serviceUrl),
        );
        if (pulled.updateRemote) {
          const linked = (await this.store.get<SyncInfo>(StoreKey.SyncInfo))!;
          await this.pushCurrent(api, linked, pulled.bookmarks);
        }
        return;
      } catch (err) {
        // Downgraded service: drop the v1.2 flag and retry on the legacy path.
        if (err instanceof UnsupportedVersionException) {
          await this.downgradeV12(info);
        } else {
          throw err;
        }
      }
    }
    const res = await api.getBookmarks(info.id!);
    const deps = this.depsFor(api, syncToolbar);
    const pulled = await this.withSuspended(() =>
      pullWithDerivedKey(deps, {
        syncId: info.id!,
        derivedKey: info.password!,
        blob: res.bookmarks ?? '',
        lastUpdated: res.lastUpdated!,
        remoteVersion: res.version ?? undefined,
        meta: res.meta,
        supportsV12: false,
      }, info.serviceUrl),
    );
    if (pulled.updateRemote) {
      const linked = (await this.store.get<SyncInfo>(StoreKey.SyncInfo))!;
      await this.pushCurrent(api, linked, pulled.bookmarks);
    }
  }

  /**
   * Capability probe, cached per service URL. Any failure means legacy —
   * the caller stays on the v1.1 timestamp path.
   */
  private async isV12(serviceUrl: string): Promise<boolean> {
    const cached = this.v12cache.get(serviceUrl);
    if (cached !== undefined) return cached;
    let probed = false;
    try {
      probed = await this.makeApi(serviceUrl).supportsV12();
    } catch {
      probed = false;
    }
    this.v12cache.set(serviceUrl, probed);
    this.log.log(XbsLogLevel.Debug, 'sync', `Capabilities for ${serviceUrl}: v12=${probed}`);
    return probed;
  }

  /** Forget a stale v1.2 flag after a 412 (downgraded service). */
  private async downgradeV12(info: SyncInfo): Promise<void> {
    this.v12cache.delete(info.serviceUrl ?? DefaultServiceUrl);
    await this.store.set(StoreKey.SyncInfo, { ...info, supportsV12: false });
    await this.store.remove(StoreKey.SyncRevision);
    await this.store.remove(StoreKey.SyncHash);
    this.log.log(XbsLogLevel.Info, 'sync', 'Service no longer speaks v1.2, back on the legacy path');
  }

  /**
   * Push on the best available contract: revision CAS when the link is v1.2
   * and a revision is stored, timestamp otherwise. A 412 (downgraded
   * service) invalidates the flag and retries once on the legacy path.
   */
  private async pushCurrent(api: XSyncApiClient, info: SyncInfo, tree: BookmarkNode[]): Promise<string> {
    if (v12Usable(info)) {
      const baseRevision = await getStoredRevision(this.store);
      if (baseRevision !== undefined) {
        try {
          return await pushBookmarks(api, this.store, info.id!, info.password!, tree, false, baseRevision);
        } catch (err) {
          if (!(err instanceof UnsupportedVersionException)) throw err;
          await this.downgradeV12(info);
        }
      }
    }
    return pushBookmarks(api, this.store, info.id!, info.password!, tree);
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
      await this.pushCurrent(api, info, next);
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
    await this.pushCurrent(api, info, tree);
  }

  // ---------------------------------------------------------- native events

  onNativeEvent(): void {
    // Alarm-based debounce (not setTimeout): creating the same alarm twice
    // overwrites it, and alarms wake a sleeping MV3 service worker.
    void this.ports.alarms
      .once(NativeDebounceAlarmName, Date.now() + (this.options.debounceMs ?? 300))
      .catch((err) => this.onBackgroundError(err));
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
      const v12 = await this.isV12(serviceUrl);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      const prev = await this.capturePrev();
      const { id } = await this.withSuspended(() =>
        createNewSync(this.depsFor(api, syncToolbar), password, serviceUrl, v12),
      );
      const linked = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
      await this.saveUndo({
        kind: 'connect-new',
        opDerivedKey: linked!.password!,
        opSyncId: id,
        opServiceUrl: serviceUrl,
        ...prev,
      });
      await this.afterLink();
      return { id };
    } finally {
      this.connecting = false;
      await this.setBadge(false);
    }
  }

  private async connectExisting(
    serviceUrl: string,
    syncId: string,
    password: string,
    direction: 'pull' | 'push' = 'pull',
  ): Promise<{ id: string }> {
    if (this.connecting) throw new UnexpectedResponseException('Connect already in progress.');
    this.connecting = true;
    await this.setBadge(true);
    try {
      const api = this.makeApi(serviceUrl);
      await checkService(api, this.log);
      const v12 = await this.isV12(serviceUrl);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      if (direction === 'push') {
        await this.connectPushExisting(api, serviceUrl, syncId, password, syncToolbar, v12);
      } else {
        const versionRes = await api.getVersion(syncId);
        const remoteVersion = versionRes.version ?? undefined;
        if (remoteVersion && compareVersions(remoteVersion, SyncClientVersion) > 0) {
          throw new UnsupportedSyncVersionException(
            `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
          );
        }
        const derived = await deriveKey(password, syncId, remoteVersion ?? SyncClientVersion);
        const natives = await this.adapter.readAll(syncToolbar);
        // v1.2 links read the extended shape so meta flows; a 412 falls back
        // to the legacy shape instead of failing the link.
        let res: import('../shared/api.js').GetBookmarksResponse;
        let effectiveV12 = v12;
        if (v12) {
          try {
            res = await api.getBookmarksV12(syncId);
          } catch (err) {
            if (!(err instanceof UnsupportedVersionException)) throw err;
            effectiveV12 = false;
            this.v12cache.set(serviceUrl, false);
            res = await api.getBookmarks(syncId);
          }
        } else {
          res = await api.getBookmarks(syncId);
        }
        await this.saveUndo({
          kind: 'connect-pull',
          opDerivedKey: derived,
          opSyncId: syncId,
          opServiceUrl: serviceUrl,
          ...(await this.capturePrev()),
          localEnc: await encryptData(JSON.stringify(natives), derived),
          localCount: countNodes(natives),
        });
        const pulled = await this.withSuspended(() =>
          pullWithDerivedKey(this.depsFor(api, syncToolbar), {
            syncId,
            derivedKey: derived,
            blob: res.bookmarks ?? '',
            lastUpdated: res.lastUpdated!,
            remoteVersion,
            meta: res.meta,
            supportsV12: effectiveV12,
          }, serviceUrl),
        );
        if (pulled.updateRemote) {
          const linked = (await this.store.get<SyncInfo>(StoreKey.SyncInfo))!;
          await this.pushCurrent(api, linked, pulled.bookmarks);
        }
      }
      await this.afterLink();
      return { id: syncId };
    } finally {
      this.connecting = false;
      await this.setBadge(false);
    }
  }

  /**
   * First-link upload onto an existing sync (migration case, never the
   * default): version gate → password verified by decrypting the remote →
   * safety-backup download of the server copy → PUT local tree based on the
   * remote lastUpdated. A 409 surfaces as a conflict error, nothing is
   * overwritten locally.
   */
  private async connectPushExisting(
    api: XSyncApiClient,
    serviceUrl: string,
    syncId: string,
    password: string,
    syncToolbar: boolean,
    v12: boolean,
  ): Promise<void> {
    const versionRes = await api.getVersion(syncId);
    const remoteVersion = versionRes.version ?? undefined;
    if (remoteVersion && compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(password, syncId, remoteVersion ?? SyncClientVersion);
    // v1.2 links read the extended shape so the upload can use revision CAS.
    const remote = v12 ? await api.getBookmarksV12(syncId) : await api.getBookmarks(syncId);
    const remotePlain = await decryptData(remote.bookmarks ?? '', derived);
    const remoteTree = (remotePlain ? JSON.parse(remotePlain) : []) as BookmarkNode[];
    await this.ports.chrome.download(`keepmark-pre-push-${Date.now()}.json`, JSON.stringify(remoteTree));
    await this.saveUndo({
      kind: 'connect-push',
      opDerivedKey: derived,
      opSyncId: syncId,
      opServiceUrl: serviceUrl,
      ...(await this.capturePrev()),
      remotePreBlob: remote.bookmarks ?? '',
      localCount: countNodes(remoteTree),
    });
    const localTree = await this.withSuspended(async () => {
      const natives = await this.adapter.readAll(syncToolbar);
      const withIds = ensureContainersExist(natives);
      return withIds;
    });
    const encrypted = await encryptData(JSON.stringify(localTree), derived);
    const updated =
      v12 && remote.meta?.revision !== undefined
        ? await api.updateBookmarksV12(syncId, encrypted, remote.meta.revision, false)
        : await api.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
    await this.withSuspended(async () => {
      const mappings = await this.adapter.rebuildMappings(localTree, syncToolbar);
      await this.idMapper.set(mappings);
    });
    await this.store.set(StoreKey.SyncInfo, {
      id: syncId,
      password: derived,
      version: remoteVersion,
      serviceUrl,
      supportsV12: v12,
    });
    await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
    await this.store.set(StoreKey.Bookmarks, encrypted);
    await persistMeta(this.store, updated.meta);
    await this.store.set(StoreKey.SyncEnabled, true);
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
    const { info, syncToolbar } = await this.requireCreds();
    const tree = await importBackup(json, password);
    const count = countNodes(tree);
    const natives = await this.adapter.readAll(syncToolbar);
    const currentBlob = await this.store.get<string>(StoreKey.Bookmarks);
    await this.saveUndo({
      kind: 'import',
      opDerivedKey: info.password!,
      opSyncId: info.id!,
      opServiceUrl: info.serviceUrl ?? DefaultServiceUrl,
      ...(await this.capturePrev()),
      localEnc: await encryptData(JSON.stringify(natives), info.password!),
      localCount: countNodes(natives),
      remotePreBlob: currentBlob,
    });
    await this.withSuspended(async () => {
      const mappings = await overwriteAll(this.adapter, tree, syncToolbar);
      await this.idMapper.set(mappings);
    });
    this.queue.enqueue('remote', false);
    const err = await this.drain();
    if (err) throw err;
    return { count };
  }

  /**
   * Move-service wizard. NOTHING syncs until the popup submits an explicit
   * SwitchTarget (mode + direction + passwords). Both branches start with a
   * plaintext safety-backup download of the scrapped side; the existing
   * branch verifies the password by decrypting BEFORE mutating anything.
   */
  private async switchService(target: SwitchTarget): Promise<{ id: string }> {
    const { info, syncToolbar } = await this.requireCreds();
    const tree = await this.cachedTree(info);
    if (!target.newPassword) throw new IncompleteSyncInfoException('A password is required.');
    if (target.mode === 'existing' && !target.syncId) {
      throw new IncompleteSyncInfoException('A sync ID is required for an existing sync.');
    }
    // Safety-backup of the scrapped side before moving (plaintext, like Keepmark).
    await this.ports.chrome.download(`keepmark-safety-${Date.now()}.json`, JSON.stringify(tree));
    const newApi = this.makeApi(target.newServiceUrl);
    await checkService(newApi, this.log);
    const v12 = await this.isV12(target.newServiceUrl);

    if (target.mode === 'new') {
      const prev = await this.capturePrev();
      const { id } = await switchService(newApi, this.store, tree, target.newPassword, target.newServiceUrl, v12);
      const linked = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
      await this.saveUndo({
        kind: 'switch-new',
        opDerivedKey: linked!.password!,
        opSyncId: id,
        opServiceUrl: target.newServiceUrl,
        ...prev,
      });
      await this.afterLink();
      return { id };
    }

    const syncId = target.syncId!;
    const versionRes = await newApi.getVersion(syncId);
    const remoteVersion = versionRes.version ?? undefined;
    if (remoteVersion && compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(target.newPassword, syncId, remoteVersion ?? SyncClientVersion);
    const remote = v12 ? await newApi.getBookmarksV12(syncId) : await newApi.getBookmarks(syncId);
    // Password check first: throws InvalidCredentials before anything is overwritten.
    await decryptData(remote.bookmarks ?? '', derived);

    if (target.direction === 'pull') {
      const natives = await this.adapter.readAll(syncToolbar);
      await this.saveUndo({
        kind: 'switch-pull',
        opDerivedKey: derived,
        opSyncId: syncId,
        opServiceUrl: target.newServiceUrl,
        ...(await this.capturePrev()),
        localEnc: await encryptData(JSON.stringify(natives), derived),
        localCount: countNodes(natives),
      });
      await this.withSuspended(() =>
        pullWithDerivedKey(this.depsFor(newApi, syncToolbar), {
          syncId,
          derivedKey: derived,
          blob: remote.bookmarks ?? '',
          lastUpdated: remote.lastUpdated!,
          remoteVersion,
          meta: remote.meta,
          supportsV12: v12,
        }, target.newServiceUrl),
      );
    } else {
      // Push the local tree onto the existing remote (revision CAS on v1.2,
      // timestamp otherwise). A 409 surfaces honestly, nothing is lost: the
      // safety backup above plus the undo slot hold the pre-push state.
      await this.saveUndo({
        kind: 'switch-push',
        opDerivedKey: derived,
        opSyncId: syncId,
        opServiceUrl: target.newServiceUrl,
        ...(await this.capturePrev()),
        remotePreBlob: remote.bookmarks ?? '',
        localCount: countNodes(tree),
      });
      const encrypted = await encryptData(JSON.stringify(tree), derived);
      const updated =
        v12 && remote.meta?.revision !== undefined
          ? await newApi.updateBookmarksV12(syncId, encrypted, remote.meta.revision, false)
          : await newApi.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
      await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
      await this.store.set(StoreKey.Bookmarks, encrypted);
      await this.store.set(StoreKey.SyncInfo, {
        id: syncId,
        password: derived,
        version: remoteVersion,
        serviceUrl: target.newServiceUrl,
        supportsV12: v12,
      });
      await persistMeta(this.store, updated.meta);
      await this.store.set(StoreKey.SyncEnabled, true);
    }
    await this.afterLink();
    return { id: syncId };
  }

  private async getDuplicates(): Promise<DuplicateGroup[]> {
    const { info } = await this.requireCreds();
    return getDuplicateGroups(await this.cachedTree(info));
  }

  /**
   * v1.2-only: delete the server copy of the linked sync, then unlink this
   * device (natives are untouched). Gated behind the stored supportsV12 flag:
   * on legacy services it throws UnsupportedVersionException and NOTHING is
   * deleted. There is no server-side undelete, so the safety net is a
   * plaintext backup download taken BEFORE the DELETE plus a double confirm
   * in the UI — deliberately no undo slot (a PUT-back would 401).
   */
  private async deleteRemoteSync(): Promise<{ deleted: boolean }> {
    const { info } = await this.requireCreds();
    if (!v12Usable(info)) {
      throw new UnsupportedVersionException('Not supported (requires service v1.2).');
    }
    const tree = await this.cachedTree(info);
    await this.ports.chrome.download(`keepmark-server-backup-${Date.now()}.json`, JSON.stringify(tree));
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    try {
      await deleteRemoteSync(api, info.id!);
    } catch (err) {
      if (err instanceof UnsupportedVersionException) {
        // Raced a downgrade: persist the downgrade, report honestly.
        await this.downgradeV12(info);
      }
      throw err;
    }
    this.log.log(XbsLogLevel.Info, 'sync', `Server copy ${info.id} deleted, unlinking device`);
    await this.disableSync();
    await this.ports.chrome
      .notify('Server copy deleted', 'The sync was deleted from the service. This device is now unlinked; local bookmarks are untouched.')
      .catch(() => undefined);
    return { deleted: true };
  }

  /**
   * Read-only preflight for the move wizard: service info + version
   * compatibility + (existing mode) remote existence/lastUpdated + local
   * count. Never mutates state, never syncs.
   */
  private async switchPreview(
    newServiceUrl: string,
    mode: 'new' | 'existing',
    syncId?: string,
  ): Promise<SwitchPreviewResult> {
    const { info } = await this.requireCreds();
    const localCount = await this.countCached(info).catch(() => undefined);
    const api = this.makeApi(newServiceUrl, ServiceProbeTimeoutMs);
    let service;
    try {
      // Extended shape when the target speaks v1.2, legacy shape otherwise —
      // either way no mutation, no sync.
      service = await api.getInfoV12().catch((err: unknown) =>
        err instanceof UnsupportedVersionException ? api.getInfo() : Promise.reject(err),
      );
    } catch {
      return { reachable: false, localCount };
    }
    const result: SwitchPreviewResult = {
      reachable: true,
      serviceVersion: service.version ?? undefined,
      versionCompatible: !service.version || compareVersions(service.version, MinApiVersion) >= 0,
      serviceStatus: service.status,
      maxSyncSize: service.maxSyncSize,
      localCount,
      supportsV12: service.capabilities?.revision === true,
    };
    if (mode === 'existing' && syncId) {
      try {
        const remote = await api.getLastUpdated(syncId);
        result.remoteExists = true;
        result.remoteLastUpdated = remote.lastUpdated ?? undefined;
      } catch {
        result.remoteExists = false;
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- undo slot

  /**
   * Single undo slot for dangerous link operations. Snapshots are taken
   * BEFORE any mutation and hold encrypted blobs only (never plaintext at
   * rest, never the raw password). Overwritten by the next dangerous op,
   * cleared on undo/dismiss. Remote PUT-back re-reads the server base, so a
   * concurrent write fails honestly with 409 instead of clobbering.
   */
  private async saveUndo(
    slot: Omit<UndoSlotData, 'timestamp'>,
  ): Promise<void> {
    await this.store.set(StoreKey.UndoSlot, { ...slot, timestamp: Date.now() });
  }

  private async clearUndo(): Promise<{ cleared: boolean }> {
    await this.store.remove(StoreKey.UndoSlot);
    return { cleared: true };
  }

  private async getUndoState(): Promise<UndoState | null> {
    const slot = await this.store.get<UndoSlotData>(StoreKey.UndoSlot);
    if (!slot) return null;
    return {
      kind: slot.kind,
      timestamp: slot.timestamp,
      bookmarkCount: slot.localCount,
      serviceUrl: slot.opServiceUrl,
    };
  }

  private async restoreNatives(tree: BookmarkNode[], syncToolbar: boolean): Promise<void> {
    await this.withSuspended(async () => {
      await this.adapter.clearAndPopulate(tree, syncToolbar);
      await this.idMapper.set(await this.adapter.rebuildMappings(tree, syncToolbar));
    });
  }

  /** Previous link state for undo snapshots (empty when unlinked). */
  private async capturePrev(): Promise<
    Pick<UndoSlotData, 'prevSyncInfo' | 'prevLastUpdated' | 'prevBlob'>
  > {
    return {
      prevSyncInfo: (await this.store.get<SyncInfo>(StoreKey.SyncInfo)) ?? {},
      prevLastUpdated: await this.store.get<string>(StoreKey.LastUpdated),
      prevBlob: await this.store.get<string>(StoreKey.Bookmarks),
    };
  }

  private async restorePrevState(slot: UndoSlotData): Promise<void> {
    await this.store.set(StoreKey.SyncInfo, slot.prevSyncInfo);
    if (slot.prevLastUpdated !== undefined) {
      await this.store.set(StoreKey.LastUpdated, slot.prevLastUpdated);
    } else {
      await this.store.remove(StoreKey.LastUpdated);
    }
    if (slot.prevBlob !== undefined) {
      await this.store.set(StoreKey.Bookmarks, slot.prevBlob);
    } else {
      await this.store.remove(StoreKey.Bookmarks);
    }
    await this.store.set(StoreKey.SyncEnabled, !!slot.prevSyncInfo.id);
  }

  private async undoLastLink(): Promise<{ undone: UndoKind }> {
    const slot = await this.store.get<UndoSlotData>(StoreKey.UndoSlot);
    if (!slot) throw new UnexpectedResponseException('Nothing to undo.');
    const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;

    if (slot.localEnc) {
      const tree = JSON.parse(await decryptData(slot.localEnc, slot.opDerivedKey)) as BookmarkNode[];
      await this.restoreNatives(tree, syncToolbar);
    }
    if (slot.remotePreBlob) {
      const api = this.makeApi(slot.opServiceUrl);
      const fresh = await api.getLastUpdated(slot.opSyncId);
      await api.updateBookmarks(slot.opSyncId, slot.remotePreBlob, fresh.lastUpdated ?? '', false);
    }
    await this.restorePrevState(slot);
    await this.clearUndo();
    this.log.log(XbsLogLevel.Info, 'sync', `Undid ${slot.kind}, previous state restored`);
    return { undone: slot.kind };
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

  /** Persisted log verbosity (XbsLogLevel 0..4, default Info). */
  private async setVerbosity(level: number): Promise<{ level: number }> {
    if (!Number.isInteger(level) || level < XbsLogLevel.Error || level > XbsLogLevel.Verbose) {
      throw new UnexpectedResponseException(`Invalid log level: ${level}`);
    }
    await this.store.set(StoreKey.LogVerbosity, level);
    this.log.minLevel = level as XbsLogLevel;
    return { level };
  }

  private async applyVerbosity(): Promise<void> {
    const level = await this.store.get<number>(StoreKey.LogVerbosity);
    if (level !== undefined && level >= XbsLogLevel.Error && level <= XbsLogLevel.Verbose) {
      this.log.minLevel = level as XbsLogLevel;
    }
  }
  private async getStatus(): Promise<StatusResponse> {
    const syncEnabled = (await this.store.get<boolean>(StoreKey.SyncEnabled)) ?? false;
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    const lastUpdated = await this.store.get<string>(StoreKey.LastUpdated);
    const blob = await this.store.get<string>(StoreKey.Bookmarks);
    return {
      syncEnabled,
      syncId: info?.id,
      serviceUrl: info?.serviceUrl,
      lastUpdated,
      queueLength: this.queue.length,
      syncing: this.queue.syncing || this.connecting,
      usedBytes: blob?.length ?? 0,
      bookmarkCount: info ? await this.countCached(info).catch(() => undefined) : undefined,
      logLevel: this.log.minLevel as number,
      supportsV12: v12Usable(info),
    };
  }

  private async countCached(info: SyncInfo): Promise<number | undefined> {
    const blob = await this.store.get<string>(StoreKey.Bookmarks);
    if (!blob || !info.password) return undefined;
    const plain = await decryptData(blob, info.password);
    return countNodes((plain ? JSON.parse(plain) : []) as BookmarkNode[]);
  }

  /**
   * Fast live probe of the service (3s timeout, never throws): reachability,
   * service status/version/location/message/max size + remote lastUpdated.
   * Powers the popup status card without touching sync state. Also refreshes
   * the stored v1.2 flag (server upgrades heal without relink); an offline
   * probe leaves the flag untouched.
   */
  private async ping(): Promise<PingResponse> {
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (!info?.id) return { reachable: false };
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl, ServiceProbeTimeoutMs);
    try {
      const [service, remote, v12] = await Promise.all([
        api.getInfo(),
        api.getLastUpdated(info.id).catch(() => undefined),
        // undefined = unknown (offline/mid-probe failure): never downgrades.
        api
          .getInfoV12()
          .then((r) => r.capabilities?.revision === true)
          .catch(() => undefined),
      ]);
      if (v12 !== undefined && v12 !== (info.supportsV12 === true)) {
        await this.store.set(StoreKey.SyncInfo, { ...info, supportsV12: v12 });
        this.v12cache.set(info.serviceUrl ?? DefaultServiceUrl, v12);
        this.log.log(XbsLogLevel.Info, 'sync', `Capability refresh for ${info.serviceUrl}: v12=${v12}`);
      }
      return {
        reachable: true,
        status: service.status,
        version: service.version ?? undefined,
        location: service.location ?? undefined,
        message: service.message ?? undefined,
        maxSyncSize: service.maxSyncSize,
        remoteLastUpdated: remote?.lastUpdated ?? undefined,
        supportsV12: v12 ?? v12Usable(info),
      };
    } catch {
      return { reachable: false };
    }
  }

  async disableSync(err?: Error): Promise<void> {
    this.queue.clear();
    await this.ports.alarms.clear(UpdatesAlarmName);
    await this.store.remove(StoreKey.BookmarkIdMappings);
    await this.store.remove(StoreKey.Bookmarks);
    await this.store.remove(StoreKey.LastUpdated);
    await this.store.remove(StoreKey.SyncRevision);
    await this.store.remove(StoreKey.SyncHash);
    await this.store.set(StoreKey.SyncEnabled, false);
    await this.store.set(StoreKey.SyncInfo, {});
    await this.setBadge(false);
    if (err instanceof SyncNotFoundException) {
      await this.ports.chrome.notify('Sync removed', 'The sync was removed from the service.');
    } else if (err) {
      this.log.log(XbsLogLevel.Warning, 'sync', `Sync disabled: ${err.message}`);
    }
  }

  /** First-run / startup: verbosity, snapshot install backup, resume polling when linked. */
  async startup(): Promise<void> {
    await this.applyVerbosity();
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
