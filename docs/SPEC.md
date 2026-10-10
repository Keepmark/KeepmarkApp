# KeepmarkApp — Product & Verification Specification

Version: 0.1.0 · Status: working draft for outsourced code verification
Companion docs: `README.md` (overview, install), `DEVELOPMENT.md` (build, contracts), `AGENTS.md` (agent resume point).
Code under verification: `src/`, `res/`, `scripts/`, `tests/` in this repo.

## 0. Purpose and audience

This document is the single normative reference for an **external code
verification** (outsourced review/audit) of KeepmarkApp. It defines:

- what the product must do (features, behaviors, UX rules),
- the protocol and crypto contracts it must honor byte-for-byte,
- the security/privacy properties that must hold,
- how to run every verification gate and what "pass" means (§13).

Where this spec conflicts with code comments, **this spec wins**; where it
conflicts with `AGENTS.md`, this spec wins for behavior and `AGENTS.md` wins
for workflow. Gaps found during verification must be reported as defects
against this spec (§13.4), not silently reinterpreted.

## 1. Product overview

KeepmarkApp (Keepmark for browsers) is a bookmark-sync browser extension:
an independent alternative compatible with xBrowserSync, written from scratch,
**Firefox MV2 first, Chromium MV3 second**. Not affiliated with or endorsed by
xBrowserSync. It interoperates with the official xBrowserSync apps and services
and with Keepmark Server (KeepmarkApi, extended contract v1.2). License GPL-3.0-only
(`LICENSE.md`).

Goals:

- G1. Sync the user's full bookmark tree against any compatible service with
  zero silent data loss (never auto-merge, never drop silently).
- G2. Management UI (status, connection, space, backup, duplicates, move,
  logs, settings), not bookmark browsing.
- G3. Same end-to-end encryption as the official xBrowserSync clients (password never leaves
  the device).
- G4. Behavioral parity between Firefox and Chromium builds.

Non-goals (explicitly out of scope, must NOT be "found missing"):

- Bookmark browsing/search UI, multi-account, auto-backup schedule,
  QR connect (only `QrDelimiter` constant reserved), telemetry.

## 2. Stack, layout, commands

- Stack: TypeScript strict, `webextension-polyfill`, `lzutf8@0.6.0` (pinned),
  Vitest, Vite, vanilla-TS UI (no framework). Node v22, TS ~5.6.
- License GPL-3.0-only. Name/version `keepmark-app@0.1.0` in `package.json`
  and in both manifests (must match on release).
- Layout: `src/shared/` (platform-agnostic core — cross-platform logic lives
  here), `src/firefox/` + `src/chromium/` (thin platform layers),
  `src/background/` (queue owner + browser wiring), `src/popup/` (popup +
  shared `ui.ts`), `src/manager/` (full-tab manager), `src/*.html` entries,
  `res/manifest.{firefox,chromium}.json`, `res/assets/`,
  `vite.{firefox,chromium,chromium-sw}.ts`, `vite.shared.ts`,
  `scripts/{package,qa}.mjs`, `tests/`.

Commands (from repo root). All must pass before any release:

| Command | What it does | Pass criterion |
|---|---|---|
| `npm install` | install deps | exit 0 |
| `npm test` | `vitest run` (13 spec files, no browser needed) | all green (e2e-live skips without `KEEPMARK_E2E_URL`) |
| `npm run lint` | `tsc --noEmit` (app) + `-p tsconfig.chromium.json` | zero `error TS` (grep output, never trust tail) |
| `npm run build` | both platforms → `build/firefox`, `build/chromium` | 3 `built in` lines, exit 0 |
| `npm run package` | asserts + zips → `dist/keepmark-{platform}-{version}.zip` | both zips written |
| `npm run qa` | static QA, no browser (§10.3) | `QA: all green` + `addons-linter: 0 errors` |

`build/` and `dist/` are gitignored build outputs; never hand-edit.

## 3. Protocol and crypto contracts (load-bearing)

These contracts are byte-compatibility-critical. Any change requires
re-running vectors + e2e (§11) and is a major finding if broken.

### 3.1 Versions (`src/shared/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `DefaultServiceUrl` | `https://api.xbrowsersync.org` | default + "Official service" badge identity |
| `MinApiVersion` | `1.1.9` | minimum service API; older → `UnsupportedApiVersionException`, link blocked |
| `ApiVersion` | `1.1.13` | `Accept-Version` header on all legacy calls |
| `ApiVersion12` | `1.2.0` | `Accept-Version` on extended calls, only after capability probe |
| `SyncClientVersion` | `1.8.0` | sync format advertised on create/upgrade; remote `version` must be `<=` it |
| `KeyDerivationIterations` | 250 000 | PBKDF2-SHA256 rounds |
| `GcmNonceLength` | 16 | AES-GCM IV bytes, prepended to ciphertext |
| `SeparatorUrl` | `xbs:separator` | separator marker (Firefox native type) |
| `SyncPollIntervalMs` | 15 min | remote-change poll (alarm `xbs-sync-updates-check`) |
| `ServiceProbeTimeoutMs` | 3000 | `/info` probe timeout |
| `DefaultHttpTimeoutMs` | 12000 | bookmark up/download timeout |

