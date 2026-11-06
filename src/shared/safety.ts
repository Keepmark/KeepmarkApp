// Safety backups: persistent, listed, restorable snapshots of destroyed
// sides. Ports the Keepmark Android safety spec (README §Safety backups,
// verification-spec R7) to extension constraints:
//
// - No filesystem: index + payloads live in storage.local (unlimitedStorage
//   is declared), listed/restored/deleted from the manager Backup section.
// - No KeyStore: payloads are encrypted with the stored sync-derived key
//   (same trust anchor as the undo slot). Entries record keyId (SHA-256/8
//   of the key); restores under a rotated key refuse honestly. Pre-link
//   writes stay plaintext flagged enc:null ("not encrypted").
// - No separate master key (documented deviation from Android): rotation is
//   per-entry re-encryption on password change, best-effort.
//
// Fail-closed: writers throw on any storage failure — callers MUST abort
// the destructive operation when writeSafety throws.

import { countNodes, validateTree } from './backup.js';
import { decryptData, derivedKeyId, encryptData } from './crypto.js';
import { sanitizeSyncId } from './logging.js';
import type { BookmarkNode } from './models.js';
import { safetyFileKey, Store, StoreKey } from './store.js';
import { t } from './i18n.js';
import { sanitizeSavedSyncs, savedSyncName, type SavedSync } from './saved-syncs.js';

/** Destroyed side a snapshot was taken from. */
export type SafetySide = 'local' | 'remote';

/** Operation that destroyed the side (Keepmark §1 tags + local restore). */
export type SafetyOperation =
  | 'take-remote'
  | 'upload-local'
  | 'create-empty'
  | 'import-backup'
  | 'change-password'
  | 'switch-take-remote'
  | 'switch-upload'
  | 'duplicates-cleanup'
  | 'pre-restore'
  | 'restore'
  | 'delete-remote'
  | 'merge-local'
  | 'merge-remote'
  | 'conflict-pull'
  | 'conflict-push'
  | 'conflict-merge'
  /** A sync whose magnitude exceeded `MaxSilentSyncChanges`: the local side
   *  was snapshotted before the download replaced it. */
  | 'sync-pull'
  /** Same, upload side: the server copy was snapshotted before the replace. */
  | 'sync-push'
  /** One-shot upgrade from the retired toolbar switch: the stale local
   *  toolbar was snapshotted before the active sync's toolbar replaced it. */
  | 'toolbar-adopt';

/** One manifest row (mirrors Keepmark safety-index.json). */
export interface SafetyEntry {
  fileName: string;
  createdAtUtc: string;
  operation: SafetyOperation;
  side: SafetySide;
  items: number;
  sizeBytes: number;
  /** Truncated sync id (never the full bearer). */
  syncId: string;
  /** 'derived' = encrypted under the sync key; null = plaintext, pre-link. */
  enc: 'derived' | null;
  /** Key id the payload is encrypted under (enc === 'derived' only). */
  keyId?: string;
  /** Display name of the sync (label or host) when the snapshot was taken;
   *  the list prefers the current name of a still-saved sync. */
  syncName?: string;
  /** What the operation changed, when the writer measured it (massive
   *  syncs): bookmarks/folders the new side adds and drops. */
  added?: number;
  removed?: number;
  /** List-time only (never stored): why this browser cannot restore it now. */
  locked?: SafetyLock;
}

/** Why a safety backup cannot be restored with the current link:
 *  `other-sync` = encrypted under another sync's key (or an older password);
 *  `needs-link` = encrypted or server-side, and this browser is unlinked. */
export type SafetyLock = 'other-sync' | 'needs-link';

/** Same rule readSafetyTree and restoreSafety apply, decided up front so the
 *  list never offers a restore that would fail. An encrypted entry without a
 *  keyId (older format) is not judged here: the restore still checks it. */
