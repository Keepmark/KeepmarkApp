// User-facing workflow texts: confirmations, implication lines and results.
// One place to read and change them; wording follows docs/UI-TERMS.md and
// docs/WORKFLOWS.md (kept identical to the Android app).

export const ChangePasswordImplication =
  'Your other devices stop syncing until you unlink them and link again with the new password. ' +
  'Edits not yet synced are uploaded now. Older backup files keep their own password.';

export const ChangePasswordDone =
  'Password changed. Link your other devices again with the new password and update your password manager. ' +
  'Undo is in Status; the previous server copy is in Backup → Safety backups.';
