# KeepmarkApp — browser extension (Firefox MV2 + Chromium MV3)

xBrowserSync-compatible bookmark sync. New codebase, inspired by `../app`
(browser-extension logic) with the robustness rules of `../Keepmark`
(whole-blob sync, no silent merge, crypto interop).

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
npm test              # vitest: crypto/api/bookmarks/sync/queue/reconcile/backup/core
npm run lint          # tsc --noEmit
npm run build         # both platforms -> build/firefox, build/chromium
npm run build:firefox
npm run build:chromium
npm run package       # zips -> dist/ (system zip or python3 fallback)
```

## Layout

- `src/shared/` — platform-agnostic core: `constants`, `errors`, `models`,
  `bookmarks` (tree helpers), `native` (generic read/clear/populate/mappings),
  `crypto`, `api`, `logging`, `store` (`StoreKey` + backends), `id-mapper`,
  `sync` (first-sync flows), `sync-queue` (gated FIFO + failure policy),
  `reconcile` (native→synced whole-tree pass), `messages` (popup↔background
  protocol + error wire format), `backup`, `duplicates`.
- `src/firefox/` — `platform` (about: rules, fixed roots), `bookmarks`
  (3 containers, `type:'separator'`), `adapter` (NativeAdapter).
- `src/chromium/` — `platform` (chrome:/edge: rules, roots 2/1),
  `bookmarks` (Menu = folder in Other, bookmark-style separators), `adapter`.
- `src/background/` — `core.ts` (queue owner: jobs, alarms, listeners,
  all message handlers), `adapter.ts` (NativeAdapter interface),
  `background.ts` (browser wiring; `@platform/adapter` alias per build).
- `src/popup/` — connect / search+list / add / settings (status, toolbar
  toggle, backup export-import, duplicates, move-service, unlink).
- `src/popup.html`, `src/background.html` — vite entries (land at output root).
- `res/manifest.{firefox,chromium}.json` — copied to output as manifest.json.
- `vite.{firefox,chromium,chromium-sw}.ts` + `vite.shared.ts`, `scripts/package.mjs`.

## Sync model

- Whole-blob: every push uploads the full tree with optimistic `lastUpdated`.
- Queue lives only in the background context; popup talks via messages.
- Native edits (listener debounce, popup add/remove) reconcile native→synced
  through stored id mappings (stable ids), then push.
- 409: stash the uncommitted tree as a `keepmark-conflict-*.json` download,
  notify, then pull latest. Never auto-merge, never drop silently.
- Sync loss (401): queue cleared, credentials wiped, notification.
- "Sync now" = pull-if-newer then push.

## Platform differences (from the original client)

- Firefox: roots `menu________/unfiled_____/toolbar_____`, all 3 containers,
  native separators, `about:newtab`.
- Chromium: roots Other=`2` + Toolbar=`1`, no Menu root (folder `[xbs] Menu`
  inside Other), separators are `───` / `|` bookmarks, `chrome://newtab/`.

## Install for testing

- Firefox: `about:debugging → This Firefox → Load Temporary Add-on →
  build/firefox/manifest.json`.
- Chromium: `chrome://extensions → Developer mode → Load unpacked →
  build/chromium`.
