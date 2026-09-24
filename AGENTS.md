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
npm run lint          # tsc --noEmit — must be clean before any commit
npm run build         # both platforms -> build/firefox, build/chromium
npm run build:firefox
npm run build:chromium
npm run package       # zips -> dist/ (system `zip`, else python3 fallback)
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
| `api.ts` | `XSyncApiClient` v1.1.13, `Accept-Version` header, 12s timeout, bodies never logged | Keepmark `XSyncApiClient.cs` |
| `logging.ts` | Levels, ring `InMemoryLogger`, `LogSanitizer` (sync IDs truncated, secrets never logged) | Keepmark `Logging.cs` |
| `bookmarks.ts` | Tree helpers: containers, `newBookmark/cleanBookmark`, ids, validate/repair, `nativeToSynced`, separator detection | `app/bookmark-helper.service.ts` |
| `native.ts` | Generic read/clear/populate/mappings over injected `BookmarkApi` + `NativeOps` factory + `chromiumIsSeparator` | `app/webext-bookmark` + both platform services |
| `store.ts` | `StoreKey` enum (ALL keys live here), `Store`, `MemoryBackend` (tests), `BrowserLocalBackend` (storage.local, MV2+MV3) | `app/store.enum.ts`, webext-store |
| `id-mapper.ts` | `syncedId<->nativeId` mappings, sorted, rebuilt on populate | `app/bookmark-id-mapper.service.ts` |
| `sync.ts` | `checkService`, `createNewSync`, `pullExistingSync`, `pullWithDerivedKey`, `pushBookmarks`, `switchService` | `app/bookmark-sync-provider` + login component |
| `sync-queue.ts` | Gated FIFO `SyncQueue` + failure policy (offline→front, 409→local-first, 401→sync-lost) | `app/sync.service.ts` |
| `reconcile.ts` | `reconcileContainer`: whole-tree native→synced pass via mappings (replaces Add/Modify/Remove/Move/Reorder cases) | new design (equivalent semantics) |
| `messages.ts` | `MessageCommand` + payload/response types + `toWireError/fromWireError` (name-based rehydration) | `app/webext.interface.ts` + sendMessage |
| `backup.ts` | Encrypted envelope `{app,format,salt,blob}` + guards (pwd≥8, 50MB, 200k nodes) | Keepmark `BackupGuard.cs` + envelope |
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
- `src/popup/` — vanilla TS popup (`popup.html` at `src/`, `popup.ts`,
  `popup.css`): connect / search+list+delete / add (prefilled from active
  tab) / settings (status, toolbar toggle, export/import, duplicates,
  move-service, unlink). Display reads `storage.local` + decrypts locally;
  ALL mutations go through background messages.

### Build

- Entries at `src/` root so outputs land flat: `src/popup.html`,
  `src/background.html` (MV2 only).
- `vite.firefox.ts` (popup+background page), `vite.chromium.ts` (popup),
  `vite.chromium-sw.ts` (service worker, single-file ESM lib build),
  `vite.shared.ts` (`platformAlias` + `copyStatic` manifest+assets plugin).
- `res/manifest.{firefox,chromium}.json` → output `manifest.json`;
  `res/assets/` → output `assets/`. Icons generated from
  `../Keepmark/src/Keepmark/Resources/AppIcon/appicon.png` (see §7).
- `scripts/package.mjs` zips `build/*` → `dist/`.

## 4. Load-bearing contracts (do NOT change lightly)

1. **Crypto envelope**: `base64(IV16B || AES-GCM-256(lzutf8(JSON)))`, key =
   PBKDF2-SHA256/250k, salt = UTF-8(sync ID). `tests/vectors.json` (from
   Keepmark, generated from original `app/crypto.service.ts` + lzutf8@0.6.0)
   MUST decrypt green after any `crypto.ts` change. Legacy version-less syncs
   rejected (open once in the original client).
2. **API**: `Accept-Version: 1.1.13`, min service `1.1.9`, sync format `1.8.0`
   (never lower — remote≤local version gate). Password never transmitted;
   sync ID in URL is the bearer. 409 = pull-before-push, never merge.
3. **Sync model**: whole-blob pushes with optimistic `lastUpdated`; stored
   password field holds the DERIVED key, never raw. Queue lives ONLY in the
   background context. 409 → conflict file + notify + pull. 401 → wipe creds.
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
- No `any` leaks, no `window`/`document` outside `src/popup/`, no `Buffer`
  (use `atob`/`btoa` helpers in `crypto.ts` — work in SW + Node).
- `base: './'` in app configs (relative asset URLs — absolute breaks); html
  entries must stay at `src/` root or outputs nest and manifests break.
- `tsconfig.paths @platform/* → src/firefox/*` exists for `tsc` only; real
  selection is the vite alias per config.

## 7. Pending work (exact resume point)

**Icons/assets from Keepmark — DONE (2026-09-25):**

- `res/assets/{icon16,icon32,icon48,icon128,notsynced32}.png` generated with
  PIL LANCZOS from `../Keepmark/src/Keepmark/Resources/AppIcon/appicon.png`
  (432² RGBA rounded tile; notsynced = grayscale + 35% dim).
- Manifests carry `icons` + `default_icon` 32; `copyStatic` ships `assets/`;
  background sets `setIcon` per state (notsynced variant on `!`) + badge text;
  notifications use `icon48.png`; popup header shows the mark.
- Source of truth for future sizes: Keepmark `brand/` + `Resources/AppIcon/`.

**Known limitations / next features (not started):** manual browser QA
(see README install section); QR connect (only `QrDelimiter` constant exists);
no multi-account; no auto-backup schedule; toolbar toggle + Chromium Menu
folder edge cases covered by tests but untested live.
