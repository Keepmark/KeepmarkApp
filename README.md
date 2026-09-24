# KeepmarkApp — browser extension (Firefox first, then Chromium MV3)

xBrowserSync-compatible bookmark sync. New codebase, inspired by `../app`
(browser-extension logic) with the robustness rules of `../Keepmark`
(whole-blob sync, no silent merge, crypto interop).

## Stack

TypeScript strict + `webextension-polyfill` + `lzutf8@0.6.0` + Vitest.
No UI framework yet (popup comes in Fase 2/3).

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
npm test        # vitest run: crypto interop + api error mapping + versions
npm run lint    # tsc --noEmit
```

## Layout

- `src/shared/` — platform-agnostic core: `constants`, `errors`, `models`,
  `crypto`, `api`, `logging`. Edit here for cross-platform logic.
- `tests/` — `crypto.test.ts`, `api.test.ts`, `vectors.json`.
- Firefox MV2 manifest + background + popup: Fase 2. Chromium MV3: Fase 6.
