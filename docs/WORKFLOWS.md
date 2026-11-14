# Workflows (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same workflow principles, direction words and consequences.
Actions that exist on one platform only are labelled. Keep this file identical
in `KeepmarkApp/docs/WORKFLOWS.md` and `KeepmarkMobile/docs/WORKFLOWS.md`.
Words come from `UI-TERMS.md`.

## Rules that apply to every workflow

1. **Gating first.** A workflow that needs a linked sync (Change password,
   Unlink, and on the extension Backup import and Delete sync from server) shows,
   when the device is not linked, one notice with a link to the connection flow and disables
   its action. Android offers an existing sync while linked; while unlinked `+ Add a sync`
   can also create a new one. Its Backup import works unlinked, on this device only. The user never learns about a
   missing link from an error after submit.
2. **One informed confirmation.** Show the consequences before the final action,
   whose button names what will happen. In Connect / Add a sync and in Backup
   import, the verified review is the confirmation: its final button executes
   immediately. Android Connect and conflict resolution show consequences beside
   the chosen direction and apply directly. The extension uses one inline
   confirmation for popup Connect and manager conflict resolution. Other
   destructive actions use one confirmation next to their button (inline, or
   inside the modal task that owns the operation), with an explicit action and
   Cancel. Never add another confirmation after a review. No `window.confirm`
   and no checkbox.
3. **Direction wording and order.** Everywhere a direction is chosen the options
   are, in this order: `Keep the server copy` (Download), `Merge both`,
   `Keep this device's copy` (Upload; "this browser's copy" in the extension).
   One function builds the confirmation text for a direction and is used by
   Connect, Add a sync and Sync conflict.
4. **Password rule.** A new sync or backup password is at least 8 characters and
   is typed twice. A password the user enters to open something existing is typed
   once and has no length rule. Messages: `Use a password of at least 8
   characters.` and `Passwords do not match.` The extension sync lock is a
   separate device-local secret: only non-empty is required.
5. **Errors stay next to the button that caused them**, are announced
   (`role="alert"`), and are emptied when the step is retried. On failure only
   secrets that were consumed are cleared; fields needed to retry stay, and any
   armed confirmation is reset.
6. **Results say what happened and what to do next**: one line of outcome, one
   line of follow-up when the user has something to do (store the sync ID, update
   other devices), and a pointer to Backup → Safety backups when one was made.
7. **Safety backups are taken before every destructive step, not on every
   edit.** A first link that replaces a side (Connect: existing sync, either
   direction), a backup import, a restore, a password change, a duplicates
   cleanup or a batch delete snapshots the side it replaces. Android moves and
   single-item deletes use a short Undo; bulk delete recovers through Backup.
   Deliberate browser server deletion takes no backup and keeps no recovery copy. **Switching between saved syncs
   takes no snapshot on either app:** the copy this device leaves is already
   on its own server and activating that sync again brings it back, so a switch
   is reversible without a backup. A sync that would replace more than 10
   changed items in one go (a wipe, an import done outside the app, another client gone
   wrong) is not an ordinary edit either: it snapshots the side it replaces
   first (a move counts as removal plus addition) — `sync-pull` for the copy on this device, `sync-push` for the server
   copy — and the sync then continues. The extension shows no "last action /
   undo" banner in Status; its visible recovery path is Backup → Safety
   backups. A workflow that takes a snapshot says so in its confirmation or
   result.
   Forgetting a saved sync affects its backups only where their key can never
   return: the extension deletes them (Restore only uses the active sync's
   key); Android keeps them, because re-linking the same sync with the same
   password derives the same key again.
8. **One task at a time, on its own surface.** An operation that takes over the
   screen — Add a sync, Activate a saved sync, the sync lock, rename / forget /
   unlink / delete of a saved sync, and Change password — runs as a single
   task. On the extension it is a modal dialog: the page behind is inert, Cancel
   and Escape end it, and opening another task closes the first. On Android the
   add panel replaces the Syncs list and every other row is disabled while a row
   confirmation, the rename editor or the change-password task is open. Two
   operations, two Cancel buttons or a second confirmation are never on screen
   at once.

