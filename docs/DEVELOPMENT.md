# Keepmark for browsers — developer guide

Technical reference for contributors and reviewers: stack, interop contract,
layout, sync model, safety backups, permissions and platform differences.
Product overview: [README](../README.md). Agent resume point: [`AGENTS.md`](../AGENTS.md).
Full product and verification spec: [`SPEC.en.md`](SPEC.en.md).

## Design principles

Same robustness rules as Keepmark for Android: whole-blob sync, merge only
as an explicit previewed choice (never silent), byte-level crypto interop.

One task at a time: every operation of the Sync section (add a sync with its
sync lock gate, activate, the sync lock itself, rename/forget/unlink/delete)
runs inside its own modal `<dialog>` (`src/popup/modal.ts`). The page behind is
inert, opening another task closes the first, and an answer that arrives after
its task ended is discarded by token. Shared rules: [`WORKFLOWS.md`](WORKFLOWS.md).

## Stack

TypeScript strict + `webextension-polyfill` + `lzutf8@0.6.0` + Vitest + Vite.
Popup is vanilla TS (no framework, for MV3 longevity).

## Interop contract (load-bearing)

- API `v1.1.13`, header `Accept-Version`, base default
  `https://api.xbrowsersync.org`. Min supported `1.1.9`.
- Password is never sent to the service; QR linking explicitly transfers it to Android. Key = PBKDF2-SHA256/250k,
  salt = UTF-8(sync ID) → base64. Legacy syncs without version rejected.
- Wire blob = `base64(IV16B || AES-GCM-256(lzutf8(JSON bookmarks)))`.
- Vectors: `tests/vectors.json` (copied from Keepmark, generated from the
  original `app/crypto.service.ts` + `lzutf8@0.6.0`). Never change
  `src/shared/crypto.ts` without `npm test` passing decrypt of all vectors.

## Commands

```sh
npm install
npm test              # vitest: crypto/api/bookmarks/sync/queue/reconcile/merge/backup/safety/duplicates/messages/logging/ui/core
npm run lint          # tsc --noEmit
npm run build         # both platforms -> build/firefox, build/chromium
npm run build:firefox
npm run build:chromium
npm run package       # zips -> dist/ (needs system `zip` or python3, else fails)
npm run qa            # static QA: ids, SW-safety, manifests, no HTML-injection
                      # sinks, addons-linter (0 errors, no UNSAFE_* warnings)
npm run qa:browser    # real Firefox + Chromium vs live KeepmarkApi (94 checks, see SPEC §11.3)
```

## Layout

- `src/shared/` — platform-agnostic core: `constants`, `errors`, `models`,
  `bookmarks` (tree helpers), `native` (generic read/clear/populate/mappings),
  `crypto`, `api`, `logging`, `store` (`StoreKey` + backends), `id-mapper`,
  `sync` (first-sync flows), `sync-queue` (gated FIFO + failure policy),
  `reconcile` (native→synced whole-tree pass), `merge` (pure two-way union +
  preview stats), `messages` (popup↔background protocol + error wire format),
  `backup`, `safety` (indexed snapshots), `duplicates`.
- `src/firefox/` — `platform` (about: rules, fixed roots), `bookmarks`
  (3 containers, `type:'separator'`), `adapter` (NativeAdapter).
- `src/chromium/` — `platform` (chrome:/edge: rules, roots 2/1),
  `bookmarks` (Menu = folder in Other, bookmark-style separators), `adapter`.
- `src/background/` — `core.ts` (queue owner: jobs, alarms, listeners,
  all message handlers), `adapter.ts` (NativeAdapter interface),
  `background.ts` (browser wiring; `@platform/adapter` alias per build).
- `src/popup/` — small popup: connect (new / existing pull-push-merge),
  status card + read-only saved-sync list (activation dialog) + sync now +
  open manager. Display only; mutations via messages.
- `src/manager/` — full-tab manager: Status (incl. danger zone), Backup
  (export, import preview and direct restore, safety list/restore/delete),
  Duplicates (scan, single + bulk delete), Sync (saved-sync registry with
  primary Activate (disabled when active), secondary ⋮ menu with ordinary
  commands first and separated Forget/Unlink/Delete last, `Change password` on the
  active row, `+ Add new sync` wizard with target + merge preview, optional
  sync lock — each operation is a modal task dialog, never an inline panel that
  can overlap another one), Settings (language, the log
  panel folded behind one "Show logs" button), About. The long password
  belongs to a sync, so changing it is a row action, not a Settings section,
  and it never asks the sync lock password: the background re-wraps the saved
  key under the previous one (`scheme: 'rotated'`).
