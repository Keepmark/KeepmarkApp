// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { MessageCommand } from '../src/shared/messages';

const harness = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('webextension-polyfill', () => ({ default: {
  storage: { onChanged: { addListener: vi.fn() } },
} }));
vi.mock('../src/manager/connect-qr', () => ({ ConnectQrController: class {
  close() {} updateStatus() {}
} }));
vi.mock('../src/popup/ui', async (original) => ({
  ...await original<object>(), send: harness.send,
  initI18n: async () => undefined, renderStatusCard: () => undefined,
}));
const el = (id: string) => document.getElementById(id)!;
const field = (id: string, value: string) => {
  (el(id) as HTMLInputElement).value = value;
  el(id).dispatchEvent(new Event('input', { bubbles: true }));
};
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
const openSyncs = async () => {
  (document.querySelector('#sidebar button[data-section="syncs"]') as HTMLButtonElement).click();
  await settle();
};
const openAdd = async () => {
  (el('m-btn-add-sync') as HTMLButtonElement).click();
  await settle();
};
const chooseExisting = async () => {
  const existing = document.querySelector<HTMLInputElement>('input[name="m-link-mode"][value="existing"]')!;
  existing.checked = true;
  existing.dispatchEvent(new Event('change'));
  await settle();
};

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = readFileSync('src/manager.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  HTMLElement.prototype.scrollIntoView = vi.fn();
  harness.send.mockReset().mockImplementation(async (msg) => {
    switch (msg.command) {
      case MessageCommand.GetServices: return [];
      case MessageCommand.ProbeService: return { reachable: true, versionCompatible: true, version: '1.1.13', status: 1 };
      case MessageCommand.GetStatus: return { syncEnabled: true, serviceUrl: 'https://old.test', syncId: 'old', queueLength: 0, syncing: false, supportsV12: true, bookmarkCount: 3 };
      case MessageCommand.GetSavedSyncs: return {
        syncs: [{ serviceUrl: 'https://old.test', syncId: 'old', lastUsedAt: '2026-10-20T10:00:00.000Z' }],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: false,
      };
      case MessageCommand.CheckSyncTarget: return { reachable: true, versionCompatible: true, localCount: 3, remoteExists: true };
      case MessageCommand.PreviewMerge: return { localOnly: 1, remoteOnly: 2, localCount: 3, remoteCount: 4, titleConflicts: 0 };
      case MessageCommand.LinkSync: return { id: 'new-id' };
      case MessageCommand.ConnectNew: return { id: 'new-id', bookmarkCount: 3 };
      case MessageCommand.RemoveSavedSync: return { removed: true, unlinked: true };
      default: return null;
    }
  });
  await import('../src/manager/manager');
  await settle();
  await openSyncs();
  el('m-link-url-label').closest('.service-picker')!.querySelector<HTMLInputElement>('input[value="custom"]')!.click();
  field('m-link-url', 'https://target.test');
  el('m-link-url-check').click(); await settle();
});

it('keeps the add form hidden until requested and cancels it', async () => {
  expect(el('m-link-form').hidden).toBe(true);
  await openAdd();
  expect(el('m-link-form').hidden).toBe(false);
  expect(el('m-btn-add-sync').hidden).toBe(true);
  el('m-btn-add-cancel').click();
  expect(el('m-link-form').hidden).toBe(true);
  expect(el('m-btn-add-sync').hidden).toBe(false);
});

it('creates a new sync from the live bookmarks and reports the uploaded count', async () => {
  await openAdd();
  field('m-link-password', 'password123');
  field('m-link-confirm', 'password123');
  el('m-btn-link-direct').click(); await settle();
  const call = harness.send.mock.calls.find(([m]) => m.command === MessageCommand.ConnectNew)?.[0];
  expect(call).toMatchObject({ serviceUrl: 'https://target.test', password: 'password123' });
  expect(call.label).toBe('target.test');
  expect(el('m-link-form').hidden).toBe(true);
  expect(el('m-syncs-result').textContent).toContain('3');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.CheckSyncTarget)).toBe(false);
});

it('warns about a pending conflict but still creates the sync', async () => {
  harness.send.mockImplementation(async (msg) => {
    switch (msg.command) {
      case MessageCommand.GetStatus:
        return { syncEnabled: true, serviceUrl: 'https://old.test', syncId: 'old', queueLength: 0, syncing: false, supportsV12: true, bookmarkCount: 3, conflict: true };
      case MessageCommand.GetSavedSyncs:
        return {
          syncs: [{ serviceUrl: 'https://old.test', syncId: 'old' }],
          active: { serviceUrl: 'https://old.test', syncId: 'old' },
          switchLockSet: false,
        };
      case MessageCommand.ConnectNew: return { id: 'new-id', bookmarkCount: 2 };
      default: return null;
    }
  });
  el('m-btn-refresh').click(); await settle();
  await openAdd();
  expect(el('m-link-conflict').hidden).toBe(false);
  expect((el('m-btn-link-direct') as HTMLButtonElement).disabled).toBe(false);
  field('m-link-password', 'password123');
  field('m-link-confirm', 'password123');
  el('m-btn-link-direct').click(); await settle();
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.ConnectNew)).toBe(true);
});

