// Curated public services plus locally remembered, successfully linked custom services.
export interface ServiceOption {
  url: string;
  location?: string;
  maxSyncSize?: number;
  version?: string;
  saved?: boolean;
}

export const PublicServices: readonly ServiceOption[] = [
  { url: 'https://api.xbrowsersync.org/', location: 'GB', maxSyncSize: 1048576, version: '1.1.13' },
  { url: 'https://xbrowsersync.freerangecloud.com/', location: 'CA', maxSyncSize: 10240000, version: '1.1.13' },
  { url: 'https://sync.adminforge.de/', location: 'DE', maxSyncSize: 5120000, version: '1.1.13' },
  { url: 'https://xbs.eris.cc/', location: 'DE', maxSyncSize: 5242880, version: '1.1.13' },
  { url: 'https://xbsapi.cgrx.de/', location: 'DE', maxSyncSize: 10240000, version: '1.1.13' },
  { url: 'https://xsync.nixnet.services/', location: 'DE', maxSyncSize: 10485760, version: '1.1.13' },
  { url: 'https://xbs.25mb.co.uk/', location: 'GB', maxSyncSize: 1048576, version: '1.1.13' },
  { url: 'https://sync.marksync.org/', location: 'IT', maxSyncSize: 1048576, version: '1.1.13' },
];

/** Canonical identity preserves reverse-proxy paths, rejects credentials/query/fragment. */
export function normalizeServiceUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid HTTPS service URL');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

export function mergeServiceCatalog(saved: readonly ServiceOption[] = []): ServiceOption[] {
  const entries = PublicServices.map(entry => ({ ...entry }));
  const seen = new Set(entries.map(entry => normalizeServiceUrl(entry.url)));
  for (const entry of Array.isArray(saved) ? saved : []) {
    try {
      const url = normalizeServiceUrl(entry.url);
      if (seen.has(url)) continue;
      seen.add(url);
      entries.push({ ...entry, url, saved: true });
    } catch { /* Ignore invalid old storage rows. */ }
  }
  return entries;
}
