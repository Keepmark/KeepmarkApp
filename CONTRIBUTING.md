# Contributing to Keepmark for browsers (KeepmarkApp)

Thank you for helping! Before a pull request can be merged, you must sign the
[Contributor License Agreement](CLA.md) (CLA).

## Why a CLA

Keepmark for browsers (KeepmarkApp) is released under the GNU GPL v3 only (GPL-3.0-only). The CLA lets the maintainer
also use contributions in other Keepmark products, including commercial ones
(for example Keepmark for Android), and relicense them in the future. You keep
the copyright on your work.

## How to sign

1. Open your pull request.
2. The **CLA Assistant** bot comments on it with a link to `CLA.md`.
3. Reply in the pull request with exactly:

   ```
   I have read the CLA Document and I hereby sign the CLA
   ```

You sign once: future pull requests from the same GitHub account are covered.
If the check does not update, comment `recheck`. Signatures are stored in
`signatures/version1/cla.json` on the `cla-signatures` branch.

## Before opening a pull request

- `npm test` and `npm run lint` pass; `npm run build` builds both browsers.
- User-facing texts go through `src/shared/i18n/` in all five languages
  (en, it, fr, es, de), wording per `docs/UI-TERMS.md`.
- Read `AGENTS.md` for module map and load-bearing contracts.

