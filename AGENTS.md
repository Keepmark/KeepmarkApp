# AGENTS.md — KeepmarkApp (browser extension)

Read this first when resuming work here. Companion docs: `README.md`
(user-facing build/install/sync model), root `../AGENTS.md` (repo layout).

## 1. What this is

New xBrowserSync-compatible bookmark-sync browser extension, rewritten from
scratch. Firefox MV2 first, Chromium MV3 second. Inspired by `../app`
(AngularJS 1.x client — logic reference only, stack NOT reused) and hardened
with the rules of `../Keepmark` (whole-blob sync, no silent merge, crypto
interop, English-only).

- Own git repo, branch `master`, remote
  `ssh://git@git.example/KeepmarkApp.git`.
- Root `$HOME/Projects/xBrowserSync` is NOT a git repo. Work here only.
- License GPL-3.0-only. Name/version in `package.json` (`keepmark-app@0.1.0`)
  and in both manifests (keep them in sync on release).
- Commit + push whenever something stable lands (explicit user rule).

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
npm run qa            # static QA: ids, SW-safety, manifests, linter (no browser)
```

No env vars, no DB, no devices needed. Node v22, npm 12 (see `.nvmrc` — none;
toolchain is system node). `build/` and `dist/` are gitignored.

## 3. Module map

### `src/shared/` — platform-agnostic core (edit here for cross-platform logic)

| File | Responsibility | Ported from |
|---|---|---|
| `constants.ts` | API/sync versions, timeouts, `compareVersions`, separator URL | Keepmark `XbsConstants.cs` |
| `errors.ts` | 13 typed errors + `errorForStatus(status)` mapping | `app/api-xbrowsersync.service.ts` via Keepmark `XbsErrors.cs` |
| `models.ts` | `BookmarkNode` (camelCase wire), `SyncState`, `ServiceStatus`, `normalizeBookmarks` | Keepmark `Models.cs` |
| `crypto.ts` | PBKDF2-SHA256/250k → AES-GCM-256, 16B IV prepended, lzutf8, base64; `deriveKey/encryptData/decryptData` | `app/crypto.service.ts` |
| `api.ts` | `XSyncApiClient` dual-stack v1.1.13/v1.2.0 (`Accept-Version` per request, `SyncMeta`/`ApiCapabilities`, revision CAS, conditional GET, `DELETE`), 12s timeout, bodies never logged | Keepmark `XSyncApiClient.cs` |
| `logging.ts` | Levels, ring `InMemoryLogger`, `LogSanitizer` (sync IDs truncated, secrets never logged) | Keepmark `Logging.cs` |
| `bookmarks.ts` | Tree helpers: containers, `newBookmark/cleanBookmark`, ids, validate/repair, `nativeToSynced`, separator detection | `app/bookmark-helper.service.ts` |
| `native.ts` | Generic read/clear/populate/mappings over injected `BookmarkApi` + `NativeOps` factory + `chromiumIsSeparator` | `app/webext-bookmark` + both platform services |
| `store.ts` | `StoreKey` enum (ALL keys live here), `Store`, `MemoryBackend` (tests), `BrowserLocalBackend` (storage.local, MV2+MV3) | `app/store.enum.ts`, webext-store |
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
- `src/chromium/`: `platform.ts` (roots Other=`2`/Toolbar=`1`, no Menu root,
  `chrome://` or `edge://` newtab), `bookmarks.ts` (Menu = `[xbs] Menu` folder
  inside Other, `───`/`|` bookmark separators), `adapter.ts`.
- Both adapters implement `src/background/adapter.ts` (`NativeAdapter`):
  `NativeOps` + `newTabUrl` + `syncContainers` + `readContainer` +
  `removeBySyncedId` + `addNative`. Chromium `readContainer(Menu)` reads the
  Menu folder; `addNative` to Menu creates it if missing.

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
  shared `ui.ts`): connect + status card + sync now + open manager. Display
  only; mutations via messages.
- `src/manager/` — full-tab manager (`manager.html` at `src/`): sidebar
  (Status, Backup, Duplicates, Move, Logs, Settings), each section with its
  own contextual busy/error/result evidence; move wizard has a read-only
  `SwitchPreview` preflight before confirm.

### Build

- Entries at `src/` root so outputs land flat: `src/popup.html`,
  `src/background.html` (MV2 only).
- `vite.firefox.ts` (popup+background page+manager), `vite.chromium.ts` (popup+manager),
  `vite.chromium-sw.ts` (service worker, single-file ESM lib build),
  `vite.shared.ts` (`platformAlias` + `copyStatic` manifest+assets plugin).
- `res/manifest.{firefox,chromium}.json` → output `manifest.json`;
  `res/assets/` → output `assets/`. Icons rebuilt from the official Keepmark
  brand (`../Keepmark/brand/10-favicon.png`: navy `#172552`,
  keyhole x0.362–0.630/y0.300–0.611): navy-tile manifest icons (48/128) +
  toolbar icons (16/32, grayscale notsynced), white mark chip in pages
  (from `03-standalone.png`).
- `scripts/package.mjs` zips `build/*` → `dist/`.

## 4. Load-bearing contracts (do NOT change lightly)

1. **Crypto envelope**: `base64(IV16B || AES-GCM-256(lzutf8(JSON)))`, key =
   PBKDF2-SHA256/250k, salt = UTF-8(sync ID). `tests/vectors.json` (from
   Keepmark, generated from original `app/crypto.service.ts` + lzutf8@0.6.0)
   MUST decrypt green after any `crypto.ts` change. Legacy version-less syncs
   rejected (open once in the original client).
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
4. **No dynamic `import()`** in shipped code: the MV3 service worker must be
   one file (`vite.chromium-sw.ts` lib build). Static imports only.
5. `res/strings`-style i18n: English-only by decision (Keepmark rule); no
   telemetry; HTTPS-only services.

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
  the user must scroll to find. E.g. move wizard step 1 → `move-error`,
  step 2 submit → `move-error-2`; safety list actions → `backup-error-2`;
  in-list deletes → `dup-error-2`; danger-zone actions → `status-error-2`.
  Every box needs `role="alert"`, starts `hidden`, and is emptied (not just
  hidden) when cleared; `hideErrors()` must cover all of them.
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

**Icons/assets from Keepmark brand/ — DONE (see res/assets, git history):**
toolbar + manifest + notification icons rescaled from `10-favicon.png`
(plus grayscale notsynced); in-page brand chip uses the white mark. Source of
truth for future sizes: `../Keepmark/brand/`.

**Known limitations / next features (not started):** manual browser QA
(see README install section); QR connect (only `QrDelimiter` constant exists);
no multi-account; no auto-backup schedule; toolbar toggle + Chromium Menu
folder edge cases covered by tests but untested live.
