import { describe, expect, it, vi } from 'vitest';
import { XSyncApiClient } from '../src/shared/api';
import {
  HandoffAuthFailedException, HandoffLimitException, HandoffNotFoundException, HandoffUnavailableException,
  ServiceOfflineException, SyncNotFoundException,
} from '../src/shared/errors';
import { t } from '../src/shared/i18n';
import { InMemoryLogger, XbsLogLevel } from '../src/shared/logging';

const handoffId = 'tGggaQeJDZf0F3QGzcz8iro8a28lqeDJlyvuhXEP6ys';
const syncId = '0123456789abcdef0123456789abcdef';

function client(status: number, body: unknown, headers: Record<string, string> = {}) {
  const log = new InMemoryLogger();
  log.minLevel = XbsLogLevel.Verbose;
  const fetchFn = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));
  return { api: new XSyncApiClient('https://example.test/', log, fetchFn as unknown as typeof fetch), fetchFn, log };
}

describe('api client: handoff vouchers', () => {
  it('creates with the v1.2 header and never logs the voucher or sync ID', async () => {
    const { api, fetchFn, log } = client(201, { expiresAt: '2026-11-14T10:00:00.000Z', codeRequired: true });
    const body = { handoffId, payload: 'cGF5bG9hZA', ttlSeconds: 600, authHash: 'a'.repeat(64) };
    expect(await api.createHandoff(syncId, body)).toEqual({ expiresAt: '2026-11-14T10:00:00.000Z', codeRequired: true });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://example.test/bookmarks/${syncId}/handoffs`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Accept-Version']).toBe('1.2.0');
    expect(JSON.parse(init.body as string)).toEqual(body);
    const text = JSON.stringify(log.entries ?? log);
    expect(text).not.toContain(handoffId);
    expect(text).not.toContain(syncId);
  });

  it('redeems once and returns the payload', async () => {
    const { api, fetchFn } = client(200, { payload: 'cGF5bG9hZA' });
    expect(await api.redeemHandoff(handoffId, 'auth')).toBe('cGF5bG9hZA');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse((fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string)).toEqual({ auth: 'auth' });
  });

  it.each([
    [403, { code: 'HandoffAuthFailedException' }, { 'X-Handoff-Attempts-Left': '2' }, HandoffAuthFailedException, t('handoff.wrongCode', { left: 2 })],
    [403, { code: 'HandoffAuthFailedException' }, { 'X-Handoff-Attempts-Left': '0' }, HandoffNotFoundException, t('handoff.notFound')],
    [404, { code: 'HandoffNotFoundException' }, {}, HandoffNotFoundException, t('handoff.notFound')],
    [404, { code: 'NotImplementedException' }, {}, HandoffUnavailableException, t('handoff.unavailable')],
    [406, { code: 'HandoffLimitExceededException' }, {}, HandoffLimitException, t('handoff.limit')],
    [412, {}, {}, HandoffUnavailableException, t('handoff.unavailable')],
    [401, {}, {}, SyncNotFoundException, undefined],
    [503, {}, {}, ServiceOfflineException, undefined],
  ])('maps %i %j to its error', async (status, body, headers, Ctor, message) => {
    const { api, fetchFn } = client(status, body, headers);
    const result = api.redeemHandoff(handoffId);
    await expect(result).rejects.toBeInstanceOf(Ctor);
    if (message) await expect(result).rejects.toThrow(message);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('revoke: true when deleted, false when already gone', async () => {
    expect(await client(204, {}).api.revokeHandoff(syncId, handoffId)).toBe(true);
    expect(await client(404, { code: 'HandoffNotFoundException' }).api.revokeHandoff(syncId, handoffId)).toBe(false);
  });

  it('a network failure is offline (one attempt)', async () => {
    const log = new InMemoryLogger();
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const api = new XSyncApiClient('https://example.test/', log, fetchFn as unknown as typeof fetch);
    await expect(api.redeemHandoff(handoffId)).rejects.toBeInstanceOf(ServiceOfflineException);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
