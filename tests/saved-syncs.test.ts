import { describe, expect, it } from 'vitest';
import {
  canonicalServiceUrl,
  findSavedSync,
  isActiveSavedSync,
  removeSavedSync,
  sanitizeSavedSyncs,
  sameSavedSync,
  savedSyncKey,
  savedSyncName,
  serviceHost,
  shortSyncId,
  sortSavedSyncs,
  upsertSavedSync,
  type SavedSync,
} from '../src/shared/saved-syncs';

const row = (over: Partial<SavedSync> = {}): SavedSync => ({
  serviceUrl: 'https://api.xbrowsersync.org/',
  syncId: 'aaaa-bbbb',
  lastUsedAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

describe('saved syncs registry', () => {
  it('upserts a new row and sorts most recently used first', () => {
    const list = upsertSavedSync([], row());
    const withOlder = upsertSavedSync(
      list,
      row({ serviceUrl: 'https://other.test/', syncId: 'cccc', lastUsedAt: '2026-10-20T09:00:00.000Z' }),
    );
    expect(withOlder.map((r) => r.syncId)).toEqual(['aaaa-bbbb', 'cccc']);
    expect(withOlder[0].lastUsedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('dedupes by canonical URL + sync id and keeps the previous label', () => {
    const first = upsertSavedSync([], row({ label: 'Lavoro', syncVersion: '1.8.0' }));
    // Trailing slash / case differences in the URL are the same service.
    const second = upsertSavedSync(first, row({ serviceUrl: 'https://API.xbrowsersync.org', lastUsedAt: '2026-10-21T08:00:00.000Z' }));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      serviceUrl: 'https://api.xbrowsersync.org/',
      label: 'Lavoro',
      syncVersion: '1.8.0',
      lastUsedAt: '2026-10-21T08:00:00.000Z',
    });
  });

  it('keeps the same sync id on two services as two rows', () => {
    const list = upsertSavedSync(upsertSavedSync([], row()), row({ serviceUrl: 'https://other.test/' }));
    expect(list).toHaveLength(2);
    expect(removeSavedSync(list, { serviceUrl: 'https://other.test/', syncId: 'aaaa-bbbb' })).toHaveLength(1);
    expect(findSavedSync(list, { serviceUrl: 'https://other.test/', syncId: 'aaaa-bbbb' })?.serviceUrl).toBe(
      'https://other.test/',
    );
  });

  it('normalizes identities for matching and finds nothing for unknown rows', () => {
    expect(sameSavedSync({ serviceUrl: 'https://x.test', syncId: 's' }, { serviceUrl: 'https://x.test/', syncId: 's' })).toBe(true);
    expect(isActiveSavedSync(row(), undefined)).toBe(false);
    expect(isActiveSavedSync(row(), { serviceUrl: 'https://api.xbrowsersync.org', syncId: 'aaaa-bbbb' })).toBe(true);
    expect(findSavedSync([row()], { serviceUrl: 'https://api.xbrowsersync.org/', syncId: 'nope' })).toBeUndefined();
    expect(savedSyncKey('https://x.test', 's')).toBe('https://x.test/\ns');
  });

  it('survives rows written by older versions (invalid URL never throws)', () => {
    expect(canonicalServiceUrl('not a url')).toBe('not a url');
    expect(serviceHost('not a url')).toBe('not a url');
    expect(serviceHost('https://sync.example.org/path')).toBe('sync.example.org');
    expect(upsertSavedSync([], row({ serviceUrl: 'not a url' }))[0].serviceUrl).toBe('not a url');
  });

  it('sorts deterministically when last use ties, and names rows by label or host', () => {
    const a = row({ syncId: 'b', lastUsedAt: '2026-10-20T10:00:00.000Z' });
    const b = row({ syncId: 'a', lastUsedAt: '2026-10-20T10:00:00.000Z' });
    expect(sortSavedSyncs([a, b]).map((r) => r.syncId)).toEqual(['a', 'b']);
    expect(savedSyncName(row({ label: '  Lavoro  ' }))).toBe('Lavoro');
    expect(savedSyncName(row())).toBe('api.xbrowsersync.org');
  });

  it('shortens sync ids for lists (the full id stays copyable elsewhere)', () => {
    expect(shortSyncId('432a397288db410e9f733e5dbda9d4af')).toBe('432a39…d4af');
    expect(shortSyncId('12345678-90ab-cdef')).toBe('123456…cdef');
    expect(shortSyncId('short')).toBe('short');
  });

  it('drops garbage rows instead of trusting the stored shape', () => {
    expect(sanitizeSavedSyncs(undefined)).toEqual([]);
    expect(sanitizeSavedSyncs('nope')).toEqual([]);
    expect(sanitizeSavedSyncs({ syncId: 'x' })).toEqual([]);

    const list = sanitizeSavedSyncs([
      null,
      42,
      { serviceUrl: 'https://a.test', syncId: '' },
      { serviceUrl: '', syncId: 'no-service' },
      { serviceUrl: 'https://old.test', syncId: 'old', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { serviceUrl: 'https://new.test', syncId: 'new', label: '  ', syncVersion: 3, lastUsedAt: 7 },
    ]);
    expect(list.map((r) => r.syncId)).toEqual(['old', 'new']);
    // Canonicalized, unknown/typed fields dropped, missing timestamp last.
    expect(list[1]).toEqual({ serviceUrl: 'https://new.test/', syncId: 'new', lastUsedAt: '' });
    expect(list[0]).toMatchObject({ serviceUrl: 'https://old.test/', syncId: 'old' });
  });

  it('keeps a valid label and version when they are present', () => {
    const [entry] = sanitizeSavedSyncs([
      { serviceUrl: 'https://x.test', syncId: 's', label: 'Lavoro', syncVersion: '1.8.0', lastUsedAt: 't' },
    ]);
    expect(entry).toEqual({
      serviceUrl: 'https://x.test/',
      syncId: 's',
      label: 'Lavoro',
      syncVersion: '1.8.0',
      lastUsedAt: 't',
    });
  });
});
