// @vitest-environment happy-dom
// Popup panel for the saved syncs: read-only rendering (activate only) and the
// modal sync-change-password step. Rename/remove live in the manager only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedSyncsPanel } from '../src/popup/saved-syncs';
import { MessageCommand, type SavedSyncsResponse } from '../src/shared/messages';
import type { SavedSync } from '../src/shared/saved-syncs';

const harness = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/popup/ui', async (original) => ({ ...await original<object>(), send: harness.send }));
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));

const el = (id: string): HTMLElement => document.getElementById(id)!;
const dialog = (): HTMLDialogElement => el('p-saved-dialog') as HTMLDialogElement;
const tick = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

const rows: SavedSync[] = [
  { serviceUrl: 'https://api.xbrowsersync.org/', syncId: 'aaaaaaaa1111', label: 'Lavoro', lastUsedAt: '2026-10-20T10:00:00.000Z' },
  { serviceUrl: 'https://other.example/', syncId: 'bbbbbbbb2222', lastUsedAt: '2026-10-19T10:00:00.000Z' },
];
const data: SavedSyncsResponse = {
  syncs: rows,
  active: { serviceUrl: 'https://api.xbrowsersync.org/', syncId: 'aaaaaaaa1111' },
  switchLockSet: true,
};

let panel: SavedSyncsPanel;
let onChanged: ReturnType<typeof vi.fn>;

function rowEls(): HTMLElement[] {
  return [...el('p-saved-list').querySelectorAll<HTMLElement>('.saved-row')];
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="p-saved-card">
      <h2 id="p-saved-title"></h2>
      <ul id="p-saved-list"></ul>
      <dialog id="p-saved-dialog">
        <p><strong id="p-saved-confirm-text"></strong></p>
        <p id="p-saved-hint"></p>
        <label id="p-saved-pw-row"><input id="p-saved-password" type="password" /></label>
        <button id="p-saved-activate"></button>
        <button id="p-saved-cancel"></button>
        <div id="p-saved-error" role="alert" hidden></div>
      </dialog>
    </div>`;
  harness.send.mockReset().mockResolvedValue({});
  onChanged = vi.fn(async () => undefined);
  panel = new SavedSyncsPanel('p-saved', onChanged);
});

describe('saved syncs popup panel', () => {
  it('renders rows read-only: active tag, one activate button for the dormant one', () => {
    panel.render(data);
    expect(el('p-saved-card').hidden).toBe(false);
    expect(el('p-saved-title').textContent).toBe('Syncs (2)');
    const [active, dormant] = rowEls();
    expect(active.classList.contains('saved-active')).toBe(true);
    expect(active.textContent).toContain('Lavoro');
    // No rename, no remove, nowhere to manage: the popup only switches.
    expect(active.querySelectorAll('button')).toHaveLength(0);
    expect(dormant.querySelectorAll('button')).toHaveLength(1);
    expect(dormant.textContent).toContain('other.example');
    // The ID is a capability token: only a prefix is shown.
    expect(dormant.textContent).toContain('bbbbbbbb…');
  });

  it('hides the card when the list is empty and clears a stale error', () => {
    panel.render(data);
    el('p-saved-error').textContent = 'boom';
    el('p-saved-error').hidden = false;
    panel.render({ syncs: [], switchLockSet: true });
    expect(el('p-saved-card').hidden).toBe(true);
    expect(el('p-saved-error').textContent).toBe('');
    expect(el('p-saved-error').hidden).toBe(true);
  });

  it('hides the card when there is nothing to switch to', () => {
    panel.render({ syncs: [rows[0]], active: data.active, switchLockSet: true });
    expect(el('p-saved-card').hidden).toBe(true);
    // Unlinked registry: one dormant row is exactly what the popup is for.
    panel.render({ syncs: [rows[0]], switchLockSet: true });
    expect(el('p-saved-card').hidden).toBe(false);
    expect(el('p-saved-title').textContent).toBe('Sync (1)');
  });

  it('activates a dormant row through the modal password step', async () => {
    panel.render(data);
    (rowEls()[1].querySelector('button') as HTMLButtonElement).click();
    expect(dialog().open).toBe(true);
    expect(el('p-saved-confirm-text').textContent).toContain('other.example');
    expect(document.activeElement).toBe(el('p-saved-password'));

    // Empty password: rejected locally, nothing sent.
    (el('p-saved-activate') as HTMLButtonElement).click();
    await tick();
    expect(harness.send).not.toHaveBeenCalled();
    expect(el('p-saved-error').hidden).toBe(false);

    (el('p-saved-password') as HTMLInputElement).value = 'target password';
    (el('p-saved-activate') as HTMLButtonElement).click();
    await tick();
    expect(harness.send).toHaveBeenCalledWith({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://other.example/',
      syncId: 'bbbbbbbb2222',
      switchPassword: 'target password',
    });
    expect(onChanged).toHaveBeenCalledWith('activated');
    expect(dialog().open).toBe(false);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('');
  });

  it('keeps the prompt open and the password in place when activation fails', async () => {
    harness.send.mockRejectedValueOnce(new Error('Invalid credentials'));
    panel.render(data);
    (rowEls()[1].querySelector('button') as HTMLButtonElement).click();
    (el('p-saved-password') as HTMLInputElement).value = 'wrong';
    (el('p-saved-activate') as HTMLButtonElement).click();
    await tick();
    expect(dialog().open).toBe(true);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('wrong');
    expect(el('p-saved-error').textContent).toBe('Invalid credentials');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('without a switch password hides the field and activates directly', async () => {
    panel.render({ ...data, switchLockSet: false });
    (rowEls()[1].querySelector('button') as HTMLButtonElement).click();
    expect(el('p-saved-pw-row').hidden).toBe(true);
    (el('p-saved-activate') as HTMLButtonElement).click();
    await tick();
    expect(harness.send).toHaveBeenCalledWith({
      command: MessageCommand.ActivateSavedSync,
      serviceUrl: 'https://other.example/',
      syncId: 'bbbbbbbb2222',
    });
    expect(onChanged).toHaveBeenCalledWith('activated');
  });

  it('cancels the password step from its own button', () => {
    panel.render(data);
    (rowEls()[1].querySelector('button') as HTMLButtonElement).click();
    (el('p-saved-password') as HTMLInputElement).value = 'secret';
    (el('p-saved-cancel') as HTMLButtonElement).click();
    expect(dialog().open).toBe(false);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('');
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('a re-render closes an open step instead of leaving it orphaned', () => {
    panel.render(data);
    (rowEls()[1].querySelector('button') as HTMLButtonElement).click();
    expect(dialog().open).toBe(true);
    panel.render(data);
    expect(dialog().open).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });
});
