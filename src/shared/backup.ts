// Encrypted backup export/import. Ports Keepmark BackupGuard + the
// BackupEnvelope idea (App stays "KeepmarkApp", Format 1):
//
//   { app, format, salt, blob }
//   blob = base64(IV16B || AES-GCM(lzutf8(JSON tree))) under
//          PBKDF2-SHA256/250k(password, salt)
//
// Guards mirror BackupGuard: password >= 8 chars, .json suffix on paths,
// 50MB / 200k nodes bounds, BFS tree validation.

import { decryptData, deriveKey } from './crypto.js';
import { SyncClientVersion } from './constants.js';
import type { BookmarkNode } from './models.js';
import { eachBookmark } from './bookmarks.js';

export const BackupAppName = 'KeepmarkApp';
export const BackupFormat = 1;
export const MinBackupPasswordLength = 8;
export const MaxBackupBytes = 50 * 1024 * 1024;
export const MaxBackupNodes = 200_000;

export interface BackupEnvelope {
  app: string;
  format: number;
  salt: string;
  blob: string;
}

function randomSalt(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return globalThis.btoa(bin);
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

/** BFS validation: rejects null nodes and oversized trees. */
export function validateTree(nodes: BookmarkNode[]): void {
  if (!Array.isArray(nodes)) throw new Error('Backup does not contain a bookmark tree.');
  const queue: BookmarkNode[] = [...nodes];
  let seen = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!node || typeof node !== 'object') throw new Error('Backup contains an invalid node.');
    seen += 1;
    if (seen > MaxBackupNodes) throw new Error('Backup exceeds the node limit.');
    if (node.children) {
      if (!Array.isArray(node.children)) throw new Error('Backup contains an invalid node.');
      queue.push(...node.children);
    }
  }
}

export async function exportBackup(nodes: BookmarkNode[], password: string): Promise<string> {
  requireBackupPassword(password);
  validateTree(nodes);
  const salt = randomSalt();
  const key = await deriveKey(password, salt, SyncClientVersion);
  const { encryptData } = await import('./crypto.js');
  const blob = await encryptData(JSON.stringify(nodes), key);
  const envelope: BackupEnvelope = { app: BackupAppName, format: BackupFormat, salt, blob };
  return JSON.stringify(envelope);
}

export async function importBackup(json: string, password: string): Promise<BookmarkNode[]> {
  requireBackupPassword(password);
  if (json.length > MaxBackupBytes) throw new Error('Backup file too large.');
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(json) as BackupEnvelope;
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }
  if (envelope.format !== BackupFormat || typeof envelope.blob !== 'string' || typeof envelope.salt !== 'string') {
    throw new Error('Unsupported backup format.');
  }
  const key = await deriveKey(password, envelope.salt, SyncClientVersion);
  const plain = await decryptData(envelope.blob, key).catch(() => {
    throw new Error('Wrong backup password or corrupted file.');
  });
  const nodes = JSON.parse(plain) as BookmarkNode[];
  validateTree(nodes);
  return nodes;
}
