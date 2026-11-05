// Saved syncs: the registry behind multi-sync. One sync is ACTIVE at a time
// (StoreKey.SyncInfo); the others are dormant rows the popup can activate.
// A dormant row carries its derived key, either wrapped under the optional
// switch lock (opt-in protection) or in clear when no password is set. The
// clear scheme is the same exposure as the active SyncInfo key; the wrapped
// one needs the short switch password to unlock. Activating a row verifies the
// remote copy by decrypting it before anything is mutated.
//
// Pure helpers: no storage, no DOM, no crypto — safe in the MV3 worker.

import type { WrappedSecret } from './switch-lock.js';
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
  /** Fingerprint of the row's derived key (see derivedKeyId), so cleanup can
   *  match the row's safety backups without unwrapping a switch credential. */
  keyId?: string;
  /** How to get this row's derived key back: in clear (no switch password
   *  configured) or wrapped under the switch-lock vault. The active row has
   *  one too, so it stays activatable after being demoted. */
  credential?: SavedSyncCredential;
}

/**
 * A row key. `plain` = the derived key in clear, used when the user did not
 * opt into the switch password; `switch` = AES-GCM under the vault key.
 * `rotated` = the long sync password changed while the switch lock was
 * locked: `previous` still holds the key before the rotation and `sealed`
 * holds the current one encrypted with it. The next activation already
 * unlocks the vault, so it unwraps the chain and rewraps the row — a password
 * change never asks for the switch password.
 */
export type SavedSyncCredential =
  | { scheme: 'plain'; key: string }
  | ({ scheme: 'switch' } & WrappedSecret)
  | { scheme: 'rotated'; previous: SavedSyncCredential; sealed: string };

/** Longest accepted label (the UI shows it in a narrow row). */
export const MaxSavedSyncLabelLength = 40;

/** Trimmed label, or undefined for "use the automatic name" (the host).
 *  Defensive truncation: the UI caps the input too. */
export function normalizeSavedSyncLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  if (!label) return undefined;
  return label.slice(0, MaxSavedSyncLabelLength);
}

/** True when another row already uses this label (case-insensitive: two rows
 *  named "Work" would be indistinguishable in the list). */
export function savedSyncLabelTaken(
  list: readonly SavedSync[],
  target: SavedSyncActive | undefined,
  label: string,
): boolean {
  const needle = label.trim().toLocaleLowerCase();
  if (!needle) return false;
  return list.some((row) =>
    (!target || !sameSavedSync(row, target)) &&
    (row.label ?? '').trim().toLocaleLowerCase() === needle,
  );
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
    keyId: entry.keyId ?? (index >= 0 ? next[index].keyId : undefined),
    // Refreshing a row without a credential must never drop the stored one.
    credential: entry.credential ?? (index >= 0 ? next[index].credential : undefined),
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

/**
 * Storage is shared with older builds and hand-edited state: never trust the
 * shape. Unknown rows are dropped instead of breaking an upsert (which runs
 * inside the link flow), known rows are canonicalized and re-sorted.
 */
export function sanitizeSavedSyncs(value: unknown): SavedSync[] {
  if (!Array.isArray(value)) return [];
  const rows: SavedSync[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Partial<SavedSync>;
    if (typeof row.syncId !== 'string' || !row.syncId.trim()) continue;
    if (typeof row.serviceUrl !== 'string' || !row.serviceUrl.trim()) continue;
    rows.push({
      serviceUrl: canonicalServiceUrl(row.serviceUrl),
      syncId: row.syncId,
      ...(typeof row.label === 'string' && row.label.trim() ? { label: row.label } : {}),
      ...(typeof row.syncVersion === 'string' && row.syncVersion ? { syncVersion: row.syncVersion } : {}),
      ...(typeof row.keyId === 'string' && row.keyId ? { keyId: row.keyId } : {}),
      ...(normalizeCredential(row.credential) ? { credential: normalizeCredential(row.credential) } : {}),
      lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : '',
    });
  }
  return sortSavedSyncs(rows);
}

/** Credential shape check + normalization (unknown values are dropped, never
 *  trusted). Legacy wrapped blobs without a scheme become `switch`. */
export function normalizeCredential(value: unknown): SavedSyncCredential | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const blob = value as Partial<SavedSyncCredential> & Partial<WrappedSecret>;
  if (blob.scheme === 'plain') {
    return typeof blob.key === 'string' && !!blob.key ? { scheme: 'plain', key: blob.key } : undefined;
  }
  if (blob.scheme === 'rotated') {
    const previous = normalizeCredential((blob as { previous?: unknown }).previous);
    const sealed = (blob as { sealed?: unknown }).sealed;
    if (!previous || typeof sealed !== 'string' || !sealed) return undefined;
    return { scheme: 'rotated', previous, sealed };
  }
  if (typeof blob.iv === 'string' && !!blob.iv && typeof blob.ct === 'string' && !!blob.ct) {
    return { scheme: 'switch', iv: blob.iv, ct: blob.ct };
  }
  return undefined;
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
/** Compact sync ID for display: head and tail (`432a39…d4af`), one line.
 *  The full ID is a bearer token: copy it from the status card, never from here. */
export function shortSyncId(syncId: string, head = 6, tail = 4): string {
  return syncId.length <= head + tail + 1 ? syncId : `${syncId.slice(0, head)}…${syncId.slice(-tail)}`;
}

/** Suggested name for a new row: the host, or "host 2", "host 3"… when a
 *  saved sync already answers to that name (label or host fallback). */
export function suggestSavedSyncName(
  serviceUrl: string,
  list: readonly SavedSync[],
  exclude?: SavedSyncActive,
): string {
  const base = serviceHost(serviceUrl);
  const taken = new Set(
    list
      .filter((row) => !exclude || !sameSavedSync(row, exclude))
      .map((row) => savedSyncName(row).trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  if (!taken.has(base.toLocaleLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

/** Row name in the UI: the user label when set, otherwise the service host. */
export function savedSyncName(entry: SavedSync): string {
  const label = entry.label?.trim();
  return label ? label : serviceHost(entry.serviceUrl);
}