## Saved-sync list and settings layout

The extension manager and Android Syncs page give every saved sync a prominent
`Activate` button. It is disabled on the active sync, whose active badge stays
visible. Secondary commands are in the row's accessible `⋮` menu: ordinary
commands (rename, show QR or change password where supported) first, then a
separate final group for forgetting, unlinking and server deletion where
supported. A menu opens only that row's existing task; confirmations and stable
sync identity checks still apply. Only one menu is open at a time; Escape and
clicking outside close it. The extension popup remains a minimal activation list.

On Android, Settings places the complete log block after all other preferences,
immediately before `Save`.

## Shared workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Connect: new sync | no | Service URL, password + confirm → `Create sync` | none | The password cannot be recovered. After success the full sync ID is shown with `Copy sync ID`. |
| Connect: existing sync | no | Service URL, sync ID, password → verification → direction with consequences → apply | Android: apply executes; extension popup: one inline confirmation | Download: unsynced edits on this device are lost. Upload: changes from other devices are lost. Merge: items deleted on one side come back. |
| Change password | yes | Syncs → `Change password` on the active sync's row → Current, New, Confirm new → `Change password` | one inline confirmation | Other devices stop syncing until they are unlinked and linked again with the new password. Unsynced local edits are uploaded now. Older backup files keep their own password. The long password belongs to the sync, so this is a row action in Syncs, never a Settings section, and the sync lock is not asked again: the saved key is re-wrapped under the previous one. |
| Backup: export | no | Backup → `Export…` (opens a task dialog) → backup password + confirm → `Export encrypted backup` | none | The backup password is not the sync password and cannot be recovered. |
| Backup: import | yes (extension) / no (Android) | `Choose backup file…` → password of that backup → `Check backup` (dry run: item count, nothing changes) → consequences → `Restore backup` | Review is the only confirmation; final button executes | Replaces local bookmarks and, while linked, the server copy; the other devices receive it at their next sync. A wrong password clears only the password; the file stays chosen. |
| Safety backup: restore | no | `Restore` | always | What is replaced (local bookmarks or server copy) and that a pre-restore backup is taken. Backups of another sync (or needing a link while unlinked) cannot be restored here: they are hidden behind the `Restorable here / All` filter, shown dimmed with the reason, with no `Restore` and, when their sync is saved, `Activate <name>…` instead. |
| Safety backup: delete | no | `Delete` | always | There is no undo. |
| Unlink this device | yes | `Unlink this device…` | always | Local bookmarks stay. Linking again needs the sync ID and password. Edits not yet synced stay only on this device. Undo is cleared. |
| Sync conflict | conflict | direction with consequences → apply | Android: apply executes; extension: one inline confirmation | Same direction text as Connect. |
| Duplicates | no | mark → `Delete marked` (per URL or all marked) | always | One copy of each URL always stays. While linked the deletion is uploaded and the other devices get it at their next sync. A safety backup is saved first. |