export function safetyLock(
  entry: Pick<SafetyEntry, 'enc' | 'keyId' | 'side'>,
  link: { linked: boolean; keyId?: string },
): SafetyLock | undefined {
  if (!link.linked && (entry.side === 'remote' || entry.enc === 'derived')) return 'needs-link';
  if (entry.enc === 'derived' && entry.keyId && link.keyId && entry.keyId !== link.keyId) return 'other-sync';
  return undefined;
}

/** Newest entries kept; older pruned automatically (payload + row together). */
export const SafetyRetention = 10;
/** Choices offered in Settings; SafetyRetention is the default. */
export const SafetyKeepChoices = [3, 5, 10, 20, 30, 50] as const;

/** The user's retention, or the default when unset or out of the choices. */
export async function safetyKeep(store: Store): Promise<number> {
  const raw = await store.get<number>(StoreKey.SafetyKeep);
  return (SafetyKeepChoices as readonly number[]).includes(raw as number) ? (raw as number) : SafetyRetention;
}

/** Delete the oldest entries beyond `keep` (index row + payload). Returns
 *  how many went. Used when the setting is lowered and on every write. */
/** Newest first; equal timestamps keep their index order (same-second writes),
 *  so retention never drops a newer file in favour of an older twin. */
function newestFirst(a: { createdAtUtc: string }, b: { createdAtUtc: string }): number {
  return a.createdAtUtc < b.createdAtUtc ? 1 : a.createdAtUtc > b.createdAtUtc ? -1 : 0;
}

export async function pruneSafety(store: Store, keep: number): Promise<number> {
  const rows = await listSafety(store);
  if (rows.length <= keep) return 0;
  const sorted = [...rows].sort(newestFirst);
  for (const old of sorted.slice(keep)) await store.remove(safetyFileKey(old.fileName));
  await store.set(StoreKey.SafetyIndex, sorted.slice(0, keep));
  return sorted.length - keep;
}

const SafetyApp = 'KeepmarkApp-safety';
const SafetyFormat = 1;

interface SafetyPayload {
  app: string;
  format: number;
  keyId?: string;
  blob?: string;
  tree?: BookmarkNode[];
}

export function buildFileName(operation: SafetyOperation, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `safety-${stamp}-${operation}.json`;
}

async function uniqueName(store: Store, base: string, taken: Set<string>): Promise<string> {
  const free = async (name: string): Promise<boolean> =>
    !taken.has(name) && (await store.get<unknown>(safetyFileKey(name))) === undefined;
  if (await free(base)) return base;
  const stem = base.replace(/\.json$/, '');
  let n = 2;
  while (!(await free(`${stem}-${n}.json`))) n += 1;
  return `${stem}-${n}.json`;
}

/** Name of the saved sync with this full ID, if the registry has it. Never
 *  fails the snapshot: a broken registry only loses the label. */
async function savedNameFor(store: Store, syncId: string | undefined): Promise<string | undefined> {
  if (!syncId) return undefined;
  try {
    const rows = sanitizeSavedSyncs(await store.get<unknown>(StoreKey.SavedSyncs));
    const row = rows.find((r) => r.syncId === syncId);
    return row ? savedSyncName(row) : undefined;
  } catch {
    return undefined;
  }
}

/** Rows with the current name of their sync: a saved sync whose truncated ID
 *  matches exactly one row lends its (possibly renamed) name; otherwise the
 *  name recorded at write time stays. */
export async function listSafetyNamed(
  store: Store,
  link?: { linked: boolean; keyId?: string },
): Promise<SafetyEntry[]> {
  const entries = await listSafety(store);
  let rows: SavedSync[] = [];
  try {
    rows = sanitizeSavedSyncs(await store.get<unknown>(StoreKey.SavedSyncs));
  } catch {
    rows = [];
  }
  return entries.map((entry) => {
    const matches = rows.filter((r) => sanitizeSyncId(r.syncId) === entry.syncId);
    const named = matches.length === 1 ? { ...entry, syncName: savedSyncName(matches[0]!) } : entry;
    const locked = link ? safetyLock(entry, link) : undefined;
    return locked ? { ...named, locked } : named;
  });
}