`compareVersions`: numeric dotted comparison, tolerates leading `v` and
non-digit suffixes. Never ordinal string compare.

### 3.2 v1.1 endpoints (frozen legacy shapes)

Base: `{serviceUrl}/`. Every request sends `Accept-Version: 1.1.13`.
Bodies are JSON; request/response bodies are never logged (method + path +
status + timing only, sync ID truncated in labels).

| Method + path | Body | Success validator | Notes |
|---|---|---|---|
| `GET info` | — | `status !== undefined && version` | `checkService` enforces `version >= 1.1.9` |
| `POST bookmarks` | `{version: 1.8.0}` | `id && lastUpdated && version` | create |
| `GET bookmarks/:id` | — | `lastUpdated` present | full download |
| `GET bookmarks/:id/lastUpdated` | — | `lastUpdated` present | cheap poll |
| `GET bookmarks/:id/version` | — | `version` present | format gate |
| `PUT bookmarks/:id` | `{bookmarks, lastUpdated[, version]}` | `lastUpdated` present | whole-blob upload, optimistic timestamp; `version` sent only when creating/upgrading |

Sync ID in URL is the bearer token. `fetch` must stay bound (wrapper, never
bare `fetch` reference — Firefox throws otherwise). AbortController timeout
per request; timeouts/aborts map to offline (§3.4).

### 3.3 v1.2 extended contract (opt-in, KeepmarkApi)

Advertised via `capabilities: {revision, conditionalGet, delete}` in
`GET info` with `Accept-Version: 1.2.0`. Detection rule: v1.2 **iff**
`capabilities.revision === true` (`supportsV12()` in `api.ts`,
`supportsV12()` in `models.ts`, `v12Usable(info)` requires
`info.supportsV12 === true` — `undefined`/never-probed counts as legacy).

`capabilities.syncExpiryDays` (integer ≥ 0, `0` = kept forever) is the
service's inactive-sync expiry. Display only: `ping()` and `SwitchPreview`
return it (`validExpiryDays()` drops absent/malformed values → `undefined`),
the manager shows it in Settings (“Unused syncs”) and in the move preview via
`describeSyncExpiry()` (`—` when unknown, i.e. legacy service). Never stored.

| Feature | Request | Behavior |
|---|---|---|
| Extended info | `GET info` + `Accept-Version: 1.2.0` | legacy servers return legacy shape (no capabilities) or 412 → treated as v1.1 |
| Extended GET | `GET bookmarks/:id` + v1.2 | same shape + `meta {revision, hash, size, createdAt}`; absent/zeroed for pre-v1.2 syncs |
| Conditional GET | `GET` + `If-None-Match: "<hash>"` | `304` → `null` (unchanged); legacy 412 → caller falls back to full GET |
| Revision CAS PUT | `PUT` body `{bookmarks, baseRevision[, version]}` (never `lastUpdated`) | atomic compare-and-swap; races lose with 409 |
| Server delete | `DELETE bookmarks/:id` + v1.2, success may be `{}`/empty | legacy 412 → `UnsupportedVersionException`; UI-gated, never silent fallback |
| Create v1.2 | `POST` + v1.2 | response carries `meta` (fresh creates report revision 1) |

412-fallback discipline (mandatory): every v1.2 attempt has a legacy retry
path that also **downgrades the cached flag** (`downgradeV12`: clears cache,
patches stored `supportsV12=false`, drops stored revision/hash) so a
downgraded service is never retried on v1.2 with a poisoned revision.
`persistMeta` clears stored revision/hash on any legacy (meta-less) response.

Stored v1.2 state: `SyncInfo.supportsV12`, `SyncRevision`, `SyncHash`
(`StoreKey`). Live `Ping` refreshes the flag when reachable; offline probes
leave it untouched (stored flag is the fallback everywhere).

### 3.4 Error mapping (HTTP → typed error → UX)

`errorForStatus(status, serverMessage, tr)` (`src/shared/errors.ts`).
Server message appended as `(server: …)` suffix, else `(HTTP n)`.

| HTTP | Exception | Meaning / required handling |
|---|---|---|
| 400 | `UnexpectedResponseException` | malformed; surfaced, no retry |
| 401 | `SyncNotFoundException` | sync gone → queue cleared, creds wiped, `RemovedSync` plaintext snapshot (tree+lastUpdated+URL, never password), notification `Sync removed` |
| 404 | `InvalidServiceException` | not a valid service |
| 405 | `NotAcceptingNewSyncsException` | no new syncs |
| 406 | `DailyNewSyncLimitException` | quota; e2e consumes it (§11.2) |
| 409 | `DataOutOfSyncException` | remote moved → conflict **persisted** in `StoreKey.ConflictState` (encrypted local tree + remote `lastUpdated` seen; survives MV3 worker sleeps and browser restarts), plaintext `keepmark-conflict-*.json` download + `Sync conflict` notification, queue stops (`ConflictCapturedException`). While pending: no auto-pull (`checkForUpdates`/local jobs skip), native edits refresh the stored local side, no push. UI (`GetConflictState` / `GetConflictPreview` / `ResolveConflict`) offers **Pull** / **Push** / **Merge** (union, never deletes), each confirmed. Never auto-merge. |
| 412 | `UnsupportedVersionException` | v1.2 on legacy → downgrade + legacy retry; surfaced as `Not supported (requires service v1.2)` |
| 413 | `SyncTooLargeException` | blob exceeds `maxSyncSize` |
| 429 | `ThrottledException` | transient: job requeued at the front, drain stops (no tight loop); credentials are never wiped for a 429 |
| 5xx/network/timeout/abort | `ServiceOfflineException` | non-local jobs requeued at front, error rethrown |