- `src/popup.html`, `src/background.html` — vite entries (land at output root).
- `res/manifest.{firefox,chromium}.json` — copied to output as manifest.json.
- `vite.{firefox,chromium,chromium-sw}.ts` + `vite.shared.ts`, `scripts/package.mjs`.

## Sync model

- Whole-blob: every push uploads the full tree with optimistic `lastUpdated`.
- Queue lives only in the background context; popup talks via messages.
- Native edits (listener debounce, popup add/remove) reconcile native→synced
  through stored id mappings (stable ids), then push.
- `dateAdded` (optional Keepmark field, Unix ms, shared with KeepmarkMobile):
  new natives take the browser's `dateAdded` (else now); known nodes keep the
  synced value, like description/tags, and it is never a diff source. Full
  native reads (`readAll`: first upload, conflict upload/merge) copy the
  native date, which on a pulled device is the populate time.
- 409: the conflict is persisted (survives worker sleeps/restarts), the
  uncommitted tree is stashed as a `keepmark-conflict-*.json` download and a
  notification points to the manager, where you pick Take remote / Upload
  local / Merge (each confirmed, destroyed side safety-backed-up first).
  No auto-pull while it is pending; never auto-merge, never drop silently.
- Native edits that never reached the server are checked before every pull:
  they become a conflict instead of being overwritten.
- Sync loss (401): queue cleared, credentials wiped, notification.
- All three containers sync automatically: native edits enqueue uploads and a
  15-minute alarm checks changes made elsewhere. "Sync now" = pull-if-newer then push.
- Saved-sync activation verifies the target read-only, reconciles and persists
  pending native edits of the outgoing sync, then replaces the browser tree.
  A pending conflict or failed save blocks activation. Target verification
  needs the service, so activation cannot proceed offline. The credential-change
  gate serializes the switch with mutations; ordinary activation takes no snapshot.

## Merge mode (third link direction)

When the local tree and the server copy diverged (offline edits here,
uploads from another PC there), `merge` unions both sides instead of
overwriting one: remote nodes/ids/metadata kept, local-only bookmarks
adopted with fresh ids into path-matched (or newly created) folders,
separators kept from both sides. Same URL both sides → server title wins
(counted). Deletes are never merged (no tombstones): items deleted on one
side while offline reappear — the preview says so.

- `src/shared/merge.ts` is pure (no I/O, inputs never mutated): the same
  `mergeTrees` serves the `PreviewMerge` dry-run and the confirmed flows.
- Preview shows local-only / remote-only / title-conflicts /
  folders-created / separators-adopted before anything mutates; both flows
  confirm per-counts (popup dialog, add-sync wizard check + confirm).
- Fail-closed safety snapshots of BOTH sides on a first link (`merge-local`,
  `merge-remote`) with undo kind `connect-merge`; a switch-merge snapshots
  nothing (a union destroys nothing). PUT on the remote base (revision CAS or
  timestamp; 409 honest).

## Automatic backups

`src/shared/auto-backup.ts` plus `autoBackupTick` in `src/background/core.ts`
(0.1.63). A copy of the LOCAL bookmarks is written as a safety entry with
operation `auto`, so listing, restore and delete are the safety-backup paths.

- Settings `StoreKey.AutoBackup` `{enabled, everyDays, keep}`: default on,
  daily, 7 kept; choices 1 or 7 days and 3 / 7 / 14 / 30 copies.
- An hourly alarm (`AutoBackupAlarmName`) and the end of `startup()` call the
  tick; `autoBackupDue` decides. A browser closed at the due time catches up
  when it starts.
- Nothing is written when the tree and the key are the ones of the last
  automatic backup that still exists (`treeFingerprint`: an HMAC keyed by
  the derived key, so the stored value reveals nothing about the bookmarks;
  plain SHA-256 while unlinked, when the copy itself is plain text).
- Manager settings stay disabled until `GetAutoBackup` answered and while a
  change is saving, so a failed read or a double change never sends values
  the user did not choose.
- The tick is postponed to the next alarm while a sync job, a link change, a
  suspend or a conflict is pending, and does nothing before `startup()` has
  finished. The tree is read inside `withSuspended`.
- All `SafetyIndex` writers in `safety.ts` share one lock (`indexLocked`), so
  an automatic backup can never drop the row of a safety snapshot written at
  the same moment.
- Retention is two separate budgets (`retain` in `safety.ts`): `auto` entries
  by their own limit, every other entry by `StoreKey.SafetyKeep`.
- Encrypted with the active sync key; unlinked browsers get a plaintext entry
  flagged `enc:null`, like any pre-link safety backup.
- Silent. A failed run stores its reason and `GetStatus.autoBackupError`
  shows it under the Status card until a run completes.
- The copies live in `storage.local` and go away with the extension.

## bookmarks.html export

