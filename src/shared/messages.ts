// Popup <-> background message protocol. Ports app/webext.interface.ts +
// the error rehydration in WebExtPlatformService.sendMessage: background
// serializes thrown errors as {name, message}, popup rebuilds them by name.

import {
  DailyNewSyncLimitException,
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  InvalidCredentialsException,
  InvalidServiceException,
  NotAcceptingNewSyncsException,
  ServiceOfflineException,
  SyncNotFoundException,
  SyncTooLargeException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedApiVersionException,
  UnsupportedSyncVersionException,
  UnsupportedVersionException,
  XbsException,
} from './errors.js';
import type { BookmarkNode, ServiceStatus } from './models.js';
import type { MergeStats } from './merge.js';
import type { SafetyEntry } from './safety.js';

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
  SwitchPreview = 'switch-preview',
  PreviewMerge = 'preview-merge',
  SetVerbosity = 'set-verbosity',
  GetUndoState = 'get-undo-state',
  UndoLastLink = 'undo-last-link',
  DismissUndo = 'dismiss-undo',
  ChangePassword = 'change-password',
  GetRemovedSync = 'get-removed-sync',
  ClearRemovedSync = 'clear-removed-sync',
  GetToolbarSync = 'get-toolbar-sync',
  SetToolbarSync = 'set-toolbar-sync',
  PreviewBackup = 'preview-backup',
  GetSafetyList = 'get-safety-list',
  RestoreSafety = 'restore-safety',
  DeleteSafety = 'delete-safety',
  RemoveDuplicates = 'remove-duplicates',
  GetDuplicates = 'get-duplicates',
  RemoveBookmark = 'remove-bookmark',
  ExportBackup = 'export-backup',
  ImportBackup = 'import-backup',
  SwitchService = 'switch-service',
  DeleteRemoteSync = 'delete-remote-sync',
  DownloadFile = 'download-file',
  // Conflict resolution
  GetConflictState = 'get-conflict-state',
  GetConflictPreview = 'get-conflict-preview',
  ResolveConflict = 'resolve-conflict',
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
  /** Last-known service API version (refreshed on link + live ping). */
  serviceVersion?: string;
  lastUpdated?: string;
  queueLength: number;
  syncing: boolean;
  /** Size of the stored encrypted blob in bytes (base64 chars). */
  usedBytes?: number;
  /** Nodes in the cached tree (for action summaries). */
  bookmarkCount?: number;
  /** Stored log verbosity (XbsLogLevel). */
  logLevel?: number;
  /** True when the linked service speaks the v1.2 contract (gates v1.2-only UI). */
  supportsV12?: boolean;
  /** True when a server-deleted sync left a local snapshot (see RemovedSync). */
  removedSync?: boolean;
  /** True when a push received 409 and conflict state is captured. */
  conflict?: boolean;
}

/** Plaintext snapshot of a server-deleted sync (no password ever stored). */
export interface RemovedSyncSnapshot {
  bookmarks: BookmarkNode[];
  lastUpdated?: string;
  serviceUrl?: string;
  savedAt: string;
}

/** Move-service target. Nothing syncs until the popup submits this choice. */
export interface SwitchTarget {
  newServiceUrl: string;
  /** 'new' = create sync + upload local; 'existing' = link + push, pull or merge. */
  mode: 'new' | 'existing';
  syncId?: string;
  newPassword: string;
  /** existing mode only: overwrite remote with local, local with remote, or union both. */
  direction: 'push' | 'pull' | 'merge';
}

/** Read-only preflight for the move wizard. Never mutates anything. */
export interface SwitchPreviewResult {
  reachable: boolean;
  serviceVersion?: string;
  versionCompatible?: boolean;
  serviceStatus?: ServiceStatus;
  maxSyncSize?: number;
  /** existing mode only: whether the target sync id exists + its lastUpdated. */
  remoteExists?: boolean;
  remoteLastUpdated?: string;
  localCount?: number;
  /** True when the target speaks the v1.2 contract. */
  supportsV12?: boolean;
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
  /** True when the linked service speaks the v1.2 contract. */
  supportsV12?: boolean;
}

/** Current conflict state (set when a push gets 409). */
export interface ConflictStateResponse {
  hasConflict: boolean;
  /** Number of items in the local tree that failed to push. */
  localCount?: number;
  /** Remote lastUpdated at the moment of conflict. */
  remoteLastUpdated?: string;
  /** Full local tree JSON (encrypted with current derived key) — only included on demand. */
  localTreeEncrypted?: string;
}