it('runs the existing-sync review while linked and executes from it', async () => {
  await openAdd();
  await chooseExisting();
  field('m-link-id', 'target-id');
  field('m-link-password', 'password123');
  el('m-btn-link-check').click(); await settle();
  expect(el('link-step2').hidden).toBe(false);
  expect(el('link-implication').textContent).toContain('old');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.LinkSync)).toBe(false);
  el('m-btn-link').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.LinkSync)).toHaveLength(1);
  expect(el('m-link-form').hidden).toBe(true);
});

it('rejects stale checks after a password edit and requires another review', async () => {
  await openAdd();
  await chooseExisting();
  field('m-link-id', 'target-id');
  field('m-link-password', 'password123');
  let resolve!: (value: unknown) => void;
  harness.send.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  el('m-btn-link-check').click();
  field('m-link-password', 'different123');
  resolve({ reachable: true, versionCompatible: true }); await settle();
  expect(el('link-step2').hidden).toBe(true);
  expect((el('m-btn-link') as HTMLButtonElement).disabled).toBe(true);
});

it('verifies the password for an existing target before revealing its final action', async () => {
  await openAdd();
  await chooseExisting();
  field('m-link-id', 'target-id');
  field('m-link-password', 'password123');
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.CheckSyncTarget) return { reachable: true, remoteExists: true, versionCompatible: true };
    if (msg.command === MessageCommand.PreviewMerge) throw new Error('Wrong password');
    return null;
  });
  el('m-btn-link-check').click(); await settle();
  expect(el('link-step2').hidden).toBe(true);
  expect(el('link-error').textContent).toBe('Wrong password');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.LinkSync)).toBe(false);
});

it('asks once before deleting the server sync from the active row', async () => {
  el('m-syncs-delete-0').click(); await settle();
  el('m-syncs-delete-0-yes').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.DeleteRemoteSync)).toHaveLength(1);
  expect(document.querySelector('#m-syncs-delete-0-confirm')).toBeNull();
});

it('removes the active row with a message that names the unlink', async () => {
  el('m-syncs-rm-0').click(); await settle();
  const prompt = document.getElementById('m-syncs-rm-0-confirm')!;
  expect(prompt.textContent).toContain('unlink this browser');
  el('m-syncs-rm-0-yes').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.RemoveSavedSync)).toHaveLength(1);
  expect(el('m-syncs-result').textContent).toContain('no longer linked');
});

it('changes direction within the verified review without asking to check again', async () => {
  await openAdd();
  await chooseExisting();
  field('m-link-id', 'target-id');
  field('m-link-password', 'password123');
  el('m-btn-link-check').click(); await settle();
  const checks = harness.send.mock.calls.length;
  const merge = document.querySelector<HTMLInputElement>('input[name="m-link-direction"][value="merge"]')!;
  merge.checked = true; merge.dispatchEvent(new Event('change'));
  expect(el('link-step2').hidden).toBe(false);
  expect(harness.send.mock.calls).toHaveLength(checks);
  expect(el('link-merge-counts').textContent).toContain('1');
  expect(el('link-implication').textContent).toContain('may return');
  el('m-btn-link').click(); await settle();
  expect(harness.send.mock.calls.find(([m]) => m.command === MessageCommand.LinkSync)?.[0]).toMatchObject({ link: { direction: 'merge' } });
});

it('restores a verified backup directly from its consequences without another prompt', async () => {
  const file = new File(['synthetic-backup'], 'backup.json');
  Object.defineProperty(el('m-import-file'), 'files', { value: [file], configurable: true });
  el('m-import-file').dispatchEvent(new Event('change'));
  field('m-import-password', 'backup-secret');
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.PreviewBackup) return { count: 12 };
    if (msg.command === MessageCommand.ImportBackup) return { count: 12, safety: 'saved' };
    if (msg.command === MessageCommand.GetSafetyList) return [];
    return null;
  });
  el('m-btn-import-check').click(); await settle();
  expect(el('m-import-preview').textContent).toContain('12');
  expect(el('m-import-preview').textContent).toContain('other devices');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.ImportBackup)).toBe(false);
  el('m-btn-import-confirm').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.ImportBackup)).toHaveLength(1);
  expect(document.querySelector('#m-btn-import-confirm-confirm')).toBeNull();
});