Non-HTTP: decrypt failure → `InvalidCredentialsException` (wrong password);
missing creds/blob → `IncompleteSyncInfoException`; bad shape →
`UnexpectedResponseException`; remote format newer than 1.8.0 →
`UnsupportedSyncVersionException`; service older than 1.1.9 →
`UnsupportedApiVersionException`. Wire transport preserves type by name
(`toWireError`/`fromWireError`, unknown names → `XbsException`).

### 3.5 Crypto envelope

`base64(IV16B || AES-GCM-256(lzutf8(JSON)))`, key =
`PBKDF2-SHA256/250k(password, UTF-8(syncId))` → raw 32 B → base64.
`deriveKey` requires a sync version; version-less legacy syncs are rejected
with "open once in the original xBrowserSync client".
`tests/vectors.json` (from the original `app/crypto.service.ts` +
`lzutf8@0.6.0`) MUST decrypt green after any `crypto.ts` change; reverse
direction covered by Keepmark-side scripts. Helpers use `atob`/`btoa`
(SW + Node safe); no `Buffer`; `bytesToBase64` chunked (`0x8000`).
Empty plaintext encrypts to `''`. Guards: 32-byte key length enforced on
decrypt; wrong password → `InvalidCredentialsException`.

### 3.6 Sync format rules

- `BookmarkNode` wire fields are camelCase (`id? number`, `title?`,
  `url?`, `description?`, `tags?`, `children?`), byte-compatible with
  original-client and Keepmark blobs.
- `normalizeBookmarks`: trim descriptions (300 ch), drop empty
  description/tags.
- Remote `version` missing → legacy error; greater than `SyncClientVersion`
  → newer-client error. `updateVersion=true` only on create/upgrade PUTs.
- Stored password field holds the **derived key**, never the raw password.

## 4. Sync engine (background only)

