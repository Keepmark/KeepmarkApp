# AGENTS.md — KeepmarkApp (browser extension)

Read this first when resuming work here. Companion docs: `README.md`
(user-facing GitHub landing page), `docs/DEVELOPMENT.md` (build, interop,
sync model, permissions), root `../AGENTS.md` (repo layout).

## 1. What this is

New xBrowserSync-compatible bookmark-sync browser extension, rewritten from
scratch. Firefox MV2 first, Chromium MV3 second. Inspired by `../app`
(AngularJS 1.x client — logic reference only, stack NOT reused) and hardened
with the rules of `../KeepmarkMobile` (whole-blob sync, no silent merge, crypto
interop).

- Own git repo, branch `master`, remote
  `ssh://git@git.example/KeepmarkApp.git`.
- Root `$HOME/Projects/xBrowserSync` is NOT a git repo. Work here only.
- License GPL-3.0-only (see `LICENSE.md`; © 2026 Yari Melzani). Name/version in `package.json` (source of truth)
  and in both manifests (keep them in sync; bump patch on every deploy/package so the user can test it).
- Commit + push whenever something stable lands (explicit user rule).
- Distribution: Chromium on the Chrome Web Store
  (<https://chromewebstore.google.com/detail/jaaekkbgpeiikepahjelfbkfgpjphbhb>,
  item id `jaaekkbgpeiikepahjelfbkfgpjphbhb`); Firefox on AMO
  (<https://addons.mozilla.org/en-US/firefox/addon/keepmark/>, add-on id
  `keepmark@proton.me`). Each version is submitted with the source package
  `https://github.com/Keepmark/KeepmarkApp/archive/refs/tags/vX.Y.Z.zip` and
  reviewer build steps `npm ci` + `npm run build:firefox`. GitHub releases
  (<https://github.com/Keepmark/KeepmarkApp/releases>, tag `vX.Y.Z`) carry the
  Chromium `.zip` uploaded to the store + the Mozilla-signed `.xpi` +
  `SHA256SUMS`, notes in the v0.1.18 format (what's new, install, SHA-256
  table). Create them with `gh release create`.
- Keep landing pages and ecosystem links version-independent: link to stores
  and `/releases/latest`. Put release-specific changes in release notes; keep
  version numbers in docs only for compatibility, contracts or historical context.

## 2. Commands (run from `KeepmarkApp/` only)

```sh
npm install
npm test              # vitest run — must be green before any commit
npm run lint          # tsc --noEmit — must be clean before any commit (grep for
                      # "error", never trust tail: tsc errors hide above the last line)
npm run build         # both platforms -> build/firefox, build/chromium
npm run build:firefox
npm run build:chromium
npm run package       # zips -> dist/ (system `zip`, else python3 fallback)
npm run qa            # static QA: ids, SW-safety, manifests, no HTML-injection
                      # sinks, addons-linter (0 errors, no UNSAFE_* warnings)
npm run qa:browser    # real Firefox + Chromium vs live KeepmarkApi (99 checks, see SPEC §11.3)
```

No env vars, no DB, no devices needed. Node v22, npm 12 (see `.nvmrc` — none;
toolchain is system node). `build/` and `dist/` are gitignored.

## 3. Module map

### `src/shared/` — platform-agnostic core (edit here for cross-platform logic)

| File | Responsibility | Behavior reference |
|---|---|---|
| `constants.ts` | API/sync versions, timeouts, `compareVersions`, separator URL | Keepmark `XbsConstants.cs` |
| `errors.ts` | 13 typed errors + `errorForStatus(status)` mapping | `app/api-xbrowsersync.service.ts` via Keepmark `XbsErrors.cs` |
| `models.ts` | `BookmarkNode` (camelCase wire), `SyncState`, `ServiceStatus`, `normalizeBookmarks` | Keepmark `Models.cs` |
| `crypto.ts` | PBKDF2-SHA256/250k → AES-GCM-256, 16B IV prepended, lzutf8, base64; `deriveKey/encryptData/decryptData` | `app/crypto.service.ts` |
| `api.ts` | `XSyncApiClient` dual-stack v1.1.13/v1.2.0 (`Accept-Version` per request, `SyncMeta`/`ApiCapabilities`, revision CAS, conditional GET, `DELETE`), 12s timeout, bodies never logged | Keepmark `XSyncApiClient.cs` |
| `logging.ts` | Levels, ring `InMemoryLogger`, `LogSanitizer` (sync IDs truncated, secrets never logged) | Keepmark `Logging.cs` |
| `bookmarks.ts` | Tree helpers: containers, `newBookmark/cleanBookmark`, ids, validate/repair, `nativeToSynced`, separator detection | `app/bookmark-helper.service.ts` |
| `native.ts` | Generic read/clear/populate/mappings over injected `BookmarkApi` + `NativeOps` factory + `chromiumIsSeparator` | `app/webext-bookmark` + both platform services |
| `i18n.ts` + `i18n/*.ts` | UI localization: `t`, `tn`, `resolveLang`, catalogs en/it/fr/es/de/ja/pt/ru/zh | new |
| `store.ts` | `StoreKey` enum (ALL keys live here), `Store`, `MemoryBackend` (tests), `BrowserLocalBackend` (storage.local, MV2+MV3) | `app/store.enum.ts`, webext-store |
| `saved-syncs.ts` | Multi-sync registry: rows (service, sync ID, label, last use) plus each row's derived key — wrapped under the sync-change lock when set, `plain` otherwise (never the raw password) — canonical identity, label rules + host suggestion, upsert/remove/sort/active matching | new (model A: one active sync) |
| `switch-lock.ts` | Optional short sync-change password: PBKDF2-SHA256 (200k) wraps a random vault key, the vault key wraps row keys. Create/unlock/change (rewrap the vault only, rows untouched)/remove (rows become plain)/reset (new vault). Only "non-empty" is enforced: PINs and 1-character secrets are valid | new |
| `id-mapper.ts` | `syncedId<->nativeId` mappings, sorted, rebuilt on populate | `app/bookmark-id-mapper.service.ts` |
| `sync.ts` | `checkService`, `createNewSync`, `pullExistingSync`, `pullWithDerivedKey`, `pushBookmarks`, `switchService` | `app/bookmark-sync-provider` + login component |
| `sync-queue.ts` | Gated FIFO `SyncQueue` + failure policy (offline/429→front, 409→persisted conflict for user resolution, 401→sync-lost) | `app/sync.service.ts` |
| `reconcile.ts` | `reconcileContainer`: whole-tree native→synced pass via mappings (replaces Add/Modify/Remove/Move/Reorder cases) | new design (equivalent semantics) |
| `merge.ts` | `mergeTrees`: pure two-way union by URL (remote kept, local adopted with fresh ids, separators unioned, deletes never merged) + preview stats | new design (connect/switch third direction) |
| `messages.ts` | `MessageCommand` + payload/response types + `toWireError/fromWireError` (name-based rehydration) | `app/webext.interface.ts` + sendMessage |
| `backup.ts` | Encrypted envelope `{app,format,salt,blob}` (writes shared `xBrowserSyncNg` tag, reads legacy `KeepmarkApp` too) + guards (pwd≥8, 50MB, 200k nodes, depth cap) | Keepmark `BackupGuard.cs` + envelope |
| `safety.ts` | Safety snapshots: manifest + payloads in storage.local, retention 5, derived-key encryption + keyId, fail-closed writes, restore/delete/rekey | Keepmark safety spec (no master key: derived key is the anchor, like the undo slot) |
| `duplicates.ts` | URL groups, last-copy-locked deletion plan, `deleteByIds` | Keepmark `/duplicates` page |

### Platform layers (thin)

- `src/firefox/`: `platform.ts` (roots `menu________/unfiled_____/toolbar_____`,
  `about:newtab`, `about:` config pages), `bookmarks.ts` (3 containers,
  `type:'separator'`), `adapter.ts` (`makeAdapter` → `NativeAdapter`).
- `src/chromium/`: `platform.ts` (roots found by `folderType`, account-synced
  first, legacy ids Other=`2`/Toolbar=`1` only as fallback; no Menu root,
  `chrome://` or `edge://` newtab), `bookmarks.ts` (Menu = `[xbs] Menu` folder
  inside Other, `───`/`|` bookmark separators), `adapter.ts`.
- Both adapters implement `src/background/adapter.ts` (`NativeAdapter`):
  `NativeOps` + `newTabUrl` + `syncContainers` + `readContainer` +
  `removeBySyncedId` + `addNative`. Chromium `readContainer(Menu)` reads the
  Menu folder; `addNative` to Menu creates it if missing. `rootKey()` names the
  current native roots: every full `idMapper.set` records it
  (`StoreKey.NativeRootKey`); if the roots move (Chrome local <-> account
  storage) the core captures a conflict with `reason: 'roots'` instead of
  reconciling stale mappings (`captureIfRootsMoved` in `core.ts`).

### Background + popup

- `src/background/core.ts` — `BackgroundCore`: owns the queue; job runners
  (local pull / remote reconcile+push / restore); debounced native events;
  15-min alarm `xbs-sync-updates-check`; all message handlers (connect new +
  existing, add/remove, backup, switch-service with safety download,
  duplicates, status, disable); `drain()` loop; `startup()` (install snapshot
  + resume polling). NO DOM here — must stay service-worker safe.
- `src/background/background.ts` — browser wiring: `webextension-polyfill`,
  storage/alarms/listeners/badge/notify/download ports, `onMessage` → wire
  `{ok,data}` / `{ok:false,errorName,message}`, `onInstalled/onStartup`.
  Adapter via `@platform/adapter` vite alias (NOT runtime detection).
- `src/popup/` — small popup (`popup.html` at `src/`, `popup.ts`, `popup.css`,
  shared `ui.ts`): connect + status card + saved syncs (multi-sync) + sync now + open manager. Display
  only; mutations via messages. `saved-syncs.ts` renders the same registry in
  both views read-only (active tag, `Activate` on inactive rows only) and owns
  the modal activation step (sync-change password only when one is set).
  Rename/remove/add/delete live in the manager. The server-removed notice is
  informational only (the fact, no backup wording, no actions): the kept copy
  lives in the manager's Backup section, where the user goes on their own.
- `src/manager/` — full-tab manager (`manager.html` at `src/`): sidebar
  (Status, Backup, Duplicates, Sync, Logs, Settings, About), each section with
  its own contextual busy/error/result evidence; the add-sync wizard has a
  read-only `SwitchPreview` preflight before confirm; the Sync section owns the
  saved registry (rows + `+ Add a sync` form + optional sync-change password).
  With a password set, `+ Add a sync` asks it first (read-only
  `VerifySwitchPassword`) and only then opens the form, which has no password
  field of its own.

### Build

- Entries at `src/` root so outputs land flat: `src/popup.html`,
  `src/background.html` (MV2 only).
- `vite.firefox.ts` (popup+background page+manager), `vite.chromium.ts` (popup+manager),
  `vite.chromium-sw.ts` (service worker, single-file ESM lib build),
  `vite.shared.ts` (`platformAlias` + `copyStatic` manifest+assets plugin).
- `res/manifest.{firefox,chromium}.json` → output `manifest.json`;
  `res/assets/` → output `assets/`. Icons follow the Android app (canvas
  "BxRibbon", v0.1.12): manifest/notification icons 48/128 = launcher icon 5D
  tile; manifest 16/32 + toolbar = bare ribbon filling the slot (`synced*` navy
  with a 1px light edge for dark Chromium toolbars, `notsynced*`
  grey; `*-dark*` white variants picked on Firefox via `matchMedia` in
  `background.ts` + manifest `theme_icons`; Chromium SW has no `matchMedia`,
  so `src/offscreen.html` (permission `offscreen`, reason `MATCH_MEDIA`)
  reports the theme with `km-theme` messages, routed in `background.ts`
  before `core.handleMessage`; a restarted SW asks it via `km-theme-query`);
  pages use `brand-ribbon.svg` hanging from the navy header/sidebar band.
- `scripts/package.mjs` zips `build/*` → `dist/`.

## 4. Load-bearing contracts (do NOT change lightly)

1. **Crypto envelope**: `base64(IV16B || AES-GCM-256(lzutf8(JSON)))`, key =
   PBKDF2-SHA256/250k, salt = UTF-8(sync ID). `tests/vectors.json` (from
   Keepmark, generated from original `app/crypto.service.ts` + lzutf8@0.6.0)
   MUST decrypt green after any `crypto.ts` change. Legacy version-less syncs
   rejected (open once in the official xBrowserSync client).
2. **API**: dual-stack `Accept-Version: 1.1.13` (legacy) + `1.2.0` (extended,
   only after `capabilities.revision` probe; legacy answers 412), min service
   `1.1.9`, sync format `1.8.0` (never lower — remote≤local version gate).
   Password never transmitted; sync ID in URL is the bearer.
   409 = persisted conflict, user picks pull/push/merge (never auto-merge); resolution PUTs use the fresh remote base. v1.2 uses revision CAS + conditional
   GET; `DELETE /bookmarks/:id` is gated behind stored `supportsV12` (UI
   disabled + "Not supported (requires service v1.2)" on legacy).
3. **Sync model**: whole-blob pushes with optimistic `lastUpdated`; stored
   password field holds the DERIVED key, never raw. Queue lives ONLY in the
   background context. 409 → conflict persisted (`StoreKey.ConflictState`) + file + notify, no auto-pull while pending; unpushed native edits are never wiped by a pull. 401 → wipe creds.
   **Multi-sync (one active at a time)**: `StoreKey.SavedSyncs` holds the rows;
   `SyncInfo`/`Bookmarks`/`LastUpdated`/`ConflictState`/`UndoSlot` always
   describe the ACTIVE sync. The sync-change password is OPTIONAL
   (`StoreKey.SwitchLock`: random vault key wrapped by its PBKDF2 key). With a
   lock, rows hold `{scheme:'switch'}` and activation/new links prove it,
   unwrap the row's key and verify the target (read-only: version gate + GET +
   decrypt) → persist active (fail-closed, conflict blocks) → apply the target
   tree. Without a lock, rows hold `{scheme:'plain', key}` and activation is a
   plain confirmation. The sync's own long password is neither asked nor
   stored. Removing the password unwraps the rows to plain; reset mints a new
   vault and drops every row but the active one. Rows can be forgotten in any
   state: an inactive row is forgotten, the ACTIVE row also unlinks this device
   (the row is the link; the server copy stays). Never self-pull, never merge
   across syncs. A row does hold the sync ID, a capability token for the
   service's `DELETE`: truncate it in UI, never log it.