/** Detailed merge preview for the conflict resolution UI. */
export interface ConflictPreviewResponse {
  /** Counts from mergeTrees dry-run. */
  mergeStats: MergePreview;
  /** Local tree node count (denominator). */
  localCount: number;
  /** Remote tree node count (denominator). */
  remoteCount: number;
  /** Sample paths for localOnly (first 5). */
  localOnlySample: string[];
  /** Sample paths for remoteOnly (first 5). */
  remoteOnlySample: string[];
  /** Sample title conflicts (first 5, format "localTitle → remoteTitle"). */
  titleConflictsSample: string[];
  /** Sample folders created (first 5). */
  foldersCreatedSample: string[];
}

/** Direction to resolve the conflict. */
export type ConflictResolutionDirection = 'pull' | 'push' | 'merge';

/** Resolve conflict payload — executes the chosen resolution. */
export interface ResolveConflictPayload {
  direction: ConflictResolutionDirection;
}

/** One-slot undo for dangerous link operations. Snapshots are encrypted. */
export type UndoKind =
  | 'connect-new'
  | 'connect-pull'
  | 'connect-push'
  | 'connect-merge'
  | 'switch-new'
  | 'switch-pull'
  | 'switch-push'
  | 'switch-merge'
  | 'change-password'
  | 'restore'
  | 'import'
  | 'duplicates';

export interface UndoState {
  kind: UndoKind;
  timestamp: number;
  bookmarkCount?: number;
  serviceUrl?: string;
}

export interface DuplicateEntry {
  id: number;
  title?: string;
  path: string;
  /** Original (unnormalized) URL of this copy for display. */
  url?: string;
}

export interface DuplicateGroup {
  url: string;
  entries: DuplicateEntry[];
}

export type MessagePayload =
  | { command: MessageCommand.SyncBookmarks; sync: SyncRequest }
  | { command: MessageCommand.RestoreBookmarks; bookmarks: BookmarkNode[] }
  | { command: MessageCommand.ConnectNew; serviceUrl: string; password: string }
  | { command: MessageCommand.ConnectExisting; serviceUrl: string; syncId: string; password: string; direction: 'pull' | 'push' | 'merge' }
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
  | { command: MessageCommand.DeleteRemoteSync }
  | { command: MessageCommand.SwitchPreview; newServiceUrl: string; mode: 'new' | 'existing'; syncId?: string }
  | { command: MessageCommand.PreviewMerge; serviceUrl: string; syncId: string; password: string }
  | { command: MessageCommand.SetVerbosity; level: number }
  | { command: MessageCommand.GetUndoState }
  | { command: MessageCommand.UndoLastLink }
  | { command: MessageCommand.DismissUndo }
  | { command: MessageCommand.GetRemovedSync }
  | { command: MessageCommand.ClearRemovedSync }
  | { command: MessageCommand.ChangePassword; currentPassword: string; newPassword: string }
  | { command: MessageCommand.GetToolbarSync }
  | { command: MessageCommand.SetToolbarSync; enabled: boolean }
  | { command: MessageCommand.PreviewBackup; json: string; password: string }
  | { command: MessageCommand.GetSafetyList }
  | { command: MessageCommand.RestoreSafety; fileName: string }
  | { command: MessageCommand.DeleteSafety; fileName: string }
  | { command: MessageCommand.RemoveDuplicates; ids: number[] }
  | { command: MessageCommand.DownloadFile; filename: string; text: string }
  // Conflict resolution
  | { command: MessageCommand.GetConflictState }
  | { command: MessageCommand.GetConflictPreview }
  | { command: MessageCommand.ResolveConflict; direction: ConflictResolutionDirection };

/** Merge dry-run result: preview counts only, no trees (message size limits). */
export type MergePreview = MergeStats;

/** Safety list rows cross the wire as-is (manifest rows, no secrets). */
export type { SafetyEntry };

export type MessageResponse =
  | { ok: true; data?: unknown }
  | { ok: false; errorName: string; message: string };

const registry: Record<string, new (message: string) => Error> = {
  DataOutOfSyncException,
  DailyNewSyncLimitException,
  IncompleteSyncInfoException,
  InvalidCredentialsException,
  InvalidServiceException,
  NotAcceptingNewSyncsException,
  ServiceOfflineException,
  SyncNotFoundException,
  SyncTooLargeException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedApiVersionException,
  UnsupportedSyncVersionException,
  UnsupportedVersionException,
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
