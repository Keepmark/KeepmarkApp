# Workflows (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same workflow principles and consequences. Compact popup
confirmation differences are listed explicitly below. Keep this file identical in
`KeepmarkApp/docs/WORKFLOWS.md` and `KeepmarkMobile/docs/WORKFLOWS.md`.
Words come from `UI-TERMS.md`. Platform differences are listed at the end.

## Rules that apply to every workflow

1. **Gating first.** A workflow that needs a linked sync (Add a sync, Change
   password, Backup import, Unlink, Delete sync) shows, when the device is not
   linked, one notice with a link to Connect and disables its action. The user
   never learns about a missing link from an error after submit.
2. **One informed confirmation.** Show the consequences before the final action,
   whose button names what will happen. In Add a sync and Backup import, the
   verified review is the confirmation: its final button executes immediately.
   Android Connect and conflict resolution show consequences beside the chosen
   direction and apply directly. The extension uses one inline confirmation
   for popup Connect and manager conflict resolution. Other destructive actions use one inline confirmation
   next to their button, with an explicit action and Cancel. Never add another
   confirmation after a review. No `window.confirm`, modal or checkbox.
3. **Direction wording and order.** Everywhere a direction is chosen the options
   are, in this order: `Keep the server copy` (Download), `Merge both`,
   `Keep this device's copy` (Upload; "this browser's copy" in the extension).
   One function builds the confirmation text for a direction and is used by
   Connect, Add a sync and Sync conflict.
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
| Connect: existing sync | no | Service URL, sync ID, password → verification → direction with consequences → apply | Android: apply executes; extension popup: one inline confirmation | Download: unsynced edits on this device are lost. Upload: changes from other devices are lost. Merge: items deleted on one side come back. |
| Add a sync (manager → Sync → `+ Add new sync`) | yes | Destination, new/existing sync and credentials → `Continue` (verifies, no writes) → direction and review → `Connect` | Review is the only confirmation; final button executes | The old sync stays available. Other devices keep using it until moved. Save the new sync ID and password. |
| Change password | yes | Current, New, Confirm new → `Change password` | always | Other devices stop syncing until they are unlinked and linked again with the new password. Unsynced local edits are uploaded now. Older backup files keep their own password. |
| Backup: export | no | Backup password + confirm → `Export encrypted backup` | none | The backup password is not the sync password and cannot be recovered. |
| Backup: import | yes | `Choose backup file…` → password of that backup → `Check backup` (dry run: item count, nothing changes) → consequences → `Restore backup` | Review is the only confirmation; final button executes | Replaces local bookmarks and the server copy; the other devices receive it at their next sync. A wrong password clears only the password; the file stays chosen. |
| Safety backup: restore | no | `Restore` | always | What is replaced (local or server copy) and that a pre-restore backup is taken. |
| Safety backup: delete | no | `Delete` | always | There is no undo. |
| Unlink this device | yes | `Unlink this device…` (extension: `Unlink this browser…`) | always | Local bookmarks stay. Linking again needs the sync ID and password. Edits not yet synced stay only on this device. Undo is cleared. |
| Delete sync from server (extension, service v1.2) | yes | Manager → Sync → `Delete from server…` on the active row | once | The server copy is gone for every device; they stop syncing at their next sync. No undelete. A plaintext copy of the server data is kept for download (the removed-sync card). |
| Removed sync (extension) | shown while unlinked after the sync was deleted or removed from the service | `Download copy` / `Dismiss…` | Dismiss only | The kept copy is the only copy of the removed sync; the download is a plain JSON file, not encrypted. |
| Sync conflict | conflict | direction with consequences → apply | Android: apply executes; extension: one inline confirmation | Same direction text as Connect. |
| Activate a saved sync (extension, multi-sync) | no (unlinked) / yes (linked) | Popup → `Syncs` list → `Activate` → sync-change password (only if set) → apply | none beyond the dialog | The password is proved first (it unwraps the row's key, then a read-only version gate + GET + decrypt); only then is the sync that is active right now saved, and a failed save or a pending conflict cancels the switch. The sync's own long password is never asked at activation. Without a sync-change password the dialog is a plain confirmation. |
| Add a new sync (extension, multi-sync) | no | Manager → Sync → `+ Add new sync` → mode `A new sync` → service URL + password + confirm → `Create and upload` | none: the note says the current sync stays | Uploads the bookmarks currently in this browser and reports how many. A pending conflict is a warning only: the new sync starts from the local tree, while the conflicted sync keeps its server copy. |
| Remove a saved sync (extension, multi-sync) | manager only | Manager → Sync → `Remove…` on a row | always | Dormant: the row only. Active: this browser is unlinked (the row is the link); the sync and its server copy stay. |
| Duplicates | no | mark → `Delete marked` (per URL or all marked) | always | One copy of each URL always stays. While linked the deletion is uploaded and the other devices get it at their next sync. A safety backup is saved first. |

## Step and button visibility

- Add a sync (Sync section) has two phases: destination and credentials, then verified review.
  Changing target inputs invalidates the review; changing direction updates it. Android
  Connect verifies credentials before showing reconciliation choices; the extension
  popup verifies during submission. Android merge previews run automatically when
  Merge is selected; the extension computes them during verification. Applying
  requires the current preview to be ready. Technical service details in the extension
  are collapsed under Details; failures remain next to Continue.
- The primary button of a step is disabled only while busy or when a required
  field is empty. Validation messages appear after pressing it.
- Busy labels: `Checking…`, `Connecting…`, `Downloading…`, `Uploading…`,
  `Merging…`, `Moving…`, `Changing…`, `Exporting…`, `Importing…`.
- A wizard that resumes (after leaving the page or an app restart) never resumes
  on its final review: it restarts at the step that asks the password, and the
  service check and merge preview run again.
- Undo (extension): the last overwrite offers `Undo` for its kind (named in
  words, not by key). Result text: `Undone: <what was undone>.`

## Multi-sync (saved syncs, extension)

- One sync is active at a time; the others are dormant rows (label, service,
  sync ID prefix, last use). Every row stores its derived key — under the
  optional sync-change password when one is set, in clear when it is not
  (same exposure as the active key). The sync ID (a capability token the UI
  truncates) is kept in the row, never the sync's long password.
- The **sync-change password** is optional and manager-owned: a short secret
  (a PIN of a few digits is fine — only "not empty" is enforced). It wraps a
  random vault key, which wraps every row's key. Changing it rewraps only the
  vault (rows untouched); removing it unwraps the rows to clear; losing it
  means the dormant keys are gone.
- Set/change/remove/reset it in Manager → Sync → Sync-change password. With a
  password, activation, a new link and any change that demotes the active key
  ask for it. Without one, a dormant row is a plain confirmation and the rows
  are stored in clear in this browser.
- Manager → Sync → `+ Add new sync` opens the form (hidden until requested):
  service URL, `A new sync` or `An existing sync`, credentials, optional name.
  - **A new sync** is additive: it is created on the service from the
    bookmarks currently in this browser and the result reports the uploaded
    count. The sync in use stays in the list. A pending conflict is only a
    warning (the new sync starts from the local tree; the conflicted sync
    keeps its server copy).
  - **An existing sync** while linked goes through the check/review wizard
    (direction + consequences); while unlinked it connects directly after the
    direction confirmation.
- Row actions: `Activate` (dormant), `Rename` (metadata only, no password),
  `Unlink` (active: detach this browser, the row stays dormant),
  `Delete from server…` (active only, v1.2: removes the server copy and the
  row) and `Remove…` (every row).
  - `Remove…` on a dormant row forgets the row only: bookmarks, server copy
    and safety backups stay.
  - `Remove…` on the active row necessarily unlinks this browser (the row is
    the link), then forgets the row. There is no "remove the active only when
    it is the last" rule and no "activate another first" step.
- The popup is read-only: dormant rows offer only `Activate`, which opens a
  modal dialog asking for the sync-change password (only when one is set) and
  states that it is not the sync's own password. Rename, remove, delete and
  the add flow live in the manager (footer `Manage`). The saved list is shown
  when there is something to switch to (2+ rows, or 1 dormant row while
  unlinked); with a single active sync it is hidden.
- Activating a row = (password when set) → the background unlocks the row's
  key and proves the target with a read-only preflight (version gate + GET +
  decrypt, nothing written) → saves the active side (`fail-closed`: unpushed
  native edits are pushed first; a pending conflict cancels the switch) →
  replaces the native tree with the target's → the previous sync stays listed.
- Reset (forgotten password) mints a new vault and deletes every row but the
  active one; the active sync keeps working and is wrapped under the new
  password. Server copies, safety backups and the undo slot are untouched.
- Activating the already-active row is refused; the native tree is never
  re-read from the same sync.
- The list survives unlink and browser restart; the active row is marked
  `Active` with its API badge, the others are `Inactive` and offer `Activate`.

## Platform differences (allowed)

- The extension has a popup (connect, status, sync now) and a full-page manager
  (all other workflows). The mobile app has one page per workflow.
- `Delete sync from server` and conditional requests exist only where the service
  reports v1.2.
- The extension says "this browser's copy"; the mobile app says "this device's
  copy".
- Undo of the last overwrite exists only in the extension; the mobile app's way
  back is Backup → Safety backups (Home keeps a short undo for a single delete).
- Change password result: the extension adds `Undo is in Status`.
- Backup restore: the extension needs a linked sync (the restored tree is
  uploaded right away). The mobile app also restores while unlinked, on this
  device only; its implication line says which case applies.

## Service selection (connect and move)

Every editable service URL uses the same selector: eight curated public services,
with the first one selected by default, followed by locally saved custom services
and “Custom URL…”. Each entry shows the host (marked as the default or as saved)
with its country, size limit and API version; a service that accepts existing
syncs only says so, and any message the service reports is shown with the endpoint.
Only the selected service is probed, and a stale reply cannot unlock another URL.
Public and saved entries are checked automatically; custom URLs expose a manual
connection check and adjacent API/limit/location feedback, and editing a custom URL
invalidates its proof. Offline or incompatible services block progress; a service
accepting existing syncs only blocks new-sync creation.

The move “Continue” action still verifies target credentials and prepares the
consequence review; it is not a manual connection-test button. The selector must
pass first. A custom URL is saved only after a successful connect/create/move,
never after a probe or preview, and stays in the catalog if temporarily offline.
Saved entries keep the location, size limit and API version verified when they were
paired, and are local to this installation; URLs are normalized and deduplicated,
preserving reverse-proxy paths. No catalog request contacts every listed service or
depends on either discovery website at runtime.

The selector opens on the service this installation is already linked to, and on the
catalog default while nothing is linked. Wherever a destination is named in words —
the Android move review and the confirm that precedes the move, and the completion
message on both platforms — the full normalized service URL is used, never the bare
host.

## Browser → Android QR linking

- Browser manager Status → Connect Keepmark on your phone (Android icon) → Show connection QR →
  focused dialog → current password → Show QR. The launch button is hidden
  while the dialog is open. Password errors stay next to the key-icon input
  inside the dialog and allow retry. The QR includes a small Keepmark logo.
  Outside click or Escape closes the dialog and erases the QR.
  Local key verification and a read-only remote GET/decryption precede display.
- The QR is compact Keepmark format-1 JSON with service, ID, sync data version
  and original password; 1800 UTF-8 bytes maximum. No password is persisted or
  sent to the service. Display ends after 60 seconds, close, Escape, navigation,
  hidden, blur or pagehide; returning never restores it. A captured copy remains
  reusable: this is a display timeout, not credential expiry.
- Android Connect → Existing sync and Add a sync → existing target offer a
  QR icon button before manual service/ID/password entry. Scan QR requests camera
  permission only after the user chooses scanning. First scan stops the camera.
  Validation is local; the service and abbreviated ID are shown before any
  network request. The acquired-credentials review replaces manual fields,
  scan prompts and later-step headings in both flows. Service and short ID sit
  above separate full-width Continue / Cancel actions with explicit spacing.
  During verification only this review and its busy state remain; the raw
  candidate has already been consumed. Cancel/Back return to the unchanged
  manual target; background, lock or 60 seconds discard the candidate.
- Explicit Link reuses the manual verification and reconciliation path.
  Direction consequences, one final action, preview locks and safety backups remain
  required. Verification failure drops the QR password and requires rescanning;
  manual entry remains available. Already-linked devices scan within Add a sync
  and retain its verification/review gates.


## Android: organize multiple items

Hold a bookmark/folder, or choose Select from its action menu. Tap more rows or All;
folders include their contents. Move opens the destination tree: choose a folder or
create one inside the selected destination, then confirm Move. A newly created folder
is saved immediately, even if Move is canceled. Move can be undone for six seconds
unless content has since changed. Delete asks once, including counts of folder
contents, and creates a verified safety backup before deleting. Recovery for multiple
delete is through Backup → Safety backups. Back exits selection without changes;
Back inside picker/confirmation preserves selection. New sync contents invalidate
selection and ask you to select again. The selection remains local to the current
folder/search/results list; there is no selection carried across navigation.