4. **No dynamic `import()`** in shipped code: the MV3 service worker must be
   one file (`vite.chromium-sw.ts` lib build). Static imports only.
5. **i18n** (en, it, fr, es, de, ja, pt-BR, ru, zh): every user-facing text is a key in
   `src/shared/i18n/en.ts` (source of truth) with a translation in
   `it/fr/es/de/ja/pt/ru/zh.ts` (`resolveLang` keeps only the base tag, so `pt-PT` → `pt`,
   `zh-TW` → `zh` Simplified)
   (`Record<MessageKey,string>`: a missing key fails `tsc`; `tests/i18n.test.ts`
   checks keys and `{placeholders}`). Use `t(key, params)` / `tn(base, n)` (plurals:
   `<base>_one` / `<base>_other`) from `src/shared/i18n.ts` (DOM-free, SW-safe, static
   imports only). Static HTML uses `data-i18n*` attributes (`applyI18n` in
   `src/popup/ui.ts`; QA check 5b verifies the keys). Never a module-level constant
   with UI text: it would be frozen before the language loads; use functions.
   Language setting: `StoreKey.UiLanguage` (`system` = `browser.i18n.getUILanguage()`),
   loaded by the background at every wake-up (`loadLanguage`) and by pages in
   `initI18n`; changing it reloads the page. Logs stay English. Wording follows
   `docs/UI-TERMS.md` (9-language glossary, identical in KeepmarkMobile). Manifest
   name/description use `res/_locales/*` (`pt_BR`, `zh_CN` folders). No telemetry; HTTPS-only services.

