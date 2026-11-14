import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCommand } from '../src/shared/messages';

const harness = vi.hoisted(() => ({
  handleMessage: vi.fn(async (_message: unknown) => ({ synthetic: 'result' })),
  listener: undefined as undefined | ((message: unknown, sender: { id?: string; url?: string }) => unknown),
}));
vi.mock('webextension-polyfill', () => ({ default: {
  bookmarks: {}, storage: { local: {} },
  runtime: {
    id: 'keepmark-test', getURL: (path: string) => `moz-extension://test-origin/${path}`,
    onMessage: { addListener: (listener: typeof harness.listener) => { harness.listener = listener; } },
    onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
  },
} }));
vi.mock('@platform/adapter', () => ({ makeAdapter: vi.fn(() => ({})) }));
vi.mock('../src/background/core', () => ({ BackgroundCore: class {
  handleMessage = harness.handleMessage;
  startup = vi.fn(async () => undefined);
} }));

beforeAll(async () => { await import('../src/background/background'); });
beforeEach(() => { harness.handleMessage.mockClear(); });

describe('live background onMessage QR routing', () => {
  const request = { command: MessageCommand.PrepareConnectQr, switchPassword: 'synthetic-only' };
  it('routes authorized manager requests to core', async () => {
    const result = await harness.listener!(request, { id: 'keepmark-test', url: 'moz-extension://test-origin/manager.html?section=status' });
    expect(result).toEqual({ ok: true, data: { synthetic: 'result' } });
    expect(harness.handleMessage).toHaveBeenCalledWith(request);
  });
  it.each([{}, { id: 'keepmark-test', url: 'https://web.test/manager.html' }, { id: 'keepmark-test', url: 'moz-extension://test-origin/popup.html' }])('rejects sender before invoking core: %j', async (sender) => {
    expect(await harness.listener!(request, sender)).toMatchObject({ ok: false });
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });
  it('keeps ordinary message routing intact', async () => {
    const message = { command: MessageCommand.GetStatus };
    expect(await harness.listener!(message, {})).toEqual({ ok: true, data: { synthetic: 'result' } });
    expect(harness.handleMessage).toHaveBeenCalledWith(message);
  });
  it('handles theme messages without passing them to core', async () => {
    expect(await harness.listener!({ type: 'km-theme', dark: true }, {})).toBeUndefined();
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });
});