`src/shared/netscape.ts` writes a standard Netscape bookmarks file from
Manager → Backup → "Bookmarks file (HTML)" (0.1.61). It is **not encrypted**:
the manager shows the warning first and only "Export anyway" downloads
`keepmark-[<sync>-]YYYYMMDD-HHmmss.html`. Nodes that are neither a folder nor
a link are skipped, so the file matches the reported count (0.1.62). The
extension does not import this format: use the browser's own import, or
Keepmark for Android.

## Safety backups

Every destructive step snapshots the destroyed side first (`src/shared/safety.ts`,
ported from the Keepmark Android safety spec): connect pull/push, change-password,
import, restore, batch delete and bulk duplicate cleanup. Deliberate server
deletion is the exception: it takes no snapshot, keeps no removed-sync copy
and prunes safety backups belonging to that sync. **A switch between
saved syncs is not destructive** — the copy this device leaves is already on
its own server and activating that sync again brings it back — so it takes no
snapshot and arms no undo; the manager shows no "last action / undo" banner.
**A sync is not destructive either, until it is massive**: a pull or a push
that would add, remove or move more than `MaxSilentSyncChanges` (10) nodes is
not an ordinary edit, so it snapshots the side it replaces first — `sync-pull`
for the copy in this browser (right before the natives are replaced,
`PullMeta.beforeReplace`), `sync-push` for the server copy (compared against
the last synced tree, fetched just for the snapshot). `changedNodeCount` in
`src/shared/tree-diff.ts` measures it: bookmarks by normalized URL and folders
by path below the three roots, counted per parent, so a move is a removal plus
an addition and moving a folder with more than five bookmarks is massive too.
Snapshot write failure aborts the operation (fail closed); single bookmark
add/remove is exempt (mirrors the Android single-delete exception).

Every container (Menu, Other, Toolbar) is always synced. The old "Include the
bookmarks toolbar in the sync" switch is gone: with it off, a switch never
wrote the target sync's toolbar (so the browser kept the previous one) and the
next push replaced the server's toolbar with that stale copy. Installs that
still carry the legacy key are migrated once at startup
(`adoptToolbarOnUpgrade`): the local toolbar is snapshotted fail-closed
(`toolbar-adopt`), replaced with the active sync's toolbar, then the key is
dropped. Every worker wake path retries this migration before syncing or
changing the active tree. Failure blocks those operations while diagnostics
and backup export remain available. Only toolbar mappings are replaced;
untouched native mappings keep their synced IDs and metadata. The native replace itself is atomic for the link state: the link is
saved only after the natives were rewritten, and a failed replace puts the
previous bookmarks back (best effort) so the app never claims a switch that the
browser did not perform.

- Stored in `storage.local`: `SafetyIndex` manifest rows
  (`fileName, createdAtUtc, operation, side, items, sizeBytes, truncated
  syncId, enc`) + one `safetyFile:` payload each. Newest N kept (Settings, `StoreKey.SafetyKeep`, default 10), older
  pruned (payload + row together). Listed/restored/deleted from Manager →
  Backup → Safety backups.
- Encrypted with the sync-derived key (`keyId` = SHA-256/8 recorded);
  restores under a rotated key refuse honestly. Pre-link writes stay
  plaintext flagged "not encrypted". `GetSafetyList` flags each row with
  `locked` (`safetyLock`): `other-sync` when its `keyId` differs from the
  current link's, `needs-link` when it is encrypted or remote-side while
  unlinked. The manager hides locked rows behind a "Restorable here / All"
  filter (shown only when some exist); a locked card is dimmed, says why, has
  no Restore, keeps Delete, and offers `Activate <name>…` when exactly one
  saved inactive row matches its short sync ID. Password change re-encrypts entries
  best-effort (never fails the flow).
- Restore: local-side entries replace natives (push-if-linked);
  remote-side entries require the link and re-push (409 honest). The used
  entry is never deleted; counts are validated, damage refused.
- Success messages name the safety net ("see Backup → Safety backups").

## Backup interop (Keepmark Android)

Export envelope `{app, format, salt, blob}` is byte-compatible with the
Android client: new exports are stamped `app: "xBrowserSyncNg"` (the tag
Android requires) and legacy `"KeepmarkApp"` files still import here. The
download name carries the sync it belongs to —
`keepmark-backup-<sync>-YYYY-MM-DD.xbs.json`, where `<sync>` is the active
sync's name slugged by `backupSlug` (lowercase, accents folded, anything not a
letter or digit collapsed into one underscore, at most 40 characters); without
a usable name the file keeps `keepmark-backup-YYYY-MM-DD.xbs.json`.

## Permissions (why each one)