## 5. Testing

- `tests/*.test.ts` run in Node (WebCrypto available). No browser needed.
- Mocks: in-memory `browser.bookmarks` (`firefox-bookmarks.test.ts`,
  `chromium-bookmarks.test.ts`), fake API server (`sync.test.ts`,
  `background-core.test.ts`), fake ports/alarms/listeners
  (`background-core.test.ts` exercises connect/pull/native-event/alarm/409/
  remove/dupes/backup/switch/disable/status end-to-end through messages).
- `browser.bookmarks` is ALWAYS injected (`BookmarkApi`), never imported in
  logic — keeps everything unit-testable and SW-safe.
- After touching `Crypto/`, `Api/`, or sync flows: `npm test` + `npm run lint`
  + `npm run build` (both) and check `build/*/manifest.json` asset references.

## 6. Engineering rules (from dev notes + Keepmark README)

- Verify by execution: tests + lint + both builds before commit. Never commit red.
- Existing files over new files; small diffs; no speculative features.
- Destructive ops resolve by stable identity (synced IDs, never ephemeral),
  validate first, keep safety backups, never swallow errors (log with context).
- Error evidence belongs to the step that produced it: in top-down wizards
  and multi-action sections, each action cluster gets its own adjacent error
  box (`<base>-error`, `<base>-error-2`, …) instead of one top-of-section box
  the user must scroll to find. E.g. add-sync wizard step 1 → `link-error`,
  step 2 submit → `link-error-2`; backup export → `backup-error`, restore
  from file → `backup-error-2`, safety list actions → `backup-error-3`;
  in-list deletes → `dup-error-2`; danger-zone actions → `status-error-2`;
  the manager's kept copy of a removed sync (Backup) → `removed-error`.
  Every box has class `error`, `role="alert"`, starts `hidden`, and is
  emptied (not just hidden) when cleared. `showError(id, msg)` and
  `clearMessages()` in `src/popup/flow.ts` handle all of them by selector (no
  ID list to maintain). Confirmations use `confirmInline` from the same file,
  never `window.confirm`; workflow texts live in `src/popup/texts.ts`. The
  per-step contract is `docs/WORKFLOWS.md`.
