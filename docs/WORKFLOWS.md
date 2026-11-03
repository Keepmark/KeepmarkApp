# Workflows (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same workflow principles, direction words and consequences.
Actions that exist on one platform only are labelled. Keep this file identical
in `KeepmarkApp/docs/WORKFLOWS.md` and `KeepmarkMobile/docs/WORKFLOWS.md`.
Words come from `UI-TERMS.md`.

## Rules that apply to every workflow

1. **Gating first.** A workflow that needs a linked sync (Change password,
   Unlink, and on the extension Backup import and Delete sync from server) shows,
   when the device is not linked, one notice with a link to Connect and disables
   its action. Android offers `+ Add a sync` only while linked; its Backup import
   also works unlinked, on this device only. The user never learns about a
   missing link from an error after submit.
2. **One informed confirmation.** Show the consequences before the final action,
   whose button names what will happen. In Connect / Add a sync and in Backup
   import, the verified review is the confirmation: its final button executes
   immediately. Android Connect and conflict resolution show consequences beside
   the chosen direction and apply directly. The extension uses one inline
   confirmation for popup Connect and manager conflict resolution. Other
   destructive actions use one inline confirmation next to their button, with an
   explicit action and Cancel. Never add another confirmation after a review. No
   `window.confirm`, modal or checkbox.
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
7. **Safety backups are taken before every overwrite or deletion.** A workflow
   that takes one says so in its confirmation or result. Forgetting a saved sync
   affects its backups only where their key can never return: the extension
   deletes them (Restore only uses the active sync's key); Android keeps them,
   because re-linking the same sync with the same password derives the same key
   again.

## Shared workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Connect: new sync | no | Service URL, password + confirm → `Create sync` | none | The password cannot be recovered. After success the full sync ID is shown with `Copy sync ID`. |
| Connect: existing sync | no | Service URL, sync ID, password → verification → direction with consequences → apply | Android: apply executes; extension popup: one inline confirmation | Download: unsynced edits on this device are lost. Upload: changes from other devices are lost. Merge: items deleted on one side come back. |
| Change password | yes | Current, New, Confirm new → `Change password` | always | Other devices stop syncing until they are unlinked and linked again with the new password. Unsynced local edits are uploaded now. Older backup files keep their own password. |
| Backup: export | no | Backup password + confirm → `Export encrypted backup` | none | The backup password is not the sync password and cannot be recovered. |
| Backup: import | yes (extension) / no (Android) | `Choose backup file…` → password of that backup → `Check backup` (dry run: item count, nothing changes) → consequences → `Restore backup` | Review is the only confirmation; final button executes | Replaces local bookmarks and, while linked, the server copy; the other devices receive it at their next sync. A wrong password clears only the password; the file stays chosen. |
| Safety backup: restore | no | `Restore` | always | What is replaced (local bookmarks or server copy) and that a pre-restore backup is taken. |
| Safety backup: delete | no | `Delete` | always | There is no undo. |
| Unlink this device | yes | `Unlink this device…` | always | Local bookmarks stay. Linking again needs the sync ID and password. Edits not yet synced stay only on this device. Undo is cleared. |
| Sync conflict | conflict | direction with consequences → apply | Android: apply executes; extension: one inline confirmation | Same direction text as Connect. |
| Duplicates | no | mark → `Delete marked` (per URL or all marked) | always | One copy of each URL always stays. While linked the deletion is uploaded and the other devices get it at their next sync. A safety backup is saved first. |

## Android workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Add a sync while linked (Connect → `+ Add a sync`) | yes | Sync-change password gate (only if set) → existing sync only (manual or QR) → verification → direction with consequences → apply | apply executes | The sync just added becomes active; the previous one stays in the Syncs list with its server copy. Unsynced edits on this device are pushed first: a pending conflict or a failed push cancels the switch and changes nothing. A brand-new sync requires unlinking first (bookmarks stay). With a sync-change password, the wizard is gated: one field and `Continue` come first (a wrong password fails there, cleared), and only then the form opens — the password is never asked again inside it. |
| Syncs: Activate | no | Syncs → `Activate` → device unlock when app lock is set → apply | none beyond the device unlock | Read-only check first (service/version gate + download + decrypt with the key saved in the row); only then the active side is saved and this device adopts the chosen sync's copy behind a `switch-take-remote` safety backup. The sync you leave stays in the list. The sync's own long password is never asked. |
| Syncs: Forget / Unlink | no | Syncs → `Forget…` (inactive) / `Unlink this device…` (active) | always | Inactive: only the row is forgotten; bookmarks, the server copy and the other rows stay. Active: this device is unlinked and the row disappears; the bookmarks stay and the sync plus its server copy stay for the other devices. Dormant rows survive an unlink. Forgetting also drops that key's safety-master wrap when no other saved sync uses it; safety backups and copies of removed syncs stay. |
| Removed sync (401) | shown while linked | Home/Status notice → `Try again` / `Unlink and keep a copy…` / `Cancel` | always for the unlink; retry and cancel execute at once | The service no longer has this sync (expiry or another device's deletion). Nothing happens automatically and local bookmarks are untouched. Unlinking keeps a verified local copy of this device's tree, restorable from Backup → `Copies of removed syncs` and never pruned; `Cancel` keeps the notice quiet for that sync until an explicit retry. |
| Removed-sync copy | no | Backup → `Copies of removed syncs` → `Restore` / `Delete` | always | Restore takes a `pre-restore` safety backup first and replaces the local bookmarks (pushed at the next sync while linked). Delete removes only that copy; there is no undo. Copies are never pruned automatically. |

## Extension workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Add a sync (manager → Sync → `+ Add a sync`) | no | Destination, `A new sync` / `An existing sync`, credentials → `Continue` (verifies, no writes) → direction and review → `Connect` | Review is the only confirmation; final button executes | The previous sync stays available and other devices keep using it until moved. A new sync is created from the bookmarks currently in this browser and reports the uploaded count. Save the new sync ID and password. |
| Activate a saved sync (popup) | no (unlinked) / yes (linked) | `Syncs` list → `Activate` → sync-change password (only if set) → apply | none beyond the dialog | The password is proved first (it unwraps the row's key, then a read-only version gate + GET + decrypt); only then is the sync that is active right now saved (`fail-closed`: a pending conflict cancels the switch). The sync's own long password is never asked at activation. Without a sync-change password the dialog is a plain confirmation. |
| Forget or unlink a saved sync (manager) | manager only | Manager → Sync → `Forget…` (inactive) / `Unlink this device…` (active) | always | Inactive: only the row is forgotten and the server copy stays; safety backups only that key could open are deleted with it. Active: this device is unlinked and the row disappears; its bookmarks stay and the sync plus its server copy stay for the other devices. Deleting it for everyone is `Delete from server…`. |
| Delete sync from server (service v1.2) | yes | Manager → Sync → `Delete from server…` on the active row | once | The server copy is gone for every device; they stop syncing at their next sync. No undelete, and this browser keeps no copy: local bookmarks stay, no safety backup is taken or kept, and the manager reports the outcome. |
| Removed sync | shown while unlinked after the service no longer has the sync | Popup: informational notice only (no actions, no backup wording); Manager → Backup: `Download copy` / `Dismiss…` | Dismiss only | Only for a sync that disappeared from the service (expiry or another device's deletion). The popup states the fact and stops there: the kept copy and its actions belong to Backup, where the user goes on their own. That copy is the only copy of the removed sync and a plain JSON file, not encrypted. A deliberate `Delete from server…` keeps no copy. |

## Step and button visibility

- Add a sync (Sync section) has two phases: destination and credentials, then a
  verified review. Changing target inputs invalidates the review; changing
  direction updates it. Android Connect verifies credentials before showing
  reconciliation choices; the extension popup verifies during submission.
  Android merge previews run automatically when Merge is selected; the extension
  computes them during verification. Applying requires the current preview to be
  ready. Technical service details in the extension are collapsed under Details;
  failures remain next to Continue.
- The primary button of a step is disabled only while busy or when a required
  field is empty. Validation messages appear after pressing it.
- Busy labels: `Checking…`, `Connecting…`, `Downloading…`, `Uploading…`,
  `Merging…`, `Changing…`, `Exporting…`, `Importing…`.
- A flow that resumes (the extension manager after leaving the page or a browser
  restart) never resumes on its final review: it restarts at the step that asks
  the password, and the service check and merge preview run again. Android has
  no resumable wizard.
- Undo (extension): the last overwrite offers `Undo` for its kind (named in
  words, not by key). Result text: `Undone: <what was undone>.`

## Multi-sync model (shared principles)

- One sync is **active** at a time. Its tree is the only bookmark tree on the
  device. The other saved syncs are **inactive** rows: service URL, sync ID and
  derived key, plus an optional label; never the sync's long password.
- Identity is the canonical service URL plus the sync ID. Re-adding the same pair
  updates the row in place; a sync is never listed twice.
- The list is local to this installation: nothing about saved syncs is stored on
  the service.
- Activating is read-only until the target is proved: version gate + GET +
  decrypt with the saved key, then the active side is saved fail-closed, then the
  local tree is replaced. A wrong key, an expired sync, an offline service or a
  pending conflict changes nothing.
- The key protection differs by platform: Android stores the rows in the
  platform's Keystore-backed secure storage and can additionally require the
  device unlock (app lock) before a switch; the extension stores the rows under
  an optional **sync-change password** vault (plain rows when no password is
  set).
- `+ Add a sync` follows the platform's rules: Android offers only an existing
  sync while linked (a brand-new sync needs an unlink first); the extension can
  also create a new sync from the current bookmarks, which is additive and leaves
  the previous sync in the list.

## Extension: sync-change password

- Optional and manager-owned: a short secret (a PIN of a few digits is fine —
  only "not empty" is enforced). It wraps a random vault key, which wraps every
  row's key. Changing it rewraps only the vault (rows untouched); removing it
  unwraps the rows to clear; losing it means the inactive rows' keys are gone.
- Set/change/remove/reset it in Manager → Sync → Sync-change password. With a
  password, activation, a new link and any change that demotes the active key ask
  for it. Without one, an inactive row is a plain confirmation and the rows are
  stored in clear in this browser (same exposure as the active key).
- The add-sync wizard is gated the same way: with a password set, `+ Add a
  sync` asks for it first (`VerifySwitchPassword`, read-only proof), then shows
  the rest of the flow; the form has no password field of its own.
- The section shows only the state (`Set` / `Not set`) and the actions; one
  action at a time opens a single panel with just the fields that action needs:
  `Set…` (new + repeat), `Change…` (current + new + repeat), `Remove…` (current
  alone, with the consequence as the confirmation) and `Forgot it? Reset…` (new
  + repeat, below the actions, since it is the last resort). Cancel closes the
  panel and clears its fields; a wrong current password is never kept.
- Reset (forgotten password) mints a new vault and deletes every row but the
  active one; the active sync keeps working and is wrapped under the new
  password. Server copies and the undo slot are untouched; the encrypted safety
  backups of the dropped rows go with them.
- The popup is read-only: inactive rows offer only `Activate`. Rename, forget,
  unlink, delete and the add flow live in the manager (footer `Manage`). The
  saved list appears when there is something to switch to (2+ rows, or 1
  inactive row while unlinked); with a single active sync it is hidden.

## Android: a sync removed from the service

- A 401 (sync not found: expired after inactivity, or deleted by someone) never
  triggers a local action. Home and Status show one notice with `Try again`,
  `Unlink and keep a copy…` and `Cancel`; nothing is unlinked, uploaded or
  snapshotted until the user chooses.
- `Unlink and keep a copy…` asks once, then keeps a verified local copy of this
  device's tree before the credentials go: content-addressed, encrypted with the
  device key, in `Backup` → `Copies of removed syncs`, with `Restore` and
  `Delete`. The copy is never pruned automatically and identical trees are stored
  once. With no local items, the device is simply unlinked and no empty file is
  written.
- `Cancel` only silences the notice for that sync: it comes back after an
  explicit `Try again` or for a different sync, never on its own.
- The unlink keeps local bookmarks on screen and removes only the row of that
  sync; dormant rows are untouched.

## Platform differences (allowed)

- The extension has a popup (connect, status, sync now) and a full-page manager
  (all other workflows). The mobile app has one page per workflow.
- `Delete sync from server` and conditional requests exist only where the service
  reports v1.2.
- The extension says "this browser's copy"; the mobile app says "this device's
  copy".
- The extension protects saved-sync keys with an optional sync-change password;
  Android uses platform secure storage plus the optional device unlock.
- Android can add only an existing sync while linked; the extension can also
  create a new sync from the current bookmarks.
- Undo of the last overwrite exists only in the extension; the mobile app's way
  back is Backup → Safety backups (Home keeps a short undo for a single delete).
- Change password result: the extension adds `Undo is in Status`.
- Backup restore: the extension needs a linked sync (the restored tree is
  uploaded right away). The mobile app also restores while unlinked, on this
  device only; its implication line says which case applies.
- A removed sync keeps an encrypted, restorable copy on Android; the extension
  offers a plain JSON download or dismissal.

## Service selection (connect and add)

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

The `Continue` action still verifies target credentials and prepares the
consequence review; it is not a manual connection-test button. The selector must
pass first. A custom URL is saved only after a successful connect/create/add,
never after a probe or preview, and stays in the catalog if temporarily offline.
Saved entries keep the location, size limit and API version verified when they were
paired, and are local to this installation; URLs are normalized and deduplicated,
preserving reverse-proxy paths. No catalog request contacts every listed service or
depends on either discovery website at runtime.

The selector opens on the service this installation is already linked to, and on the
catalog default while nothing is linked. Wherever a destination is named in words —
the Connect review and confirmation, and the completion message on both platforms —
the full normalized service URL is used, never the bare host. Android's custom
editor chooses the scheme (`https` default, `http` explicit) next to the host box
and shows the cleartext warning immediately when `http` is selected; the extension
accepts `https` and plain `http` only for `localhost` / `127.0.0.1` / `[::1]`.

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
- Android Connect (first link, and `+ Add a sync` while linked) offers a
  QR icon button before manual service/ID/password entry. Scan QR requests camera
  permission only after the user chooses scanning. First scan stops the camera.
  Validation is local; the service and abbreviated ID are shown before any
  network request. The acquired-credentials review replaces manual fields,
  scan prompts and later-step headings in both flows. Service and short ID sit
  above separate full-width Continue / Cancel actions with explicit spacing.
  During verification only this review and its busy state remain; the raw
  candidate has already been consumed. Cancel/Back return to the unchanged
  manual target; background, lock or 60 seconds discard the candidate.
- An `http://` payload is accepted by the parser, but the review does not repeat
  the cleartext warning shown by the manual editor (known gap).
- Explicit Connect reuses the manual verification and reconciliation path.
  Direction consequences, one final action, preview locks and safety backups remain
  required. Verification failure drops the QR password and requires rescanning;
  manual entry remains available. Already-linked devices scan within `+ Add a
  sync` and keep the same verification/review gates.

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
