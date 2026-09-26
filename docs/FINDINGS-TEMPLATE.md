# Code Verification — Findings Template

Project: KeepmarkApp · Spec: `docs/SPEC.md` (§13) · Reviewer: __________ · Date: __________
Code revision verified: commit __________ · Gates run: lint / test / build / package / qa / e2e-live (circle)

## Gate log (paste command outputs or attach)

| Gate | Command | Result (PASS/FAIL) | Notes |
|---|---|---|---|
| lint | `npm run lint` | | `error TS` count: |
| test | `npm test` | | files / tests passed: |
| build | `npm run build` | | `built in` count (expect 3): |
| package | `npm run package` | | zips written: |
| qa | `npm run qa` | | addons-linter errors (expect 0): |
| e2e-live | `KEEPMARK_E2E_URL=… npm test -- tests/e2e-live.test.ts` | n/a if no server | quota state before/after: |

## Finding (copy one block per defect)

> ### [F-001] Title
>
> - Severity: Blocker / Major / Minor (§13.4)
> - Spec ref: §__. (quote the violated requirement)
> - Location: `path/to/file.ts:line`
> - Evidence: (command output, diff, reproduction steps)
> - Impact: (data loss / secret leak / broken sync / wrong gate / …)
> - Proposed fix: (concrete, minimal)
> - Regression test to add: (file + case name + what it asserts)

## Traceability matrix (spec ↔ code ↔ tests)

| Spec section | Implementation file(s) | Covering test(s) | Verified (y/n) |
|---|---|---|---|
| §3.5 crypto envelope | `src/shared/crypto.ts` | `tests/crypto.test.ts`, `tests/vectors.json` | |
| §3.2/3.3 API contracts | `src/shared/api.ts` | `tests/api.test.ts`, `tests/e2e-live.test.ts` | |
| §3.4 error mapping | `src/shared/errors.ts` | `tests/api.test.ts` | |
| §4.1 queue policy | `src/shared/sync-queue.ts` | `tests/queue-messages.test.ts` | |
| §4.2 engine flows | `src/background/core.ts`, `src/shared/sync.ts`, `reconcile.ts` | `tests/background-core.test.ts`, `tests/sync.test.ts`, `tests/reconcile.test.ts` | |
| §5 features | `src/background/core.ts`, `src/shared/backup.ts`, `duplicates.ts` | `tests/backup-duplicates.test.ts`, `tests/background-core.test.ts` | |
| §6 storage | `src/shared/store.ts` | `tests/*` (MemoryBackend), `scripts/qa.mjs` #6 | |
| §7 UI | `src/popup/ui.ts`, `popup.ts`, `src/manager/manager.ts` | `tests/ui.test.ts`, `scripts/qa.mjs` #1 | |
| §8 platform | `src/firefox/*`, `src/chromium/*`, `res/manifest.*.json` | `tests/firefox-bookmarks.test.ts`, `tests/chromium-bookmarks.test.ts` | |
| §9 security | `src/shared/logging.ts`, `crypto.ts`, `store.ts` | `tests/logging.test.ts`, `tests/crypto.test.ts` | |
| §10 build/QA | `vite.*.ts`, `scripts/*` | `scripts/qa.mjs` (self-checking) | |

## Verdict

- [ ] PASS — all §2 gates green, zero Blocker/Major findings, §3 byte-exact.
- [ ] CONDITIONAL PASS — only Minor findings (list: __________).
- [ ] FAIL — Blockers/Majors open (list: __________).

Signature: __________ Date: __________