- Success evidence mirrors it: multi-outcome operations restate WHAT ran
  (mode + direction + target), not just "Done". Build the message in a pure
  shared helper (e.g. `describeMoveResult` in `ui.ts`) with a unit test per
  outcome, never inline in the click handler.
- No `any` leaks, no `window`/`document` outside `src/popup/`, no `Buffer`
  (use `atob`/`btoa` helpers in `crypto.ts` — work in SW + Node).
- `base: './'` in app configs (relative asset URLs — absolute breaks); html
  entries must stay at `src/` root or outputs nest and manifests break.
- `tsconfig.paths @platform/* → src/firefox/*` exists for `tsc` only; real
  selection is the vite alias per config.

## 7. Pending work (exact resume point)

**Icons/assets — DONE (v0.1.12, canvas "BxRibbon"):** see section 3; PNGs
are rendered from SVG (5D geometry from `../KeepmarkMobile` launcher icon).

**Chromium narrow host permissions (not started, agreed 2026-10-11):** Chrome
Web Store flags `host_permissions https://*/*` as "broad host permissions"
(in-depth review, slower on every update). Plan: keep only the default
service in `host_permissions`, move `https://*/*` to
`optional_host_permissions`, call `chrome.permissions.request({origins})`
from the popup/manager (user gesture) on connect and when adding a sync; test
connect + add flows (unit + `qa:browser`). First check whether CORS alone
already lets the MV3 worker reach the service without any host grant.

