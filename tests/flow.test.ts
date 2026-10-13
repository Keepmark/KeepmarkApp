// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: async () => ({ ok: true }) } } }));

import { cancelConfirm, clearMessages, confirmInline, showError, showFor } from '../src/popup/flow';

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

describe('showFor (auto-hiding banner)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="banner" hidden><span class="row"><button id="act">Undo</button></span></div>';
  });

  it('shows now and hides after the given time', () => {
    showFor('banner', 60_000, 'act');
    expect(document.getElementById('banner')!.hidden).toBe(false);
    vi.advanceTimersByTime(59_999);
    expect(document.getElementById('banner')!.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.getElementById('banner')!.hidden).toBe(true);
    vi.useRealTimers();
  });

  it('hides at once when the time is already over', () => {
    document.getElementById('banner')!.hidden = false;
    showFor('banner', 0, 'act');
    expect(document.getElementById('banner')!.hidden).toBe(true);
    vi.useRealTimers();
  });

  it('cancels an open confirmation when it hides', async () => {
    showFor('banner', 1000, 'act');
    const answer = confirmInline('act', { message: 'Undo?', confirmLabel: 'Yes, undo' });
    vi.advanceTimersByTime(1000);
    expect(await answer).toBe(false);
    expect(document.getElementById('banner')!.hidden).toBe(true);
    vi.useRealTimers();
  });

  it('waits while the action is busy', () => {
    showFor('banner', 1000, 'act');
    (document.getElementById('act') as HTMLButtonElement).disabled = true;
    vi.advanceTimersByTime(5000);
    expect(document.getElementById('banner')!.hidden).toBe(false);
    (document.getElementById('act') as HTMLButtonElement).disabled = false;
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('banner')!.hidden).toBe(true);
    vi.useRealTimers();
  });
});
