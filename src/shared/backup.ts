// Encrypted backup export/import. Envelope shared with the Keepmark Android
// app (same crypto, same guards) so files are cross-readable:
//
//   { app, format, salt, blob }
//   blob = base64(IV16B || AES-GCM(lzutf8(JSON tree))) under
//          PBKDF2-SHA256/250k(password, salt)
//
// Written with App = "xBrowserSyncNg" (the shared family tag the Android
// client requires); files stamped with the legacy "KeepmarkApp" tag still
// import. Anything else is refused.
// Guards mirror BackupGuard: password >= 8 chars, .json suffix on paths,
// 50MB / 200k nodes bounds, BFS tree validation.

import { bytesToBase64, decryptData, deriveKey, encryptData } from './crypto.js';
import { SyncClientVersion } from './constants.js';
import type { BookmarkNode } from './models.js';
import { eachBookmark } from './bookmarks.js';
import { t } from './i18n.js';

export const BackupAppName = 'KeepmarkApp';
/** Family tag written on new exports (required by the Android client). */
export const SharedBackupAppName = 'xBrowserSyncNg';
export const BackupFormat = 1;
export const MinBackupPasswordLength = 8;
export const MaxBackupBytes = 50 * 1024 * 1024;
export const MaxBackupNodes = 200_000;
/** Max nesting depth: a hostile 100k-deep tree passes shape checks but blows
 * the stack in recursive passes (countNodes/eachBookmark/JSON). */
export const MaxBackupDepth = 1000;

export interface BackupEnvelope {
  app: string;
  format: number;
  salt: string;
  blob: string;
}

function randomSalt(): string {
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export function requireBackupPassword(password: string): void {
  if (!password || password.length < MinBackupPasswordLength) {
    throw new Error(t('err.backupPwShort', { min: MinBackupPasswordLength }));
  }
}

export function countNodes(nodes: BookmarkNode[]): number {
  let n = 0;
  eachBookmark(() => n++, nodes);
  return n;
}

/** BFS validation: shape-checked nodes, rejects nulls, over-deep and oversized trees. */
export function validateTree(nodes: BookmarkNode[]): void {
  if (!Array.isArray(nodes)) throw new Error(t('err.backupNoTree'));
  // Index queue, not shift(): shift() is O(n²) on 200k nodes.
  const queue: { node: BookmarkNode; depth: number }[] = nodes.map((node) => ({ node, depth: 1 }));
  let head = 0;
  let seen = 0;
  while (head < queue.length) {
    const { node, depth } = queue[head++];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(t('err.backupInvalidNode'));
    }
    if (depth > MaxBackupDepth) throw new Error(t('err.backupNesting'));
    if (node.id !== undefined && typeof node.id !== 'number') {
      throw new Error(t('err.backupBadId'));
    }
    if (node.title !== undefined && typeof node.title !== 'string') {
      throw new Error(t('err.backupBadTitle'));
    }
    if (node.url !== undefined && typeof node.url !== 'string') {
      throw new Error(t('err.backupBadUrl'));
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
      throw new Error(t('err.backupBadDescription'));
    }
    if (node.tags !== undefined && (!Array.isArray(node.tags) || node.tags.some((t) => typeof t !== 'string'))) {
      throw new Error(t('err.backupBadTags'));
    }
    if (node.dateAdded !== undefined && typeof node.dateAdded !== 'number') {
      throw new Error(t('err.backupInvalidNode'));
    }
    seen += 1;
    if (seen > MaxBackupNodes) throw new Error(t('err.backupNodeLimit'));
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error(t('err.backupInvalidNode'));
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }
  }
}

/** Longest slug kept from a sync name in a file name. */
export const MaxBackupSlugLength = 40;

/**
 * Slug for a file name: lowercase, accents folded, anything that is not a
 * letter or digit collapsed into one underscore (spaces included), no leading
 * or trailing underscore. Returns '' when nothing usable is left.
 */
export function backupSlug(value: string | undefined): string {
  const folded = (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return folded
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MaxBackupSlugLength)
    .replace(/_+$/g, '');
}

/**
 * Download name for an export: `keepmark-backup-<sync>-<date>.xbs.json`. The
 * sync name is a human label (host fallback), so it is slugged; without one
 * the file keeps the plain dated name.
 */
export function backupFileName(syncName: string | undefined, date: Date): string {
  const slug = backupSlug(syncName);
  const day = date.toISOString().slice(0, 10);
  return slug ? `keepmark-backup-${slug}-${day}.xbs.json` : `keepmark-backup-${day}.xbs.json`;
}

export async function exportBackup(nodes: BookmarkNode[], password: string): Promise<string> {
  requireBackupPassword(password);
  validateTree(nodes);
  const salt = randomSalt();
  const key = await deriveKey(password, salt, SyncClientVersion);
  const blob = await encryptData(JSON.stringify(nodes), key);
  const envelope: BackupEnvelope = { app: SharedBackupAppName, format: BackupFormat, salt, blob };
  return JSON.stringify(envelope);
}

export async function importBackup(json: string, password: string): Promise<BookmarkNode[]> {
  requireBackupPassword(password);
  // Real bytes, not UTF-16 code units: the limit is a byte budget.
  if (new TextEncoder().encode(json).length > MaxBackupBytes) throw new Error(t('err.backupTooLarge'));
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(json) as BackupEnvelope;
  } catch {
    throw new Error(t('err.backupNotJson'));
  }
  if (
    (envelope.app !== SharedBackupAppName && envelope.app !== BackupAppName) ||
    envelope.format !== BackupFormat ||
    typeof envelope.blob !== 'string' ||
    typeof envelope.salt !== 'string'
  ) {
    throw new Error(t('err.backupFormat'));
  }
  const key = await deriveKey(password, envelope.salt, SyncClientVersion);
  const plain = await decryptData(envelope.blob, key).catch(() => {
    throw new Error(t('err.backupWrongPw'));
  });
  let nodes: BookmarkNode[];
  try {
    nodes = JSON.parse(plain) as BookmarkNode[];
  } catch {
    throw new Error(t('err.backupCorrupt'));
  }
  validateTree(nodes);
  return nodes;
}
