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
  | 'conflict-merge';

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
}

/** Newest entries kept; older pruned automatically (payload + row together). */
export const SafetyRetention = 5;

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
  return rows.sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1));
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
  };
  const next = [entry, ...(await listSafety(store))].sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1));
  const pruned = next.slice(0, SafetyRetention);
  for (const old of next.slice(SafetyRetention)) {
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
    throw new Error(`Safety backup ${entry.fileName} is damaged or missing.`);
  }
  let tree: BookmarkNode[];
  if (payload.blob !== undefined) {
    if (!derivedKey) throw new Error(`Safety backup ${entry.fileName} is encrypted — relink the sync first.`);
    if (entry.keyId) {
      const current = await derivedKeyId(derivedKey);
      if (current !== entry.keyId) {
        throw new Error(
          `Safety backup ${entry.fileName} is locked to another sync or password (key ${entry.keyId}).`,
        );
      }
    }
    let plain: string;
    try {
      plain = await decryptData(payload.blob, derivedKey);
    } catch {
      throw new Error(`Safety backup ${entry.fileName} is damaged or the key no longer fits.`);
    }
    try {
      tree = JSON.parse(plain) as BookmarkNode[];
    } catch {
      throw new Error(`Safety backup ${entry.fileName} is damaged.`);
    }
  } else if (payload.tree !== undefined) {
    tree = payload.tree;
  } else {
    throw new Error(`Safety backup ${entry.fileName} is damaged.`);
  }
  validateTree(tree);
  if (countNodes(tree) !== entry.items) {
    throw new Error(`Safety backup ${entry.fileName} is damaged (count drift).`);
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
