// User-facing workflow texts: confirmations, implication lines and results.
// One place to read and change them; wording follows docs/UI-TERMS.md and
// docs/WORKFLOWS.md (kept identical to the Android app).

export const ChangePasswordImplication =
  'Your other devices stop syncing until you unlink them and link again with the new password. ' +
  'Edits not yet synced are uploaded now. Older backup files keep their own password.';

export const ChangePasswordDone =
  'Password changed. Link your other devices again with the new password and update your password manager. ' +
  'Undo is in Status; the previous server copy is in Backup → Safety backups.';

// Backup → Export.
export const BackupPasswordHint =
  'It is not your sync password and cannot be recovered: without it the file cannot be opened.';
export const exportDone = (fileName: string): string =>
  `Backup saved to your downloads as ${fileName}. Keep its password: it is not your sync password and cannot be recovered.`;

// Backup → Restore from a backup file.
export const importChecked = (fileName: string, count: number): string =>
  `${fileName}: ${count} item(s), password correct. Nothing has changed yet.`;
export const ImportImplication =
  "This browser's bookmarks and the server copy are replaced; your other devices get the backup at their next sync. " +
  'The current bookmarks are saved to Safety backups first, and Undo is in Status.';
export const importDone = (count: number): string =>
  `Restored ${count} item(s) and uploaded them. Your other devices get them at their next sync. ` +
  'Undo is in Status; the previous bookmarks are in Safety backups below.';

// Backup → Safety backups.
export const safetyRestoreImplication = (side: 'local' | 'remote', items: number): string =>
  side === 'local'
    ? `This browser's bookmarks are replaced with this copy (${items} items) and, while linked, uploaded; ` +
      'your other devices get it at their next sync. The current bookmarks are saved as a safety backup first.'
    : `The server copy is replaced with this copy (${items} items); your other devices get it at their next sync. ` +
      'The current server copy is saved as a safety backup first.';
export const safetyRestoreDone = (count: number, preFile: string): string =>
  `Restored ${count} item(s). The state before the restore is saved as ${preFile}.`;
export const SafetyDeleteImplication = 'This safety backup is gone for good.';

// Duplicates.
export const dupDeleteConfirm = (count: number): { message: string; implication: string; confirmLabel: string } => ({
  message: `Delete ${count} marked duplicate(s)?`,
  implication:
    'One copy of each URL always stays; while linked the deletion is uploaded and your other devices get it at their next sync. ' +
    'A safety backup is saved first.',
  confirmLabel: 'Yes, delete',
});
export const dupDeleteDone = (count: number): string =>
  `Deleted ${count} duplicate(s). Safety backup saved — see Backup → Safety backups.`;

// Status → Danger zone.
export const UnlinkImplication =
  'Syncing stops; the bookmarks on this browser stay. To link again you need the sync ID and its password, ' +
  'so copy the sync ID first if you have not saved it. Edits not yet synced stay on this browser only, ' +
  'and Undo is cleared.';
export const UnlinkDone =
  'Browser unlinked. Its bookmarks are untouched; link again from the Keepmark popup with the sync ID and password.';
export const DeleteRemoteImplication =
  'The sync is erased from the service for every device: your other devices stop syncing and find it gone at ' +
  'their next sync. The service has no undelete. The bookmarks on this browser stay, and a copy of the server ' +
  'data is kept: download it from the Keepmark popup.';
export const DeleteRemoteDone =
  'Sync deleted from the server and this browser unlinked; its bookmarks are untouched. ' +
  'Download the kept copy of the server data from the Keepmark popup.';

// Popup → server-removed sync card.
export function removedSyncText(count: number, lastUpdated?: string): string {
  const when = lastUpdated ? ` (last synced ${new Date(lastUpdated).toLocaleString()})` : '';
  return (
    `This browser is unlinked. The bookmarks on this browser stay. The last synced copy${when}, ` +
    `${count} item${count === 1 ? '' : 's'}, is kept here: download it as a plain JSON file ` +
    '(not encrypted), or dismiss it.'
  );
}
export const RemovedSyncDismissImplication =
  'The kept copy is deleted from this browser. It is the only copy of the removed sync, so download it first if you may need it.';

// Direction choice (Connect existing sync, Move into an existing sync,
// Conflict). One order everywhere: server copy, merge, this browser's copy.
export type Direction = 'pull' | 'merge' | 'push';
export const DirectionOrder: readonly Direction[] = ['pull', 'merge', 'push'];

export const directionConfirm: Record<Direction, { message: string; implication: string; confirmLabel: string }> = {
  pull: {
    message: "Replace this browser's bookmarks with the server copy?",
    implication: 'Edits on this browser that are not yet synced are lost. A copy is saved to Backup → Safety backups first.',
    confirmLabel: 'Yes, download',
  },
  merge: {
    message: 'Merge both copies into one and sync it everywhere?',
    implication:
      'Nothing is deleted, but items removed on one side while the other was offline come back. ' +
      'Both copies are saved to Backup → Safety backups first.',
    confirmLabel: 'Yes, merge',
  },
  push: {
    message: "Replace the server copy with this browser's bookmarks?",
    implication: 'Changes from your other devices that are only on the server are lost. A copy is saved to Backup → Safety backups first.',
    confirmLabel: 'Yes, upload',
  },
};

// Move service.
export const MoveImplication =
  'The old sync stays on the old service and is not deleted. Your other devices stay linked to the old service ' +
  'until you move them too. Store the new sync ID and password.';
export const moveNewConfirm = (url: string, count?: number): string =>
  `Create a new sync on ${url} and upload ${count ?? 'your'} bookmarks?`;
export const MoveDoneNext = 'Store the sync ID with the password, then move your other devices with it.';

// Undo (Status banner in the manager, popup banner).
/** What the undo slot `kind` did, in words (never the raw key). */
export function undoWhat(kind: string): string {
  switch (kind) {
    case 'connect-new':
      return 'created a new sync';
    case 'connect-pull':
      return 'downloaded the server copy';
    case 'connect-push':
      return 'uploaded over the server copy';
    case 'connect-merge':
      return 'merged local and server bookmarks';
    case 'switch-new':
      return 'moved to a new sync';
    case 'switch-pull':
      return 'moved and downloaded the server copy';
    case 'switch-push':
      return 'moved and uploaded over the server copy';
    case 'switch-merge':
      return 'moved and merged with the server copy';
    case 'change-password':
      return 'changed the sync password';
    case 'restore':
      return 'restored bookmarks';
    case 'duplicates':
      return 'deleted duplicates';
    default:
      return 'imported a backup';
  }
}
export const undoConfirm = (kind: string): { message: string; implication: string; confirmLabel: string } => ({
  message: 'Undo the last action?',
  implication: `It reverts “${undoWhat(kind)}”. Changes made since then are discarded.`,
  confirmLabel: 'Yes, undo',
});
export const undoneText = (kind: string): string => `Undone: ${undoWhat(kind)}.`;
