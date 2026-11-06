// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { MessageCommand } from '../src/shared/messages';

const harness = vi.hoisted(() => ({ send: vi.fn(), storageListener: vi.fn() }));
vi.mock('webextension-polyfill', () => ({ default: {
  storage: { onChanged: { addListener: (listener: unknown) => harness.storageListener.mockImplementation(listener as never) } },
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

it('opens the add wizard in its own modal and cancels the whole task', async () => {
  const dialog = el('m-link-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(false);
  await openAdd();
  expect(dialog.open).toBe(true);
  expect(el('m-link-form').hidden).toBe(false);
  // The list stays on the page but behind the modal layer: inert, not gone.
  expect(el('m-btn-add-sync').hidden).toBe(false);
  el('m-btn-add-cancel').click();
  expect(dialog.open).toBe(false);
  expect(el('m-link-form').hidden).toBe(true);
});

it('asks the sync lock password in the same modal before revealing the wizard', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [{ serviceUrl: 'https://old.test', syncId: 'old' }],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: true,
      };
    }
    if (msg.command === MessageCommand.VerifySwitchPassword) return { ok: true };
    return null;
  });
  el('m-btn-refresh').click(); await settle();
  const dialog = el('m-link-dialog') as HTMLDialogElement;
  await openAdd();
  // One dialog: the gate is step one, the wizard is still hidden.
  expect(dialog.open).toBe(true);
  expect(el('m-link-gate').hidden).toBe(false);
  expect(el('m-link-form').hidden).toBe(true);
  field('m-link-gate-pw', 'pin');
  el('m-btn-link-gate-go').click(); await settle();
  expect(dialog.open).toBe(true);
  expect(el('m-link-gate').hidden).toBe(true);
  expect(el('m-link-form').hidden).toBe(false);
});

it('asks the sync lock password in the activation modal', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [
          { serviceUrl: 'https://old.test', syncId: 'old' },
          { serviceUrl: 'https://other.test', syncId: 'other', label: 'Altro' },
        ],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: true,
      };
    }
    if (msg.command === MessageCommand.ActivateSavedSync) return { activated: true };
    return null;
  });
  el('m-btn-refresh').click(); await settle();
  el('m-syncs-act-1').click(); await settle();
  const dialog = el('m-activate-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(el('m-syncs-pw-row').hidden).toBe(false);
  expect(el('m-syncs-activate-text').textContent).toContain('Altro');
  // No password, no switch: the error stays inside the modal.
  el('m-syncs-activate-go').click(); await settle();
  expect(el('m-activate-error').textContent).not.toBe('');
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.ActivateSavedSync)).toBe(false);
  field('m-syncs-activate-pw', 'pin');
  el('m-syncs-activate-go').click(); await settle();
  const call = harness.send.mock.calls.find(([m]) => m.command === MessageCommand.ActivateSavedSync)?.[0];
  expect(call).toMatchObject({ syncId: 'other', switchPassword: 'pin' });
  expect(dialog.open).toBe(false);
});

it('changes the active sync password from its row, without the switch lock', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.ChangePassword) return { lastUpdated: 'now' };
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [
          { serviceUrl: 'https://old.test', syncId: 'old', label: 'Lavoro' },
          { serviceUrl: 'https://other.test', syncId: 'other' },
        ],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: true,
      };
    }
    return null;
  });
  await openSyncs();
  // The password belongs to the active sync: its row owns the trigger, a
  // dormant row does not.
  const trigger = el('m-syncs-pw-0') as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  expect(document.getElementById('m-syncs-pw-1')).toBeNull();
  trigger.click(); await settle();
  const dialog = el('m-pw-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(el('m-pw-target').textContent).toContain('Lavoro');
  // No switch lock field: rotating a sync password never asks for it.
  expect(document.getElementById('m-pw-switch')).toBeNull();
  field('m-current-password', 'old password');
  field('m-new-password', 'brand new password');
  field('m-new-password-confirm', 'brand new password');
  (el('m-btn-password-go') as HTMLButtonElement).click(); await settle();
  const call = harness.send.mock.calls.find(([m]) => m.command === MessageCommand.ChangePassword)?.[0];
  expect(call).toEqual({
    command: MessageCommand.ChangePassword,
    currentPassword: 'old password',
    newPassword: 'brand new password',
  });
  expect(dialog.open).toBe(false);
  expect(el('m-syncs-result').hidden).toBe(false);
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

it('focuses the name field when a remembered service hides the URL input', async () => {
  // The picker hides the custom-URL label (not the input): focusing the URL
  // would leave the caret on the page body, so a name typed right after
  // opening the form would silently go nowhere and the host would be saved.
  (el('m-link-url').closest('label') as HTMLElement).hidden = true;
  await openAdd();
  const name = el('m-link-name') as HTMLInputElement;
  expect(document.activeElement).toBe(name);
  // The suggestion is selected: typing replaces it instead of appending.
  expect(name.selectionEnd).toBe(name.value.length);
  field('m-link-name', 'Casa mia');
  field('m-link-password', 'password123');
  field('m-link-confirm', 'password123');
  el('m-btn-link-direct').click(); await settle();
  const call = harness.send.mock.calls.find(([m]) => m.command === MessageCommand.ConnectNew)?.[0];
  expect(call.label).toBe('Casa mia');
  expect(el('m-link-form').hidden).toBe(true);
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
  const dialog = el('m-row-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(el('m-row-message').textContent).not.toBe('');
  // Destructive: the initial focus is Cancel, never the red button.
  expect(document.activeElement).toBe(el('m-btn-row-cancel'));
  el('m-btn-row-go').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.DeleteRemoteSync)).toHaveLength(1);
  expect(dialog.open).toBe(false);
});

