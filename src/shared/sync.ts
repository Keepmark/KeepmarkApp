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
} from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import type { BookmarkNode, ServiceInfo } from './models.js';
import { ServiceStatus } from './models.js';
import { ensureContainersExist, repairBookmarkIds, validateBookmarkIds } from './bookmarks.js';
import type { XSyncApiClient } from './api.js';
import { Store, StoreKey, type SyncInfo } from './store.js';
import { BookmarkIdMapper } from './id-mapper.js';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getNativeBookmarksAsBookmarks,
  type BookmarkApi,
} from '../firefox/bookmarks.js';

export interface SyncDeps {
  api: XSyncApiClient;
  store: Store;
  bookmarksApi: BookmarkApi;
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

async function saveSyncState(
  store: Store,
  info: SyncInfo,
  lastUpdated: string,
  encrypted: string,
  serviceUrl?: string,
): Promise<void> {
  await store.set(StoreKey.SyncInfo, serviceUrl ? { ...info, serviceUrl } : info);
  await store.set(StoreKey.LastUpdated, lastUpdated);
  await store.set(StoreKey.Bookmarks, encrypted);
  await store.set(StoreKey.SyncEnabled, true);
}

/**
 * New sync: POST create → derive key → read native tree → encrypt → PUT.
 * Mirrors first-sync Remote with !syncEnabled.
 */
export async function createNewSync(
  deps: SyncDeps,
  password: string,
  serviceUrl?: string,
): Promise<{ id: string }> {
  const { api, store, bookmarksApi, idMapper, log, syncToolbar } = deps;
  const created = await api.createSync();
  if (!created.id || !created.lastUpdated || !created.version) {
    const { UnexpectedResponseException } = await import('./errors.js');
    throw new UnexpectedResponseException('Unexpected response from the service.');
  }
  const derived = await deriveKey(password, created.id, created.version);

  const bookmarks = await getNativeBookmarksAsBookmarks(bookmarksApi, syncToolbar);
  const encrypted = await encryptData(JSON.stringify(bookmarks), derived);
  const updated = await api.updateBookmarks(created.id, encrypted, created.lastUpdated, true);

  const mappings = await buildIdMappings(bookmarksApi, bookmarks, syncToolbar);
  await idMapper.set(mappings);
  await saveSyncState(
    store,
    { id: created.id, password: derived, version: created.version },
    updated.lastUpdated!,
    encrypted,
    serviceUrl,
  );
  log.log(XbsLogLevel.Info, 'sync', 'New sync created and native bookmarks uploaded');
  return { id: created.id };
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
): Promise<{ bookmarks: BookmarkNode[]; lastUpdated: string; updateRemote: boolean }> {
  const { api, store, bookmarksApi, idMapper, log, syncToolbar } = deps;
  const versionRes = await api.getVersion(syncId);
  const remoteVersion = versionRes.version;
  if (remoteVersion && compareVersions(remoteVersion, SyncClientVersion) > 0) {
    throw new UnsupportedSyncVersionException(
      `Sync version ${remoteVersion} is newer than this client (${SyncClientVersion}).`,
    );
  }
  const derived = await deriveKey(password, syncId, remoteVersion ?? SyncClientVersion);

  const res = await api.getBookmarks(syncId);
  const plain = await decryptData(res.bookmarks ?? '', derived);
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

  await clearNativeBookmarks(bookmarksApi, syncToolbar);
  await createNativeBookmarksFromBookmarks(bookmarksApi, bookmarks, syncToolbar);
  const mappings = await buildIdMappings(bookmarksApi, bookmarks, syncToolbar);
  await idMapper.set(mappings);
  await saveSyncState(
    store,
    { id: syncId, password: derived, version: remoteVersion ?? undefined },
    res.lastUpdated!,
    res.bookmarks ?? '',
    serviceUrl,
  );
  log.log(XbsLogLevel.Info, 'sync', 'Remote bookmarks pulled into native containers');
  return { bookmarks, lastUpdated: res.lastUpdated!, updateRemote };
}

/** Encrypt the full tree and PUT it (optimistic lastUpdated; 409 → DataOutOfSync). */
export async function pushBookmarks(
  api: XSyncApiClient,
  store: Store,
  syncId: string,
  derivedKey: string,
  bookmarks: BookmarkNode[],
  updateVersion = false,
): Promise<string> {
  const lastUpdated = await store.get<string>(StoreKey.LastUpdated);
  if (!syncId || !derivedKey || !lastUpdated) throw new IncompleteSyncInfoException('Sync info incomplete.');
  const encrypted = await encryptData(JSON.stringify(bookmarks), derivedKey);
  const res = await api.updateBookmarks(syncId, encrypted, lastUpdated, updateVersion);
  await store.set(StoreKey.LastUpdated, res.lastUpdated);
  await store.set(StoreKey.Bookmarks, encrypted);
  return res.lastUpdated!;
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
): Promise<{ id: string }> {
  const created = await newApi.createSync();
  if (!created.id || !created.lastUpdated || !created.version) {
    const { UnexpectedResponseException } = await import('./errors.js');
    throw new UnexpectedResponseException('Unexpected response from the service.');
  }
  const derived = await deriveKey(newPassword, created.id, created.version);
  const encrypted = await encryptData(JSON.stringify(bookmarks), derived);
  const updated = await newApi.updateBookmarks(created.id, encrypted, created.lastUpdated, true);
  await saveSyncState(
    store,
    { id: created.id, password: derived, version: created.version },
    updated.lastUpdated!,
    encrypted,
    newServiceUrl,
  );
  return { id: created.id };
}
