// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  },
}));

import {
  contractGate,
  describeMoveResult,
  describeUndo,
  formatBytes,
  renderStatusCard,
  validateConnect,
  validatePasswordChange,
  validateSwitch,
  withBusy,
} from '../src/popup/ui';
import type { StatusResponse } from '../src/shared/messages';

function mountCard(prefix: string, withCount: boolean): void {
  document.body.innerHTML = `
    <span id="${prefix}-pill"></span>
    <span id="${prefix}-service-badge"></span>
    <dd id="${prefix}-server"></dd>
    <dd id="${prefix}-swversion"></dd>
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

  it('prefers Offline over Syncing when queued but unreachable', () => {
    renderStatusCard('t', { status: { ...linked(), syncing: true, queueLength: 2 }, ping: { reachable: false } });
    expect(document.getElementById('t-pill')!.textContent).toBe('Offline');
  });

  it('contract suffix falls back to the stored flag when offline', () => {
    renderStatusCard('t', { status: { ...linked(), supportsV12: true }, ping: undefined });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service · API v1.2');
    renderStatusCard('t', { status: { ...linked(), supportsV12: true }, ping: { reachable: true, supportsV12: false } });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service');
  });

  it('works without max size and without the count element', () => {
    mountCard('x', false);
    renderStatusCard('x', { status: linked(), ping: { reachable: true } });
    expect(document.getElementById('x-space')!.textContent).toBe('152.3 KB');
    expect(document.getElementById('x-pill')!.textContent).toBe('Synced');
  });

  it('tags the v1.2 contract on the badge, legacy badge unchanged', () => {
    renderStatusCard('t', { status: linked(), ping: { reachable: true, supportsV12: true } });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service · API v1.2');
    renderStatusCard('t', { status: linked(), ping: { reachable: true } });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service');
    renderStatusCard('t', { status: linked(), ping: { reachable: true, supportsV12: false } });
    expect(document.getElementById('t-service-badge')!.textContent).toBe('Official service');
  });

  it('shows the service version when the row exists, ignores its absence', () => {
    // Old mounts without the row keep working (no throw).
    renderStatusCard('t', { status: { ...linked(), serviceVersion: '1.2.0' }, ping: { reachable: true } });
    document.body.innerHTML = `
      <span id="v-pill"></span><span id="v-service-badge"></span>
      <dd id="v-server"></dd><dd id="v-swversion"></dd><dd><code id="v-syncid"></code></dd>
      <dd id="v-last"></dd><div><div id="v-space-fill"></div></div><span id="v-space"></span>
    `;
    renderStatusCard('v', { status: { ...linked(), serviceVersion: '1.2.0' }, ping: { reachable: true } });
    expect(document.getElementById('v-swversion')!.textContent).toBe('1.2.0');
    renderStatusCard('v', { status: linked(), ping: { reachable: true, version: '1.1.13' } });
    expect(document.getElementById('v-swversion')!.textContent).toBe('1.1.13');
    renderStatusCard('v', { status: { ...linked(), syncEnabled: false }, ping: undefined });
    expect(document.getElementById('v-swversion')!.textContent).toBe('—');
  });
});

describe('contractGate (v1.2-only UI)', () => {
  it('enables only on v1.2, with badge and no hint', () => {
    const g = contractGate({ liveV12: true, storedV12: false, syncEnabled: true });
    expect(g.enabled).toBe(true);
    expect(g.title).toBe('');
    expect(g.hintHidden).toBe(true);
    expect(g.badge).toBe('API v1.2');
  });

  it('live probe wins over a stale stored flag', () => {
    expect(contractGate({ liveV12: false, storedV12: true, syncEnabled: true }).enabled).toBe(false);
    expect(contractGate({ liveV12: true, storedV12: false, syncEnabled: true }).enabled).toBe(true);
  });

  it('offline falls back to the stored link flag', () => {
    expect(contractGate({ liveV12: undefined, storedV12: true, syncEnabled: true }).enabled).toBe(true);
    expect(contractGate({ liveV12: undefined, storedV12: false, syncEnabled: true }).enabled).toBe(false);
  });

  it('legacy disables with the reason and shows the hint', () => {
    const g = contractGate({ liveV12: false, storedV12: false, syncEnabled: true });
    expect(g.enabled).toBe(false);
    expect(g.title).toBe('Not supported (requires service v1.2)');
    expect(g.hintHidden).toBe(false);
    expect(g.badge).toBe('API v1.1');
  });

  it('never probed counts as legacy (old links)', () => {
    const g = contractGate({ liveV12: undefined, storedV12: undefined, syncEnabled: true });
    expect(g.enabled).toBe(false);
    expect(g.title).toContain('Not supported');
  });

  it('unlinked hides hint and badge', () => {
    const g = contractGate({ liveV12: false, storedV12: false, syncEnabled: false });
    expect(g.hintHidden).toBe(true);
    expect(g.badge).toBe('');
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

  it('keeps a pre-disabled (gated) button disabled', async () => {
    // Regression: gated buttons (v1.2 delete, move preview lock) must not
    // be force-enabled by the busy wrapper.
    const btn = document.getElementById('btn-busy') as HTMLButtonElement;
    btn.disabled = true;
    await withBusy('btn-busy', 'Working…', async () => {
      expect(btn.disabled).toBe(true);
    });
    expect(btn.disabled).toBe(true);
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
    for (const kind of ['connect-new', 'connect-pull', 'connect-push', 'connect-merge', 'switch-new', 'switch-pull', 'switch-push', 'switch-merge', 'change-password', 'restore', 'import']) {
      const text = describeUndo(kind, 42, 0);
      expect(text).toContain('42 bookmarks');
      expect(text).toContain('Undo restores');
    }
    expect(describeUndo('connect-pull', undefined, 0)).not.toContain('bookmarks)');
  });
});

describe('describeMoveResult', () => {
  it('names mode, direction and target in all four outcomes', () => {
    expect(
      describeMoveResult({ mode: 'new', direction: 'push', newServiceUrl: 'https://n.test/' }),
    ).toBe('Move complete — created a new sync on https://n.test/ and uploaded your bookmarks.');
    expect(
      describeMoveResult({ mode: 'existing', direction: 'push', newServiceUrl: 'https://n.test/', syncId: 's1' }),
    ).toBe('Move complete — overwrote the remote sync s1 on https://n.test/ with your local bookmarks.');
    expect(
      describeMoveResult({ mode: 'existing', direction: 'merge', newServiceUrl: 'https://n.test/', syncId: 's1' }),
    ).toBe(
      'Move complete — merged your local bookmarks with the remote sync s1 on https://n.test/ (nothing deleted).',
    );
    expect(
      describeMoveResult({ mode: 'existing', direction: 'pull', newServiceUrl: 'https://n.test/', syncId: 's1' }),
    ).toBe('Move complete — replaced your local bookmarks with the remote sync s1 from https://n.test/.');
  });
  it('states the uploaded count when known', () => {
    expect(
      describeMoveResult({ mode: 'new', direction: 'push', newServiceUrl: 'https://n.test/', bookmarkCount: 2088 }),
    ).toBe('Move complete — created a new sync on https://n.test/ and uploaded 2088 bookmarks.');
  });
});

describe('validateConnect (foolproof rules)', () => {
  const base = {
    mode: 'existing' as const,
    direction: 'pull' as const,
    serviceUrl: 'https://api.xbrowsersync.org',
    syncId: 'id',
    password: 'pw',
    confirm: '',
    pushConfirmed: false,
  };
  it('pull default passes with id + password', () => {
    expect(validateConnect(base)).toBeNull();
  });
  it('rejects bad service URLs', () => {
    expect(validateConnect({ ...base, serviceUrl: 'not a url' })).toBe('Service URL is not a valid URL.');
    expect(validateConnect({ ...base, serviceUrl: 'http://example.com/' })).toBe(
      'Service URL must use https (http is allowed only for localhost).',
    );
    expect(validateConnect({ ...base, serviceUrl: 'http://localhost:8090' })).toBeNull();
  });
  it('trims a whitespace-only sync id', () => {
    expect(validateConnect({ ...base, syncId: '   ' })).toBe('Sync ID is required for an existing sync.');
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
  it('merge needs no push confirmation (it never overwrites)', () => {
    expect(validateConnect({ ...base, direction: 'merge' })).toBeNull();
    expect(validateConnect({ ...base, direction: 'merge', syncId: '' })).toBe(
      'Sync ID is required for an existing sync.',
    );
  });
});

describe('validateSwitch', () => {
  it('requires url + password, confirm always, id for existing', () => {
    expect(validateSwitch({ mode: 'new', newServiceUrl: '', syncId: '', newPassword: '', confirm: '' })).toBe(
      'Service URL is required.',
    );
    expect(validateSwitch({ mode: 'new', newServiceUrl: 'ftp://x/', syncId: '', newPassword: 'a', confirm: 'a' })).toBe(
      'Service URL must use https (http is allowed only for localhost).',
    );
    expect(
      validateSwitch({ mode: 'new', newServiceUrl: 'https://x/', syncId: '', newPassword: 'a', confirm: 'b' }),
    ).toBe('Passwords do not match.');
    expect(
      validateSwitch({ mode: 'existing', newServiceUrl: 'https://x/', syncId: '  ', newPassword: 'a', confirm: 'a' }),
    ).toBe('Sync ID is required for an existing sync.');
    expect(
      validateSwitch({ mode: 'existing', newServiceUrl: 'https://x/', syncId: 'id', newPassword: 'a', confirm: 'b' }),
    ).toBeNull(); // existing verifies by decrypting: typo fails safely, no confirmation asked
    expect(
      validateSwitch({ mode: 'existing', newServiceUrl: 'https://x/', syncId: 'id', newPassword: '', confirm: '' }),
    ).toBe('The target sync password is required.');
    expect(
      validateSwitch({ mode: 'new', newServiceUrl: 'https://x/', syncId: '', newPassword: 'a', confirm: 'a' }),
    ).toBeNull();
  });
});

describe('validatePasswordChange', () => {
  const base = { current: 'old-pw', next: 'new-pw', confirm: 'new-pw' };
  it('passes when everything lines up', () => {
    expect(validatePasswordChange(base)).toBeNull();
  });
  it('requires the current password first', () => {
    expect(validatePasswordChange({ ...base, current: '' })).toBe('Current password is required.');
  });
  it('requires a new password', () => {
    expect(validatePasswordChange({ ...base, next: '', confirm: '' })).toBe('A new password is required.');
  });
  it('rejects reusing the current password', () => {
    expect(validatePasswordChange({ current: 'same', next: 'same', confirm: 'same' })).toBe(
      'The new password must be different from the current one.',
    );
  });
  it('requires the confirmation to match', () => {
    expect(validatePasswordChange({ ...base, confirm: 'typo' })).toBe('New passwords do not match.');
  });
});
