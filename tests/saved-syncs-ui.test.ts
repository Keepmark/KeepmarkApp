// @vitest-environment happy-dom
// Popup panel for the saved syncs: rendering, the inline password step, the
// remove confirmation and the rule "a re-render never keeps a stale confirm".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedSyncsPanel } from '../src/popup/saved-syncs';
import { MessageCommand, type SavedSyncsResponse } from '../src/shared/messages';
import type { SavedSync } from '../src/shared/saved-syncs';

const harness = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/popup/ui', async (original) => ({ ...await original<object>(), send: harness.send }));
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));

const el = (id: string): HTMLElement => document.getElementById(id)!;
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
let openManager: ReturnType<typeof vi.fn>;

function rowEls(): HTMLElement[] {
  return [...el('p-saved-list').querySelectorAll<HTMLElement>('.saved-row')];
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="p-saved-card">
      <h2 id="p-saved-title"></h2>
      <ul id="p-saved-list"></ul>
      <div id="p-saved-notice" hidden>
        <p></p><button id="p-saved-open-manager"></button>
      </div>
      <div id="p-saved-confirm" hidden>
        <p><strong id="p-saved-confirm-text"></strong></p>
        <p id="p-saved-hint"></p>
        <input id="p-saved-password" type="password" />
        <div>
          <button id="p-saved-activate"></button>
          <button id="p-saved-cancel"></button>
        </div>
      </div>
      <div id="p-saved-error" role="alert" hidden></div>
    </div>`;
  harness.send.mockReset().mockResolvedValue({});
  onChanged = vi.fn(async () => undefined);
  openManager = vi.fn();
  panel = new SavedSyncsPanel('p-saved', onChanged, openManager);
});

describe('saved syncs popup panel', () => {
  it('renders rows, marks the active one and never offers to remove it', () => {
    panel.render(data);
    expect(el('p-saved-card').hidden).toBe(false);
    expect(el('p-saved-title').textContent).toBe('Syncs (2)');
    const [active, dormant] = rowEls();
    expect(active.classList.contains('saved-active')).toBe(true);
    expect(active.textContent).toContain('Lavoro');
    // Active row: badge only, no activate/remove buttons.
    expect(active.querySelectorAll('button')).toHaveLength(0);
    expect(dormant.querySelectorAll('button')).toHaveLength(2);
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

  it('uses the singular form for one row', () => {
    panel.render({ syncs: [rows[0]], active: data.active, switchLockSet: true });
    expect(el('p-saved-title').textContent).toBe('Sync (1)');
  });

  it('activates a dormant row through the inline password step', async () => {
    panel.render(data);
    (rowEls()[1].querySelector('button.mini:not(.danger)') as HTMLButtonElement).click();
    expect(el('p-saved-confirm').hidden).toBe(false);
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
    expect(el('p-saved-confirm').hidden).toBe(true);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('');
  });

  it('keeps the prompt open and the password in place when activation fails', async () => {
    harness.send.mockRejectedValueOnce(new Error('Invalid credentials'));
    panel.render(data);
    (rowEls()[1].querySelector('button.mini:not(.danger)') as HTMLButtonElement).click();
    (el('p-saved-password') as HTMLInputElement).value = 'wrong';
    (el('p-saved-activate') as HTMLButtonElement).click();
    await tick();
    expect(el('p-saved-confirm').hidden).toBe(false);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('wrong');
    expect(el('p-saved-error').textContent).toBe('Invalid credentials');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('without a switch password the notice shows and activation is disabled', () => {
    panel.render({ ...data, switchLockSet: false });
    expect(el('p-saved-notice').hidden).toBe(false);
    const dormant = rowEls()[1];
    const activate = dormant.querySelector('button.mini:not(.danger)') as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
    (el('p-saved-open-manager') as HTMLButtonElement).click();
    expect(openManager).toHaveBeenCalledTimes(1);
  });

  it('removes a row only after the inline confirmation', async () => {
    panel.render(data);
    (el('p-saved-rm-1') as HTMLButtonElement).click();
    await tick();
    expect(document.getElementById('p-saved-rm-1-confirm')).not.toBeNull();
    (document.getElementById('p-saved-rm-1-cancel') as HTMLButtonElement).click();
    await tick();
    expect(harness.send).not.toHaveBeenCalled();

    (el('p-saved-rm-1') as HTMLButtonElement).click();
    await tick();
    (document.getElementById('p-saved-rm-1-yes') as HTMLButtonElement).click();
    await tick();
    expect(harness.send).toHaveBeenCalledWith({
      command: MessageCommand.RemoveSavedSync,
      serviceUrl: 'https://other.example/',
      syncId: 'bbbbbbbb2222',
    });
    expect(onChanged).toHaveBeenCalledWith('removed');
  });

  it('a re-render cancels an open confirmation instead of leaving it orphaned', async () => {
    panel.render(data);
    (el('p-saved-rm-1') as HTMLButtonElement).click();
    await tick();
    expect(document.getElementById('p-saved-rm-1-confirm')).not.toBeNull();
    panel.render(data);
    await tick();
    expect(document.getElementById('p-saved-rm-1-confirm')).toBeNull();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('cancels the password step from its own button', async () => {
    panel.render(data);
    (rowEls()[1].querySelector('button.mini:not(.danger)') as HTMLButtonElement).click();
    (el('p-saved-password') as HTMLInputElement).value = 'secret';
    (el('p-saved-cancel') as HTMLButtonElement).click();
    expect(el('p-saved-confirm').hidden).toBe(true);
    expect((el('p-saved-password') as HTMLInputElement).value).toBe('');
    expect(harness.send).not.toHaveBeenCalled();
  });
});