- `alarms` — 15-min remote-change poll + SW-safe native-edit debounce.
- `bookmarks` — read/clear/populate native containers + change listeners.
- `downloads` — conflict files, backup export (data: URLs).
- `notifications` — sync-removed / conflict notices.
- `storage` + `unlimitedStorage` — encrypted blob (up to service maxSyncSize),
  id mappings, install backup, safety files + index, trace log in
  `storage.local` beyond the 5–10 MB default quota.
- Chromium `host_permissions https://*/*` + loopback http (`localhost`,
  `127.0.0.1`) — MV3 service workers need an explicit host grant for
  `fetch()` to user-configured services. Plain-http LAN hosts are rejected
  by the URL validator anyway. No content scripts, no page access: the grant
  covers API calls only.

## Platform differences

- Firefox: roots `menu________/unfiled_____/toolbar_____`, all 3 containers,
  native separators, `about:newtab`.
- Chromium: roots Other + Toolbar resolved by `folderType` (Chrome 134+;
  account-synced roots preferred, legacy ids `2`/`1` as fallback), no Menu root (folder `[xbs] Menu`
  inside Other), separators are `───` / `|` bookmarks, `chrome://newtab/`.

## Install for testing

- Firefox: `about:debugging → This Firefox → Load Temporary Add-on →
  build/firefox/manifest.json`.
- Chromium: `chrome://extensions → Developer mode → Load unpacked →
  build/chromium`.

## License and notices

License, third-party notices and disclaimer: see the [README](../README.md#license).

## Browser → Android QR

Status → the “Connect Keepmark on your phone” card → “Show connection QR” opens
a native modal `<dialog>` with password verification followed by the QR. The card
button is hidden while the dialog is open; backdrop clicks, Escape and focus loss
close it and clear transient state. The dialog gives instructions for Keepmark for Android. Verification
checks the current password against the derived key and the live remote
encrypted blob. No sync mutation or capability probe runs.
The card itself is hidden while this browser is unlinked (an inert card only
pushes the “not connected” hint down) and, when the active service is plain HTTP
— which the payload refuses — it stays visible with the button disabled and
`qr.httpsRequired` in place of the destination, so the reason is on screen
instead of hidden behind a failed attempt.
The manager-only command returns exactly `{app:"Keepmark",format:1,
serviceType:"xbrowsersync",serviceUrl,id,version,password}`. The numeric dotted
version is the sync data format; ID is ASCII `[A-Za-z0-9_-]{1,128}`. Payloads
are limited to 1800 UTF-8 bytes; HTTPS service URL must have no credentials,
query, fragment, whitespace or backslash. Password text is preserved literally.
The payload builder throws `qr.httpsRequired` for a non-HTTPS (or unsafe) URL and
`err.syncInfoIncomplete` for a structural failure, so the dialog can name the
actionable one; `qr.busy` covers a verification attempted while a link/sync
operation is still running.

qrcode 1.5.4 renders a black-on-white canvas locally (M correction, quiet zone
4). Generation guards discard late verification/render results. Close, Escape,
section navigation, blur, hidden, pagehide and BFCache restore clear the canvas
and inputs; 60 seconds limits display only. A captured QR stays reusable.
No new extension permissions, storage keys or service endpoints are required.

The QR dialog retains contextual verification errors beside its key-icon password
field and permits retry without reopening. Known wrong-password errors use the
localized message; arbitrary exception text is never displayed. Close/backdrop,
Escape and focus loss still erase transient data. `render-connect-qr.ts` draws a
small local Keepmark icon with white backing within 10% of canvas width.
An integer scale of at least three pixels per module avoids blurred dense codes; QR
correction is H up to 1200 UTF-8 bytes, Q up to 1600, M up to the 1800-byte cap.
The logo does not change the payload.


### Shared service selector

`shared/service-catalog.ts` contains the eight curated public endpoints from
xBrowserSync and MarkSync (verified 2026-10-17). `popup/service-picker.ts` and its
stylesheet are used by the connect popup/full page and the move manager.
`GetServices` merges public entries with `StoreKey.RememberedServices`;
`ProbeService` checks one candidate with the short service-probe timeout, without
linking or writing preferences. Background connect/create/move completion alone
remembers custom services. The UI uses a generation token and exact checked URL
to ignore stale results; new/existing mode also gates NoNewSyncs. The normal URL
policy remains HTTPS, with HTTP loopback for local development/QA.

### Destructive actions and active sync identity

Manager server deletion and duplicate cleanup send the reviewed `{serviceUrl, syncId}`
identity. The background rejects a missing or mismatched identity before any mutation
and holds the credential-change gate through validation and completion. Duplicate
scans bind to that same identity; a storage identity change clears their selection,
cancels inline confirmations, and closes row/password dialogs. Cleanup additionally
intersects requested IDs with the current duplicate groups (preserving their newest
copy), so unique bookmarks and folders can never be deleted through this command.
