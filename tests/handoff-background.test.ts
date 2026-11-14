import { describe, expect, it, vi } from 'vitest';
import { BackgroundCore, type CorePorts } from '../src/background/core';
import type { NativeAdapter } from '../src/background/adapter';
import type { XSyncApiClient } from '../src/shared/api';
import { deriveKey, encryptData } from '../src/shared/crypto';
import {
  HandoffAuthFailedException, InvalidCredentialsException, ServiceOfflineException, UnexpectedResponseException,
} from '../src/shared/errors';
import { createHandoff, parseHandoffLink, redeemRequest } from '../src/shared/handoff';
import { t } from '../src/shared/i18n';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger } from '../src/shared/logging';
import { MessageCommand, type ShareLinkResult } from '../src/shared/messages';
import { parseShareLink } from '../src/shared/share-link';
import { MemoryBackend, Store, StoreKey, type SyncInfo } from '../src/shared/store';

const id = '0123456789abcdef0123456789abcdef';
const serviceUrl = 'https://sync.example.test/api';
const handoffCaps = { defaultTtlSeconds: 600, maxTtlSeconds: 3600, maxActivePerSync: 5, maxAttempts: 5, maxPayloadBytes: 4096 };

async function setup(opts: { handoff?: boolean; probeFails?: boolean } = {}) {
  const store = new Store(new MemoryBackend());
  const derived = await deriveKey('synthetic password', id, '1.8.0');
  const info: SyncInfo = { id, password: derived, serviceUrl, version: '1.8.0' };
  await store.set(StoreKey.SyncInfo, info);
  await store.set(StoreKey.SyncEnabled, true);
  await store.set(StoreKey.SavedSyncs, [{ serviceUrl, syncId: id, label: 'Laptop', lastUsedAt: '2026-11-14T00:00:00.000Z', credential: { scheme: 'plain', key: derived } }]);
  const remote = { bookmarks: await encryptData('[]', derived), version: '1.8.0', lastUpdated: 'r1' };
  const vouchers = new Map<string, { payload: string; authHash?: string; ttlSeconds?: number }>();
  const api = {
    getBookmarks: vi.fn(async () => remote),
    checkServiceV12: vi.fn(async () => {
      if (opts.probeFails) throw new ServiceOfflineException('offline');
      return { status: 1, version: '1.2.0', url: serviceUrl, capabilities: { revision: true, conditionalGet: true, delete: true, ...(opts.handoff === false ? {} : { handoff: handoffCaps }) } };
    }),
    createHandoff: vi.fn(async (_sync: string, body: { handoffId: string; payload: string; ttlSeconds?: number; authHash?: string }) => {
      vouchers.set(body.handoffId, body);
      return { expiresAt: '2026-11-14T00:10:00.000Z', codeRequired: !!body.authHash };
    }),
    redeemHandoff: vi.fn(async (handoffId: string) => {
      const v = vouchers.get(handoffId);
      if (!v) throw new Error('not found');
      vouchers.delete(handoffId);
      return v.payload;
    }),
    revokeHandoff: vi.fn(async (_sync: string, handoffId: string) => vouchers.delete(handoffId)),
  };
  const listener = { add: vi.fn(), remove: vi.fn() };
  const ports: CorePorts = {
    alarms: { schedule: vi.fn(), clear: vi.fn(), once: vi.fn(), onAlarm: vi.fn() },
    listeners: { created: listener, changed: listener, removed: listener, moved: listener },
    chrome: { setBadge: vi.fn(), notify: vi.fn(), download: vi.fn() },
  };
  const adapter = {
    readAll: vi.fn(), clearAndPopulate: vi.fn(), rebuildMappings: vi.fn(), readContainer: vi.fn(),
    removeBySyncedId: vi.fn(), addNative: vi.fn(), rootKey: vi.fn(),
  };
  const core = new BackgroundCore(store, new BookmarkIdMapper(store), new InMemoryLogger(), adapter as unknown as NativeAdapter, ports, () => api as unknown as XSyncApiClient);
  return { core, api, derived, vouchers };
}

