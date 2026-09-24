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
