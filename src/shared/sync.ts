// First-sync flows. Ports the Local/Remote cases of
// app/bookmark-sync-provider.service.ts plus the login orchestration of
// app-login.component.ts, functional style with injected deps.
//
// Whole-blob: every push uploads the full tree. 409 from the server surfaces
// as DataOutOfSyncException (caller re-pulls; never auto-merge).

import { MinApiVersion, SyncClientVersion, compareVersions } from './constants.js';
import { decryptData, deriveKey, encryptData } from './crypto.js';
import {
  IncompleteSyncInfoException,
  UnsupportedApiVersionException,
  UnsupportedSyncVersionException,
  UnsupportedVersionException,
} from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import type { BookmarkNode, ServiceInfo } from './models.js';
import { UnexpectedResponseException } from './errors.js';
import { ServiceStatus } from './models.js';
import { ensureContainersExist, repairBookmarkIds, validateBookmarkIds } from './bookmarks.js';
import type { SyncMeta, XSyncApiClient } from './api.js';
import { Store, StoreKey, type SyncInfo } from './store.js';
import { BookmarkIdMapper } from './id-mapper.js';
import type { NativeOps } from './native.js';

export interface SyncDeps {
  api: XSyncApiClient;
  store: Store;
  native: NativeOps;
  idMapper: BookmarkIdMapper;
  log: IXbsLogger;
  syncToolbar: boolean;
}

/** Probe the service and enforce MinApiVersion. Used at connect time. */
export async function checkService(api: XSyncApiClient, log: IXbsLogger): Promise<ServiceInfo> {
  const res = await api.getInfo();
  if (!res.version || compareVersions(res.version, MinApiVersion) < 0) {
    throw new UnsupportedApiVersionException(
      `Service version ${res.version ?? 'unknown'} is older than the minimum ${MinApiVersion}.`,
    );
  }
  log.log(XbsLogLevel.Info, 'sync', `Service online, API ${res.version}`);
  return {
    location: res.location,
    maxSyncSize: res.maxSyncSize,
    message: res.message,
    status: res.status ?? ServiceStatus.Online,
    version: res.version,
  };
}

/**
 * Extended probe for v1.2 gating. Returns the full info including
 * capabilities when the service speaks v1.2, otherwise the legacy shape.
 * Never throws for "legacy" — only for unreachable/invalid services.
 */
export async function checkServiceV12(api: XSyncApiClient, log: IXbsLogger): Promise<ServiceInfo> {
  const base = await checkService(api, log);
  const v12 = await api.checkServiceV12();
  return { ...base, capabilities: v12.capabilities };
}

