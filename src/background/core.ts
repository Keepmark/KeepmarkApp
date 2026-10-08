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
  InvalidCredentialsException,
  ServiceOfflineException,
  SyncNotFoundException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedSyncVersionException,
  UnsupportedVersionException,
  ConflictCapturedException,
} from '../shared/errors.js';
import type { IXbsLogger } from '../shared/logging.js';
import { sanitizeSyncId, XbsLogLevel } from '../shared/logging.js';
import type { BookmarkNode } from '../shared/models.js';
import { ensureContainersExist, repairBookmarkIds, validateBookmarkIds } from '../shared/bookmarks.js';
import { BookmarkContainer } from '../shared/bookmarks.js';
import { countNodes, exportBackup, importBackup } from '../shared/backup.js';
import { deleteByIds, getDuplicateGroups } from '../shared/duplicates.js';
import { mergeTrees, type MergeStats } from '../shared/merge.js';
import { diffTrees, sameContent } from '../shared/tree-diff.js';
import {
  deleteSafety,
  listSafety,
  readSafetyTree,
  rekeySafety,
  writeSafety,
  type SafetyEntry,
} from '../shared/safety.js';
import { BookmarkIdMapper } from '../shared/id-mapper.js';
import {
  MessageCommand,
  type DuplicateGroup,
  type MessagePayload,
  type PingResponse,
  type RemovedSyncSnapshot,
  type StatusResponse,
  type SwitchPreviewResult,
  type SwitchTarget,
  type SyncJobType,
  type UndoKind,
  type UndoState,
  // Conflict resolution types
  type ConflictStateResponse,
  type ConflictPreviewResponse,
  type ConflictResolutionDirection,
} from '../shared/messages.js';
import { reconcileContainer } from '../shared/reconcile.js';
import { Store, StoreKey, type SyncInfo } from '../shared/store.js';
import {
  checkService,
  createNewSync,
  deleteRemoteSync,
  describeMoveResult,
  getStoredHash,
  getStoredRevision,
  persistMeta,
  pullWithDerivedKey,
  pushBookmarks,
  pushEncrypted,
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
  /** Whether the op side spoke v1.2 (best-effort server cleanup on undo). */
  opSupportsV12?: boolean;
  prevSyncInfo: SyncInfo;
  prevLastUpdated?: string;
  prevBlob?: string;
  /** Stored v1.2 revision/hash of the previous link (elsewhere a wrong base). */
  prevRevision?: number;
  prevHash?: string;
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
  /** Chromium-only (absent on Firefox): fires on reorder without move. */
  childrenReordered?: ListenerPort;
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

/** Persisted conflict (StoreKey.ConflictState). The local tree is encrypted
 *  under the link key, like every other stored tree. */
interface StoredConflict {
  syncId: string;
  localEnc: string;
  localCount: number;
  remoteLastUpdated: string;
  capturedAt: string;
}

interface ConflictData {
  localTree: BookmarkNode[];
  localEncrypted: string;
  localCount: number;
  remoteLastUpdated: string;
}

export class BackgroundCore {
  readonly queue: SyncQueue;
  private suspended = 0;
  /** Native change arrived while suspended: re-schedule on release. */
  private dirtyDuringSuspend = false;
  private connecting = false;
  private started = false;
  /** In-flight drain shared by concurrent callers (no false "did not drain"). */
  private drainFlight?: Promise<Error | undefined>;
  private disabling = false;
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
    // Chromium-only: reorder without move (e.g. "sort by name") emits only
    // this event upstream. Absent on Firefox — optional port.
    ports.listeners.childrenReordered?.add(onEvent);
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
      case MessageCommand.PreviewMerge:
        return this.previewMerge(msg.serviceUrl, msg.syncId, msg.password);
      case MessageCommand.SetVerbosity:
        return this.setVerbosity(msg.level);
      case MessageCommand.GetUndoState:
        return this.getUndoState();
      case MessageCommand.UndoLastLink:
        return this.undoLastLink();
      case MessageCommand.DismissUndo:
        return this.clearUndo();
      case MessageCommand.GetRemovedSync:
        return this.getRemovedSync();
      case MessageCommand.ClearRemovedSync:
        await this.store.remove(StoreKey.RemovedSync);
        return { cleared: true };
      case MessageCommand.ChangePassword:
        return this.changePassword(msg.currentPassword, msg.newPassword);
      case MessageCommand.GetToolbarSync:
        return { enabled: (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true };
      case MessageCommand.SetToolbarSync:
        await this.store.set(StoreKey.SyncBookmarksToolbar, msg.enabled);
        return { enabled: msg.enabled };
      case MessageCommand.PreviewBackup:
        return this.previewBackup(msg.json, msg.password);
      case MessageCommand.GetSafetyList:
        return listSafety(this.store);
      case MessageCommand.RestoreSafety:
        return this.restoreSafety(msg.fileName);
      case MessageCommand.DeleteSafety:
        return { deleted: await deleteSafety(this.store, msg.fileName) };
      case MessageCommand.RemoveDuplicates:
        return this.removeDuplicates(msg.ids);
      case MessageCommand.DownloadFile:
        return this.ports.chrome.download(msg.filename, msg.text);
      // Conflict resolution
      case MessageCommand.GetConflictState:
        return this.getConflictState();
      case MessageCommand.GetConflictPreview:
        return this.getConflictPreview();
      case MessageCommand.ResolveConflict:
        return this.resolveConflict(msg.direction);
      default:
        throw new UnexpectedResponseException(`Unknown command: ${(msg as { command: string }).command}`);
    }
  }

  // ---------------------------------------------------------------- sync jobs

  private async runJob(job: SyncJob): Promise<void> {
    await this.setBadge(true);
    try {
      if (job.type === 'local') await this.doLocalJob();
      else if (job.type === 'remote') {
        const result = await this.pushAfterNativeChange();
        // If conflict captured, throw signal to stop queue — UI will resolve.
        if (result.conflict) throw new ConflictCapturedException();
      }
      else await this.doRestoreJob(job.bookmarks);
    } finally {
      await this.setBadge(false);
    }
  }

  /** Enqueue through the real queue to keep FIFO order with native events. */
  private async queueSync(type: SyncJobType, bookmarks?: BookmarkNode[]): Promise<{ queued: boolean; conflict?: boolean }> {
    // "Sync now" semantics for manual remote syncs: pull first when the
    // remote moved, then push — a single round trip from the popup.
    if (type === 'remote') {
      await this.checkForUpdates();
    }
    this.queue.enqueue(type, false, bookmarks);
    const err = await this.drain();
    if (err) {
      if (err instanceof ConflictCapturedException) {
        return { queued: true, conflict: true };
      }
      throw err;
    }
    return { queued: true };
  }

  /** Drain the queue; concurrent callers share one flight. Returns the last error. */
  async drain(): Promise<Error | undefined> {
    this.drainFlight ??= this.runDrain().finally(() => {
      this.drainFlight = undefined;
    });
    return this.drainFlight;
  }

  private async runDrain(): Promise<Error | undefined> {
    let last: Error | undefined;
    for (let i = 0; i < 10 && (this.queue.length > 0 || this.queue.syncing); i++) {
      try {
        await this.queue.execute();
      } catch (err) {
        last = err as Error;
        // Conflict captured for user resolution: stop queue, return signal.
        if (err instanceof ConflictCapturedException) return err;
        // Offline/throttled requeue the job at the front: retrying immediately
        // would hammer the service in a tight loop — stop and let the next
        // event/alarm retry instead.
        if (err instanceof ServiceOfflineException || err instanceof ThrottledException) break;
      }
      if (this.queue.length === 0 && !this.queue.syncing) break;
    }
    if (this.queue.length === 0) return last;
    return new Error('Sync queue did not drain.', { cause: last });
  }

  /**
   * Flush pending queue jobs before a direct GET+PUT sequence (connect-push,
   * switch, password change, undo, delete) so the pre-read sees a quiescent
   * state. Errors are swallowed: the operation reports its own outcome.
   */
  private async quiesce(): Promise<void> {
    await this.drain().catch(() => undefined);
  }

  private async doLocalJob(): Promise<void> {
    const { info, syncToolbar } = await this.requireCreds();
    // A pending conflict waits for the user: never pull over it.
    if (await this.hasConflict()) {
      this.log.log(XbsLogLevel.Info, 'sync', 'Pull skipped: conflict pending user resolution');
      return;
    }
    // Native edits that never reached the server (offline push, then the
    // in-memory queue died with an MV3 worker sleep / browser restart) would
    // be wiped by clearAndPopulate. Surface them as a conflict instead.
    if (await this.store.get<string>(StoreKey.Bookmarks)) {
      const pending = await this.reconcileNatives(info, syncToolbar);
      const local = ensureContainersExist(pending.next);
      // Only REAL unpushed content counts: a reconcile that flags a change
      // but yields the cached content (id/mapping noise) is not an edit, and
      // a local side the server already holds loses nothing by pulling.
      if (pending.changed && !sameContent(local, ensureContainersExist(await this.cachedTree(info)))) {
        const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
        const { res, tree: remoteTree } = await this.fetchRemote(api, info);
        if (!sameContent(local, ensureContainersExist(remoteTree))) {
          await this.captureConflict(info, local, res.lastUpdated ?? '');
          throw new ConflictCapturedException();
        }
        this.log.log(XbsLogLevel.Info, 'sync', 'Unpushed local edits already on the server: pulling, no conflict');
      }
    }
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
   * Capability probe, cached per service URL. Only decisive answers are
   * cached (extended or legacy shape alike); transport failures stay
   * uncached so a network blip never pins the session to the legacy path.
   */
  private async isV12(serviceUrl: string): Promise<boolean> {
    const cached = this.v12cache.get(serviceUrl);
    if (cached !== undefined) return cached;
    try {
      const res = await this.makeApi(serviceUrl).getInfoV12();
      const probed = res.capabilities?.revision === true;
      this.v12cache.set(serviceUrl, probed);
      this.log.log(XbsLogLevel.Debug, 'sync', `Capabilities for ${serviceUrl}: v12=${probed}`);
      return probed;
    } catch {
      this.log.log(XbsLogLevel.Debug, 'sync', `Capabilities probe failed for ${serviceUrl}, treating as legacy (uncached)`);
      return false;
    }
  }

  /**
   * Forget a stale v1.2 flag after a 412 (downgraded service). Re-reads the
   * stored link first so a concurrent ping refresh or password rotation is
   * never clobbered — only the capability flag is patched.
   */
  private async downgradeV12(info: SyncInfo): Promise<void> {
    this.v12cache.delete(info.serviceUrl ?? DefaultServiceUrl);
    const current = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (current?.id === info.id) {
      await this.store.set(StoreKey.SyncInfo, { ...current, supportsV12: false });
    }
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
  async pushAfterNativeChange(): Promise<{ pushed: boolean; conflict?: boolean }> {
    const { info, syncToolbar } = await this.requireCreds();
    if (this.suspended > 0) {
      // Lost otherwise: the debounce alarm is one-shot and already consumed.
      // Remember it and re-schedule when the suspend window closes.
      this.dirtyDuringSuspend = true;
      return { pushed: false };
    }
    const { next: reconciled, mappings, changed } = await this.reconcileNatives(info, syncToolbar);
    if (await this.hasConflict()) {
      // Conflict pending: keep the stored local side current (the user's
      // latest edits are what "Upload local" / "Merge" will use), no push.
      if (changed) await this.captureConflict(info, ensureContainersExist(reconciled), undefined, false);
      return { pushed: false, conflict: true };
    }
    if (!changed) {
      this.log.log(XbsLogLevel.Debug, 'sync', 'Native change resolved to no-op');
      return { pushed: false };
    }
    const next = ensureContainersExist(reconciled);
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    try {
      await this.pushCurrent(api, info, next);
      // Mappings follow the pushed tree only once the server accepted it: on a
      // 409 the cached tree stays the reconcile base, with matching mappings.
      await this.idMapper.set(mappings);
      return { pushed: true };
    } catch (err) {
      if (err instanceof DataOutOfSyncException) {
        // Remote moved under us. If it already holds exactly our content
        // (another device made the same change, or merged us in), adopt it:
        // that is not a conflict. Otherwise persist it for the user.
        const fresh = await this.fetchRemote(api, info).catch(() => undefined);
        if (fresh && sameContent(next, ensureContainersExist(fresh.tree))) {
          await this.adoptRemote(api, info, syncToolbar, fresh.res);
          return { pushed: false };
        }
        await this.captureConflict(info, next, fresh?.res.lastUpdated ?? '');
        return { pushed: false, conflict: true };
      }
      throw err;
    }
  }

  /** Pure native -> synced pass over the cached tree (nothing persisted). */
  private async reconcileNatives(
    info: SyncInfo,
    syncToolbar: boolean,
  ): Promise<{ next: BookmarkNode[]; mappings: Awaited<ReturnType<BookmarkIdMapper['all']>>; changed: boolean }> {
    let next = await this.cachedTree(info);
    let mappings = await this.idMapper.all();
    let changed = false;
    const containers = this.adapter.syncContainers.filter(
      (c) => syncToolbar || c !== BookmarkContainer.Toolbar,
    );
    for (const container of containers) {
      const natives = await this.adapter.readContainer(container);
      const r = reconcileContainer(
        natives,
        container,
        next,
        mappings,
        this.adapter.newTabUrl,
        this.adapter.isSeparatorNode,
      );
      next = r.bookmarks;
      mappings = r.mappings;
      changed = changed || r.changed;
    }
    return { next, mappings, changed };
  }

  // ------------------------------------------------------------- conflicts

  private async hasConflict(): Promise<boolean> {
    return (await this.store.get<StoredConflict>(StoreKey.ConflictState)) !== undefined;
  }

  /**
   * Persist (or refresh) the pending conflict. `notify` = first capture: also
   * stash the plaintext conflict file + system notification (safety net).
   * `remoteLastUpdated` undefined keeps the previously captured value.
   */
  private async captureConflict(
    info: SyncInfo,
    localTree: BookmarkNode[],
    remoteLastUpdated?: string,
    notify = true,
  ): Promise<void> {
    const prev = await this.store.get<StoredConflict>(StoreKey.ConflictState);
    await this.store.set(StoreKey.ConflictState, {
      syncId: info.id!,
      localEnc: await encryptData(JSON.stringify(localTree), info.password!),
      localCount: countNodes(localTree),
      remoteLastUpdated: remoteLastUpdated ?? prev?.remoteLastUpdated ?? '',
      capturedAt: prev?.capturedAt ?? new Date().toISOString(),
    } satisfies StoredConflict);
    if (!notify) return;
    this.log.log(XbsLogLevel.Warning, 'sync', 'Sync conflict captured, waiting for user resolution');
    await this.ports.chrome
      .download(`keepmark-conflict-${Date.now()}.json`, JSON.stringify(localTree))
      .catch(() => undefined);
    await this.ports.chrome
      .notify('Sync conflict', 'Remote changed first. Open the manager to resolve.')
      .catch(() => undefined);
  }

  private async loadConflict(info: SyncInfo): Promise<ConflictData | null> {
    const stored = await this.store.get<StoredConflict>(StoreKey.ConflictState);
    if (!stored) return null;
    if (stored.syncId !== info.id) {
      // Belongs to a previous link: meaningless now.
      await this.store.remove(StoreKey.ConflictState);
      return null;
    }
    const plain = await decryptData(stored.localEnc, info.password!);
    return {
      localTree: (plain ? JSON.parse(plain) : []) as BookmarkNode[],
      localEncrypted: stored.localEnc,
      localCount: stored.localCount,
      remoteLastUpdated: stored.remoteLastUpdated,
    };
  }

  /** Remote tree on the link's best contract (412 → downgrade + legacy). */
  private async fetchRemote(
    api: XSyncApiClient,
    info: SyncInfo,
  ): Promise<{ res: import('../shared/api.js').GetBookmarksResponse; tree: BookmarkNode[] }> {
    let res: import('../shared/api.js').GetBookmarksResponse;
    if (v12Usable(info)) {
      try {
        res = await api.getBookmarksV12(info.id!);
      } catch (err) {
        if (!(err instanceof UnsupportedVersionException)) throw err;
        await this.downgradeV12(info);
        res = await api.getBookmarks(info.id!);
      }
    } else {
      res = await api.getBookmarks(info.id!);
    }
    if (res.version && compareVersions(res.version, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${res.version} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const plain = await decryptData(res.bookmarks ?? '', info.password!);
    let tree: BookmarkNode[];
    try {
      tree = (plain ? JSON.parse(plain) : []) as BookmarkNode[];
    } catch (err) {
      throw new UnexpectedResponseException('Remote sync data is corrupted.', { cause: err });
    }
    return { res, tree };
  }

  /** Pull a remote that was just downloaded (natives, cache, meta, mappings). */
  private async adoptRemote(
    api: XSyncApiClient,
    info: SyncInfo,
    syncToolbar: boolean,
    res: import('../shared/api.js').GetBookmarksResponse,
  ): Promise<void> {
    await this.withSuspended(() =>
      pullWithDerivedKey(this.depsFor(api, syncToolbar), {
        syncId: info.id!,
        derivedKey: info.password!,
        blob: res.bookmarks ?? '',
        lastUpdated: res.lastUpdated!,
        remoteVersion: res.version ?? info.version,
        meta: res.meta,
        supportsV12: v12Usable(info),
      }, info.serviceUrl),
    );
  }

  /**
   * A stored conflict whose local side equals the server copy (e.g. the
   * other device merged us in meanwhile) has nothing to resolve: adopt the
   * remote and clear it. Returns true when it was dropped.
   */
  private async dropPhantomConflict(info: SyncInfo, syncToolbar: boolean): Promise<boolean> {
    const conflict = await this.loadConflict(info);
    if (!conflict) return false;
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    const { res, tree } = await this.fetchRemote(api, info);
    if (!sameContent(ensureContainersExist(conflict.localTree), ensureContainersExist(tree))) return false;
    await this.adoptRemote(api, info, syncToolbar, res);
    await this.store.remove(StoreKey.ConflictState);
    this.log.log(XbsLogLevel.Info, 'sync', 'Conflict cleared: both sides already hold the same bookmarks');
    return true;
  }

  /**
   * PUT `tree` on the base of the remote just read (`res`) — never on the
   * stored base, which is exactly what caused the conflict.
   */
  private async pushOnBase(
    api: XSyncApiClient,
    info: SyncInfo,
    tree: BookmarkNode[],
    res: import('../shared/api.js').GetBookmarksResponse,
  ): Promise<string> {
    const encrypted = await encryptData(JSON.stringify(tree), info.password!);
    const rev = v12Usable(info) ? res.meta?.revision : undefined;
    try {
      return await pushEncrypted(api, this.store, info.id!, encrypted, res.lastUpdated!, false, rev);
    } catch (err) {
      if (!(err instanceof UnsupportedVersionException) || rev === undefined) throw err;
      await this.downgradeV12(info);
      return pushEncrypted(api, this.store, info.id!, encrypted, res.lastUpdated!);
    }
  }

  private async doRestoreJob(bookmarks?: BookmarkNode[]): Promise<void> {
    if (!bookmarks) throw new UnexpectedResponseException('Nothing to restore.');
    const tree = bookmarks;
    const { info, syncToolbar } = await this.requireCreds();
    // Restore overwrites natives: snapshot first like every mutating flow.
    const natives = await this.adapter.readAll(syncToolbar);
    // Fail-closed safety net alongside the undo slot.
    await writeSafety(this.store, {
      operation: 'restore',
      side: 'local',
      tree: natives,
      syncId: info.id,
      derivedKey: info.password,
    });
    const currentBlob = await this.store.get<string>(StoreKey.Bookmarks);
    await this.saveUndo({
      kind: 'restore',
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
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    await this.pushCurrent(api, info, tree);
  }

  // ---------------------------------------------------------- native events

  onNativeEvent(): void {
    // Alarm-based debounce (not setTimeout): creating the same alarm twice
    // overwrites it, and alarms wake a sleeping MV3 service worker.
    // Never schedule while unlinked: a pending alarm firing after disable
    // would only produce queue noise.
    void this.store
      .get<boolean>(StoreKey.SyncEnabled)
      .then((enabled) => {
        if (!enabled) return;
        return this.ports.alarms.once(NativeDebounceAlarmName, Date.now() + (this.options.debounceMs ?? 300));
      })
      .catch((err) => this.onBackgroundError(err));
  }

  async checkForUpdates(): Promise<void> {
    const enabled = await this.store.get<boolean>(StoreKey.SyncEnabled);
    if (!enabled) return;
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (!info?.id) return;
    if (await this.hasConflict()) {
      // Phantom conflicts clear themselves; real ones wait for the user.
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      if (!(await this.dropPhantomConflict(info, syncToolbar).catch(() => false))) return;
    }
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
      await this.quiesce();
      const api = this.makeApi(serviceUrl);
      const svc = await checkService(api, this.log);
      const v12 = await this.isV12(serviceUrl);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      const prev = await this.capturePrev();
      const { id } = await this.withSuspended(() =>
        createNewSync(this.depsFor(api, syncToolbar), password, serviceUrl, v12),
      );
      const linked = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
      if (!linked?.password) throw new IncompleteSyncInfoException('Link state missing after create.');
      if (v12 && linked?.supportsV12 !== true) {
        // createAndUpload fell back to legacy mid-flight: fix the poisoned cache.
        this.v12cache.set(serviceUrl, false);
      }
      await this.saveUndo({
        kind: 'connect-new',
        opDerivedKey: linked.password!,
        opSyncId: id,
        opServiceUrl: serviceUrl,
        opSupportsV12: linked!.supportsV12 === true,
        ...prev,
      });
      await this.afterLink(svc.version);
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
    direction: 'pull' | 'push' | 'merge' = 'pull',
  ): Promise<{ id: string }> {
    if (this.connecting) throw new UnexpectedResponseException('Connect already in progress.');
    this.connecting = true;
    await this.setBadge(true);
    try {
      await this.quiesce();
      const api = this.makeApi(serviceUrl);
      const svc = await checkService(api, this.log);
      const v12 = await this.isV12(serviceUrl);
      const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
      if (direction === 'push') {
        await this.connectPushExisting(api, serviceUrl, syncId, password, syncToolbar, v12);
      } else if (direction === 'merge') {
        await this.connectMergeExisting(api, serviceUrl, syncId, password, syncToolbar, v12);
      } else {
        const versionRes = await api.getVersion(syncId);
        const remoteVersion = versionRes.version ?? undefined;
        if (!remoteVersion) {
          throw new UnsupportedSyncVersionException(
            'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
          );
        }
        if (compareVersions(remoteVersion, SyncClientVersion) > 0) {
          throw new UnsupportedSyncVersionException(
            `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
          );
        }
        const derived = await deriveKey(password, syncId, remoteVersion);
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
        // Fail-closed safety net: the pull destroys the local tree. If the
        // snapshot cannot be written, abort before mutating anything.
        await writeSafety(this.store, {
          operation: 'take-remote',
          side: 'local',
          tree: natives,
          syncId,
          derivedKey: derived,
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
      await this.afterLink(svc.version);
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
    if (!remoteVersion) {
      throw new UnsupportedSyncVersionException(
        'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
      );
    }
    if (compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(password, syncId, remoteVersion);
    // v1.2 links read the extended shape so the upload can use revision CAS.
    // A 412 anywhere (downgraded service) falls back to the legacy contract.
    let remote: import('../shared/api.js').GetBookmarksResponse;
    let effectiveV12 = v12;
    if (v12) {
      try {
        remote = await api.getBookmarksV12(syncId);
      } catch (err) {
        if (!(err instanceof UnsupportedVersionException)) throw err;
        effectiveV12 = false;
        this.v12cache.set(serviceUrl, false);
        remote = await api.getBookmarks(syncId);
      }
    } else {
      remote = await api.getBookmarks(syncId);
    }
    const remotePlain = await decryptData(remote.bookmarks ?? '', derived);
    const remoteTree = (remotePlain ? JSON.parse(remotePlain) : []) as BookmarkNode[];
    // Fail-closed: the PUT destroys the server copy. Abort before uploading
    // when the snapshot cannot be written.
    await writeSafety(this.store, {
      operation: 'upload-local',
      side: 'remote',
      tree: remoteTree,
      syncId,
      derivedKey: derived,
    });
    // Snapshot first, persist the slot only after the remote write lands: a
    // failed PUT must not clobber the previous undo.
    const prev = await this.capturePrev();
    const localTree = await this.withSuspended(async () => {
      const natives = await this.adapter.readAll(syncToolbar);
      const withIds = ensureContainersExist(natives);
      return withIds;
    });
    const encrypted = await encryptData(JSON.stringify(localTree), derived);
    let updated: import('../shared/api.js').UpdateBookmarksResponse;
    if (effectiveV12 && remote.meta?.revision !== undefined) {
      try {
        updated = await api.updateBookmarksV12(syncId, encrypted, remote.meta.revision, false);
      } catch (err) {
        if (!(err instanceof UnsupportedVersionException)) throw err;
        effectiveV12 = false;
        this.v12cache.set(serviceUrl, false);
        updated = await api.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
      }
    } else {
      updated = await api.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
    }
    await this.saveUndo({
      kind: 'connect-push',
      opDerivedKey: derived,
      opSyncId: syncId,
      opServiceUrl: serviceUrl,
      ...prev,
      remotePreBlob: remote.bookmarks ?? '',
      localCount: countNodes(remoteTree),
    });
    await this.withSuspended(async () => {
      const mappings = await this.adapter.rebuildMappings(localTree, syncToolbar);
      await this.idMapper.set(mappings);
    });
    await this.store.set(StoreKey.SyncInfo, {
      id: syncId,
      password: derived,
      version: remoteVersion,
      serviceUrl,
      supportsV12: effectiveV12,
    });
    await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
    await this.store.set(StoreKey.Bookmarks, encrypted);
    await persistMeta(this.store, updated.meta);
    await this.store.set(StoreKey.SyncEnabled, true);
  }

  /**
   * Merge dry-run: version gate → GET → decrypt → read natives → union,
   * returning preview counts only. Nothing mutates: no storage writes, no
   * queue, no native changes. Wrong password surfaces as
   * InvalidCredentials before anything else runs.
   */
  private async previewMerge(serviceUrl: string, syncId: string, password: string): Promise<MergeStats> {
    const api = this.makeApi(serviceUrl);
    await checkService(api, this.log);
    const versionRes = await api.getVersion(syncId);
    const remoteVersion = versionRes.version ?? undefined;
    if (!remoteVersion) {
      throw new UnsupportedSyncVersionException(
        'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
      );
    }
    if (compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(password, syncId, remoteVersion);
    const res = await api.getBookmarks(syncId);
    const plain = await decryptData(res.bookmarks ?? '', derived);
    let remoteTree: BookmarkNode[];
    try {
      remoteTree = (plain ? JSON.parse(plain) : []) as BookmarkNode[];
    } catch (err) {
      throw new UnexpectedResponseException('Remote sync data is corrupted.', { cause: err });
    }
    const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
    const natives = await this.adapter.readAll(syncToolbar);
    return mergeTrees(natives, remoteTree).stats;
  }

  /**
   * First-link union onto an existing sync: version gates → password verified
   * by decrypting the remote → dry-run merge → fail-closed safety snapshots
   * of BOTH sides → populate natives with the union → PUT the union on the
   * remote base (revision CAS on v1.2, timestamp otherwise). A 409 surfaces
   * honestly with both snapshots intact.
   */
  private async connectMergeExisting(
    api: XSyncApiClient,
    serviceUrl: string,
    syncId: string,
    password: string,
    syncToolbar: boolean,
    v12: boolean,
  ): Promise<void> {
    const versionRes = await api.getVersion(syncId);
    const remoteVersion = versionRes.version ?? undefined;
    if (!remoteVersion) {
      throw new UnsupportedSyncVersionException(
        'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
      );
    }
    if (compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(password, syncId, remoteVersion);
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
    const remotePlain = await decryptData(res.bookmarks ?? '', derived);
    let remoteTree: BookmarkNode[];
    try {
      remoteTree = (remotePlain ? JSON.parse(remotePlain) : []) as BookmarkNode[];
    } catch (err) {
      throw new UnexpectedResponseException('Remote sync data is corrupted.', { cause: err });
    }
    const natives = await this.adapter.readAll(syncToolbar);
    const { tree: merged } = mergeTrees(natives, remoteTree);
    if (!validateBookmarkIds(merged)) {
      // Defensive only: merge assigns fresh ids above the remote max, so a
      // failure here means a bug — repair loudly instead of pushing dupes.
      this.log.log(XbsLogLevel.Warning, 'sync', 'Merged tree failed id validation, repairing');
      repairBookmarkIds(merged);
    }
    const union = ensureContainersExist(merged);
    await writeSafety(this.store, {
      operation: 'merge-local',
      side: 'local',
      tree: natives,
      syncId,
      derivedKey: derived,
    });
    await writeSafety(this.store, {
      operation: 'merge-remote',
      side: 'remote',
      tree: remoteTree,
      syncId,
      derivedKey: derived,
    });
    await this.saveUndo({
      kind: 'connect-merge',
      opDerivedKey: derived,
      opSyncId: syncId,
      opServiceUrl: serviceUrl,
      ...(await this.capturePrev()),
      localEnc: await encryptData(JSON.stringify(natives), derived),
      localCount: countNodes(natives),
      remotePreBlob: res.bookmarks ?? '',
    });
    await this.withSuspended(async () => {
      const mappings = await overwriteAll(this.adapter, union, syncToolbar);
      await this.idMapper.set(mappings);
    });
    const encrypted = await encryptData(JSON.stringify(union), derived);
    let updated: import('../shared/api.js').UpdateBookmarksResponse;
    // Base = the remote just read; a stored revision belongs to the PREVIOUS link.
    const baseRevision = res.meta?.revision;
    if (effectiveV12 && baseRevision !== undefined) {
      try {
        updated = await api.updateBookmarksV12(syncId, encrypted, baseRevision, false);
      } catch (err) {
        if (!(err instanceof UnsupportedVersionException)) throw err;
        effectiveV12 = false;
        this.v12cache.set(serviceUrl, false);
        updated = await api.updateBookmarks(syncId, encrypted, res.lastUpdated!, false);
      }
    } else {
      updated = await api.updateBookmarks(syncId, encrypted, res.lastUpdated!, false);
    }
    await this.store.set(StoreKey.SyncInfo, {
      id: syncId,
      password: derived,
      version: remoteVersion,
      serviceUrl,
      supportsV12: effectiveV12,
    });
    await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
    await this.store.set(StoreKey.Bookmarks, encrypted);
    await persistMeta(this.store, updated.meta);
    await this.store.set(StoreKey.SyncEnabled, true);
  }

  private async afterLink(serviceVersion?: string): Promise<void> {
    // Remember the service version for the status card (offline fallback —
    // the live ping refreshes it whenever reachable).
    if (serviceVersion) {
      const linked = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
      if (linked?.id) {
        await this.store.set(StoreKey.SyncInfo, { ...linked, serviceVersion });
      }
    }
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

  /**
   * Password change = re-encrypt the current tree under a new key derived
   * from (newPassword, same syncId) and PUT it. Version unchanged. The old
   * password stops working everywhere immediately: plaintext safety-backup
   * first, undo slot covers rollback (old blob PUT-back with the old key).
   * Dual-stack: revision CAS on v1.2 links (timestamp fallback on 412),
   * timestamp on legacy links.
   */
  private async changePassword(currentPassword: string, newPassword: string): Promise<{ lastUpdated: string }> {
    if (!currentPassword) throw new IncompleteSyncInfoException('Current password is required.');
    if (!newPassword) throw new IncompleteSyncInfoException('A new password is required.');
    const { info } = await this.requireCreds();
    const version = info.version ?? SyncClientVersion;
    // Prove the current password BEFORE touching anything: the derived key
    // must match the stored one, otherwise nothing is downloaded, queued or
    // overwritten.
    const currentDerived = await deriveKey(currentPassword, info.id!, version);
    if (currentDerived !== info.password) {
      throw new InvalidCredentialsException('Current password is incorrect.');
    }
    await this.quiesce();
    const tree = await this.cachedTree(info);
    const derived = await deriveKey(newPassword, info.id!, version);
    const currentBlob = await this.store.get<string>(StoreKey.Bookmarks);
    const lastUpdated = await this.store.get<string>(StoreKey.LastUpdated);
    if (!lastUpdated) throw new IncompleteSyncInfoException('Sync info incomplete.');
    // Fail-closed: the PUT re-encrypts the server copy. Abort when the
    // pre-change snapshot cannot be written.
    await writeSafety(this.store, {
      operation: 'change-password',
      side: 'remote',
      tree,
      syncId: info.id,
      derivedKey: info.password,
    });
    // Snapshot now, persist the slot only after the PUT lands: a failed
    // password change must not clobber the previous undo.
    const prev = await this.capturePrev();
    const encrypted = await encryptData(JSON.stringify(tree), derived);
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    // Dual-stack PUT: revision CAS when the link is v1.2 (with honest 412
    // fallback for a downgraded service), timestamp otherwise.
    const tryV12 = v12Usable(info) ? await getStoredRevision(this.store) : undefined;
    let updatedLast: string;
    try {
      updatedLast = await pushEncrypted(api, this.store, info.id!, encrypted, lastUpdated, false, tryV12);
    } catch (err) {
      if (!(err instanceof UnsupportedVersionException) || tryV12 === undefined) throw err;
      await this.downgradeV12(info);
      updatedLast = await pushEncrypted(api, this.store, info.id!, encrypted, lastUpdated);
    }
    await this.saveUndo({
      kind: 'change-password',
      opDerivedKey: info.password!,
      opSyncId: info.id!,
      opServiceUrl: info.serviceUrl ?? DefaultServiceUrl,
      ...prev,
      remotePreBlob: currentBlob,
      localCount: countNodes(tree),
    });
    // Re-read before rotating the key: a concurrent ping refresh must survive.
    const current = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (current?.id !== info.id) throw new IncompleteSyncInfoException('Sync changed during password rotation.');
    await this.store.set(StoreKey.SyncInfo, { ...current, password: derived });
    // Migrate safety entries to the new key (best-effort: rotation never
    // fails the flow; unmigrated entries refuse honestly via keyId).
    const rekeyed = await rekeySafety(this.store, info.password!, derived).catch(() => ({
      rekeyed: 0,
      skipped: ['rotation'],
    }));
    if (rekeyed.skipped.length > 0) {
      this.log.log(
        XbsLogLevel.Warning,
        'sync',
        `Safety rekey skipped ${rekeyed.skipped.length} entries (kept under the old key)`,
      );
    }
    this.log.log(XbsLogLevel.Info, 'sync', 'Password changed, blob re-encrypted');
    return { lastUpdated: updatedLast };
  }

  private async importBackup(json: string, password: string): Promise<{ count: number; safety: string }> {
    const { info, syncToolbar } = await this.requireCreds();
    const imported = await importBackup(json, password);
    // Backups predate validation: duplicate/non-integer ids would ride the
    // positional mappings straight onto the server. Repair before populating.
    const tree = ensureContainersExist(
      validateBookmarkIds(imported) ? imported : repairBookmarkIds(imported),
    );
    const count = countNodes(tree);
    const natives = await this.adapter.readAll(syncToolbar);
    // Fail-closed: the import destroys the local tree. Abort when the
    // snapshot cannot be written.
    const safety = await writeSafety(this.store, {
      operation: 'import-backup',
      side: 'local',
      tree: natives,
      syncId: info.id,
      derivedKey: info.password,
    });
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
    return { count, safety: safety.fileName };
  }

  /**
   * Import dry-run: validates + decrypts, returns the node count without
   * touching natives, queue or storage. The manager shows the count and
   * only then enables the confirmed ImportBackup.
   */
  private async previewBackup(json: string, password: string): Promise<{ count: number }> {
    await this.requireCreds();
    const tree = await importBackup(json, password);
    return { count: countNodes(tree) };
  }

  /**
   * Restore a safety entry. Local-side entries replace the natives (and push
   * when linked); remote-side entries re-upload the server copy (link +
   * matching key required). A pre-restore snapshot of the current state is
   * taken fail-closed first; the used entry is never deleted.
   */
  private async restoreSafety(fileName: string): Promise<{ count: number; safety: string }> {
    const rows = await listSafety(this.store);
    const entry = rows.find((e) => e.fileName === fileName);
    if (!entry) throw new UnexpectedResponseException(`Safety backup ${fileName} not found.`);
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    if (entry.side === 'remote' && (!info?.id || !info.password)) {
      throw new IncompleteSyncInfoException('Link the sync this backup belongs to first.');
    }
    const tree = await readSafetyTree(this.store, entry, info?.password);
    const toolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;
    // Snapshot the state being replaced, fail-closed.
    let preFile = '';
    if (entry.side === 'local') {
      const natives = await this.adapter.readAll(toolbar);
      preFile = (
        await writeSafety(this.store, {
          operation: 'pre-restore',
          side: 'local',
          tree: natives,
          syncId: info?.id,
          derivedKey: info?.password,
        })
      ).fileName;
      await this.withSuspended(async () => {
        const mappings = await overwriteAll(this.adapter, tree, toolbar);
        await this.idMapper.set(mappings);
      });
      if (info?.id && info.password) {
        // Dirty → push like any local change (queued remote job, 409 honest).
        this.queue.enqueue('remote', false);
        const err = await this.drain();
        if (err) throw err;
      }
    } else {
      if (!info?.id || !info.password) {
        throw new IncompleteSyncInfoException('Link the sync this backup belongs to first.');
      }
      const pre = await writeSafety(this.store, {
        operation: 'pre-restore',
        side: 'remote',
        tree: await this.cachedTree(info),
        syncId: info.id,
        derivedKey: info.password,
      });
      preFile = pre.fileName;
      const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
      await this.pushCurrent(api, info, tree);
      await this.withSuspended(async () => {
        const mappings = await overwriteAll(this.adapter, tree, toolbar);
        await this.idMapper.set(mappings);
      });
    }
    return { count: countNodes(tree), safety: preFile };
  }

  /**
   * Bulk duplicate cleanup: ONE safety snapshot (fail-closed), ONE native
   * overwrite, ONE push. The result names the safety net (R7.5).
   */
  private async removeDuplicates(ids: number[]): Promise<{ deleted: number; safety: string }> {
    const { info, syncToolbar } = await this.requireCreds();
    // Prune the CURRENT natives (reconciled over the cache), so edits that
    // are not pushed yet survive the overwrite below.
    await this.quiesce();
    const tree = (await this.reconcileNatives(info, syncToolbar)).next;
    // Structural lock: the newest copy (max id) of each group can never be
    // selected — a crafted/buggy caller cannot wipe a group silently.
    const locked = new Set<number>();
    for (const group of getDuplicateGroups(tree)) {
      const idsInGroup = group.entries.map((e) => e.id);
      if (idsInGroup.length > 1) locked.add(Math.max(...idsInGroup));
    }
    const doomed = new Set(ids.filter((id) => !locked.has(id)));
    const pruned = deleteByIds(tree, doomed);
    const deleted = countNodes(tree) - countNodes(pruned);
    if (deleted === 0) return { deleted: 0, safety: '' };
    const natives = await this.adapter.readAll(syncToolbar);
    const safety = await writeSafety(this.store, {
      operation: 'duplicates-cleanup',
      side: 'local',
      tree: natives,
      syncId: info.id,
      derivedKey: info.password,
    });
    const currentBlob = await this.store.get<string>(StoreKey.Bookmarks);
    await this.saveUndo({
      kind: 'duplicates',
      opDerivedKey: info.password!,
      opSyncId: info.id!,
      opServiceUrl: info.serviceUrl ?? DefaultServiceUrl,
      ...(await this.capturePrev()),
      localEnc: await encryptData(JSON.stringify(natives), info.password!),
      localCount: countNodes(natives),
      remotePreBlob: currentBlob,
    });
    await this.withSuspended(async () => {
      const mappings = await overwriteAll(this.adapter, ensureContainersExist(pruned), syncToolbar);
      await this.idMapper.set(mappings);
    });
    this.queue.enqueue('remote', false);
    const err = await this.drain();
    if (err) throw err;
    return { deleted, safety: safety.fileName };
  }

  /**
   * Explicit move confirmation (same words as the manager result box, minus
   * the sync ID — notification centers persist, and the ID is a bearer).
   */
  private notifyMoveDone(target: SwitchTarget, _finalId: string, bookmarkCount?: number): Promise<void> {
    return this.ports.chrome
      .notify(
        'Move completed',
        describeMoveResult({
          mode: target.mode,
          direction: target.direction,
          newServiceUrl: target.newServiceUrl,
          // No sync ID: notification centers persist, and the ID is a bearer.
          bookmarkCount,
        }),
      )
      .catch(() => undefined);
  }

  /**
   * Move-service wizard. NOTHING syncs until the popup submits an explicit
   * SwitchTarget (mode + direction + passwords). The existing branch verifies
   * the password by decrypting BEFORE mutating anything, and each direction
   * snapshots its destroyed side fail-closed first (switch-new destroys
   * nothing: the local tree is uploaded as-is to a fresh sync).
   */
  private async switchService(target: SwitchTarget): Promise<{ id: string }> {
    const { info, syncToolbar } = await this.requireCreds();
    await this.quiesce();
    const tree = await this.cachedTree(info);
    if (!target.newPassword) throw new IncompleteSyncInfoException('A password is required.');
    if (target.mode === 'existing' && !target.syncId) {
      throw new IncompleteSyncInfoException('A sync ID is required for an existing sync.');
    }
    const newApi = this.makeApi(target.newServiceUrl);
    const svc = await checkService(newApi, this.log);
    const v12 = await this.isV12(target.newServiceUrl);

    if (target.mode === 'new') {
      const prev = await this.capturePrev();
      const { id } = await switchService(newApi, this.store, tree, target.newPassword, target.newServiceUrl, v12);
      const linked = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
      if (!linked?.password) throw new IncompleteSyncInfoException('Link state missing after move.');
      if (v12 && linked?.supportsV12 !== true) {
        this.v12cache.set(target.newServiceUrl, false);
      }
      await this.saveUndo({
        kind: 'switch-new',
        opDerivedKey: linked.password!,
        opSyncId: id,
        opServiceUrl: target.newServiceUrl,
        opSupportsV12: linked!.supportsV12 === true,
        ...prev,
      });
      await this.afterLink(svc.version);
      await this.notifyMoveDone(target, id, countNodes(tree));
      return { id };
    }

    const syncId = target.syncId!;
    const versionRes = await newApi.getVersion(syncId);
    const remoteVersion = versionRes.version ?? undefined;
    if (!remoteVersion) {
      throw new UnsupportedSyncVersionException(
        'Legacy sync without a version. Open it once in the original xBrowserSync client to upgrade it.',
      );
    }
    if (compareVersions(remoteVersion, SyncClientVersion) > 0) {
      throw new UnsupportedSyncVersionException(
        `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
      );
    }
    const derived = await deriveKey(target.newPassword, syncId, remoteVersion);
    let remote: import('../shared/api.js').GetBookmarksResponse;
    let effectiveV12 = v12;
    if (v12) {
      try {
        remote = await newApi.getBookmarksV12(syncId);
      } catch (err) {
        if (!(err instanceof UnsupportedVersionException)) throw err;
        effectiveV12 = false;
        this.v12cache.set(target.newServiceUrl, false);
        remote = await newApi.getBookmarks(syncId);
      }
    } else {
      remote = await newApi.getBookmarks(syncId);
    }
    // Password check first: throws InvalidCredentials before anything is overwritten.
    await decryptData(remote.bookmarks ?? '', derived);

    if (target.direction === 'pull') {
      const natives = await this.adapter.readAll(syncToolbar);
      // Fail-closed: the pull destroys the local tree.
      await writeSafety(this.store, {
        operation: 'switch-take-remote',
        side: 'local',
        tree: natives,
        syncId: info.id,
        derivedKey: info.password,
      });
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
          supportsV12: effectiveV12,
        }, target.newServiceUrl),
      );
    } else if (target.direction === 'merge') {
      // Union both sides: dry-run merge → fail-closed snapshots of BOTH
      // sides → populate natives with the union → PUT the union on the
      // remote base (revision CAS on v1.2, timestamp otherwise).
      const remotePlain = await decryptData(remote.bookmarks ?? '', derived);
      let remoteTree: BookmarkNode[];
      try {
        remoteTree = (remotePlain ? JSON.parse(remotePlain) : []) as BookmarkNode[];
      } catch (err) {
        throw new UnexpectedResponseException('Remote sync data is corrupted.', { cause: err });
      }
      const natives = await this.adapter.readAll(syncToolbar);
      const { tree: merged } = mergeTrees(natives, remoteTree);
      if (!validateBookmarkIds(merged)) {
        this.log.log(XbsLogLevel.Warning, 'sync', 'Merged tree failed id validation, repairing');
        repairBookmarkIds(merged);
      }
      const union = ensureContainersExist(merged);
      await writeSafety(this.store, {
        operation: 'merge-local',
        side: 'local',
        tree: natives,
        syncId: info.id,
        derivedKey: info.password,
      });
      await writeSafety(this.store, {
        operation: 'merge-remote',
        side: 'remote',
        tree: remoteTree,
        syncId,
        derivedKey: info.password,
      });
      await this.saveUndo({
        kind: 'switch-merge',
        opDerivedKey: derived,
        opSyncId: syncId,
        opServiceUrl: target.newServiceUrl,
        ...(await this.capturePrev()),
        localEnc: await encryptData(JSON.stringify(natives), derived),
        localCount: countNodes(natives),
        remotePreBlob: remote.bookmarks ?? '',
      });
      await this.withSuspended(async () => {
        const mappings = await overwriteAll(this.adapter, union, syncToolbar);
        await this.idMapper.set(mappings);
      });
      const encrypted = await encryptData(JSON.stringify(union), derived);
      let updated: import('../shared/api.js').UpdateBookmarksResponse;
      if (effectiveV12 && remote.meta?.revision !== undefined) {
        try {
          updated = await newApi.updateBookmarksV12(syncId, encrypted, remote.meta.revision, false);
        } catch (err) {
          if (!(err instanceof UnsupportedVersionException)) throw err;
          effectiveV12 = false;
          this.v12cache.set(target.newServiceUrl, false);
          updated = await newApi.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
        }
      } else {
        updated = await newApi.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
      }
      await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
      await this.store.set(StoreKey.Bookmarks, encrypted);
      await this.store.set(StoreKey.SyncInfo, {
        id: syncId,
        password: derived,
        version: remoteVersion,
        serviceUrl: target.newServiceUrl,
        supportsV12: effectiveV12,
      });
      await persistMeta(this.store, updated.meta);
      await this.store.set(StoreKey.SyncEnabled, true);
    } else {
      // Push the local tree onto the existing remote (revision CAS on v1.2,
      // timestamp otherwise, with 412 fallback). Fail-closed first: the push
      // destroys the server copy, so snapshot it before the PUT.
      const remotePlain = await decryptData(remote.bookmarks ?? '', derived);
      let remoteTree: BookmarkNode[];
      try {
        remoteTree = (remotePlain ? JSON.parse(remotePlain) : []) as BookmarkNode[];
      } catch (err) {
        throw new UnexpectedResponseException('Remote sync data is corrupted.', { cause: err });
      }
      await writeSafety(this.store, {
        operation: 'switch-upload',
        side: 'remote',
        tree: remoteTree,
        syncId,
        derivedKey: info.password,
      });
      // A 409 surfaces honestly, nothing is lost: the safety backup above
      // plus the undo slot hold the pre-push state. The slot is persisted
      // only after the PUT lands so a failed push never clobbers the
      // previous undo.
      const prev = await this.capturePrev();
      const encrypted = await encryptData(JSON.stringify(tree), derived);
      let updated: import('../shared/api.js').UpdateBookmarksResponse;
      if (effectiveV12 && remote.meta?.revision !== undefined) {
        try {
          updated = await newApi.updateBookmarksV12(syncId, encrypted, remote.meta.revision, false);
        } catch (err) {
          if (!(err instanceof UnsupportedVersionException)) throw err;
          effectiveV12 = false;
          this.v12cache.set(target.newServiceUrl, false);
          updated = await newApi.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
        }
      } else {
        updated = await newApi.updateBookmarks(syncId, encrypted, remote.lastUpdated!, false);
      }
      await this.saveUndo({
        kind: 'switch-push',
        opDerivedKey: derived,
        opSyncId: syncId,
        opServiceUrl: target.newServiceUrl,
        ...prev,
        remotePreBlob: remote.bookmarks ?? '',
        localCount: countNodes(tree),
      });
      await this.store.set(StoreKey.LastUpdated, updated.lastUpdated);
      await this.store.set(StoreKey.Bookmarks, encrypted);
      await this.store.set(StoreKey.SyncInfo, {
        id: syncId,
        password: derived,
        version: remoteVersion,
        serviceUrl: target.newServiceUrl,
        supportsV12: effectiveV12,
      });
      await persistMeta(this.store, updated.meta);
      await this.store.set(StoreKey.SyncEnabled, true);
    }
    await this.afterLink(svc.version);
    await this.notifyMoveDone(target, syncId, target.direction === 'push' ? countNodes(tree) : undefined);
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
   * fail-closed snapshot taken BEFORE the DELETE plus a double confirm
   * in the UI — deliberately no undo slot (a PUT-back would 401).
   */
  private async deleteRemoteSync(): Promise<{ deleted: boolean }> {
    const { info } = await this.requireCreds();
    await this.quiesce();
    if (!v12Usable(info)) {
      throw new UnsupportedVersionException('Not supported (requires service v1.2).');
    }
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    // Per-feature check: the delete capability is required proactively
    // instead of relying on the server 412 below. An unobtainable probe
    // falls through to the stored flag; the DELETE then either succeeds
    // or 412s honestly with downgrade.
    const caps = await api.getInfoV12().then(
      (r) => r.capabilities,
      (): undefined => undefined,
    );
    if (caps && caps.delete !== true) {
      throw new UnsupportedVersionException('Not supported (requires service v1.2).');
    }
    const tree = await this.cachedTree(info);
    // Fail-closed: no undelete exists server-side. Abort when the snapshot
    // cannot be written.
    await writeSafety(this.store, {
      operation: 'delete-remote',
      side: 'remote',
      tree,
      syncId: info.id,
      derivedKey: info.password,
    });
    try {
      await deleteRemoteSync(api, info.id!);
    } catch (err) {
      if (err instanceof UnsupportedVersionException) {
        // Raced a downgrade: persist the downgrade, report honestly.
        await this.downgradeV12(info);
      }
      throw err;
    }
    this.log.log(XbsLogLevel.Info, 'sync', `Sync ${sanitizeSyncId(info.id)} deleted from server, unlinking device`);
    await this.disableSync();
    await this.ports.chrome
      .notify('Sync deleted from server', 'The sync was deleted from the service. This device is now unlinked; local bookmarks are untouched.')
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
    Pick<UndoSlotData, 'prevSyncInfo' | 'prevLastUpdated' | 'prevBlob' | 'prevRevision' | 'prevHash'>
  > {
    const revision = await this.store.get<number>(StoreKey.SyncRevision);
    return {
      prevSyncInfo: (await this.store.get<SyncInfo>(StoreKey.SyncInfo)) ?? {},
      prevLastUpdated: await this.store.get<string>(StoreKey.LastUpdated),
      prevBlob: await this.store.get<string>(StoreKey.Bookmarks),
      prevRevision: typeof revision === 'number' ? revision : undefined,
      prevHash: await this.store.get<string>(StoreKey.SyncHash),
    };
  }

  /**
   * Restore the previous link state. When a remote PUT-back just rewrote the
   * server, its response (lastUpdated/blob/meta) is fresher than the snapshot
   * and is kept; otherwise the snapshotted values (incl. revision/hash) win.
   */
  private async restorePrevState(slot: UndoSlotData, keepFreshRemote: boolean): Promise<void> {
    await this.store.set(StoreKey.SyncInfo, slot.prevSyncInfo);
    if (!keepFreshRemote) {
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
      if (slot.prevRevision !== undefined) {
        await this.store.set(StoreKey.SyncRevision, slot.prevRevision);
      } else {
        await this.store.remove(StoreKey.SyncRevision);
      }
      if (slot.prevHash !== undefined) {
        await this.store.set(StoreKey.SyncHash, slot.prevHash);
      } else {
        await this.store.remove(StoreKey.SyncHash);
      }
    }
    await this.store.set(StoreKey.SyncEnabled, !!slot.prevSyncInfo.id);
  }

  private async undoLastLink(): Promise<{ undone: UndoKind }> {
    const slot = await this.store.get<UndoSlotData>(StoreKey.UndoSlot);
    if (!slot) throw new UnexpectedResponseException('Nothing to undo.');
    await this.quiesce();
    const syncToolbar = (await this.store.get<boolean>(StoreKey.SyncBookmarksToolbar)) ?? true;

    if (slot.localEnc) {
      const tree = JSON.parse(await decryptData(slot.localEnc, slot.opDerivedKey)) as BookmarkNode[];
      await this.restoreNatives(tree, syncToolbar);
    }
    let putBack = false;
    if (slot.remotePreBlob) {
      const api = this.makeApi(slot.opServiceUrl);
      const fresh = await api.getLastUpdated(slot.opSyncId);
      const res = await api.updateBookmarks(slot.opSyncId, slot.remotePreBlob, fresh.lastUpdated ?? '', false);
      // The PUT-back response is newer than the snapshot: keep it, or the
      // next push/conditional-GET works off a stale timestamp/revision/hash.
      await this.store.set(StoreKey.LastUpdated, res.lastUpdated);
      await this.store.set(StoreKey.Bookmarks, slot.remotePreBlob);
      await persistMeta(this.store, res.meta);
      putBack = true;
    }
    if (!putBack && (slot.kind === 'connect-new' || slot.kind === 'switch-new') && slot.opSupportsV12) {
      // Best-effort server cleanup: don't orphan a sync created by the undone
      // op. A legacy service has no DELETE; failures never block the unlink.
      try {
        await this.makeApi(slot.opServiceUrl).deleteBookmarks(slot.opSyncId);
      } catch (err) {
        this.log.log(XbsLogLevel.Warning, 'sync', `Undo cleanup DELETE failed: ${(err as Error)?.message ?? err}`);
      }
    }
    await this.restorePrevState(slot, putBack);
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
  private async getRemovedSync(): Promise<RemovedSyncSnapshot | null> {
    return (await this.store.get<RemovedSyncSnapshot>(StoreKey.RemovedSync)) ?? null;
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
      serviceVersion: info?.serviceVersion,
      lastUpdated,
      queueLength: this.queue.length,
      syncing: this.queue.syncing || this.connecting,
      usedBytes: blob?.length ?? 0,
      bookmarkCount: info ? await this.countCached(info).catch(() => undefined) : undefined,
      logLevel: this.log.minLevel as number,
      supportsV12: v12Usable(info),
      removedSync: (await this.store.get(StoreKey.RemovedSync)) !== undefined,
      conflict: await this.hasConflict(),
    };
  }

  /** Current conflict state for the resolution UI. */
  private async getConflictState(): Promise<ConflictStateResponse> {
    const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
    const conflict = info?.id && info.password ? await this.loadConflict(info) : null;
    if (!conflict) {
      return { hasConflict: false };
    }
    return {
      hasConflict: true,
      localCount: conflict.localCount,
      remoteLastUpdated: conflict.remoteLastUpdated,
      localTreeEncrypted: conflict.localEncrypted,
    };
  }

  /** Detailed merge preview for the conflict resolution UI (fresh remote). */
  private async getConflictPreview(): Promise<ConflictPreviewResponse> {
    const { info, syncToolbar } = await this.requireCreds();
    const conflict = await this.loadConflict(info);
    if (!conflict) {
      throw new UnexpectedResponseException('No active conflict to preview.');
    }
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    const { res, tree: remoteTree } = await this.fetchRemote(api, info);
    const local = ensureContainersExist(conflict.localTree);
    const remote = ensureContainersExist(remoteTree);
    const diff = diffTrees(local, remote);
    if (diff.identical) {
      // Nothing to resolve: adopt the server copy and clear the conflict.
      await this.adoptRemote(api, info, syncToolbar, res);
      await this.store.remove(StoreKey.ConflictState);
      this.log.log(XbsLogLevel.Info, 'sync', 'Conflict cleared on preview: both sides identical');
    }
    const { stats } = mergeTrees(local, remote);
    return {
      diff,
      mergeStats: stats,
      localCount: stats.localCount,
      remoteCount: stats.remoteCount,
      localOnlySample: this.collectLocalOnlyPaths(local, remoteTree).slice(0, 5),
      remoteOnlySample: this.collectRemoteOnlyPaths(local, remoteTree).slice(0, 5),
      titleConflictsSample: this.collectTitleConflicts(local, remoteTree).slice(0, 5),
      foldersCreatedSample: this.collectFoldersCreated(local, remoteTree).slice(0, 5),
    };
  }

  /**
   * Execute the chosen conflict resolution. Every PUT is based on the remote
   * just downloaded (pushOnBase); the destroyed side is snapshotted first
   * (fail closed); natives change only after the server accepted the write
   * (merge) or with the downloaded tree (pull). The conflict clears only on
   * success, so a failed attempt can simply be retried.
   */
  private async resolveConflict(direction: ConflictResolutionDirection): Promise<{ resolved: boolean }> {
    const { info, syncToolbar } = await this.requireCreds();
    const conflict = await this.loadConflict(info);
    if (!conflict) {
      throw new UnexpectedResponseException('No active conflict to resolve.');
    }
    const api = this.makeApi(info.serviceUrl ?? DefaultServiceUrl);
    const localTree = conflict.localTree;
    if (direction === 'pull') {
      await writeSafety(this.store, {
        operation: 'conflict-pull',
        side: 'local',
        tree: localTree,
        syncId: info.id!,
        derivedKey: info.password!,
      });
      const { res } = await this.fetchRemote(api, info);
      const linked = (await this.store.get<SyncInfo>(StoreKey.SyncInfo))!;
      const pulled = await this.withSuspended(() =>
        pullWithDerivedKey(this.depsFor(api, syncToolbar), {
          syncId: info.id!,
          derivedKey: info.password!,
          blob: res.bookmarks ?? '',
          lastUpdated: res.lastUpdated!,
          remoteVersion: res.version ?? info.version,
          meta: res.meta,
          supportsV12: v12Usable(linked),
        }, info.serviceUrl),
      );
      await this.store.remove(StoreKey.ConflictState);
      if (pulled.updateRemote) {
        await this.pushCurrent(api, (await this.store.get<SyncInfo>(StoreKey.SyncInfo))!, pulled.bookmarks);
      }
    } else if (direction === 'push') {
      const { res, tree: remoteTree } = await this.fetchRemote(api, info);
      await writeSafety(this.store, {
        operation: 'conflict-push',
        side: 'remote',
        tree: remoteTree,
        syncId: info.id!,
        derivedKey: info.password!,
      });
      const tree = ensureContainersExist(localTree);
      await this.pushOnBase(api, info, tree, res);
      // Natives already hold the local side: re-anchor the id mappings on it.
      await this.withSuspended(async () => {
        const mappings = await this.adapter.rebuildMappings(tree, syncToolbar);
        await this.idMapper.set(mappings);
      });
      await this.store.remove(StoreKey.ConflictState);
    } else {
      // Merge: union, nothing deleted. Snapshots of both sides once; a 409
      // (remote moved again) re-fetches and re-merges from the ORIGINAL local
      // side, up to 3 attempts.
      let { res, tree: remoteTree } = await this.fetchRemote(api, info);
      await writeSafety(this.store, {
        operation: 'conflict-merge',
        side: 'local',
        tree: localTree,
        syncId: info.id!,
        derivedKey: info.password!,
      });
      await writeSafety(this.store, {
        operation: 'conflict-merge',
        side: 'remote',
        tree: remoteTree,
        syncId: info.id!,
        derivedKey: info.password!,
      });
      for (let attempt = 1; ; attempt++) {
        const merged = ensureContainersExist(mergeTrees(localTree, remoteTree).tree);
        try {
          await this.pushOnBase(api, info, merged, res);
        } catch (err) {
          if (!(err instanceof DataOutOfSyncException) || attempt >= 3) throw err;
          this.log.log(XbsLogLevel.Warning, 'sync', `Conflict merge: 409 on attempt ${attempt}/3, re-merging`);
          ({ res, tree: remoteTree } = await this.fetchRemote(api, info));
          continue;
        }
        await this.withSuspended(async () => {
          const mappings = await overwriteAll(this.adapter, merged, syncToolbar);
          await this.idMapper.set(mappings);
        });
        break;
      }
      await this.store.remove(StoreKey.ConflictState);
    }
    this.log.log(XbsLogLevel.Info, 'sync', `Conflict resolved via ${direction}`);
    return { resolved: true };
  }

  /** Helpers to collect sample paths for the preview UI. */
  private collectLocalOnlyPaths(local: BookmarkNode[], remote: BookmarkNode[]): string[] {
    const remoteUrls = new Set<string>();
    const collectUrls = (nodes: BookmarkNode[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator') remoteUrls.add(n.url);
        if (n.children) collectUrls(n.children);
      }
    };
    collectUrls(remote);
    const paths: string[] = [];
    const walk = (nodes: BookmarkNode[], trail: string[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator' && !remoteUrls.has(n.url)) {
          paths.push([...trail, n.title ?? n.url].join(' / '));
        }
        if (n.children) walk(n.children, [...trail, n.title ?? '']);
      }
    };
    walk(local, []);
    return paths;
  }

  private collectRemoteOnlyPaths(local: BookmarkNode[], remote: BookmarkNode[]): string[] {
    const localUrls = new Set<string>();
    const collectUrls = (nodes: BookmarkNode[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator') localUrls.add(n.url);
        if (n.children) collectUrls(n.children);
      }
    };
    collectUrls(local);
    const paths: string[] = [];
    const walk = (nodes: BookmarkNode[], trail: string[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator' && !localUrls.has(n.url)) {
          paths.push([...trail, n.title ?? n.url].join(' / '));
        }
        if (n.children) walk(n.children, [...trail, n.title ?? '']);
      }
    };
    walk(remote, []);
    return paths;
  }

  private collectTitleConflicts(local: BookmarkNode[], remote: BookmarkNode[]): string[] {
    const remoteByUrl = new Map<string, BookmarkNode>();
    const index = (nodes: BookmarkNode[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator') remoteByUrl.set(n.url, n);
        if (n.children) index(n.children);
      }
    };
    index(remote);
    const conflicts: string[] = [];
    const walk = (nodes: BookmarkNode[]) => {
      for (const n of nodes) {
        if (n.url && n.url !== 'xbs:separator') {
          const remote = remoteByUrl.get(n.url);
          if (remote && remote.title !== n.title) {
            conflicts.push(`${n.title} → ${remote.title} (${n.url})`);
          }
        }
        if (n.children) walk(n.children);
      }
    };
    walk(local);
    return conflicts;
  }

  private collectFoldersCreated(local: BookmarkNode[], remote: BookmarkNode[]): string[] {
    const remotePaths = new Set<string>();
    const index = (nodes: BookmarkNode[], trail: string[]) => {
      for (const n of nodes) {
        if (!n.url || n.url === 'xbs:separator') {
          const path = [...trail, n.title ?? ''].join(' / ');
          remotePaths.add(path);
          if (n.children) index(n.children, [...trail, n.title ?? '']);
        }
      }
    };
    index(remote, []);
    const created: string[] = [];
    const walk = (nodes: BookmarkNode[], trail: string[]) => {
      for (const n of nodes) {
        if (!n.url || n.url === 'xbs:separator') {
          const path = [...trail, n.title ?? ''].join(' / ');
          if (!remotePaths.has(path)) created.push(path);
          if (n.children) walk(n.children, [...trail, n.title ?? '']);
        }
      }
    };
    walk(local, []);
    return created;
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
      // Refresh capability flag + service version from the live probe. Both
      // writes re-read the stored link and patch a single field, so a
      // concurrent password rotation or downgrade is never clobbered; an
      // offline probe (v12 === undefined) leaves everything untouched.
      if (v12 !== undefined && v12 !== (info.supportsV12 === true)) {
        const current = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
        if (current?.id === info.id) {
          await this.store.set(StoreKey.SyncInfo, { ...current, supportsV12: v12 });
        }
        this.v12cache.set(info.serviceUrl ?? DefaultServiceUrl, v12);
        this.log.log(XbsLogLevel.Info, 'sync', `Capability refresh for ${info.serviceUrl}: v12=${v12}`);
      }
      if (service.version && service.version !== info.serviceVersion) {
        const current = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
        if (current?.id === info.id) {
          await this.store.set(StoreKey.SyncInfo, { ...current, serviceVersion: service.version });
        }
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

  /**
   * Unlink this device. Also invalidates the undo slot: every snapshot points
   * at the previous link, and a PUT-back to a dead or foreign sync must never
   * run (delete has no undo by design).
   */
  async disableSync(err?: Error): Promise<void> {
    // Reentrancy guard: onSyncLost can fire mid-disable (a debounced alarm
    // slipping in after creds are wiped). Concurrent disables interleave
    // store ops; the first one wins.
    if (this.disabling) return;
    this.disabling = true;
    try {
      await this.doDisableSync(err);
    } finally {
      this.disabling = false;
    }
  }

  private async doDisableSync(err?: Error): Promise<void> {
    // On server-side deletion the cached copy is the ONLY copy left: stash a
    // plaintext snapshot (tree + lastUpdated + service URL, never the
    // password) before wiping, mirroring upstream setSyncRemoved. The manager
    // surfaces it with Download/Dismiss.
    if (err instanceof SyncNotFoundException) {
      try {
        const info = await this.store.get<SyncInfo>(StoreKey.SyncInfo);
        const blob = await this.store.get<string>(StoreKey.Bookmarks);
        const lastUpdated = await this.store.get<string>(StoreKey.LastUpdated);
        if (info?.password && blob) {
          const tree = JSON.parse(await decryptData(blob, info.password)) as BookmarkNode[];
          await this.store.set(StoreKey.RemovedSync, {
            bookmarks: tree,
            lastUpdated,
            serviceUrl: info.serviceUrl,
            savedAt: new Date().toISOString(),
          });
        }
      } catch (snapshotErr) {
        this.log.log(XbsLogLevel.Warning, 'sync', `RemovedSync snapshot failed: ${(snapshotErr as Error)?.message}`);
      }
    }
    this.queue.clear();
    this.v12cache.clear();
    await this.ports.alarms.clear(UpdatesAlarmName);
    await this.ports.alarms.clear(NativeDebounceAlarmName);
    await this.store.remove(StoreKey.BookmarkIdMappings);
    await this.store.remove(StoreKey.Bookmarks);
    await this.store.remove(StoreKey.LastUpdated);
    await this.store.remove(StoreKey.SyncRevision);
    await this.store.remove(StoreKey.SyncHash);
    await this.store.remove(StoreKey.UndoSlot);
    await this.store.remove(StoreKey.ConflictState);
    // Manual unlink retires any server-deletion snapshot: the manager must
    // not offer Download/Dismiss of a stale RemovedSync afterwards.
    if (!err) await this.store.remove(StoreKey.RemovedSync);
    await this.store.set(StoreKey.SyncEnabled, false);
    await this.store.set(StoreKey.SyncInfo, {});
    await this.setBadge(false);
    if (err instanceof SyncNotFoundException) {
      await this.ports.chrome.notify('Sync removed', 'The sync was removed from the service.');
    } else if (err) {
      this.log.log(XbsLogLevel.Warning, 'sync', `Sync disabled: ${err.message}`);
    }
  }

  /** First-run / startup: verbosity, one-time install snapshot, resume polling. */
  async startup(): Promise<void> {
    if (this.started) return;
    await this.applyVerbosity();
    try {
      // Write-once: every MV3 wake would otherwise contaminate the install
      // backup with already-synced natives.
      if ((await this.store.get(StoreKey.InstallBackup)) === undefined) {
        const snapshot = await this.adapter.readAll(true);
        await this.store.set(
          StoreKey.InstallBackup,
          JSON.stringify({ bookmarks: snapshot, date: new Date().toISOString() }),
        );
      }
    } catch (err) {
      this.log.log(XbsLogLevel.Warning, 'sync', `Install backup failed: ${(err as Error).message}`);
    }
    const enabled = await this.store.get<boolean>(StoreKey.SyncEnabled);
    if (enabled) {
      await this.ports.alarms.schedule(UpdatesAlarmName, this.options.pollMinutes ?? 15);
      await this.checkForUpdates().catch((err) => this.onBackgroundError(err));
    }
    await this.setBadge(false);
    // Mark started only after success: a failed boot retries next time
    // instead of wedging the worker with started=true and no listeners' work.
    this.started = true;
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
      if (this.suspended === 0 && this.dirtyDuringSuspend) {
        this.dirtyDuringSuspend = false;
        this.onNativeEvent();
      }
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
