// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: async () => ({ ok: true }) } } }));

import { cancelConfirm, clearMessages, confirmInline, showError } from '../src/popup/flow';

function click(id: string): void {
  (document.getElementById(id) as HTMLButtonElement).click();
}

describe('confirmInline', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="row"><button id="act">Change password…</button></div><div id="after"></div>';
  });

  it('shows message, implication and labels under the action row, and disables the action', () => {
    void confirmInline('act', { message: 'Change it?', implication: 'Other devices stop.', confirmLabel: 'Yes, change', danger: true });
    const box = document.getElementById('act-confirm')!;
    expect(box.previousElementSibling?.className).toBe('row');
    expect(box.className).toBe('confirm danger');
    expect(box.textContent).toContain('Change it?');
    expect(box.textContent).toContain('Other devices stop.');
    expect(document.getElementById('act-yes')!.textContent).toBe('Yes, change');
    expect(document.getElementById('act-yes')!.className).toBe('danger');
    expect(document.getElementById('act-cancel')!.textContent).toBe('Cancel');
    expect((document.getElementById('act') as HTMLButtonElement).disabled).toBe(true);
    // Destructive: focus starts on Cancel.
    expect(document.activeElement?.id).toBe('act-cancel');
  });

  it('resolves true on Yes, removes the block and re-enables the action', async () => {
    const p = confirmInline('act', { message: 'Go?', confirmLabel: 'Yes, go' });
    expect(document.activeElement?.id).toBe('act-yes');
    click('act-yes');
    await expect(p).resolves.toBe(true);
    expect(document.getElementById('act-confirm')).toBeNull();
    expect((document.getElementById('act') as HTMLButtonElement).disabled).toBe(false);
  });

  it('resolves false on Cancel', async () => {
    const p = confirmInline('act', { message: 'Go?', confirmLabel: 'Yes, go' });
    click('act-cancel');
    await expect(p).resolves.toBe(false);
    expect(document.getElementById('act-confirm')).toBeNull();
  });

  it('keeps a disabled action disabled after closing', async () => {
    (document.getElementById('act') as HTMLButtonElement).disabled = true;
    const p = confirmInline('act', { message: 'Go?', confirmLabel: 'Yes, go' });
    cancelConfirm('act');
    await expect(p).resolves.toBe(false);
    expect((document.getElementById('act') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a second confirmation for the same action cancels the first', async () => {
    const first = confirmInline('act', { message: 'One?', confirmLabel: 'Yes' });
    const second = confirmInline('act', { message: 'Two?', confirmLabel: 'Yes' });
    await expect(first).resolves.toBe(false);
    expect(document.querySelectorAll('.confirm')).toHaveLength(1);
    click('act-yes');
    await expect(second).resolves.toBe(true);
  });
});

describe('confirmInline in a list', () => {
  it('opens under the list item, not inside it after the button', () => {
    document.body.innerHTML = '<ul><li>entry <button id="r0">Restore</button> <button id="d0">Delete</button></li></ul>';
    void confirmInline('r0', { message: 'Restore?', confirmLabel: 'Yes, restore', danger: true });
    const box = document.getElementById('r0-confirm')!;
    expect(box.previousElementSibling?.tagName).toBe('LI');
    cancelConfirm('r0');
  });
});

describe('showError / clearMessages', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="a-error" class="error" role="alert" hidden></div><div id="a-result" class="result">Done.</div>';
  });

  it('shows the message in the named box', () => {
    showError('a-error', 'Broken.');
    const el = document.getElementById('a-error')!;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('Broken.');
  });

  it('empties and hides every error box and hides results', () => {
    showError('a-error', 'Broken.');
    clearMessages();
    const el = document.getElementById('a-error')!;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    expect(document.getElementById('a-result')!.hidden).toBe(true);
  });
});