/** Persisted v1.2 revision/hash for the revision-CAS push path. */
export async function getStoredRevision(store: Store): Promise<number | undefined> {
  const raw = await store.get<number>(StoreKey.SyncRevision);
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

export async function getStoredHash(store: Store): Promise<string | undefined> {
  const hash = await store.get<string>(StoreKey.SyncHash);
  return hash ? hash : undefined;
}

/**
 * Persist revision/hash from a v1.2 meta envelope. A legacy response (no
 * meta) clears stale values so the next push cannot reuse a revision the
 * server no longer tracks (e.g. after a service downgrade).
 */
export async function persistMeta(store: Store, meta: SyncMeta | undefined): Promise<void> {
  if (meta && typeof meta.revision === 'number') {
    await store.set(StoreKey.SyncRevision, meta.revision);
  } else {
    await store.remove(StoreKey.SyncRevision);
  }
  if (meta && meta.hash) {
    await store.set(StoreKey.SyncHash, meta.hash);
  } else {
    await store.remove(StoreKey.SyncHash);
  }
}

async function saveSyncState(
  store: Store,
  info: SyncInfo,
  lastUpdated: string,
  encrypted: string,
  serviceUrl?: string,
  meta?: SyncMeta,
  supportsV12?: boolean,
): Promise<void> {
  const next: SyncInfo = { ...info };
  if (supportsV12 !== undefined) next.supportsV12 = supportsV12;
  await store.set(StoreKey.SyncInfo, serviceUrl ? { ...next, serviceUrl } : next);
  await store.set(StoreKey.LastUpdated, lastUpdated);
  await store.set(StoreKey.Bookmarks, encrypted);
  await persistMeta(store, meta);
  await store.set(StoreKey.SyncEnabled, true);
}

/**
 * New sync: POST create → derive key → read native tree → encrypt → PUT.
 * Mirrors first-sync Remote with !syncEnabled.
 * `v12` tells whether the target speaks the extended contract (probed by the
 * caller): stored for UI gating plus the create-response meta.
 */
export async function createNewSync(
  deps: SyncDeps,
  password: string,
  serviceUrl?: string,
  v12 = false,
): Promise<{ id: string }> {
  const { api, store, native, idMapper, log, syncToolbar } = deps;
  const bookmarks = await native.readAll(syncToolbar);
  const { id } = await createAndUpload(api, store, bookmarks, password, serviceUrl, v12);

  const mappings = await native.rebuildMappings(bookmarks, syncToolbar);
  await idMapper.set(mappings);
  log.log(XbsLogLevel.Info, 'sync', 'New sync created and native bookmarks uploaded');
  return { id };
}

/**
 * Shared create+upload used by connect-new and move-service-new.
 * v1.2 path speaks the extended contract throughout (create meta → revision
 * CAS upload), so the stored revision/hash is populated from the start.
 */
export async function createAndUpload(
  api: XSyncApiClient,
  store: Store,
  bookmarks: BookmarkNode[],
  password: string,
  serviceUrl: string | undefined,
  v12: boolean,
): Promise<{ id: string; lastUpdated: string }> {
  const created = v12 ? await api.createSyncV12() : await api.createSync();
  if (!created.id || !created.lastUpdated || !created.version) {
    throw new UnexpectedResponseException('Unexpected response from the service.');
  }
  const derived = await deriveKey(password, created.id, created.version);
  const encrypted = await encryptData(JSON.stringify(bookmarks), derived);
  // Pre-v1.2 syncs report revision 0: the first write bumps 0 -> 1.
  const updated =
    v12 && created.meta?.revision !== undefined
      ? await api.updateBookmarksV12(created.id, encrypted, created.meta.revision, true)
      : await api.updateBookmarks(created.id, encrypted, created.lastUpdated, true);
  await saveSyncState(
    store,
    { id: created.id, password: derived, version: created.version },
    updated.lastUpdated!,
    encrypted,
    serviceUrl,
    updated.meta,
    v12,
  );
  return { id: created.id, lastUpdated: updated.lastUpdated! };
}

/**
 * Existing sync: version gate → GET → decrypt → validate/repair →
 * ensure containers → clear + populate native → rebuild mappings.
 * Mirrors processLocalSync. Returns whether the remote should be updated
 * (repaired ids or added containers).
 */
export async function pullExistingSync(
  deps: SyncDeps,
  syncId: string,
  password: string,
  serviceUrl?: string,
  v12 = false,
): Promise<{ bookmarks: BookmarkNode[]; lastUpdated: string; updateRemote: boolean }> {
  const { api, store, native, idMapper, log, syncToolbar } = deps;
  const versionRes = await api.getVersion(syncId);
  const remoteVersion = versionRes.version;
  if (remoteVersion && compareVersions(remoteVersion, SyncClientVersion) > 0) {
    throw new UnsupportedSyncVersionException(
      `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
    );
  }
  const derived = await deriveKey(password, syncId, remoteVersion ?? SyncClientVersion);

  // v1.2 links read the extended shape so meta flows; a 412 (downgraded
  // service) falls back to the legacy shape instead of failing the link.
  let res: import('./api.js').GetBookmarksResponse;
  let effectiveV12 = v12;
  if (v12) {
    try {
      res = await api.getBookmarksV12(syncId);
    } catch (err) {
      if (!(err instanceof UnsupportedVersionException)) throw err;
      effectiveV12 = false;
      res = await api.getBookmarks(syncId);
    }
  } else {
    res = await api.getBookmarks(syncId);
  }
  return pullWithDerivedKey(deps, {
    syncId,
    derivedKey: derived,
    blob: res.bookmarks ?? '',
    lastUpdated: res.lastUpdated!,
    remoteVersion: remoteVersion ?? undefined,
    meta: res.meta,
    supportsV12: effectiveV12,
  }, serviceUrl);
}

/** Extra pull inputs for the v1.2 path (meta + capability flag). */
export interface PullMeta {
  meta?: SyncMeta;
  supportsV12?: boolean;
}

/**
 * Local-pull core working from an already-derived key. Used by
 * pullExistingSync and by the background queue (which stores the derived
 * key, never the raw password).
 */
export async function pullWithDerivedKey(
  deps: SyncDeps,
  input: { syncId: string; derivedKey: string; blob: string; lastUpdated: string; remoteVersion?: string } & PullMeta,
  serviceUrl?: string,
): Promise<{ bookmarks: BookmarkNode[]; lastUpdated: string; updateRemote: boolean }> {
  const { store, native, idMapper, log, syncToolbar } = deps;
  const plain = await decryptData(input.blob, input.derivedKey);
  let bookmarks = (plain ? JSON.parse(plain) : []) as BookmarkNode[];
  let updateRemote = false;

  if (!validateBookmarkIds(bookmarks)) {
    bookmarks = repairBookmarkIds(bookmarks);
    updateRemote = true;
  }
  const withContainers = ensureContainersExist(bookmarks);
  if (JSON.stringify(withContainers) !== JSON.stringify(bookmarks)) {
    bookmarks = withContainers;
    updateRemote = true;
  }

  await native.clearAndPopulate(bookmarks, syncToolbar);
  const mappings = await native.rebuildMappings(bookmarks, syncToolbar);
  await idMapper.set(mappings);
  await saveSyncState(
    store,
    { id: input.syncId, password: input.derivedKey, version: input.remoteVersion },
    input.lastUpdated,
    input.blob,
    serviceUrl,
    input.meta,
    input.supportsV12,
  );
  log.log(XbsLogLevel.Info, 'sync', 'Remote bookmarks pulled into native containers');
  return { bookmarks, lastUpdated: input.lastUpdated, updateRemote };
}

/**
 * Encrypt the full tree and PUT it.
 * - v1.1 path (default): optimistic lastUpdated; 409 → DataOutOfSync.
 * - v1.2 path (baseRevision given): atomic revision CAS; races lose with 409.
 * The response meta (or its absence on legacy) refreshes the stored
 * revision/hash so the two paths never mix a stale revision.
 */
export async function pushBookmarks(
  api: XSyncApiClient,
  store: Store,
  syncId: string,
  derivedKey: string,
  bookmarks: BookmarkNode[],
  updateVersion = false,
  baseRevision?: number,
): Promise<string> {
  const lastUpdated = await store.get<string>(StoreKey.LastUpdated);
  if (!syncId || !derivedKey || !lastUpdated) throw new IncompleteSyncInfoException('Sync info incomplete.');
  const encrypted = await encryptData(JSON.stringify(bookmarks), derivedKey);
  return pushEncrypted(api, store, syncId, encrypted, lastUpdated, updateVersion, baseRevision);
}

/**
 * PUT a pre-encrypted blob (password change, undo PUT-backs). Same contract
 * choice as pushBookmarks: revision CAS when baseRevision is given, timestamp
 * otherwise. Persists lastUpdated/blob/meta.
 */
export async function pushEncrypted(
  api: XSyncApiClient,
  store: Store,
  syncId: string,
  encrypted: string,
  lastUpdated: string,
  updateVersion = false,
  baseRevision?: number,
): Promise<string> {
  if (!syncId || !encrypted || !lastUpdated) throw new IncompleteSyncInfoException('Sync info incomplete.');
  const res =
    baseRevision === undefined
      ? await api.updateBookmarks(syncId, encrypted, lastUpdated, updateVersion)
      : await api.updateBookmarksV12(syncId, encrypted, baseRevision, updateVersion);
  await store.set(StoreKey.LastUpdated, res.lastUpdated);
  await store.set(StoreKey.Bookmarks, encrypted);
  await persistMeta(store, res.meta);
  return res.lastUpdated!;
}

/**
 * v1.2-only: delete the server copy of a sync. The caller MUST gate this
 * behind the stored supportsV12 flag — on legacy services the server answers
 * 412 and nothing is deleted.
 */
export async function deleteRemoteSync(api: XSyncApiClient, syncId: string): Promise<void> {
  if (!syncId) throw new IncompleteSyncInfoException('Sync info incomplete.');
  try {
    await api.deleteBookmarks(syncId);
  } catch (err) {
    if (err instanceof UnsupportedVersionException) {
      throw new UnsupportedVersionException('Not supported (requires service v1.2).');
    }
    throw err;
  }
}

/** v1.2 gate: usable only when the linked service was probed as v1.2.
 * Undefined (never probed, e.g. links from older versions) counts as legacy. */
export function v12Usable(info: SyncInfo | undefined): boolean {
  return !!info?.id && info.supportsV12 === true;
}

/**
 * Move-service wizard (mirrors Keepmark SwitchService): create a fresh sync
 * on the new service and upload the current tree. The caller passes the
 * decrypted current tree (safety-backup of the old side is the caller's job).
 */
export async function switchService(
  newApi: XSyncApiClient,
  store: Store,
  bookmarks: BookmarkNode[],
  newPassword: string,
  newServiceUrl: string,
  v12 = false,
): Promise<{ id: string }> {
  const { id } = await createAndUpload(newApi, store, bookmarks, newPassword, newServiceUrl, v12);
  return { id };
}
