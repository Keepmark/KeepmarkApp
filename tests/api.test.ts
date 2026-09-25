import { describe, expect, it } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import {
  DailyNewSyncLimitException,
  DataOutOfSyncException,
  InvalidServiceException,
  NotAcceptingNewSyncsException,
  ServiceOfflineException,
  SyncNotFoundException,
  SyncTooLargeException,
  ThrottledException,
  UnexpectedResponseException,
  UnsupportedVersionException,
} from '../src/shared/errors';
import { InMemoryLogger, XbsLogLevel } from '../src/shared/logging';
import { compareVersions } from '../src/shared/constants';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api client', () => {
  it.each([
    [401, SyncNotFoundException],
    [404, InvalidServiceException],
    [405, NotAcceptingNewSyncsException],
    [406, DailyNewSyncLimitException],
    [409, DataOutOfSyncException],
    [412, UnsupportedVersionException],
    [413, SyncTooLargeException],
    [429, ThrottledException],
    [500, ServiceOfflineException],
    [418, ServiceOfflineException],
  ])('maps HTTP %i to %s', async (status, Ctor) => {
    const log = new InMemoryLogger();
    log.minLevel = XbsLogLevel.Verbose;
    const api = new XSyncApiClient('https://example.test/', log, (async () =>
      jsonResponse(status, { message: 'srv' })) as typeof fetch);
    await expect(api.getBookmarks('id')).rejects.toBeInstanceOf(Ctor);
  });

  it('throws UnexpectedResponse on bad shape', async () => {
    const log = new InMemoryLogger();
    const api = new XSyncApiClient('https://example.test/', log, (async () =>
      jsonResponse(200, { nope: true })) as typeof fetch);
    await expect(api.getBookmarks('id')).rejects.toBeInstanceOf(UnexpectedResponseException);
  });

  it('sends Accept-Version and parses success', async () => {
    const log = new InMemoryLogger();
    let seenVersion = '';
    const api = new XSyncApiClient(
      'https://example.test/',
      log,
      (async (url, init) => {
        seenVersion = (init?.headers as Record<string, string>)['Accept-Version'];
        return jsonResponse(200, { bookmarks: 'blob', version: '1.8.0', lastUpdated: '2024-01-01T00:00:00.000Z' });
      }) as typeof fetch,
    );
    const res = await api.getBookmarks('abc');
    expect(res.lastUpdated).toBe('2024-01-01T00:00:00.000Z');
    expect(seenVersion).toBe('1.1.13');
  });

  it('default fetch stays detached-safe (Firefox rejects unbound window fetch)', async () => {
    // Regression: the default fetchFn must be a wrapper, never the bare
    // global reference. Firefox throws "'fetch' called on an object that
    // does not implement interface Window" when fetch runs with a non-Window
    // receiver (e.g. called as a method on our client).
    const log = new InMemoryLogger();
    const api = new XSyncApiClient('https://example.test/', log);
    expect((api as unknown as { fetchFn: unknown }).fetchFn).not.toBe(globalThis.fetch);

    const realFetch = globalThis.fetch;
    let observedThis: unknown = 'not-called';
    globalThis.fetch = function (this: unknown) {
      observedThis = this;
      return Promise.resolve(jsonResponse(200, { status: 1, version: '1.1.13', maxSyncSize: 1 }));
    } as typeof fetch;
    try {
      await api.getInfo();
    } finally {
      globalThis.fetch = realFetch;
    }
    // Direct call shape: in a browser the receiver is the Window (works);
    // the old code called the bare reference as a client method (throws).
    expect(observedThis).toBeUndefined();
  });

  it('network failure becomes ServiceOffline with the cause attached', async () => {
    const log = new InMemoryLogger();
    const api = new XSyncApiClient('https://example.test/', log, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const err = await api.getInfo().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ServiceOfflineException);
    expect(err.message).toContain('fetch failed');
  });

  it('unmapped HTTP status is reported with its code', async () => {
    const log = new InMemoryLogger();
    const api = new XSyncApiClient('https://example.test/', log, (async () =>
      jsonResponse(418, { message: '' })) as typeof fetch);
    const err = await api.getInfo().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ServiceOfflineException);
    expect(err.message).toContain('418');
  });

  it('412 names the v1.2 requirement', async () => {
    const log = new InMemoryLogger();
    const api = new XSyncApiClient('https://example.test/', log, (async () =>
      jsonResponse(412, { message: '' })) as typeof fetch);
    const err: unknown = await api.deleteBookmarks('id').catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnsupportedVersionException);
    expect((err as Error).message).toContain('Not supported (requires service v1.2)');
  });
});

