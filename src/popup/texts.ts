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