it('unlinks the active row with the canonical "Unlink this device" wording', async () => {
  el('m-syncs-rm-0').click(); await settle();
  const dialog = el('m-row-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(el('m-row-title').textContent).toBe('Unlink this device');
  expect(el('m-row-message').textContent).toContain('Unlink this device from');
  el('m-btn-row-go').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.RemoveSavedSync)).toHaveLength(1);
  expect(el('m-syncs-result').textContent).toContain('unlinked');
});

it('warns above the fields when a reset loses the inactive syncs', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [
          { serviceUrl: 'https://old.test', syncId: 'old' },
          { serviceUrl: 'https://other.test', syncId: 'other', label: 'Altro' },
        ],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: true,
      };
    }
    return null;
  });
  el('m-btn-refresh').click(); await settle();
  el('m-btn-link-lock-reset').click(); await settle();
  const dialog = el('m-lock-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  const warning = el('m-lock-warning');
  expect(warning.hidden).toBe(false);
  expect(el('m-lock-warning-text').textContent).toContain('1 forgotten');
  // The consequence is read before typing: it precedes the form in the DOM.
  expect(warning.compareDocumentPosition(el('m-lock-form')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Reset mints a new vault, so the old password is not asked.
  expect(el('m-lock-current-row').hidden).toBe(true);
  expect(el('m-link-lock-new').hidden).toBe(false);
});

it('keeps the warning hidden for a plain change of the sync lock', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [{ serviceUrl: 'https://old.test', syncId: 'old' }],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: true,
      };
    }
    return null;
  });
  el('m-btn-refresh').click(); await settle();
  el('m-btn-link-lock-change').click(); await settle();
  expect((el('m-lock-dialog') as HTMLDialogElement).open).toBe(true);
  expect(el('m-lock-warning').hidden).toBe(true);
  expect(el('m-lock-warning-text').textContent).toBe('');
});

it('renames a row in the same modal, with the name selected', async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSavedSyncs) {
      return {
        syncs: [{ serviceUrl: 'https://old.test', syncId: 'old', label: 'Casa' }],
        active: { serviceUrl: 'https://old.test', syncId: 'old' },
        switchLockSet: false,
      };
    }
    if (msg.command === MessageCommand.RenameSavedSync) return { renamed: true };
    return null;
  });
  el('m-btn-refresh').click(); await settle();
  el('m-syncs-rename-0').click(); await settle();
  const dialog = el('m-row-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect((el('m-row-field') as HTMLInputElement).value).toBe('Casa');
  field('m-row-field', 'Ufficio');
  el('m-btn-row-go').click(); await settle();
  const call = harness.send.mock.calls.find(([m]) => m.command === MessageCommand.RenameSavedSync)?.[0];
  expect(call).toMatchObject({ label: 'Ufficio' });
  expect(dialog.open).toBe(false);
});

it('never keeps two sync tasks open at once', async () => {
  el('m-syncs-rm-0').click(); await settle();
  expect((el('m-row-dialog') as HTMLDialogElement).open).toBe(true);
  // Opening the add task closes the row task first: one operation at a time.
  el('m-btn-add-sync').click(); await settle();
  expect((el('m-row-dialog') as HTMLDialogElement).open).toBe(false);
  expect((el('m-link-dialog') as HTMLDialogElement).open).toBe(true);
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
  // Choosing the file opens the restore task with its name.
  expect((el('m-import-dialog') as HTMLDialogElement).open).toBe(true);
  expect(el('m-import-file-name').textContent).toBe('backup.json');
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
  expect((el('m-import-dialog') as HTMLDialogElement).open).toBe(false);
  expect(el('backup-result-2').hidden).toBe(false);
});

