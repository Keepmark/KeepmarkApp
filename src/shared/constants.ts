// Interop constants. Verified against api/ (v1.1.13) and app/ sources.
// Port of Keepmark.Core/XbsConstants.cs — do not change without checking
// server version routing (Accept-Version) and sync-version compatibility.

export const DefaultServiceUrl = 'https://api.xbrowsersync.org';

/** Minimum API version this client supports (mirrors app Globals.MinApiVersion). */
export const MinApiVersion = '1.1.9';

/** API version sent in the Accept-Version header. Must satisfy the server's ^1.1.3 route. */
export const ApiVersion = '1.1.13';

/** Extended contract (revision metadata, conditional GET, DELETE).
 * Sent only after the server advertises capabilities — legacy servers
 * answer 412 to it (or serve shapes without meta/capabilities). */
export const ApiVersion12 = '1.2.0';

/**
 * Sync format version advertised when creating/upgrading a sync.
 * Kept >= latest known client (1.8.0) so existing syncs are never rejected
 * by the "remote version must be <= app version" rule.
 */
export const SyncClientVersion = '1.8.0';

/** PBKDF2 iteration count used by the original JS client (crypto.service.ts). */
export const KeyDerivationIterations = 250_000;

/** AES-GCM nonce length in bytes (prepended to the ciphertext). */
export const GcmNonceLength = 16;

/** Maximum bookmark description length enforced by the original client. */
export const DescriptionMaxLength = 300;

/** Separator bookmark marker (bookmarks with this URL render as separators). */
export const SeparatorUrl = 'xbs:separator';

/** Delimiter used in QR payloads joining sync fields (reserved, not implemented yet). */
export const QrDelimiter = '|$$|';

/** Default auto-sync poll interval, mirrors the 15-minute background alarm. */
export const SyncPollIntervalMs = 15 * 60 * 1000;

/** HTTP timeout for /info probes (mirrors checkServiceStatus 3000ms). */
export const ServiceProbeTimeoutMs = 3000;

/** Default HTTP timeout for bookmark up/downloads. */
export const DefaultHttpTimeoutMs = 12000;

/**
 * Numeric dotted-version comparison ("1.1.13" > "1.1.9"; never ordinal).
 * Tolerates a leading 'v' and non-digit suffixes per part.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string): number[] =>
    v
      .replace(/^[vV]/, '')
      .split('.')
      .map((p) => {
        const m = /^(\d*)/.exec(p);
        const n = m ? parseInt(m[1] || '0', 10) : 0;
        return Number.isNaN(n) ? 0 : n;
      });
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
