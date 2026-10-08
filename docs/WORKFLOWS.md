# Workflows (shared by Keepmark browser extension and Keepmark Android)

Both apps implement the same user workflows with the same steps, buttons,
confirmations and messages. Keep this file identical in
`KeepmarkApp/docs/WORKFLOWS.md` and `KeepmarkMobile/docs/WORKFLOWS.md`.
Words come from `UI-TERMS.md`. Platform differences are listed at the end.

## Rules that apply to every workflow

1. **Gating first.** A workflow that needs a linked sync (Move service, Change
   password, Backup import, Unlink, Delete sync) shows, when the device is not
   linked, one notice with a link to Connect and disables its action. The user
   never learns about a missing link from an error after submit.
2. **One confirmation pattern.** The action button names the action. When the
   action replaces or removes data, pressing it opens an inline confirmation
   block next to the button: one implication line (what is lost, where, and who
   else is affected), then `Yes, <verb>` and `Cancel`. No `window.confirm`, no
   modal, no checkbox. Destructive confirm buttons are red; non-destructive
   actions never ask.
3. **Direction wording and order.** Everywhere a direction is chosen the options
   are, in this order: `Keep the server copy` (Download), `Merge both`,
   `Keep this device's copy` (Upload; "this browser's copy" in the extension).
   One function builds the confirmation text for a direction and is used by
   Connect, Move service and Sync conflict.
4. **Password rule.** Any password the user invents is at least 8 characters and
   is typed twice. A password the user enters to open something existing is typed
   once and has no length rule. Messages: `Use a password of at least 8
   characters.` and `Passwords do not match.`
5. **Errors stay next to the button that caused them**, are announced
   (`role="alert"`), and are emptied when the step is retried. On failure only
   secrets that were consumed are cleared; fields needed to retry stay, and any
   armed confirmation is reset.
6. **Results say what happened and what to do next**: one line of outcome, one
   line of follow-up when the user has something to do (store the sync ID, update
   other devices), and a pointer to Backup → Safety backups when one was made.
7. **Safety backups** are taken before every overwrite or deletion. A workflow
   that takes one says so in its confirmation or result.

## Workflow table

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Connect: new sync | no | Service URL, password + confirm → `Create sync` | none | The password cannot be recovered. After success the full sync ID is shown with `Copy sync ID`. |
| Connect: existing sync | no | Service URL, sync ID, password → `Open sync` (verifies) → direction → apply | always | Download: unsynced edits on this device are lost. Upload: changes from other devices are lost. Merge: items deleted on one side come back. |
| Move service | yes | Service URL → `Check service` → New sync (password + confirm) or Existing sync (ID, password → `Open sync` → direction) → review → `Move now` | when it replaces something | The old sync stays on the old service and is not deleted. Other devices stay linked to the old service until they are moved too. Store the new sync ID and password. |
| Change password | yes | Current, New, Confirm new → `Change password` | always | Other devices stop syncing until they are unlinked and linked again with the new password. Unsynced local edits are uploaded now. Older backup files keep their own password. |
| Backup: export | no | Backup password + confirm → `Export encrypted backup` | none | The backup password is not the sync password and cannot be recovered. |
| Backup: import | yes | `Choose backup file…` → password of that backup → `Check backup` (dry run: item count, nothing changes) → `Replace with this backup…` | always | Replaces local bookmarks and the server copy; the other devices receive it at their next sync. A wrong password clears only the password; the file stays chosen. |
| Safety backup: restore | no | `Restore` | always | What is replaced (local or server copy) and that a pre-restore backup is taken. |
| Safety backup: delete | no | `Delete` | always | There is no undo. |
| Unlink this device | yes | `Unlink this device…` (extension: `Unlink this browser…`) | always | Local bookmarks stay. Linking again needs the sync ID and password. Edits not yet synced stay only on this device. Undo is cleared. |
| Delete sync from server (extension, service v1.2) | yes | `Delete sync from server…` | always, twice (`Yes, delete` → `Yes, delete for good`) | The server copy is gone for every device; they stop syncing at their next sync. No undelete. A plaintext copy of the server data is kept for download (the removed-sync card). |
| Removed sync (extension) | shown while unlinked after the sync was deleted or removed from the service | `Download copy` / `Dismiss…` | Dismiss only | The kept copy is the only copy of the removed sync; the download is a plain JSON file, not encrypted. |
| Sync conflict | conflict | direction → apply | always | Same direction text as Connect. |
| Duplicates | no | mark → `Delete marked` | always | One copy of each URL stays; a safety backup is saved first. |

## Step and button visibility

- Wizards (Move service, Connect existing) show one step at a time. A later step
  appears only when the earlier step passed, and disappears again if the earlier
  inputs change (`Inputs changed — check again.`).
- The primary button of a step is disabled only while busy or when a required
  field is empty. Validation messages appear after pressing it.
- Busy labels: `Checking…`, `Connecting…`, `Downloading…`, `Uploading…`,
  `Merging…`, `Moving…`, `Changing…`, `Exporting…`, `Importing…`.
- A wizard that resumes after an app restart never resumes past a step that needs
  a password; it restarts at the step where the password is asked.
- Undo: the last overwrite offers `Undo` for its kind (named in words, not by
  key). Result text: `Undone: <what was undone>.`

## Platform differences (allowed)

- The extension has a popup (connect, status, sync now) and a full-page manager
  (all other workflows). The mobile app has one page per workflow.
- `Delete sync from server` and conditional requests exist only where the service
  reports v1.2.
- The extension says "this browser's copy"; the mobile app says "this device's
  copy".
- Backup restore: the extension needs a linked sync (the restored tree is
  uploaded right away). The mobile app also restores while unlinked, on this
  device only; its implication line says which case applies.
