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
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = readFileSync('src/manager.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  HTMLElement.prototype.scrollIntoView = vi.fn();
  harness.send.mockReset().mockImplementation(async (msg) => {
    switch (msg.command) {
      case MessageCommand.GetServices: return [];
      case MessageCommand.ProbeService: return { reachable: true, versionCompatible: true, version: '1.1.13', status: 1 };
      case MessageCommand.GetStatus: return { syncEnabled: true, serviceUrl: 'https://old.test', syncId: 'old', queueLength: 0, syncing: false, supportsV12: true, bookmarkCount: 3 };
      case MessageCommand.CheckSyncTarget: return { reachable: true, versionCompatible: true, localCount: 3, remoteExists: true };
      case MessageCommand.PreviewMerge: return { localOnly: 1, remoteOnly: 2, localCount: 3, remoteCount: 4, titleConflicts: 0 };
      case MessageCommand.LinkSync: return { syncId: 'new' };
      default: return null;
    }
  });
  await import('../src/manager/manager');
  await settle();
  el('m-link-url-label').closest('.service-picker')!.querySelector<HTMLInputElement>('input[value="custom"]')!.click();
  field('m-link-url', 'https://target.test');
  el('m-link-url-check').click(); await settle();
  field('m-link-password', 'password123');
  field('m-link-confirm', 'password123');
});
it('shows all new-sync credentials before checking, then executes from the reviewed summary', async () => {
  expect(el('link-step2').contains(el('m-link-password'))).toBe(false);
  el('m-btn-link-check').click(); await settle();
  expect(el('link-step2').hidden).toBe(false);
  expect(el('link-implication').textContent).toContain('old');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.LinkSync)).toBe(false);
  el('m-btn-link').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.LinkSync)).toHaveLength(1);
  expect(document.querySelector('#m-btn-link-confirm')).toBeNull();
});
it('rejects stale checks after a password edit and requires another review', async () => {
  let resolve!: (value: unknown) => void;
  harness.send.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  el('m-btn-link-check').click();
  field('m-link-password', 'different123');
  resolve({ reachable: true, versionCompatible: true }); await settle();
  expect(el('link-step2').hidden).toBe(true);
  expect((el('m-btn-link') as HTMLButtonElement).disabled).toBe(true);
});
it('verifies the password for an existing target before revealing its final action', async () => {
  const existing = document.querySelector<HTMLInputElement>('input[name="m-link-mode"][value="existing"]')!;
  existing.checked = true; existing.dispatchEvent(new Event('change'));
  field('m-link-id', 'target-id');
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.CheckSyncTarget) return { reachable: true, remoteExists: true, versionCompatible: true };
    if (msg.command === MessageCommand.PreviewMerge) throw new Error('Wrong password');
  });
  el('m-btn-link-check').click(); await settle();
  expect(el('link-step2').hidden).toBe(true);
  expect(el('link-error').textContent).toBe('Wrong password');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.LinkSync)).toBe(false);
});
it('asks only once before deleting the server sync', async () => {
  el('m-btn-delete-remote').click(); await settle();
  el('m-btn-delete-remote-yes').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.DeleteRemoteSync)).toHaveLength(1);
  expect(document.querySelector('#m-btn-delete-remote-confirm')).toBeNull();
});

it('changes direction within the verified review without asking to check again', async () => {
  const existing = document.querySelector<HTMLInputElement>('input[name="m-link-mode"][value="existing"]')!;
  existing.checked = true; existing.dispatchEvent(new Event('change'));
  field('m-link-id', 'target-id');
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
