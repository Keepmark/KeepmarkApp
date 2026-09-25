// Popup <-> background message protocol. Ports app/webext.interface.ts +
// the error rehydration in WebExtPlatformService.sendMessage: background
// serializes thrown errors as {name, message}, popup rebuilds them by name.

import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  InvalidCredentialsException,
  InvalidServiceException,
  ServiceOfflineException,
  SyncNotFoundException,
  SyncTooLargeException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedApiVersionException,
  UnsupportedSyncVersionException,
  XbsException,
} from './errors.js';
import type { BookmarkNode, ServiceStatus } from './models.js';

export enum MessageCommand {
  SyncBookmarks = 'sync-bookmarks',
  RestoreBookmarks = 'restore-bookmarks',
  ConnectNew = 'connect-new',
  ConnectExisting = 'connect-existing',
  AddBookmark = 'add-bookmark',
  DisableSync = 'disable-sync',
  GetStatus = 'get-status',
  GetLogs = 'get-logs',
  Ping = 'ping',
  GetDuplicates = 'get-duplicates',
  RemoveBookmark = 'remove-bookmark',
  ExportBackup = 'export-backup',
  ImportBackup = 'import-backup',
  SwitchService = 'switch-service',
  DownloadFile = 'download-file',
}

export type SyncJobType = 'local' | 'remote' | 'localAndRemote';

export interface SyncRequest {
  type: SyncJobType;
  /** Full tree to push (localAndRemote / restore paths). */
  bookmarks?: BookmarkNode[];
  runSync?: boolean;
}

export interface StatusResponse {
  syncEnabled: boolean;
  syncId?: string;
  serviceUrl?: string;
  lastUpdated?: string;
  queueLength: number;
  syncing: boolean;
  /** Size of the stored encrypted blob in bytes (base64 chars). */
  usedBytes?: number;
  /** Nodes in the cached tree (for action summaries). */
  bookmarkCount?: number;
}

/** Move-service target. Nothing syncs until the popup submits this choice. */
export interface SwitchTarget {
  newServiceUrl: string;
  /** 'new' = create sync + upload local; 'existing' = link + push or pull. */
  mode: 'new' | 'existing';
  syncId?: string;
  newPassword: string;
  /** existing mode only: overwrite remote with local, or local with remote. */
  direction: 'push' | 'pull';
}

/** Live server probe result (fast timeout, never throws). */
export interface PingResponse {
  reachable: boolean;
  status?: ServiceStatus;
  version?: string;
  location?: string;
  message?: string;
  maxSyncSize?: number;
  remoteLastUpdated?: string;
}

export interface DuplicateEntry {
  id: number;
  title?: string;
  path: string;
}

export interface DuplicateGroup {
  url: string;
  entries: DuplicateEntry[];
}

export type MessagePayload =
  | { command: MessageCommand.SyncBookmarks; sync: SyncRequest }
  | { command: MessageCommand.RestoreBookmarks; bookmarks: BookmarkNode[] }
  | { command: MessageCommand.ConnectNew; serviceUrl: string; password: string }
  | { command: MessageCommand.ConnectExisting; serviceUrl: string; syncId: string; password: string }
  | { command: MessageCommand.AddBookmark; container: string; parentId?: number; title: string; url?: string }
  | { command: MessageCommand.DisableSync }
  | { command: MessageCommand.GetStatus }
  | { command: MessageCommand.GetLogs }
  | { command: MessageCommand.Ping }
  | { command: MessageCommand.GetDuplicates }
  | { command: MessageCommand.RemoveBookmark; id: number }
  | { command: MessageCommand.ExportBackup; password: string }
  | { command: MessageCommand.ImportBackup; json: string; password: string }
  | { command: MessageCommand.SwitchService; switch: SwitchTarget }
  | { command: MessageCommand.DownloadFile; filename: string; text: string };

export type MessageResponse =
  | { ok: true; data?: unknown }
  | { ok: false; errorName: string; message: string };

const registry: Record<string, new (message: string) => Error> = {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  InvalidCredentialsException,
  InvalidServiceException,
  ServiceOfflineException,
  SyncNotFoundException,
  SyncTooLargeException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedApiVersionException,
  UnsupportedSyncVersionException,
  XbsException,
};

/** Background side: serialize any thrown error for the wire. */
export function toWireError(err: unknown): { errorName: string; message: string } {
  const name = err instanceof Error ? err.constructor.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  return { errorName: registry[name] ? name : 'XbsException', message };
}

/** Popup side: rebuild the typed error from the wire form. */
export function fromWireError(wire: { errorName: string; message: string }): Error {
  const Ctor = registry[wire.errorName] ?? XbsException;
  const err = new Ctor(wire.message);
  err.name = wire.errorName;
  return err;
}