export async function listSafety(store: Store): Promise<SafetyEntry[]> {
  const raw = await store.get<SafetyEntry[]>(StoreKey.SafetyIndex);
  if (!Array.isArray(raw)) return [];
  // Corrupt index → treated as empty (payloads become orphans, pruned lazily
  // on the next write which rebuilds from surviving payloads).
  const rows = raw.filter(
    (e) =>
      e &&
      typeof e.fileName === 'string' &&
      typeof e.createdAtUtc === 'string' &&
      typeof e.operation === 'string' &&
      (e.side === 'local' || e.side === 'remote') &&
      typeof e.items === 'number' &&
      typeof e.sizeBytes === 'number',
  );
  if (rows.length !== raw.length) return [];
  return rows.sort(newestFirst);
}

/**
 * Snapshot a tree. Throws on validation or storage failure — the caller
 * must abort the destructive operation (fail closed).
 */
export async function writeSafety(
  store: Store,
  input: {
    operation: SafetyOperation;
    side: SafetySide;
    tree: BookmarkNode[];
    syncId?: string;
    /** Omitted pre-link → plaintext entry flagged enc:null. */
    derivedKey?: string;
    /** Measured change, shown in the list ("+3 added · −40 removed"). */
    changes?: { added: number; removed: number };
  },
): Promise<SafetyEntry> {
  validateTree(input.tree);
  const items = countNodes(input.tree);
  const json = JSON.stringify(input.tree);
  const sizeBytes = new TextEncoder().encode(json).length;
  let payload: SafetyPayload;
  let enc: SafetyEntry['enc'];
  let keyId: string | undefined;
  if (input.derivedKey) {
    keyId = await derivedKeyId(input.derivedKey);
    payload = { app: SafetyApp, format: SafetyFormat, keyId, blob: await encryptData(json, input.derivedKey) };
    enc = 'derived';
  } else {
    payload = { app: SafetyApp, format: SafetyFormat, tree: input.tree };
    enc = null;
  }
  const syncName = await savedNameFor(store, input.syncId);
  const taken = new Set((await listSafety(store)).map((e) => e.fileName));
  const fileName = await uniqueName(store, buildFileName(input.operation), taken);
  await store.set(safetyFileKey(fileName), payload);
  const entry: SafetyEntry = {
    fileName,
    createdAtUtc: new Date().toISOString(),
    operation: input.operation,
    side: input.side,
    items,
    sizeBytes,
    syncId: sanitizeSyncId(input.syncId),
    enc,
    ...(keyId ? { keyId } : {}),
    ...(syncName ? { syncName } : {}),
    ...(input.changes ? { added: input.changes.added, removed: input.changes.removed } : {}),
  };
  const next = [entry, ...(await listSafety(store))].sort(newestFirst);
  const keep = await safetyKeep(store);
  const pruned = next.slice(0, keep);
  for (const old of next.slice(keep)) {
    await store.remove(safetyFileKey(old.fileName));
  }
  await store.set(StoreKey.SafetyIndex, pruned);
  return entry;
}

/**
 * Read + validate a snapshot. Refuses honestly on key mismatch (locked to
 * another sync/password), damage, or count drift.
 */
