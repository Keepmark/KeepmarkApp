// Encrypted backup export/import. Ports Keepmark BackupGuard + the
// BackupEnvelope idea (App stays "KeepmarkApp", Format 1):
//
//   { app, format, salt, blob }
//   blob = base64(IV16B || AES-GCM(lzutf8(JSON tree))) under
//          PBKDF2-SHA256/250k(password, salt)
//
// Guards mirror BackupGuard: password >= 8 chars, .json suffix on paths,
// 50MB / 200k nodes bounds, BFS tree validation.

import { bytesToBase64, decryptData, deriveKey, encryptData } from './crypto.js';
import { SyncClientVersion } from './constants.js';
import type { BookmarkNode } from './models.js';
import { eachBookmark } from './bookmarks.js';

export const BackupAppName = 'KeepmarkApp';
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
    throw new Error(`Backup password must be at least ${MinBackupPasswordLength} characters.`);
  }
}

export function countNodes(nodes: BookmarkNode[]): number {
  let n = 0;
  eachBookmark(() => n++, nodes);
  return n;
}

/** BFS validation: shape-checked nodes, rejects nulls, over-deep and oversized trees. */
export function validateTree(nodes: BookmarkNode[]): void {
  if (!Array.isArray(nodes)) throw new Error('Backup does not contain a bookmark tree.');
  // Index queue, not shift(): shift() is O(n²) on 200k nodes.
  const queue: { node: BookmarkNode; depth: number }[] = nodes.map((node) => ({ node, depth: 1 }));
  let head = 0;
  let seen = 0;
  while (head < queue.length) {
    const { node, depth } = queue[head++];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error('Backup contains an invalid node.');
    }
    if (depth > MaxBackupDepth) throw new Error('Backup exceeds the nesting limit.');
    if (node.id !== undefined && typeof node.id !== 'number') {
      throw new Error('Backup contains a node with an invalid id.');
    }
    if (node.title !== undefined && typeof node.title !== 'string') {
      throw new Error('Backup contains a node with an invalid title.');
    }
    if (node.url !== undefined && typeof node.url !== 'string') {
      throw new Error('Backup contains a node with an invalid url.');
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
      throw new Error('Backup contains a node with an invalid description.');
    }
    if (node.tags !== undefined && (!Array.isArray(node.tags) || node.tags.some((t) => typeof t !== 'string'))) {
      throw new Error('Backup contains a node with invalid tags.');
    }
    seen += 1;
    if (seen > MaxBackupNodes) throw new Error('Backup exceeds the node limit.');
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error('Backup contains an invalid node.');
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }
  }
}

export async function exportBackup(nodes: BookmarkNode[], password: string): Promise<string> {
  requireBackupPassword(password);
  validateTree(nodes);
  const salt = randomSalt();
  const key = await deriveKey(password, salt, SyncClientVersion);
  const blob = await encryptData(JSON.stringify(nodes), key);
  const envelope: BackupEnvelope = { app: BackupAppName, format: BackupFormat, salt, blob };
  return JSON.stringify(envelope);
}

export async function importBackup(json: string, password: string): Promise<BookmarkNode[]> {
  requireBackupPassword(password);
  // Real bytes, not UTF-16 code units: the limit is a byte budget.
  if (new TextEncoder().encode(json).length > MaxBackupBytes) throw new Error('Backup file too large.');
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(json) as BackupEnvelope;
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }
  if (
    envelope.app !== BackupAppName ||
    envelope.format !== BackupFormat ||
    typeof envelope.blob !== 'string' ||
    typeof envelope.salt !== 'string'
  ) {
    throw new Error('Unsupported backup format.');
  }
  const key = await deriveKey(password, envelope.salt, SyncClientVersion);
  const plain = await decryptData(envelope.blob, key).catch(() => {
    throw new Error('Wrong backup password or corrupted file.');
  });
  let nodes: BookmarkNode[];
  try {
    nodes = JSON.parse(plain) as BookmarkNode[];
  } catch {
    throw new Error('Backup file is corrupted.');
  }
  validateTree(nodes);
  return nodes;
}
