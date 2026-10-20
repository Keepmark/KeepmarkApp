// Saved syncs: the registry behind multi-sync. One sync is ACTIVE at a time
// (StoreKey.SyncInfo); the others are dormant metadata rows the popup can
// activate. Rows never hold secrets: the derived key lives only in SyncInfo
// for the active sync, and activating a saved sync always asks for its
// password, re-derives the key and verifies it by decrypting the remote copy
// before anything is mutated.
//
// Pure helpers: no storage, no DOM, no crypto — safe in the MV3 worker.

import { normalizeServiceUrl } from './service-catalog.js';

export interface SavedSync {
  /** Canonical service URL (see normalizeServiceUrl). */
  serviceUrl: string;
  syncId: string;
  /** Optional user label; the UI falls back to the service host. */
  label?: string;
  /** Sync format version seen at link time (display only). */
  syncVersion?: string;
  /** Last link/activation of this sync (ISO 8601). */
  lastUsedAt: string;
}

/** Identity of the linked sync (mirrors SyncInfo.serviceUrl + SyncInfo.id). */
export interface SavedSyncActive {
  serviceUrl: string;
  syncId: string;
}

/** Canonical URL that never throws on legacy/invalid stored rows. */
export function canonicalServiceUrl(value: string): string {
  try {
    return normalizeServiceUrl(value);
  } catch {
    return value.trim();
  }
}

export function savedSyncKey(serviceUrl: string, syncId: string): string {
  return `${canonicalServiceUrl(serviceUrl)}\n${syncId}`;
}

export function sameSavedSync(a: SavedSyncActive, b: SavedSyncActive): boolean {
  return a.syncId === b.syncId && canonicalServiceUrl(a.serviceUrl) === canonicalServiceUrl(b.serviceUrl);
}

export function isActiveSavedSync(entry: SavedSyncActive, active: SavedSyncActive | undefined): boolean {
  return active !== undefined && sameSavedSync(entry, active);
}

/**
 * Insert or refresh one row (lastUsedAt wins, so the list is "most recently
 * used first"). The label and the known sync version survive a refresh that
 * does not carry them.
 */
export function upsertSavedSync(list: readonly SavedSync[], entry: SavedSync): SavedSync[] {
  const next = list.map((row) => ({ ...row }));
  const serviceUrl = canonicalServiceUrl(entry.serviceUrl);
  const key = savedSyncKey(serviceUrl, entry.syncId);
  const index = next.findIndex((row) => savedSyncKey(row.serviceUrl, row.syncId) === key);
  const merged: SavedSync = {
    ...entry,
    serviceUrl,
    label: entry.label ?? (index >= 0 ? next[index].label : undefined),
    syncVersion: entry.syncVersion ?? (index >= 0 ? next[index].syncVersion : undefined),
  };
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return sortSavedSyncs(next);
}

export function removeSavedSync(
  list: readonly SavedSync[],
  target: SavedSyncActive,
): SavedSync[] {
  const key = savedSyncKey(target.serviceUrl, target.syncId);
  return list.filter((row) => savedSyncKey(row.serviceUrl, row.syncId) !== key);
}

export function findSavedSync(
  list: readonly SavedSync[],
  target: SavedSyncActive,
): SavedSync | undefined {
  const key = savedSyncKey(target.serviceUrl, target.syncId);
  return list.find((row) => savedSyncKey(row.serviceUrl, row.syncId) === key);
}

/** Most recently used first; deterministic ties (label, then sync id). */
export function sortSavedSyncs(list: readonly SavedSync[]): SavedSync[] {
  return [...list].sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
    const byLabel = (a.label ?? '').localeCompare(b.label ?? '');
    if (byLabel !== 0) return byLabel;
    return a.syncId.localeCompare(b.syncId);
  });
}

/** Host for display ("api.xbrowsersync.org"); the raw string when unparsable. */
export function serviceHost(serviceUrl: string): string {
  try {
    return new URL(serviceUrl).hostname;
  } catch {
    return serviceUrl;
  }
}

/** Short sync ID for lists and notifications: the ID is a bearer token, so
 *  the UI shows a prefix only (full ID stays copyable in the status card). */
export function shortSyncId(syncId: string, length = 8): string {
  return syncId.length <= length ? syncId : `${syncId.slice(0, length)}…`;
}

/** Row name in the UI: the user label when set, otherwise the service host. */
export function savedSyncName(entry: SavedSync): string {
  const label = entry.label?.trim();
  return label ? label : serviceHost(entry.serviceUrl);
}