it('exports from a task dialog and forgets the passwords on close', async () => {
  el('m-btn-export-open').click();
  expect((el('m-export-dialog') as HTMLDialogElement).open).toBe(true);
  field('m-backup-password', 'export-secret');
  el('m-btn-export-cancel').click();
  expect((el('m-export-dialog') as HTMLDialogElement).open).toBe(false);
  expect((el('m-backup-password') as HTMLInputElement).value).toBe('');
});

it('lists safety backups by day with sync name and change counts', async () => {
  const now = new Date();
  const earlier = new Date(now.getTime() - 3 * 86_400_000);
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSafetyList) {
      return [
        { fileName: 'a.json', createdAtUtc: now.toISOString(), operation: 'sync-push', side: 'remote', items: 40, sizeBytes: 2048, syncId: 'abcd…ef', enc: 'derived', syncName: 'Work', added: 14, removed: 2 },
        { fileName: 'b.json', createdAtUtc: earlier.toISOString(), operation: 'import-backup', side: 'local', items: 1, sizeBytes: 100, syncId: '…', enc: null },
      ];
    }
    return null;
  });
  el('m-btn-safety').click(); await settle();
  const days = [...document.querySelectorAll('#m-safety-list .safety-day')].map((h) => h.textContent);
  expect(days).toHaveLength(2);
  expect(days[0]).toBe('Today');
  const first = document.querySelector('#m-safety-list .safety-item')!;
  expect(first.textContent).toContain('Work');
  expect(first.textContent).toContain('abcd…ef');
  expect(first.textContent).toContain('+14');
  expect(first.textContent).toContain('2 removed');
  expect(el('safety-restore-1')).toBeTruthy();
  expect(document.querySelectorAll('.safety-item')[1]!.textContent).toContain('No sync linked');
});

it('asks before a lower safety-backup limit deletes the oldest, then applies it', async () => {
  const sent: unknown[] = [];
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetSafetyKeep) return { keep: 10, count: 8 };
    if (msg.command === MessageCommand.GetUiLanguage) return { language: 'en' };
    if (msg.command === MessageCommand.SetSafetyKeep) { sent.push(msg); return { keep: msg.keep, removed: 3 }; }
    if (msg.command === MessageCommand.GetStatus) return { syncEnabled: false, queueLength: 0, syncing: false, bookmarkCount: 0 };
    return null;
  });
  (document.querySelector('#sidebar button[data-section="settings"]') as HTMLButtonElement).click();
  await settle();
  const select = el('m-opt-safety-keep') as HTMLSelectElement;
  expect(select.value).toBe('10');
  // Raising never deletes: applied without a question.
  select.value = '20'; select.dispatchEvent(new Event('change')); await settle();
  expect(sent).toEqual([{ command: MessageCommand.SetSafetyKeep, keep: 20 }]);
  // 8 stored, limit 5: three would go, so it asks; Cancel restores the value.
  select.value = '5'; select.dispatchEvent(new Event('change')); await settle();
  expect(el('m-opt-safety-keep-confirm').textContent).toContain('Delete the 3 oldest safety backups now?');
  el('m-opt-safety-keep-cancel').click(); await settle();
  expect(select.value).toBe('20');
  expect(sent).toHaveLength(1);
  select.value = '5'; select.dispatchEvent(new Event('change')); await settle();
  el('m-opt-safety-keep-yes').click(); await settle();
  expect(sent[1]).toEqual({ command: MessageCommand.SetSafetyKeep, keep: 5 });
  expect(el('settings-result-2').textContent).toContain('Keeping the newest 5 safety backups.');
});

const removedSnapshot = {
  savedAt: '2026-10-21T09:00:00.000Z',
  lastUpdated: '2026-10-20T10:00:00.000Z',
  bookmarks: [{ id: '1', title: 'Bookmarks', children: [{ id: '2', title: 'One' }, { id: '3', title: 'Two' }] }],
};
const openBackupWithRemovedCopy = async () => {
  harness.send.mockImplementation(async (msg) => {
    if (msg.command === MessageCommand.GetRemovedSync) return removedSnapshot;
    if (msg.command === MessageCommand.GetSafetyList) return [];
    if (msg.command === MessageCommand.GetStatus) return { syncEnabled: false, queueLength: 0, syncing: false, bookmarkCount: 0 };
    return null;
  });
  (document.querySelector('#sidebar button[data-section="backup"]') as HTMLButtonElement).click();
  await settle();
};

