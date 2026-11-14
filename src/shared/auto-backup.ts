// Automatic backups: a periodic encrypted copy of the local bookmarks, stored
// with the safety backups (same index, same restore/delete path) under its
// own retention. Runs from an alarm in the background only; this module is
// the pure part (settings, due check, fingerprint, one run).
//
// - Nothing is written when the bookmarks are unchanged since the last
//   automatic backup that still exists.
// - A failed run records the reason and leaves the check time untouched, so
//   the next alarm retries.

import { bytesToHex, derivedKeyId } from './crypto.js';
import type { BookmarkNode } from './models.js';
import { AutoBackupKeepChoices, AutoBackupRetention, listSafety, writeSafety } from './safety.js';
import { Store, StoreKey } from './store.js';

/** Days between two automatic backups offered in Settings. */
export const AutoBackupDayChoices = [1, 7] as const;

export interface AutoBackupSettings {
  enabled: boolean;
  everyDays: number;
  keep: number;
}

export const AutoBackupDefaults: AutoBackupSettings = { enabled: true, everyDays: 1, keep: AutoBackupRetention };

export interface AutoBackupState {
  /** Last completed run (written or unchanged). */
  lastCheckUtc?: string;
  /** Last run that wrote a backup. */
  lastBackupUtc?: string;
  /** Fingerprint of the tree in that backup. */
  hash?: string;
  /** Safety file holding that backup: once it is deleted or pruned, the same
   *  tree is saved again. */
  fileName?: string;
  /** Why the last run failed; cleared by the next completed run. */
  error?: string;
}

/** Stored value → valid settings; anything unknown falls back to the default. */
export function sanitizeAutoBackup(raw: unknown): AutoBackupSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AutoBackupSettings, unknown>>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : AutoBackupDefaults.enabled,
    everyDays: (AutoBackupDayChoices as readonly unknown[]).includes(r.everyDays)
      ? (r.everyDays as number)
      : AutoBackupDefaults.everyDays,
    keep: (AutoBackupKeepChoices as readonly unknown[]).includes(r.keep) ? (r.keep as number) : AutoBackupDefaults.keep,
  };
}

export async function autoBackupSettings(store: Store): Promise<AutoBackupSettings> {
  return sanitizeAutoBackup(await store.get<unknown>(StoreKey.AutoBackup));
}

export async function autoBackupState(store: Store): Promise<AutoBackupState> {
  const raw = await store.get<AutoBackupState>(StoreKey.AutoBackupState);
  return raw && typeof raw === 'object' ? raw : {};
}

const DayMs = 24 * 60 * 60 * 1000;
/** The alarm is hourly and never exact: a run a few minutes early still counts. */
const SlackMs = 10 * 60 * 1000;

export function autoBackupDue(settings: AutoBackupSettings, state: AutoBackupState, nowMs: number): boolean {
  if (!settings.enabled) return false;
  const last = state.lastCheckUtc ? Date.parse(state.lastCheckUtc) : NaN;
  // A clock set back must not silence the schedule forever.
  if (Number.isNaN(last) || last > nowMs) return true;
  return nowMs - last >= settings.everyDays * DayMs - SlackMs;
}

/** Fingerprint of the tree plus the key it would be encrypted under: a new
 *  sync or a new password takes a fresh copy even when the bookmarks are
 *  equal. With a key it is an HMAC keyed by it, so the stored value is no
 *  offline oracle on the bookmarks; unlinked copies are plain text anyway. */
export async function treeFingerprint(tree: BookmarkNode[], derivedKey?: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const keyId = derivedKey ? await derivedKeyId(derivedKey) : 'plain';
  const bytes = enc.encode(`${keyId}\n${JSON.stringify(tree)}`) as BufferSource;
  if (!derivedKey) return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  const mac = await subtle.importKey('raw', enc.encode(derivedKey) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(new Uint8Array(await subtle.sign('HMAC', mac, bytes)));
}

/**
 * One run: write a backup unless the same tree is already saved. Throws on
 * validation or storage failure (the caller records it with
 * `noteAutoBackupError`).
 */
export async function runAutoBackup(
  store: Store,
  input: { tree: BookmarkNode[]; syncId?: string; derivedKey?: string; now?: Date },
): Promise<'written' | 'unchanged'> {
  const now = (input.now ?? new Date()).toISOString();
  const state = await autoBackupState(store);
  const hash = await treeFingerprint(input.tree, input.derivedKey);
  const stillThere =
    !!state.fileName && (await listSafety(store)).some((e) => e.operation === 'auto' && e.fileName === state.fileName);
  if (state.hash === hash && stillThere) {
    await store.set(StoreKey.AutoBackupState, {
      lastCheckUtc: now,
      ...(state.lastBackupUtc ? { lastBackupUtc: state.lastBackupUtc } : {}),
      hash,
      fileName: state.fileName,
    } satisfies AutoBackupState);
    return 'unchanged';
  }
  const entry = await writeSafety(store, {
    operation: 'auto',
    side: 'local',
    tree: input.tree,
    ...(input.syncId ? { syncId: input.syncId } : {}),
    ...(input.derivedKey ? { derivedKey: input.derivedKey } : {}),
  });
  await store.set(StoreKey.AutoBackupState, {
    lastCheckUtc: now,
    lastBackupUtc: now,
    hash,
    fileName: entry.fileName,
  } satisfies AutoBackupState);
  return 'written';
}

/** Keep the reason of a failed run; the check time stays, so it retries. */
export async function noteAutoBackupError(store: Store, message: string): Promise<void> {
  await store.set(StoreKey.AutoBackupState, { ...(await autoBackupState(store)), error: message });
}