export async function readSafetyTree(
  store: Store,
  entry: SafetyEntry,
  derivedKey?: string,
): Promise<BookmarkNode[]> {
  const payload = await store.get<SafetyPayload>(safetyFileKey(entry.fileName));
  if (!payload || payload.app !== SafetyApp || payload.format !== SafetyFormat) {
    throw new Error(t('err.safetyDamagedOrMissing', { fileName: entry.fileName }));
  }
  let tree: BookmarkNode[];
  if (payload.blob !== undefined) {
    if (!derivedKey) throw new Error(t('err.safetyEncrypted', { fileName: entry.fileName }));
    if (entry.keyId) {
      const current = await derivedKeyId(derivedKey);
      if (current !== entry.keyId) {
        throw new Error(t('err.safetyLocked', { fileName: entry.fileName, keyId: entry.keyId }));
      }
    }
    let plain: string;
    try {
      plain = await decryptData(payload.blob, derivedKey);
    } catch {
      throw new Error(t('err.safetyKeyMismatch', { fileName: entry.fileName }));
    }
    try {
      tree = JSON.parse(plain) as BookmarkNode[];
    } catch {
      throw new Error(t('err.safetyDamaged', { fileName: entry.fileName }));
    }
  } else if (payload.tree !== undefined) {
    tree = payload.tree;
  } else {
    throw new Error(t('err.safetyDamaged', { fileName: entry.fileName }));
  }
  validateTree(tree);
  if (countNodes(tree) !== entry.items) {
    throw new Error(t('err.safetyCountDrift', { fileName: entry.fileName }));
  }
  return tree;
}

/** Remove payload + index row. UI confirms (two-tap) before calling. */
export async function deleteSafety(store: Store, fileName: string): Promise<boolean> {
  const rows = await listSafety(store);
  if (!rows.some((e) => e.fileName === fileName)) return false;
  await store.remove(safetyFileKey(fileName));
  await store.set(
    StoreKey.SafetyIndex,
    rows.filter((e) => e.fileName !== fileName),
  );
  return true;
}

/**
 * Drop the encrypted snapshots of one sync. Its saved row is the only place
 * its key lives, so once the row is removed Restore can never open them
 * again: keeping them would only spend the global retention budget and
 * evict snapshots of live syncs. Plaintext (pre-link) entries are kept: they
 * need no key. Matching is exact on keyId when known, else on the truncated
 * sync id (the only sync identifier the manifest stores).
 */
export async function pruneSafetyForSync(
  store: Store,
  target: { syncId?: string; keyId?: string },
): Promise<number> {
  const rows = await listSafety(store);
  const truncated = target.syncId && target.syncId.length > 8 ? sanitizeSyncId(target.syncId) : undefined;
  const doomed = rows.filter((entry) => {
    if (entry.enc !== 'derived') return false;
    if (target.keyId && entry.keyId) return entry.keyId === target.keyId;
    return truncated !== undefined && entry.syncId === truncated;
  });
  if (doomed.length === 0) return 0;
  for (const entry of doomed) await store.remove(safetyFileKey(entry.fileName));
  const names = new Set(doomed.map((entry) => entry.fileName));
  await store.set(
    StoreKey.SafetyIndex,
    rows.filter((entry) => !names.has(entry.fileName)),
  );
  return doomed.length;
}

/**
 * Re-encrypt every entry readable under oldKey with newKey (password-change
 * rotation). Best-effort: failures are collected, never thrown — rotation
 * must not fail the user flow.
 */
export async function rekeySafety(
  store: Store,
  oldKey: string,
  newKey: string,
): Promise<{ rekeyed: number; skipped: string[] }> {
  const rows = await listSafety(store);
  let rekeyed = 0;
  const skipped: string[] = [];
  const newId = await derivedKeyId(newKey);
  let indexChanged = false;
  for (const entry of rows) {
    if (entry.enc !== 'derived') continue;
    try {
      const tree = await readSafetyTree(store, entry, oldKey);
      const payload: SafetyPayload = {
        app: SafetyApp,
        format: SafetyFormat,
        keyId: newId,
        blob: await encryptData(JSON.stringify(tree), newKey),
      };
      await store.set(safetyFileKey(entry.fileName), payload);
      entry.keyId = newId;
      indexChanged = true;
      rekeyed += 1;
    } catch {
      skipped.push(entry.fileName);
    }
  }
  if (indexChanged) await store.set(StoreKey.SafetyIndex, rows);
  return { rekeyed, skipped };
}