**Known limitations / next features (not started):** manual browser QA
(see README "Get it"); QR connection hardware QA;
no auto-backup schedule; toolbar toggle + Chromium Menu
folder edge cases covered by tests but untested live.

**Multi-sync — slices 1–3 DONE (merged in `master`, 0.1.36):** `SavedSyncs` registry
(upsert on every link, upgrade migration at startup), `GetSavedSyncs` /
`ActivateSavedSync` / `RemoveSavedSync` / `RenameSavedSync`, popup panel in
both views, fail-closed push before switching, conflict blocks the switch,
unlink keeps the rows. Slice 2 adds the optional sync-change password
(`switch-lock.ts`, `StoreKey.SwitchLock`, `GetSwitchLock`/
`SetSwitchPassword`/`ChangeSwitchPassword`/`RemoveSwitchPassword`/
`ResetSwitchPassword`): no length or complexity policy, plain rows when unset,
wrapped rows when set; change rewraps only the vault, remove unwraps the rows,
reset keeps the active sync and deletes the rest. Slice 3 is the UX rework:
editable labels (max 40, case-insensitive uniqueness, host suggestion), the
manager Sync section with `+ Add a sync` (new syncs upload the LIVE native
tree and report the count; a pending conflict is a warning), row actions on
three lines (status/API badge, metadata, text buttons), `Forget…` on an
inactive row and `Unlink this device…` on the active one (no last-row rule;
the unlink also prunes the encrypted safety backups only that row's key could
open and never keeps a copy of the server data), `Delete from server…` on the
active row (keeps no copy: no backup is taken or kept, no `RemovedSync`,
no notification), and a read-only popup with a modal activation dialog that
names the sync-change password. Post-review fixes landed in 0.1.34–0.1.36
(removed-sync copy in Backup, deliberate delete keeps nothing and prunes
orphaned safety backups). Next slices: "Show QR" per row, then
KeepmarkMobile (credential index + one DB per sync + Syncs page + biometry
gate + QR add-or-activate).

