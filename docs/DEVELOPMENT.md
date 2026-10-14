# Keepmark for browsers — developer guide

Technical reference for contributors and reviewers: stack, interop contract,
layout, sync model, safety backups, permissions and platform differences.
Product overview: [README](../README.md). Agent resume point: [`AGENTS.md`](../AGENTS.md).
Full product and verification spec: [`SPEC.en.md`](SPEC.en.md).

## Design principles

Same robustness rules as Keepmark for Android: whole-blob sync, merge only
as an explicit previewed choice (never silent), byte-level crypto interop.

## Stack

TypeScript strict + `webextension-polyfill` + `lzutf8@0.6.0` + Vitest + Vite.
Popup is vanilla TS (no framework, for MV3 longevity).

## Interop contract (load-bearing)

- API `v1.1.13`, header `Accept-Version`, base default
  `https://api.xbrowsersync.org`. Min supported `1.1.9`.
- Password never leaves the client. Key = PBKDF2-SHA256/250k,
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
npm run qa            # static QA: ids, SW-safety, manifests, linter (no browser)
npm run qa:browser    # real Firefox + Chromium vs live KeepmarkApi (52 checks, see SPEC §11.3)
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
  status card + sync now + undo banner + open manager. Display only;
  mutations via messages.
- `src/manager/` — full-tab manager: Status (incl. danger zone), Backup
  (export, two-step import with preview, safety list/restore/delete),
  Duplicates (scan, single + bulk delete), Move (wizard with target +
  merge preview), Logs, Settings (toolbar toggle via background, password
  change), About.
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
- "Sync now" = pull-if-newer then push.

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
  confirm per-counts (popup dialog, move wizard check + confirm).
- Fail-closed safety snapshots of BOTH sides (`merge-local`,
  `merge-remote`), undo kinds `connect-merge` / `switch-merge`, PUT on the
  remote base (revision CAS or timestamp; 409 honest).

## Safety backups

Every destructive step snapshots the destroyed side first (`src/shared/safety.ts`,
ported from the Keepmark Android safety spec): connect pull/push, switch
pull/push, change-password, import, restore, server delete, bulk duplicate
cleanup. Snapshot write failure aborts the operation (fail closed); single
bookmark add/remove is exempt (mirrors the Android single-delete exception).

- Stored in `storage.local`: `SafetyIndex` manifest rows
  (`fileName, createdAtUtc, operation, side, items, sizeBytes, truncated
  syncId, enc`) + one `safetyFile:` payload each. Newest 5 kept, older
  pruned (payload + row together). Listed/restored/deleted from Manager →
  Backup → Safety backups.
- Encrypted with the sync-derived key (`keyId` = SHA-256/8 recorded);
  restores under a rotated key refuse honestly. Pre-link writes stay
  plaintext flagged "not encrypted". Password change re-encrypts entries
  best-effort (never fails the flow).
- Restore: local-side entries replace natives (push-if-linked);
  remote-side entries require the link and re-push (409 honest). The used
  entry is never deleted; counts are validated, damage refused.
- Success messages name the safety net ("see Backup → Safety backups").

## Backup interop (Keepmark Android)

Export envelope `{app, format, salt, blob}` is byte-compatible with the
Android client: new exports are stamped `app: "xBrowserSyncNg"` (the tag
Android requires) and legacy `"KeepmarkApp"` files still import here.

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
