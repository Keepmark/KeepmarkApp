// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  },
}));

import {
  describeUndo,
  formatBytes,
  renderStatusCard,
  validateConnect,
  validateSwitch,
  withBusy,
} from '../src/popup/ui';
import type { StatusResponse } from '../src/shared/messages';

function mountCard(prefix: string, withCount: boolean): void {
  document.body.innerHTML = `
    <span id="${prefix}-pill"></span>
    <span id="${prefix}-service-badge"></span>
    <dd id="${prefix}-server"></dd>
    <dd><code id="${prefix}-syncid"></code></dd>
    <dd id="${prefix}-last"></dd>
    <div><div id="${prefix}-space-fill"></div></div>
    <span id="${prefix}-space"></span>
    ${withCount ? `<dd id="${prefix}-count"></dd>` : ''}
    <button id="btn-busy">Go</button>
  `;
}

function linked(): StatusResponse {
  return {
    syncEnabled: true,
    syncId: 'abc-123',
    serviceUrl: 'https://api.xbrowsersync.org',
    lastUpdated: '2026-09-25T10:39:48.000Z',
    queueLength: 0,
    syncing: false,
    usedBytes: 156000,
    bookmarkCount: 2089,
  };
}

describe('status card (popup + manager share this renderer)', () => {
  beforeEach(() => mountCard('t', true));

  it('unlinked state clears every field (regression: stale id/space after unlink)', () => {
    // First render linked data, then unlink — nothing stale may survive.
    renderStatusCard('t', { status: linked(), ping: { reachable: true } });
    expect(document.getElementById('t-syncid')!.textContent).toBe('abc-123');
    renderStatusCard('t', { status: { ...linked(), syncEnabled: false }, ping: undefined });
    expect(document.getElementById('t-pill')!.textContent).toBe('Not connected');
    expect(document.getElementById('t-syncid')!.textContent).toBe('—');
    expect(document.getElementById('t-server')!.textContent).toBe('—');
    expect(document.getElementById('t-last')!.textContent).toBe('—');
    expect(document.getElementById('t-space')!.textContent).toBe('—');
    expect(document.getElementById('t-count')!.textContent).toBe('—');
    expect((document.getElementById('t-space-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('renders synced state with official badge and space bar', () => {
    renderStatusCard('t', {
      status: linked(),
      ping: { reachable: true, maxSyncSize: 1048576, remoteLastUpdated: '2026-09-25T10:39:48.000Z' },
    });
    expect(document.getElementById('t-pill')!.textContent).toBe('Synced');
    expect(document.getElementById('t-pill')!.className).toContain('ok');
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service');
    expect(document.getElementById('t-space')!.textContent).toContain('of');
    expect(document.getElementById('t-count')!.textContent).toBe('2089 bookmarks');
  });

  it('flags custom services', () => {
    renderStatusCard('t', {
      status: { ...linked(), serviceUrl: 'https://sync.example.com/' },
      ping: { reachable: true },
    });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Custom service');
  });

  it('shows Behind when the remote moved', () => {
    renderStatusCard('t', {
      status: linked(),
      ping: { reachable: true, remoteLastUpdated: '2026-09-26T00:00:00.000Z' },
    });
    expect(document.getElementById('t-pill')!.textContent).toBe('Behind');
  });

  it('shows Offline when unreachable, Checking while probing, Syncing on jobs', () => {
    renderStatusCard('t', { status: linked(), ping: { reachable: false } });
    expect(document.getElementById('t-pill')!.textContent).toBe('Offline');
    renderStatusCard('t', { status: linked(), ping: undefined });
    expect(document.getElementById('t-pill')!.textContent).toBe('Checking…');
    renderStatusCard('t', { status: { ...linked(), syncing: true }, ping: { reachable: true } });
    expect(document.getElementById('t-pill')!.textContent).toBe('Syncing…');
  });

  it('works without max size and without the count element', () => {
    mountCard('x', false);
    renderStatusCard('x', { status: linked(), ping: { reachable: true } });
    expect(document.getElementById('x-space')!.textContent).toBe('152.3 KB');
    expect(document.getElementById('x-pill')!.textContent).toBe('Synced');
  });
});

describe('withBusy', () => {
  beforeEach(() => mountCard('t', true));

  it('disables with busy label and restores afterwards', async () => {
    const btn = document.getElementById('btn-busy') as HTMLButtonElement;
    await withBusy('btn-busy', 'Working…', async () => {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe('Working…');
    });
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Go');
  });

  it('restores the button when the action throws', async () => {
    const btn = document.getElementById('btn-busy') as HTMLButtonElement;
    await expect(
      withBusy('btn-busy', 'Working…', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Go');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [156000, '152.3 KB'],
    [1048576, '1.00 MB'],
  ])('%i -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('describeUndo', () => {
  it('covers every kind with count and date', () => {
    for (const kind of ['connect-new', 'connect-pull', 'connect-push', 'switch-new', 'switch-pull', 'switch-push', 'import']) {
      const text = describeUndo(kind, 42, 0);
      expect(text).toContain('42 bookmarks');
      expect(text).toContain('Undo restores');
    }
    expect(describeUndo('connect-pull', undefined, 0)).not.toContain('bookmarks)');
  });
});

describe('validateConnect (foolproof rules)', () => {
  const base = {
    mode: 'existing' as const,
    direction: 'pull' as const,
    syncId: 'id',
    password: 'pw',
    confirm: '',
    pushConfirmed: false,
  };
  it('pull default passes with id + password', () => {
    expect(validateConnect(base)).toBeNull();
  });
  it('requires password', () => {
    expect(validateConnect({ ...base, password: '' })).toBe('Password is required.');
  });
  it('new mode requires matching confirmation', () => {
    expect(validateConnect({ ...base, mode: 'new', confirm: 'x' })).toBe('Passwords do not match.');
    expect(validateConnect({ ...base, mode: 'new', confirm: 'pw' })).toBeNull();
  });
  it('existing requires sync id', () => {
    expect(validateConnect({ ...base, syncId: '' })).toBe('Sync ID is required for an existing sync.');
  });
  it('push requires the explicit confirmation tick', () => {
    expect(validateConnect({ ...base, direction: 'push' })).toBe(
      'Tick the confirmation to overwrite the server copy.',
    );
    expect(validateConnect({ ...base, direction: 'push', pushConfirmed: true })).toBeNull();
  });
});

describe('validateSwitch', () => {
  it('requires url + password, confirm for new, id for existing', () => {
    expect(validateSwitch({ mode: 'new', newServiceUrl: '', syncId: '', newPassword: '', confirm: '' })).toBe(
      'New service URL and password are required.',
    );
    expect(
      validateSwitch({ mode: 'new', newServiceUrl: 'https://x/', syncId: '', newPassword: 'a', confirm: 'b' }),
    ).toBe('Passwords do not match.');
    expect(
      validateSwitch({ mode: 'existing', newServiceUrl: 'https://x/', syncId: '', newPassword: 'a', confirm: '' }),
    ).toBe('Sync ID is required for an existing sync.');
    expect(
      validateSwitch({ mode: 'new', newServiceUrl: 'https://x/', syncId: '', newPassword: 'a', confirm: 'a' }),
    ).toBeNull();
  });
});
