# KeepmarkApp — Design rules (visual + behavioral)

Source of truth for anyone extending popup/manager UI. Extracted from
`src/popup.html`, `src/manager.html`, `src/popup/popup.css`,
`src/manager/manager.css`, `src/popup/ui.ts`, `src/popup/popup.ts`,
`src/manager/manager.ts`. Companion: `docs/SPEC.md §7`, `AGENTS.md §6`.

## 1. Tokens

"Navy ledger" palette, shared with the Keepmark Android app (same roles and
values; canvas: Keepmark Redesign artifact). Both pages:

```css
--brand: #243878;                                  /* popup header band, brand chip, extension icons */
--navy: #172552;                                   /* undo strip */
--bg: #f5f6fa; --surface: #ffffff; --fg: #141b38; --muted: #4a5170;
--border: #cdd2e1; --accent: #3d4fb0;              /* primary buttons, focus, meter */
--danger: #a12626; --ok: #1f6f5c; --warn: #9a6a0a;
```

Dark scheme (`prefers-color-scheme: dark`, both pages): `--bg: #0e1226;
--surface: #161b33; --fg: #e8eaf4; --muted: #a3a9c4; --border: #39427a;
--accent: #8c9bf0; --danger: #ff8a7a; --ok: #6fd08c; --warn: #f0b955`.
The popup also defines `--surface-2`, `--line`, `--tint`, `--tint-ink`,
`--on-accent`, `--accent-hover`.

- `color-scheme: light dark`, `font: system-ui`, no framework, no webfonts.
- Brand: `.brand-chip` (white mark `assets/brand-mark.png`; on the popup's
  `--brand` header it is a translucent white tile, in the manager a `--brand` tile,
  18px popup / 22px manager). Toolbar/manifest icons come from
  `../KeepmarkMobile/brand/src/build.py --install`; never recolor by hand.
- Popup components: navy `header` band with `#sync-state` as a pill;
  `.seg`/`.seg-opt` segmented control over the native `conn-mode` radios;
  `.option` selectable cards over the `conn-direction` radios; `.mode-hint`
  text switched by CSS `:has()`; `button.primary` for the main action of a view.
- `[hidden] { display: none !important; }` is mandatory in every page CSS:
  author `display` rules (`label`, `.row`) override UA `[hidden]` otherwise
  and wizard rows leak into view.

## 2. Layout

- Popup: 360px box (`body.fullpage` → centered 560px column for
  `popup.html?fullpage=1`, used while copying from a vault).
- Manager: `.layout` flex, 200px sticky `#sidebar`, `main` max 720px.
  Sidebar buttons toggle `.active` + `aria-current="page"`; section switch
  moves focus to the new `h2` (`tabindex=-1`).

## 3. Components (class names are the contract)

| Class | Use |
|---|---|
| `.card` + `.status-row` + `.pill` + `.badge` + `.status-grid` + `.meter` | status card, rendered only by shared `renderStatusCard(prefix)` |
| `.pill.ok/.warn/.bad/.busy` | Synced / Behind / Not connected+Offline / Syncing+Checking |
| `.badge` (`.official` = solid border for the official service, default
  dashed for custom services) | `Official/Custom service [· API v1.2]`, counts, contract tag |
| `.row` | button clusters (`gap 8px`, wrap in manager) |
| `.mini` | inline small buttons (Copy, Restore/Delete, Undo) |
| `.check` | radio/checkbox label rows |
| `.hint` (12px muted), `.warning` (popup only), `.notice` (manager About) | guidance |
| `.error[role=alert]` | per-step errors, see §4 |
| `.result` (manager only, green) / `.preview` (dashed box) | success / dry-run output |
| `.undo` (dashed warn) | undo banner + text from `describeUndo()` |
| `.danger` | text-colored destructive buttons (never filled) |
| `.dup-group/.dup-row/.dup-toggle(.on)/.dup-text/.dup-sub`, `.clean` | duplicates list (manager only) |
| `#m-log-list` (`pre`, scroll, bordered) | logs |

## 4. Behavioral rules (must follow for new features)

1. **Shared renderer**: status card markup + `renderStatusCard()` in `ui.ts`
   is the single source. Never fork per page; prefix ids (`p-`/`m-`).