describe('api client v1.2', () => {
  function v12Api(
    seen: { version?: string; ifNoneMatch?: string; method?: string; path?: string },
    status: number,
    body: unknown,
  ): XSyncApiClient {
    const log = new InMemoryLogger();
    return new XSyncApiClient(
      'https://example.test/',
      log,
      (async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.version = headers['Accept-Version'];
        seen.ifNoneMatch = headers['If-None-Match'];
        seen.method = init?.method;
        seen.path = String(url).replace('https://example.test/', '');
        return jsonResponse(status, body);
      }) as typeof fetch,
    );
  }

  it('v1.2 calls pin Accept-Version 1.2.0', async () => {
    const seen: Record<string, string | undefined> = {};
    const log = new InMemoryLogger();
    const api = new XSyncApiClient(
      'https://example.test/',
      log,
      (async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.version = headers['Accept-Version'];
        seen.method = init?.method;
        seen.path = String(url).replace('https://example.test/', '');
        const path = seen.path ?? '';
        if (path === 'info') return jsonResponse(200, { status: 1, version: '1.2.0', maxSyncSize: 9 });
        if (init?.method === 'POST') {
          return jsonResponse(200, { id: 'x', lastUpdated: 't1', version: '1.8.0', meta: { revision: 1 } });
        }
        return jsonResponse(200, { bookmarks: 'b', version: '1.8.0', lastUpdated: 't1', meta: { revision: 2 } });
      }) as typeof fetch,
    );
    await api.createSyncV12();
    expect(seen.version).toBe('1.2.0');
    await api.getBookmarksV12('x');
    expect(seen.version).toBe('1.2.0');
    expect(seen.path).toBe('bookmarks/x');
    const upd = await api.updateBookmarksV12('x', 'blob', 1);
    expect(seen.version).toBe('1.2.0');
    expect(seen.method).toBe('PUT');
    expect(upd.meta?.revision).toBe(2);
    await api.getInfoV12();
    expect(seen.version).toBe('1.2.0');
  });

  it('legacy calls keep Accept-Version 1.1.13', async () => {
    const seen: Record<string, string | undefined> = {};
    const api = v12Api(seen, 200, { bookmarks: 'b', version: '1.8.0', lastUpdated: 't' });
    await api.getBookmarks('x');
    expect(seen.version).toBe('1.1.13');
    expect(seen.ifNoneMatch).toBeUndefined();
  });

  it('conditional GET sends quoted If-None-Match and maps 304 to null', async () => {
    const seen: Record<string, string | undefined> = {};
    const log = new InMemoryLogger();
    const api304 = new XSyncApiClient(
      'https://example.test/',
      log,
      (async (_url, init) => {
        seen.version = (init?.headers as Record<string, string>)['Accept-Version'];
        seen.ifNoneMatch = (init?.headers as Record<string, string>)['If-None-Match'];
        return new Response(null, { status: 304 });
      }) as typeof fetch,
    );
    await expect(api304.getBookmarksIfChanged('x', 'abc123')).resolves.toBeNull();
    expect(seen.version).toBe('1.2.0');
    expect(seen.ifNoneMatch).toBe('"abc123"');

    const api200 = v12Api(seen, 200, { bookmarks: 'b', version: '1.8.0', lastUpdated: 't2' });
    const dto = await api200.getBookmarksIfChanged('x', 'abc123');
    expect(dto?.lastUpdated).toBe('t2');
  });

  it('conditional GET surfaces 412 for legacy fallback', async () => {
    const seen: Record<string, string | undefined> = {};
    const api = v12Api(seen, 412, { message: 'nope' });
    await expect(api.getBookmarksIfChanged('x', 'h')).rejects.toBeInstanceOf(UnsupportedVersionException);
  });

  it('delete succeeds on {} and tolerates an empty body', async () => {
    const log = new InMemoryLogger();
    const apiObj = new XSyncApiClient(
      'https://example.test/',
      log,
      (async () => jsonResponse(200, {})) as typeof fetch,
    );
    await expect(apiObj.deleteBookmarks('x')).resolves.toBeUndefined();
    const apiEmpty = new XSyncApiClient(
      'https://example.test/',
      log,
      (async () => new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    );
    await expect(apiEmpty.deleteBookmarks('x')).resolves.toBeUndefined();
  });

  it('supportsV12 is true only with the revision capability', async () => {
    const log = new InMemoryLogger();
    const mk = (status: number, body: unknown): XSyncApiClient =>
      new XSyncApiClient('https://example.test/', log, (async () => jsonResponse(status, body)) as typeof fetch);
    await expect(
      mk(200, { status: 1, version: '1.2.0', maxSyncSize: 1, capabilities: { revision: true, conditionalGet: true, delete: true } }).supportsV12(),
    ).resolves.toBe(true);
    await expect(mk(200, { status: 1, version: '1.1.13', maxSyncSize: 1 }).supportsV12()).resolves.toBe(false);
    await expect(mk(412, { message: 'x' }).supportsV12()).resolves.toBe(false);
    const offline = new XSyncApiClient('https://example.test/', log, (async () => {
      throw new TypeError('down');
    }) as typeof fetch);
    await expect(offline.supportsV12()).resolves.toBe(false);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.1.13', '1.1.9', 1],
    ['1.1.9', '1.1.13', -1],
    ['1.8.0', '1.8.0', 0],
    ['v1.1.13', '1.1.13', 0],
    ['2.0', '1.99.99', 1],
  ])('%s vs %s = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
