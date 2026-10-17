import { describe, expect, it } from 'vitest';
import { mergeServiceCatalog, normalizeServiceUrl, PublicServices } from '../src/shared/service-catalog';

describe('service catalog identity and saved entries', () => {
  it('keeps the current default first and deduplicates equivalent HTTPS URLs', () => {
    const services = mergeServiceCatalog([
      { url: 'HTTPS://API.XBROWSERSYNC.ORG:443' },
      { url: 'https://custom.test/service///' },
      { url: 'https://custom.test/service/' },
      { url: 'http://invalid.test/' },
    ]);
    expect(services[0].url).toBe('https://api.xbrowsersync.org/');
    expect(services).toHaveLength(9);
    expect(services.at(-1)).toEqual({ url: 'https://custom.test/service/', saved: true });
    expect(PublicServices).toHaveLength(8);
  });
  it('preserves reverse-proxy paths and rejects credentials and query data', () => {
    expect(normalizeServiceUrl('http://127.0.0.1:8090')).toBe('http://127.0.0.1:8090/');
    expect(mergeServiceCatalog(null as never)).toHaveLength(8);
    expect(normalizeServiceUrl(' https://CUSTOM.test:443/api ')).toBe('https://custom.test/api/');
    for (const url of ['http://custom.test', 'https://user:secret@custom.test', 'https://custom.test/?secret=1', 'https://custom.test/#fragment']) {
      expect(() => normalizeServiceUrl(url)).toThrow();
    }
  });
});