## QR linking

`shared/connect-qr.ts` builds an allowlisted Keepmark format-1 JSON (1800 UTF-8
bytes maximum); `manager/connect-qr.ts` owns the native modal dialog, canvas
lifetime and generation guards. Status shows the Android card (“Connect Keepmark
on your phone”); its “Show connection QR” button opens the dialog and is hidden
while it is open; the whole card is hidden while this browser is unlinked and its
button is disabled (with the reason on the card) for a plain-HTTP service, which
the payload refuses with the dedicated `qr.httpsRequired` message. Every row in
Manager → Sync also has `Show QR`: the same dialog (a page-level host, outside
the sections) opened with a `ConnectQrTarget`, asking that row's own long
password and decrypting one remote GET read-only — so the phone can join a
dormant sync without activating it here. Password
verification and QR share
the focused dialog; backdrop click, Escape and focus loss close and clear it. `PrepareConnectQr` is manager-only (sender gate in background wiring),
verifies the current password locally and decrypts one remote GET without
mutating sync state. qrcode 1.5.4 is imported only by `manager/render-connect-qr.ts` (local Keepmark logo, adaptive H/Q/M correction). The QR carries
the original password voluntarily to Android, never to the service or storage.


## Service picker

Use `popup/service-picker.ts` for every editable service URL (popup connect and
manager move). Catalog/probe/persistence live in `shared/service-catalog.ts` and
background `GetServices`/`ProbeService`; only completed links save a custom URL in
`StoreKey.RememberedServices`. See `docs/WORKFLOWS.md` “Service selection”.