2. **Evidence belongs to the step**: every action cluster gets its own
   adjacent error box (`<base>-error`, `<base>-error-2`, …), `role="alert"`,
   starts `hidden`, emptied (not just hidden) on clear. `hideErrors()`
   (manager) / `clearErrors()` (popup) must cover all of them; showing a new
   error hides stale `.result` boxes. Success mirrors it: restate WHAT ran
   (mode+direction+target) via a pure helper in `ui.ts`
   (`describeMoveResult`, `describeUndo`) with unit tests — never inline text
   in handlers.
3. **Busy buttons**: all async actions via `withBusy(id, busyLabel, fn)`.
   It restores the *previous* disabled state (gated buttons stay gated) and
   the label, and rethrows so throw-paths still restore.
4. **Gating order**: capability checks run BEFORE `withBusy` (it disables
   while running, an inner check would self-trigger); re-assert the gate
   AFTER it (it restores pre-click state last). Pattern: `updateDangerZone()`
   + `contractGate()`.
5. **Preview locks**: destructive wizards (merge, move, import) are
   preview-then-confirm. Pin `previewFor` inputs; submit refuses stale
   inputs (`Inputs changed since the check`); success consumes the preview
   (`updateMoveForm()` after `withBusy`, never before).
6. **Confirms**: `window.confirm` for unlink (1×), server delete (2×),
   undo, per-group and bulk duplicate deletes, import, merge. No `confirm`
   inside background/shared code (DOM only in popup/manager).
7. **Validation pure first**: `validateServiceUrl` (https, http loopback
   only), `validateConnect` (no direction tick: the inline confirm asks),
   `validateSwitch` (confirm field exists only in `new` mode — existing
   verifies by decrypting), `validatePasswordChange`. Null = valid.
8. **Passwords**: clear `confirm` always after run; clear `current` on
   failure; never keep secrets in DOM longer than needed.
9. **Stale-race guards**: `refreshSeq`/`statusSeq`/`dupSeq` generation tokens;
   stale async responses never overwrite newer state.
10. **A11y**: `role="radiogroup"`, `aria-label` on dynamic buttons,
    `aria-pressed` on dup toggles, meter fill + `aria-valuenow` in sync,
    clipboard falls back to `prompt`, English-only strings.

## 5. Extension checklist

- Reuse `$, input, send, withBusy, showError/hideErrors, showResult`,
  `validate*`, `describe*` from `ui.ts`. No `any`, no `window`/`document`
  outside popup/manager, no `Buffer`, no dynamic `import()`, static imports
  only (MV3 SW must stay one file).
- Storage keys only via `StoreKey`; mutations only via background messages
  (`MessageCommand` + handler in `core.ts`); popup/manager are display-only.
- New section: sidebar button + `sec-*` + own error/result boxes +
  `hideErrors` entry + `showSection` loader + `qa.mjs` id cross-check green.

## 6. Verification (2026-09-27)

Gates: `npm test` 268 pass / 4 skip (live e2e) · `npm run lint` clean
(both tsconfigs) · `npm run build` both platforms · `npm run qa` all green
(ids, DOM-free, SW single-file, manifests, addons-linter 0 errors).

## 7. Uniformity gaps found and fixed (2026-09-27)

1. **Popup tokens incomplete** — fixed: `--ok`/`--warn` added to popup
   `:root`, `.pill.ok/.warn`/`.warning`/`.undo` now use `var()` like the
   manager. Rule: new pages must define the full token set in `:root`.
2. **Dead `official`/`custom` classes** — fixed: `.badge.official`
   (solid border) defined in both CSS files; custom keeps the default
   dashed badge. Rule: every class assigned in `ui.ts` must exist in both
   page stylesheets.
3. **Dead dup CSS in popup** — fixed: `.dup-group` rules removed from
   `popup.css` (popup never renders duplicates). Rule: don't copy
   component CSS to pages that don't render the component.
4. **SPEC drift** — fixed: `docs/SPEC.md §7` now says `validateSwitch`
   asks confirm only in `new` mode, matching code + `tests/ui.test.ts`.
   Rule: spec sentences about validators must match `ui.ts` + tests.
5. **Asymmetric result boxes** (no code change, rule only): `.result`/
   `.preview` exist only in manager; popup merge preview uses
   `window.confirm` text (popup must stay small). Any new popup outcome
   needing persistent evidence must port `.result` over, not invent a new
   style.