Owner: `BackgroundCore` (`src/background/core.ts`). Queue lives ONLY in the
background context (never popup); UI talks via `MessageCommand` messages
(`src/shared/messages.ts`), responses `{ok, data}` / `{ok:false, errorName,
message}`. Background + shared + platform code must stay DOM-free and use
only static imports (MV3 service worker compiles to one self-contained ESM
file — qa checks §10.3 #2/#3).

### 4.1 Queue and failure policy (`src/shared/sync-queue.ts`)

Serialized FIFO, one job at a time; `enqueue` auto-runs when `run=true`.
Popup never touches the queue. `drain()` executes up to 10 steps.

| Failure | Policy |
|---|---|
| `ServiceOfflineException` on non-local job | job back to front, error rethrown |
| `DataOutOfSyncException` (409) | conflict persisted (see §3.4), queue stops via `ConflictCapturedException`; the failed job is dropped (the stored conflict carries the local side) |
| `SyncNotFound` / `IncompleteSyncInfo` / `UnsupportedSyncVersion` | clear queue, `onSyncLost` (caller disables sync) |
| `ThrottledException` (429) | like offline: job back to front, error rethrown |
| `InvalidCredentialsException` | clear queue, credentials kept (user relinks) |

### 4.2 Jobs and flows

- `local` (pull): v1.2 conditional GET with stored hash (304 → no-op) else
  full GET; decrypt → validate/repair ids → ensure containers → clear +
  populate natives → rebuild id mappings → persist (blob, lastUpdated, meta,
  `supportsV12`) → `SyncEnabled=true`. Sets `updateRemote` when ids repaired
  or containers added (order-insensitive check), then pushes.
- `remote` (push): reconcile native→synced whole-tree pass per container via
  stored id mappings (`reconcileContainer`); no-op → no push; else
  `pushCurrent` (revision CAS iff v1.2 link + stored revision, else
  timestamp). Id mappings are persisted only after the PUT lands. On 409 →
  conflict persisted + download + notification (§3.4).
- Before every pull (`local` job) the natives are reconciled against the
  cached tree: unpushed native edits (offline push whose in-memory queue died
  with the worker/browser) become a conflict instead of being wiped by
  `clearAndPopulate`.
- Phantom conflicts never reach the user: a 409 whose fresh remote already
  holds exactly the local content (`sameContent`, ids ignored) is adopted;
  the pre-pull check ignores reconcile noise that yields the cached content;
  a stored conflict whose sides became identical clears itself on the next
  check or when previewed. The preview carries a content diff
  (`tree-diff.ts`: moved between folders, description/tags, folder set,
  order-only) and the panel explains it in one sentence, so all-zero URL
  counters never leave the user guessing.
- `ResolveConflict`: the destroyed side is snapshotted first (fail closed);
  every PUT is based on the `lastUpdated` / `meta.revision` of the remote just
  downloaded (`pushOnBase`), never on the stored base that caused the 409.
  Pull replaces natives with the fresh remote; Push uploads the stored local
  side and re-anchors mappings; Merge uploads the union FIRST (3 attempts,
  re-fetch + re-merge from the original local side) and overwrites natives
  only after success. The conflict clears only on success (retryable).
- `localAndRemote`/restore: snapshot undo, overwrite natives, push.
- "Sync now" = `checkForUpdates` (pull-if-newer) then push, one round trip.
- `quiesce()` (drain, errors swallowed) runs before every direct GET+PUT
  sequence (connect-push, switch, password change, undo, delete).
- Native mutations (`AddBookmark`/`RemoveBookmark`) write natives first, then
  enqueue a non-running `remote` job + `drain()`; the native listener also
  reconciles eagerly.
- Native events: alarm-based debounce (`xbs-native-debounce`, default 300 ms;
  re-scheduling overwrites), never `setTimeout` (MV3 sleep safety), never
  scheduled while unlinked. Mutating flows run `withSuspended` so listener
  events during link ops are ignored.

### 4.3 Polling, startup, disable

- `xbs-sync-updates-check` every 15 min (scheduled on link + startup when
  enabled): compares remote vs stored `lastUpdated`, queues local on drift.
- `startup()`: applies stored log verbosity; write-once `InstallBackup`
  (first run only — every MV3 wake must NOT overwrite it); reschedules poll
  + immediate `checkForUpdates` when linked; sets badge.
- `disableSync(err?)`: clears queue + v12 cache, clears both alarms, removes
  mappings/blob/lastUpdated/revision/hash/undo, sets `SyncEnabled=false`,
  `SyncInfo={}`. On `SyncNotFoundException` first stashes the `RemovedSync`
  snapshot and notifies; badge cleared; warning logged otherwise.

## 5. Features (normative behavior per command)

Preconditions: anything needing a link calls `requireCreds()` → throws
`IncompleteSyncInfoException('Sync is not connected.')` when unlinked.
`connecting` flag rejects concurrent connects. Every destructive flow takes a
safety path (§5.8) and, where listed, an undo snapshot (§5.9).

- `ConnectNew {serviceUrl, password}`: probe service (min-version gate) →
  probe v1.2 → read native tree → create+upload (v1.2 CAS upload with 412
  retry on legacy + cache fix) → rebuild mappings → undo `connect-new` →
  schedule poll. Returns `{id}`. Passwords cleared from UI on success.
- `ConnectExisting {serviceUrl, syncId, password, direction='pull'}`:
  pull (default): version gate → derive key → GET (v1.2 with 412 fallback) →
  undo `connect-pull` (includes encrypted pre-pull natives) → overwrite
  natives → persist → push back if repaired. Push (opt-in, never default):
  version gate → password verified by decrypting remote → plaintext safety
  download of server copy → PUT local tree (revision CAS iff v1.2 + meta) →
  undo `connect-push` (slot persisted only after PUT lands) → relink.
  The popup confirms every existing-sync link inline before connecting
  (`confirmInline` on `btn-connect`, texts `directionConfirm`; merge shows
  its preview counts first).
- `SyncBookmarks {type:'remote', runSync:true}`: pull-if-newer then push.
- `AddBookmark {container, parentId?, title, url?}` / `RemoveBookmark {id}`:
  native write by stable synced id via mappings, then push-now (errors thrown
  to UI).
- `RestoreBookmarks {bookmarks}`: undo `restore`, overwrite natives, push.
- `ExportBackup {password}`: encrypted envelope
  `{app:'KeepmarkApp', format:1, salt, blob}`; guards mirror §9 (password ≥ 8,
  fresh random salt per export, 50 MB byte limit on real bytes, 200k nodes,
  shape-typed BFS validation with index queue). UI downloads
  `keepmark-backup-YYYY-MM-DD.xbs.json`, clears the password field.
- `ImportBackup {json, password}`: parse wrapped (invalid JSON / foreign
  `app` / bad `format` / wrong password / corrupted payload each get distinct
  errors), validate, undo `import`, overwrite natives + push. Returns
  `{count}`.
- `GetDuplicates`: group native bookmarks by normalized URL
  (lowercase host, default-port strip, fragment strip, tracking-param strip,
  trailing-slash rule; legacy trim+lowercase fallback), entries id-sorted
  ascending; groups sorted by size desc then URL. `planDuplicateDeletion`:
  max id (newest) locked, never returned; subset deletion ignores locked ids.
  Deletions run as sequential whole-blob reconcile+push steps (each leaves a
  consistent state).
- `SwitchPreview {newServiceUrl, mode, syncId?}`: read-only, never mutates or
  syncs; returns reachability, service version + min-version compatibility,
  status, max size, local count, target `supportsV12`, and (existing mode)
  remote existence + `lastUpdated`. Requires an existing link (tree source).
- `SwitchService {newServiceUrl, mode, syncId?, newPassword, direction}`:
  requires link; quiesce; plaintext safety download of scrapped side;
  new-mode: create+upload on target (v1.2 iff probed) → undo `switch-new` →
  returns `{id}`. Existing-pull: version gate → password check by decrypt →
  undo `switch-pull` → overwrite natives. Existing-push: undo only after PUT
  lands (`switch-push`). UI: `Check target` preflight pins
  `{newServiceUrl, mode, syncId}`; submit with changed inputs is refused
  (`Inputs changed since the check`); `Move sync` enabled only on successful
  preview and consumed after success; Sync-ID row visible in existing mode
  only; success shows `Moved. New sync ID: …` + Copy button.
- `ChangePassword {currentPassword, newPassword}`: current derived key must
  equal stored key (else `InvalidCredentialsException`, nothing touched) →
  quiesce → safety download → re-encrypt tree under new key → PUT (revision
  CAS iff v1.2 + stored revision, 412 fallback with downgrade) → undo
  `change-password` → rotate stored derived key (re-read first; abort on
  concurrent link change). Old password dies everywhere immediately.
- `DeleteRemoteSync`: v1.2-gated twice (stored flag, then live `delete`
  capability; `delete !== true` refuses). Safety plaintext download first,
  DELETE, then unlink (natives untouched) + notification + result text.
  No undo slot by design (no server undelete). UI: disabled with reason +
  hint on v1.1 (`Server delete needs API v1.2 … Unlink only removes this
  device`); two inline confirms (`Yes, delete` → `Yes, delete for
  good`, `DeleteRemoteImplication` in `texts.ts`) when enabled.
- `DisableSync` (Unlink): single inline confirm (`Yes, unlink`,
  `UnlinkImplication`: ID + password needed, unsynced edits, Undo cleared), clears state per §4.3, result text, status redrawn cleared.
- `UndoLastLink` / `DismissUndo` / `GetUndoState`: one encrypted slot;
  unlink invalidates it; undo restores previous link state; banner describes
  kind + count + time; inline confirm `Undo the last action?` naming the
  action in words (`undoConfirm`), result `Undone: <what>.` (`undoneText`).
- `GetRemovedSync` / `ClearRemovedSync`: surfaces the 401 snapshot with
  Download/Dismiss (manager/popup banner area).
- `GetConflictState`: returns `{hasConflict, localCount?, remoteLastUpdated?, localTreeEncrypted?}` — called when `status.conflict === true` to render resolution UI.
- `GetConflictPreview`: returns detailed `MergeStats` + samples (localOnly/remoteOnly/titleConflicts/foldersCreated + first 5 paths each) for the conflict resolution card.
- `ResolveConflict {direction:'pull'|'push'|'merge'}`: executes the chosen resolution; safety backup of destroyed side(s) taken first; on success clears conflict state and refreshes status.
- `SetVerbosity {level}` / `GetLogs` / `Ping` / `GetStatus` / `DownloadFile`:
  verbosity persisted (`LogVerbosity`), applied at startup; logs viewer
  renders `[LEVEL] tag: message` (already sanitized); ping is a 3 s
  never-throw probe that also refreshes stored v1.2 flag + service version
  (offline leaves both untouched); status returns link state + queue +
  `usedBytes` (base64 chars) + cached count + flags; downloads go through the
  background port (data-URL safe).

## 6. State and storage (`src/shared/store.ts`)

ALL keys live in the `StoreKey` enum; string-literal storage access outside
`store.ts` is a defect (qa #6). Backend: `browser.storage.local`
(`BrowserLocalBackend`); `MemoryBackend` for tests. Defaults: `SyncEnabled
false`, `SyncBookmarksToolbar true`, `DarkModeEnabled false`,
`BookmarkIdMappings []`.

| Key | Content | Notes |
|---|---|---|
| `SyncInfo syncInfo` | `{id?, password=derivedKey, version?, serviceUrl?, serviceVersion?, supportsV12?}` | password field is the DERIVED key, never raw |
| `Bookmarks bookmarks` | encrypted blob (base64) | size reported as `usedBytes` |
| `LastUpdated lastUpdated` | optimistic timestamp string | v1.1 push base |
| `SyncRevision/SyncHash` | v1.2 `meta` | cleared on legacy responses |
| `SyncEnabled syncEnabled` | bool | link switch |
| `BookmarkIdMappings` | sorted synced↔native mappings | rebuilt on populate |
| `UndoSlot undoSlot` | one encrypted snapshot + op link | invalidated on unlink |
| `RemovedSync removedSync` | 401 plaintext snapshot | no password stored |
| `InstallBackup installBackup` | first-run natives + date | write-once |
| `LogVerbosity logVerbosity` | `XbsLogLevel` number | applied at startup |
| `TraceLog traceLog` | ring buffer (cap 1000) | via `InMemoryLogger` |
| `SyncBookmarksToolbar` | bool default true | toolbar container inclusion |
| Legacy-tolerant | `alternateSearchBarPosition`, `autoFetchMetadata`, `autoBackUpSchedule`, `checkForAppUpdates`, `darkModeEnabled`, `display*`, `installationId`, `lastUpgradeVersion`, `telemetryEnabled` | accepted keys from original-client shape; no telemetry collected |

## 7. UI specification

Surfaces: popup (`src/popup.html`, connect + status + sync now + manager
link + undo banner; `?fullpage=1` tab mode for vault copying) and manager
(`src/manager.html`: Status, Backup, Duplicates, Move, Logs, Settings,
About). Shared renderer + validators in `src/popup/ui.ts`. Rules:

- Each manager section owns contextual busy/error/result evidence; stale
  result boxes are hidden when a new error appears (`hideErrors`).
- Async buttons use `withBusy`: busy label while running, **restores the
  previous disabled state** (never force-enables — gating survives), restores
  label, rethrows (so throw-paths still restore).
- Validation is pure and client-side first: `validateServiceUrl` (https
  always; http loopback-only), `validateConnect` (password required; new mode
  confirm match; existing requires id; push requires confirm tick),
  `validateSwitch` (confirm field only in new mode — existing verifies
  by decrypting the target before anything mutates, so a typo fails safely;
  id required for existing),
  `validatePasswordChange` (current required, next ≠ current, confirm match).
- Status card (`renderStatusCard`, prefix `p`/`m`/`t`): unlinked clears EVERY
  field to `—` (regression-pinned); badge `Official/Custom service` + `· API
  v1.2` suffix (live probe wins, stored flag offline fallback); pill priority
  `Offline > Syncing… > Checking… > Behind > Synced`; space `used of max`
  with meter, count `N bookmarks`, service-version row optional.
- `contractGate({liveV12, storedV12, syncEnabled})`: enabled iff v1.2;
  disabled title `Not supported (requires service v1.2)`; hint hidden when
  v1.2 or unlinked; badge `API v1.2` / `API v1.1` / empty unlinked.
- Delete guard is checked BEFORE `withBusy` (the wrapper disables while
  running — an inner check self-triggers and mutes the click); gate
  re-asserted AFTER `withBusy` (restores pre-click state last).
- Move wizard: preview-locked submit, gate hint visible exactly while locked,
  result cleared on input change, new-ID + Copy on success.
- `[hidden] { display: none !important; }` in both CSS files (author display
  rules otherwise override UA hiding and leak wizard rows).
- Confirm texts: unlink and delete come from `src/popup/texts.ts` (inline
  `confirmInline`, see `docs/WORKFLOWS.md`), as do undo (`undoConfirm`) and
  the conflict choices (`directionConfirm`). Password fields cleared per-flow (confirm always; current
  on failure; new kept only to retype proof).
- UI in en/it/fr/es/de/ja/pt/ru/zh (system language by default, override in Settings → Language; logs stay English); no telemetry prompts wired; dynamic list buttons get
  `aria-label`s; clipboard falls back to `prompt` when denied.

## 8. Platform matrix

Adapter chosen at build time via `@platform/adapter` vite alias (NOT runtime
detection); `tsconfig.paths` mirrors it for `tsc`. Both adapters implement
`NativeAdapter` (`src/background/adapter.ts`).

| Area | Firefox (MV2) | Chromium (MV3) |
|---|---|---|
| Manifest | `manifest_version 2`, `browser_action`, `background.page`, `browser_specific_settings.gecko` (`keepmark@proton.me`, min 142.0, `data_collection_permissions: [none]`), `incognito: not_allowed` | `manifest_version 3`, `action`, `background.service_worker` (module, single-file ESM), `host_permissions [https://*/*, http://*/*]`, `minimum_chrome_version 109` |
| Roots | `menu________` / `unfiled_____` / `toolbar_____`, all 3 containers | Other `2` + Toolbar `1`; no Menu root → `[xbs] Menu` folder inside Other (created on demand; read/write through it) |
| Separators | native `type: 'separator'` | `───` / `|` bookmark placeholders |
| New-tab URL | `about:newtab`, `about:` config detection | `chrome://newtab/` or `edge://newtab/` |
| Permissions | alarms, bookmarks, downloads, notifications, storage, unlimitedStorage | same + `host_permissions` (MV3 SW needs explicit host grant for `fetch` to user services; no content scripts, API calls only) |
| CSP | `connect-src https: http://localhost:* http://127.0.0.1:*; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'` | same connect-src |
| Background | persistent page | service worker: alarm-driven (no `setTimeout`), single bundle, no local chunk imports, no dynamic `import()` |

Icons from official Keepmark brand (`../KeepmarkMobile/brand/`): navy-tile manifest
icons (48/128) + toolbar (16/32, grayscale notsynced),
white-mark in-page chip.

## 9. Security and privacy requirements

- S1. Raw passwords never transmitted, never stored (derived key only),
  never logged; backup passwords only protect local envelopes.
- S2. Sync IDs are bearer tokens: truncated (`4…2`) in all logs/labels via
  `sanitizeSyncId`/`sanitizePath`; never persisted beyond operational stores.
- S3. `LogSanitizer` is a mechanism, not discipline: `InMemoryLogger.log`
  sanitizes every message (key=value secrets → `[redacted]`, UUID-like IDs →
  truncated); levels, 1000-entry cap, min-level drop.
- S4. HTTPS-only services; `http` allowed solely for loopback
  (`localhost`, `127.0.0.1`, `[::1]`) — enforced in `validateServiceUrl` and
  `validateSwitch`.
- S5. Backup envelope guards: password ≥ 8, 50 MB real-byte limit, 200k node
  cap, typed node validation, fresh salt per export, distinct errors per
  failure class.
- S6. Safety downloads are plaintext by design (conflict, pre-push,
  pre-pwchange, server-backup, move): filenames timestamped, failures warn
  but never block (encrypted undo slot is the primary net).
- S7. Destructive ops: stable-identity resolution (synced IDs), validate
  first, confirm in UI, snapshot before mutate, persist undo only after
  remote write lands, never swallow errors (log with context).
- S8. No telemetry, no page access, no `tabs` permission; minimal host grant
  documented in `docs/DEVELOPMENT.md` (Permissions).

## 10. Build, packaging, QA gates

- 10.1 `vite.firefox.ts` (popup + background page + manager),
  `vite.chromium.ts` (popup + manager), `vite.chromium-sw.ts` (SW lib build +
  output assert), `vite.shared.ts` (`platformAlias` + `copyStatic`
  manifest+assets plugin asserting every manifest-referenced file exists;
  background page validated in main build, SW in its own step).
  `base: './'` pinned (absolute asset URLs break packaged pages).
- 10.2 `scripts/package.mjs`: refuses unbuilt/manifest-less builds, asserts
  icons + popup + background entry exist, drops stale unversioned zips,
  writes versioned `dist/keepmark-{firefox,chromium}-{version}.zip`.
- 10.3 `scripts/qa.mjs` checks (all must pass): #1 TS↔HTML id cross-check;
  #2 DOM-free background/shared/platform; #3 no expression `import()`;
  #4 no `console.log`/`debugger`; #5 `MessageCommand`↔handler exhaustiveness
  both directions; #6 no literal storage keys outside `store.ts`; #7 build↔
  manifest coherence (missing build = FAIL); #7b MV3 specifics (no
  Firefox-only keys, SW entry, self-contained bundle); #7c pinned invariants
  (relative base, dual tsconfig); #7d every manifest permission has a
  `browser.*` usage (except documented `unlimitedStorage`/`host_permissions`);
  #8 local `addons-linter --self-hosted` on the versioned Firefox zip with
  **0 errors**.

## 11. Test strategy

- 11.1 Unit/integration (`npm test`, Node + WebCrypto + happy-dom, no
  browser): `api` (legacy shapes frozen, v1.2 pinning, 412 naming),
  `background-core` (connect/pull/push/alarm/409/remove/dupes/backup/switch/
  disable/status/v1.2 chains incl. revision races, undo-orphan cleanup),
  `backup-duplicates` (envelope round-trip, guards, normalize vectors,
  lock rule), `bookmarks` + per-platform suites (containers, separators,
  Menu folder, id repair parity), `chromium-bookmarks`, `crypto` (+
  `vectors.json` decrypt-all), `firefox-bookmarks` (mocks reused by core
  tests), `logging` (sanitizer vectors, cap/levels, verbosity persistence),
  `queue-messages` (FIFO policy, wire rehydration), `reconcile` (whole-tree
  pass), `sync` (v1.1/v1.2 paths, meta persistence, gates), `ui` (card,
  gate, busy incl. gated-restore, validators). A pre-existing fake-API
  unhandled-rejection noise in vitest output is known and unrelated.
- 11.2 Live E2E (`tests/e2e-live.test.ts`, skipped without
  `KEEPMARK_E2E_URL`): real client vs real KeepmarkApi — extended vs frozen
  shapes, link lifecycles both contracts, legacy path on v1.2 server.
  Each run consumes server `DailyNewSyncsLimit` quota (default 3/day; reset
  via Mongo `newsynclogs`, see `KeepmarkApi/docs/DEVELOPMENT.md` + `scripts/e2e-*.sh`
  there). Command:
  `KEEPMARK_E2E_URL=http://localhost:8090 npm test -- tests/e2e-live.test.ts`.
- 11.2b Automated browser QA (`npm run qa:browser`, `scripts/qa-browser.mjs`):
  builds, then drives the real extension in Firefox (MV2, WebDriver BiDi,
  temporary install) and Chromium (MV3, CDP) against a live KeepmarkApi v1.2
  (`KEEPMARK_QA_URL`, default `http://localhost:8090`; needs a generous
  `DAILY_NEW_SYNCS_LIMIT`). Covers connect new/existing, native auto-push,
  every manager section, a real two-browser conflict (merge in Firefox), MV3
  service-worker stop + persisted conflict + take remote, convergence, server
  delete, log redaction (no full sync ID / password), dark-mode screenshots.
  Throwaway profiles, generated password, the QA sync is deleted at the end;
  screenshots + `results.json` in `build/qa/`. Exit 0 only when all checks
  pass (2 = preflight: browsers/build/service missing). Not covered (still
  manual, §11.3): real toolbar clicks/popup sizing, AMO-signed install,
  multi-day MV3 sleep, 413/429 on a public service.
- 11.3 Manual browser QA (required before release, needs a human): temp
  install both builds (README "Get it"), click every button (busy labels,
  confirms, per-section evidence), rendering incl. dark mode, MV3 sleep/wake
  (alarms fire, debounce survives), real conflict (two clients racing → 409
  file + notify), real 401 (server wipe → snapshot + unlink), quota/413/429
  paths if reproducible, AMO signing blocked (needs account/API keys;
  release Firefox ignores `xpinstall.signatures.required=false`).

## 12. Known limitations (not defects)

Browser QA automated (§11.2b, last run 52/52 on Firefox 157 + Chromium 153); remaining manual items in §11.3; permanent Firefox install
blocked on AMO signing; no multi-account/auto-backup/QR; toolbar toggle +
Chromium Menu-folder edges covered by tests but untested live; another agent
may work concurrently in the tree — verify `git status`/`log` before
assuming state.

## 13. Development requirements (prevent regression)

### 13.1 Concurrency & gate discipline

- **Every `await _gate.WaitAsync()` MUST have a matching `_gate.Release()` in a `finally` block.** No exceptions. The `SyncQueue` runner wraps `runJob` in try/finally but individual engine methods that acquire the gate directly must release it.
- **Conflict resolution methods** (`ResolveConflictPullAsync`, `ResolveConflictPushAsync`, `ResolveConflictMergeAsync`) MUST:
  1. Set `_resolvingConflict = true` at start of `try`
  2. Reset `_resolvingConflict = false` in `finally` (after `_gate.Release()`)
  3. Never call other public sync methods that might re-acquire the gate (avoid deadlock)
- **`ForceSyncAsync` and `PushInBackgroundAsync`** MUST check `_resolvingConflict` **after** acquiring `_gate` and return early if true. This prevents false Conflict status during resolution.
- **Background timers** (poll, native debounce) MUST NOT fire sync logic while `_resolvingConflict` is true.

### 13.2 Merge retry discipline

- **Merge push MUST retry on 409** (DataOutOfSyncException) with re-fetch + re-merge (max 3 attempts). Single push attempt is insufficient when remote can change during merge.
- Re-merge uses the **same pure `BookmarkMerge.Merge` function** as preview, so counts always match.

### 13.3 State capture completeness

- **All conflict entry points** must capture conflict state: push (409), pull (if local dirty), auto-sync (both dirty). The `conflictState` must include: local tree, remoteLastUpdated, encrypted local blob, local count.
- **Preview API** (`GetConflictPreview`) MUST re-fetch remote at call time, not return cached state.

### 13.4 Test coverage requirements

- **Concurrency tests**: race between auto-sync and conflict resolution (Pull/Push/Merge)
- **Merge retry test**: simulate 409 on push, verify re-merge + retry succeeds
- **Gate release test**: every engine method acquiring `_gate` verified to release in `finally`
- **Flag test**: `_resolvingConflict` prevents ForceSyncAsync/background push during resolution

## 14. Release checklist (KeepmarkApp)

- [ ] `npm test` green (all 269+ tests)
- [ ] `npm run lint` clean
- [ ] `npm run build` (Firefox + Chromium) succeeds
- [ ] Manual browser QA: conflict → merge → safety backup visible
- [ ] `npm run package` → zips in `dist/`

## 13. Verification guide (for the outsourced reviewer)

- 13.1 Method: run §2 gates first (record versions + outputs); then review
  by area in contract order (§3 → §4 → §5 → §6 → §7 → §8 → §9 → §10);
  reproduce every behavior claim against code, not comments; file one
  finding per violation with spec section + file/line + severity.
- 13.2 Area checklists: crypto (vectors decrypt, no `Buffer`, guards) —
  api (Accept-Version per call, validators, 412 paths downgrade + retry,
  no body logging) — queue/engine (background-only, FIFO, policy table,
  debounce-by-alarm, suspend discipline, undo-slot timing) — storage
  (enum-only keys, derived-key-only, write-once backup, RemovedSync
  password-free) — features (preconditions, confirms, evidence, preview-lock,
  double-gate delete, password-proof-first) — UI (pill priority, gate table,
  busy-restore, hidden rule, validators) — platform (roots/separators/
  newtab per build, manifest keys, SW single-file, alias selection) —
  security (§9 S1–S8) — build/QA (asserts fire on broken fixtures, linter 0
  errors) — tests (each spec file's claimed coverage actually executes).
- 13.3 Acceptance: all §2 gates green; zero blocker/major findings; every
  §3 contract byte-exact (vectors + e2e 8/8 vs KeepmarkApi); 409/401 paths
  demonstrated by test; no `any` leaks, no DOM outside popup/manager, no
  dynamic imports, no literal store keys; manifests minimal + justified.
- 13.4 Severity: Blocker (data loss / secret leak / broken sync / gate red),
  Major (wrong gate, missing confirm/evidence, contract deviation, parity
  break), Minor (copy, style, dead code, naming). Each finding: title,
  severity, spec ref, location, evidence (command output/diff), proposed fix,
  regression test to add.
- 13.5 Deliverables: findings list, gate log (lint/test/build/package/qa +
  e2e if server provided), traceability matrix spec-section ↔ file(s) ↔
  test(s), and a final PASS/FAIL per §13.3.