describe('one-time shared links in the background', () => {
  it('reports the mode from capabilities.handoff and falls back when absent or unreachable', async () => {
    expect(await (await setup()).core.handleMessage({ command: MessageCommand.GetShareLinkMode })).toEqual({ oneTime: true, maxTtlSeconds: 3600 });
    expect(await (await setup({ handoff: false })).core.handleMessage({ command: MessageCommand.GetShareLinkMode })).toEqual({ oneTime: false });
    expect(await (await setup({ probeFails: true })).core.handleMessage({ command: MessageCommand.GetShareLinkMode })).toEqual({ oneTime: false });
  });

  it('creates a voucher (no key in the link), then redeems it once with the code and the sender label', async () => {
    const ctx = await setup();
    const made = await ctx.core.handleMessage({ command: MessageCommand.CreateShareLink, ttlSeconds: 3600, withCode: true }) as Extract<ShareLinkResult, { format: 2 }>;
    expect(made.format).toBe(2);
    expect(made.code).toMatch(/^\d{6}$/);
    expect(made.link).not.toContain(id);
    expect(made.link).not.toContain(encodeURIComponent(ctx.derived));
    expect(parseHandoffLink(made.link)?.codeRequired).toBe(true);
    const body = ctx.api.createHandoff.mock.calls[0]![1];
    expect(body.ttlSeconds).toBe(3600);
    expect(body.authHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(ctx.derived);
    await expect(ctx.core.handleMessage({ command: MessageCommand.RedeemShareLink, link: made.link })).rejects.toThrow(HandoffAuthFailedException);
    expect(ctx.api.redeemHandoff).not.toHaveBeenCalled();
    const got = await ctx.core.handleMessage({ command: MessageCommand.RedeemShareLink, link: made.link, code: made.code });
    expect(got).toEqual({ serviceUrl, id, key: ctx.derived, label: 'Laptop' });
    await expect(ctx.core.handleMessage({ command: MessageCommand.RedeemShareLink, link: made.link, code: made.code })).rejects.toThrow();
  });

  it('defaults to 10 minutes without a code and refuses a duration out of range', async () => {
    const ctx = await setup();
    const made = await ctx.core.handleMessage({ command: MessageCommand.CreateShareLink }) as Extract<ShareLinkResult, { format: 2 }>;
    expect(made.code).toBeUndefined();
    expect(ctx.api.createHandoff.mock.calls[0]![1]).toMatchObject({ ttlSeconds: 600 });
    expect(ctx.api.createHandoff.mock.calls[0]![1].authHash).toBeUndefined();
    await expect(ctx.core.handleMessage({ command: MessageCommand.CreateShareLink, ttlSeconds: 7200 })).rejects.toThrow(t('handoff.ttlInvalid'));
    await expect(ctx.core.handleMessage({ command: MessageCommand.CreateShareLink, ttlSeconds: 30 })).rejects.toThrow(UnexpectedResponseException);
  });

  it('falls back to the lasting link on a service without vouchers', async () => {
    const ctx = await setup({ handoff: false });
    const made = await ctx.core.handleMessage({ command: MessageCommand.CreateShareLink }) as ShareLinkResult;
    expect(made.format).toBe(1);
    expect(parseShareLink(made.link)).toEqual({ serviceUrl, id, key: ctx.derived });
    expect(ctx.api.createHandoff).not.toHaveBeenCalled();
  });

  it('revokes a voucher of a saved sync and reports one already gone', async () => {
    const ctx = await setup();
    const made = await ctx.core.handleMessage({ command: MessageCommand.CreateShareLink }) as Extract<ShareLinkResult, { format: 2 }>;
    const revoke = { command: MessageCommand.RevokeShareLink, serviceUrl, syncId: id, handoffId: made.handoffId } as const;
    expect(await ctx.core.handleMessage(revoke)).toEqual({ revoked: true });
    expect(await ctx.core.handleMessage(revoke)).toEqual({ revoked: false });
    await expect(ctx.core.handleMessage({ ...revoke, syncId: 'f'.repeat(32) })).rejects.toThrow(t('core.savedNotFound'));
    await expect(ctx.core.handleMessage({ ...revoke, handoffId: 'short' })).rejects.toThrow(t('handoff.revokeFailed'));
  });

  it('refuses a payload that does not decrypt and an invalid link', async () => {
    const ctx = await setup();
    const made = await createHandoff({ serviceUrl, id, key: ctx.derived });
    const parsed = parseHandoffLink(made.link)!;
    const { handoffId } = await redeemRequest(parsed);
    const other = await createHandoff({ serviceUrl, id, key: ctx.derived });
    ctx.vouchers.set(handoffId, { payload: other.payload });
    await expect(ctx.core.handleMessage({ command: MessageCommand.RedeemShareLink, link: made.link })).rejects.toThrow(InvalidCredentialsException);
    await expect(ctx.core.handleMessage({ command: MessageCommand.RedeemShareLink, link: 'keepmark://sync?v=2' })).rejects.toThrow(t('link.invalid'));
  });
});