## Android workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Add a sync while linked (Syncs → `+ Add a sync`) | yes | Device unlock when app lock is set → existing sync only (manual or QR) → verification → direction with consequences → apply | apply executes | The sync just added becomes active; the previous one stays in the Syncs list with its server copy. Unsynced edits on this device are pushed first: a pending conflict, a missing connection, a sync that no longer exists on the server or a failed push cancels the switch and changes nothing, and the message names that exact cause. A brand-new sync requires unlinking first (bookmarks stay). |
| Bookmarks file (HTML): export | no | Backup → Bookmarks file (HTML) → `Export HTML…` → warning → `Export anyway` → share sheet | the warning is the confirmation | The file is NOT encrypted. It is a hand-over copy: Keepmark deletes its own copy at the next export or start. |
| Bookmarks file (HTML): import | no | Backup → Bookmarks file (HTML) → `Import HTML…` → choose a `.html` file → preview (bookmarks, folders, separators, skipped links, duplicates; `Skip bookmarks already saved` on by default) → `Import` | Review is the only confirmation; final button executes | Additive only: one new folder `Imported <date>` at the end of Other, nothing is replaced. A safety backup is saved first; while linked the import is uploaded. |
| Tags: rename, merge, delete | no | Menu → `Tags` → tap a tag → rename (a name that already exists merges the two) or delete | delete: always; rename/merge: the note under the field | The change applies to every bookmark with that tag in one step; the bookmarks themselves stay. A safety backup is saved first; while linked the change is uploaded. |
| Pull to refresh (Explore) | yes | With the list at the top, drag down past the threshold and release | none | Same as `Sync now`. Silent when nothing moved; a short `Synced` when bookmarks were received or sent; errors, conflicts and offline report as usual. |
| Syncs: Activate | no | Syncs → `Activate` → confirmation → device unlock when app lock is set → apply | once, plus device unlock when configured | Read-only check first (service/version gate + download + decrypt with the key saved in the row); only then the active side is saved and this device adopts the chosen sync's copy — with no safety backup when it was linked to another sync (that copy is on the server); an unlinked device keeps the usual `switch-take-remote` backup. If that save cannot happen the switch is cancelled with the real reason (pending conflict, no connection, sync gone from the server, push failed) and nothing is replaced. The sync you leave stays in the list. The sync's own long password is never asked. |
| Syncs: Forget / Unlink | no | Syncs → `Forget…` (inactive) / `Unlink this device…` (active) | always | Inactive: only the row is forgotten; bookmarks, the server copy and the other rows stay. Active: this device is unlinked and the row disappears; the bookmarks stay and the sync plus its server copy stay for the other devices. Dormant rows survive an unlink. Forgetting also drops that key's safety-master wrap when no other saved sync uses it; safety backups and copies of removed syncs stay. |
| Removed sync (401) | shown while linked | Home/Status notice → `Try again` / `Unlink and keep a copy…` / `Cancel` | always for the unlink; retry and cancel execute at once | The service no longer has this sync (expiry or another device's deletion). Nothing happens automatically and local bookmarks are untouched. Unlinking keeps a verified local copy of this device's tree, restorable from Backup → `Copies of removed syncs` and never pruned; `Cancel` keeps the notice quiet for that sync until an explicit retry. |
| Removed-sync copy | no | Backup → `Copies of removed syncs` → `Restore` / `Delete` | always | Restore takes a `pre-restore` safety backup first and replaces the local bookmarks (pushed at the next sync while linked). While a sync is linked the restore is refused until that sync has saved its pending edits, so nothing unsaved is replaced silently. Delete removes only that copy; there is no undo. Copies are never pruned automatically; a copy list that cannot be read says so instead of looking empty. |

## Extension workflows

| Workflow | Needs link | Steps | Confirmation | Implication line (required) |
|---|---|---|---|---|
| Add a sync (manager → Sync → `+ Add a sync`) | no | Modal task: sync lock password when set (same dialog, first step) → destination, `A new sync` / `An existing sync`, credentials → `Continue` (verifies, no writes) → direction and review → `Connect` | Review is the only confirmation; final button executes | The previous sync stays available and other devices keep using it until moved. A new sync is created from the bookmarks currently in this browser and reports the uploaded count. Save the new sync ID and password. |
| Activate a saved sync (popup or manager) | no (unlinked) / yes (linked) | `Syncs` list → `Activate` → modal with the confirmation and, when set, the sync lock password → apply | none beyond the dialog | The password is proved first (it unwraps the row's key, then a read-only version gate + GET + decrypt); only then is the sync that is active right now saved (`fail-closed`: a pending conflict cancels the switch). The sync's own long password is never asked at activation. Without a sync lock the dialog is a plain confirmation. |
| Forget or unlink a saved sync (manager) | manager only | Manager → Sync → `Forget…` (inactive) / `Unlink this device…` (active) → confirmation in the row modal | always | Inactive: only the row is forgotten and the server copy stays; safety backups and (extension) automatic backups only that key could open are deleted with it. Active: this device is unlinked and the row disappears; its bookmarks stay and the sync plus its server copy stay for the other devices. Deleting it for everyone is `Delete from server…`. |
| Delete sync from server (service v1.2) | yes | Manager → Sync → `Delete from server…` on the active row → confirmation in the row modal | once | The server copy is gone for every device; they stop syncing at their next sync. No undelete, and this browser keeps no copy: local bookmarks stay, no safety backup is taken or kept, and the manager reports the outcome. |
| Removed sync | shown while unlinked after the service no longer has the sync | Popup: informational notice only (no actions, no backup wording); Manager → Backup: `Download copy` / `Dismiss…` | Dismiss only | Only for a sync that disappeared from the service (expiry or another device's deletion). The popup states the fact and stops there: the kept copy and its actions belong to Backup, where the user goes on their own. That copy is the only copy of the removed sync and a plain JSON file, not encrypted. A deliberate `Delete from server…` keeps no copy. |
| Bookmarks file (HTML): export | no | Manager → Backup → `Export HTML…` → warning → `Export anyway` | the warning is the confirmation | The file is NOT encrypted: anyone who opens it can read every bookmark, tag and description. Keep it private and delete it once imported. |
| Automatic backups (manager → Settings) | no | Switch `Back up automatically`, `How often` (every day / every week), `Automatic backups to keep` (3 / 7 / 14 / 30); each change applies at once | only when lowering the limit below what is stored | Lowering the limit deletes the oldest automatic backups now; they cannot be recovered. Turning the switch off deletes nothing. The copies stay in this browser: removing the extension removes them. While no sync is linked the copy is not encrypted; forgetting or unlinking a sync deletes the automatic backups only its key could open. |

## Step and button visibility

- Add a sync (Sync section) has two phases: destination and credentials, then a
  verified review. Changing target inputs invalidates the review; changing
  direction updates it. Android Connect verifies credentials before showing
  reconciliation choices; the extension popup verifies during submission.
  Android merge previews run automatically when Merge is selected; the extension
  computes them during verification. Applying requires the current preview to be
  ready. Service checks show endpoint details beside the chosen service;
  failures remain next to Continue.
- The primary button of a step is disabled only while busy or when a required
  field is empty. Validation messages appear after pressing it.
- A task never hides its Cancel at the end of a long form: the add wizard keeps
  it next to the title, the short tasks keep it beside their action, and the
  Android panel keeps its Back at the top. The user can always leave without
  scrolling.
- A task that loses something says it above its fields, with a warning icon, so
  the consequence is read before typing and not found afterwards (extension:
  `Reset and forget inactive syncs` warns that the inactive syncs' keys are
  lost, before the new password).
- Busy labels: `Checking…`, `Connecting…`, `Downloading…`, `Uploading…`,
  `Merging…`, `Changing…`, `Exporting…`, `Importing…`.
- A flow that resumes (the extension manager after leaving the page or a browser
  restart) never resumes on its final review: it restarts at the step that asks
  the password, and the service check and merge preview run again. Android has
  no resumable wizard.
- Recovery (extension): there is no "last action / undo" banner. What a
  destructive step replaced is listed in Backup → Safety backups, grouped by
  day, each entry with the operation named in words, its time, the sync it
  belongs to (saved name + short ID), how many items it added/removed when the
  writer knew the before/after trees (large syncs, conflicts, duplicates
  cleanup), side, size and encryption. The popup carries no backup or restore
  panel: it shows status and `Sync now`, and `Manage` opens the place where
  those live.

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
  an optional **sync lock** (a password that wraps them; plain rows when it is
  not set).
- `+ Add a sync` follows the platform's rules: Android offers only an existing
  sync while linked (a brand-new sync needs an unlink first); the extension can
  also create a new sync from the current bookmarks, which is additive and leaves
  the previous sync in the list.

## Automatic sync, containers and stale confirmations

- Browser sync sends native bookmark edits automatically and checks for server
  changes every 15 minutes. Android syncs only while visible: a foreground poll
  and coalesced edit pushes. There is no Manual setting on either client;
  `Sync now` remains available. Legacy Android `sync_mode=Manual` is ignored.
- Menu, Other and Toolbar all belong to the sync. There is no toolbar-exclusion
  preference. The extension adopts the active sync's toolbar on upgrades from
  the old option: a verified local safety backup must succeed first, and failed
  adoption blocks sync until a retry succeeds. Untouched bookmark mappings and
  metadata keep their identity, including edits made offline.
- On Android, saving the outgoing sync, capturing the live tree and replacing
  it hold the same engine gate. A failed remote adoption restores the previous
  mirror, metadata and dirty flag, so pending edits remain pending.
- Browser server-delete confirmations and duplicate scans belong to the sync
  that was reviewed. If another popup or manager switches the active identity,
  stale dialogs/selections are discarded and stale destructive requests are
  rejected in the background. Cleanup can remove only current duplicate
  bookmark entries, never unique bookmarks or folders.
- Change password lives on the active sync's row; Settings contains preferences
  and the folded log panel. A new export file includes the active sync's name
  when available; its backup password remains independent of the sync password.

## Extension: sync lock

- Optional and manager-owned: a short secret (a PIN of a few digits is fine —
  only "not empty" is enforced). It wraps a random vault key, which wraps every
  row's key. Changing it rewraps only the vault (rows untouched); removing it
  unwraps the rows to clear; losing it means the inactive rows' keys are gone.
- Set/change/remove/reset it in Manager → Sync → Sync lock. With a
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
- Unlinking puts this device into the unlinked state immediately (no waiting for
  the next sync tick), and keeps local bookmarks.
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
- The extension protects saved-sync keys with an optional sync lock;
  Android uses platform secure storage plus the optional device unlock.
- Android can add only an existing sync while linked; the extension can also
  create a new sync from the current bookmarks.
- The extension exposes no overwrite Undo banner in Status or the popup:
  recover supported destructive replacements through Backup → Safety backups.
  Android also uses those backups, with short Home Undo for a single delete
  or a move. Ordinary linked-to-linked activation takes no switch backup.
- Backup restore: the extension needs a linked sync (the restored tree is
  uploaded right away). The mobile app also restores while unlinked, on this
  device only; its implication line says which case applies.
- A removed sync keeps an encrypted, restorable copy on Android; the extension
  offers a plain JSON download or dismissal.
- Automatic backups exist only in the extension (a browser can change
  bookmarks while Keepmark is not open). Android imports and exports a
  `bookmarks.html`; the extension only exports one.
- Tags are browsed and edited on Android only; the extension keeps them in
  sync and in exports without a tag UI.

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

- Two entry points, one dialog: the Status card's Show connection QR (the
  ACTIVE sync) and a `Show QR` button on EVERY row of Manager → Sync, so the
  phone can join a sync that is not the one active in this browser. A row's
  dialog names that row's service and ID, asks that sync's own long password
  (never stored: the typed one is the proof) and decrypts one remote GET
  read-only; the active sync, the rows and the server are untouched. The
  dialog lives outside the sections, so a row still works while this browser is
  unlinked. The launch button is hidden while the dialog is open. Password
  errors stay next to the key-icon input inside the dialog and allow retry.
  The QR includes a small Keepmark logo. Outside click or Escape closes the
  dialog and erases the QR. Local key verification (active) or the remote
  decrypt (row) and a read-only remote GET precede display.
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