it('keeps the copy of a server-removed sync in Backup and downloads it as plain JSON', async () => {
  await openBackupWithRemovedCopy();
  expect(el('m-removed-card').hidden).toBe(false);
  expect(el('m-removed-text').textContent).toContain('2 items');
  el('m-btn-removed-download').click(); await settle();
  const call = harness.send.mock.calls.map(([m]) => m)
    .find((m) => m.command === MessageCommand.DownloadFile)!;
  expect(call.filename).toBe('keepmark-removed-sync-2026-10-21.json');
  expect(JSON.parse(call.text).bookmarks).toHaveLength(1);
});

it('asks once before dismissing the kept copy, then hides the card', async () => {
  await openBackupWithRemovedCopy();
  el('m-btn-removed-dismiss').click(); await settle();
  expect(el('m-removed-card').hidden).toBe(false);
  expect(document.getElementById('m-btn-removed-dismiss-confirm')?.textContent).toContain('only copy');
  el('m-btn-removed-dismiss-yes').click(); await settle();
  expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.ClearRemovedSync)).toHaveLength(1);
  expect(el('m-removed-card').hidden).toBe(true);
});

it('closes a stale server-delete dialog when another page switches sync', async () => {
  el('m-syncs-delete-0').click(); await settle();
  expect((el('m-row-dialog') as HTMLDialogElement).open).toBe(true);
  harness.storageListener({ syncInfo: { oldValue: { id: 'old', serviceUrl: 'https://old.test' },
    newValue: { id: 'other', serviceUrl: 'https://other.test' } } });
  await settle();
  expect((el('m-row-dialog') as HTMLDialogElement).open).toBe(false);
  el('m-btn-row-go').click(); await settle();
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.DeleteRemoteSync)).toBe(false);
});

it('clears duplicate selections when another page activates a different sync', async () => {
  const previous = harness.send.getMockImplementation()!;
  harness.send.mockImplementation(async (msg) => msg.command === MessageCommand.GetDuplicates ?
    [{ url: 'https://duplicate.test', entries: [
      { id: 1, title: 'First', path: '', url: 'https://duplicate.test' },
      { id: 2, title: 'Second', path: '', url: 'https://duplicate.test' },
    ] }] : previous(msg));
  (document.querySelector('#sidebar button[data-section="duplicates"]') as HTMLButtonElement).click();
  await settle();
  expect(el('m-dup-list').querySelectorAll('.dup-group')).toHaveLength(1);
  expect((el('m-btn-duplicates-delete-all') as HTMLButtonElement).disabled).toBe(false);
  harness.storageListener({ syncInfo: { oldValue: { id: 'old', serviceUrl: 'https://old.test' },
    newValue: { id: 'other', serviceUrl: 'https://other.test' } } });
  await settle();
  expect(el('m-dup-list').children).toHaveLength(0);
  expect((el('m-btn-duplicates-delete-all') as HTMLButtonElement).disabled).toBe(true);
  el('m-btn-duplicates-delete-all').click(); await settle();
  expect(harness.send.mock.calls.some(([m]) => m.command === MessageCommand.RemoveDuplicates)).toBe(false);
});

it('keeps activation prominent and secondary actions in a dismissible menu', async () => {
  const row = el('m-syncs-list').querySelector('.saved-row')!;
  const activate = el('m-syncs-act-0') as HTMLButtonElement;
  const menu = row.querySelector('details')!;
  expect(activate.disabled).toBe(true);
  expect(activate.closest('details')).toBeNull();
  expect(menu.open).toBe(false);
  expect(menu.querySelector('summary')!.getAttribute('aria-label')).toContain('old.test');
  const commands = [...menu.querySelectorAll('button')].map((button) => button.id);
  expect(commands).toEqual(['m-syncs-rename-0', 'm-syncs-qr-0', 'm-syncs-pw-0', 'm-syncs-rm-0', 'm-syncs-delete-0']);
  expect(menu.querySelector('hr')!.nextElementSibling!.id).toBe('m-syncs-rm-0');
  menu.open = true;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(menu.querySelector('summary'));
  menu.open = true;
  document.body.click();
  expect(menu.open).toBe(false);
  menu.open = true;
  el('m-syncs-rename-0').click();
  expect(menu.open).toBe(false);
  expect((el('m-row-dialog') as HTMLDialogElement).open).toBe(true);
  el('m-btn-row-cancel').click();
  expect(document.activeElement).toBe(menu.querySelector('summary'));
});
