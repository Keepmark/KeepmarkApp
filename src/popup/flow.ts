// Workflow building blocks shared by popup and manager (docs/WORKFLOWS.md).
// One confirmation pattern for every action that replaces or removes data:
// an inline block right under the action, with the implication spelled out,
// `Yes, <verb>` and `Cancel`. Never window.confirm, never a modal.

import { $ } from './ui.js';
import { t } from '../shared/i18n.js';

export interface ConfirmOptions {
  /** The question, e.g. "Change the sync password?" */
  message: string;
  /** What is lost, where, and who else is affected. */
  implication?: string;
  /** Exact confirm label, e.g. "Yes, change password". */
  confirmLabel: string;
  /** Red confirm button when the action replaces or deletes data. */
  danger?: boolean;
}

const pending = new Map<string, (ok: boolean) => void>();

/** Show an inline confirmation under the action button `anchorId` (under its
 * `.row` or list item when it sits in one). Resolves true on confirm, false on cancel or
 * when another confirmation for the same anchor replaces it. While open the
 * anchor is disabled, so the action cannot be armed twice. */
export function confirmInline(anchorId: string, opts: ConfirmOptions): Promise<boolean> {
  cancelConfirm(anchorId);
  const anchor = $(anchorId) as HTMLButtonElement;
  const after = anchor.closest('.row, li') ?? anchor;
  const wasDisabled = anchor.disabled;

  const box = document.createElement('div');
  box.className = opts.danger ? 'confirm danger' : 'confirm';
  box.id = `${anchorId}-confirm`;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', opts.message);
  const text = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = opts.message;
  text.append(strong);
  if (opts.implication) text.append(` ${opts.implication}`);
  const row = document.createElement('div');
  row.className = 'row';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.id = `${anchorId}-yes`;
  yes.className = opts.danger ? 'danger' : 'primary';
  yes.textContent = opts.confirmLabel;
  const no = document.createElement('button');
  no.type = 'button';
  no.id = `${anchorId}-cancel`;
  no.textContent = t('common.cancel');
  row.append(yes, no);
  box.append(text, row);
  after.after(box);
  anchor.disabled = true;

  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      pending.delete(anchorId);
      box.remove();
      anchor.disabled = wasDisabled;
      resolve(ok);
    };
    pending.set(anchorId, done);
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    // Destructive: Enter must not confirm by accident.
    (opts.danger ? no : yes).focus();
  });
}

/** Close an open confirmation for `anchorId` as cancelled (no-op if none). */
export function cancelConfirm(anchorId: string): void {
  pending.get(anchorId)?.(false);
}

const hideTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Show element `id` now and hide it after `ms` (re-arming replaces the
 * previous timer; `ms <= 0` hides at once). An open confirmation on
 * `anchorId` is cancelled first; a busy (disabled) anchor postpones it. */
export function showFor(id: string, ms: number, anchorId: string): void {
  clearTimeout(hideTimers.get(id));
  hideTimers.delete(id);
  const el = $(id) as HTMLElement;
  const hide = (): void => {
    // confirmInline also disables the anchor; only a disabled anchor with no
    // open confirmation means the action itself is running.
    const anchor = document.getElementById(anchorId) as HTMLButtonElement | null;
    if (anchor?.disabled && !document.getElementById(`${anchorId}-confirm`)) {
      hideTimers.set(id, setTimeout(hide, 1000));
      return;
    }
    hideTimers.delete(id);
    cancelConfirm(anchorId);
    el.hidden = true;
  };
  if (ms <= 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  hideTimers.set(id, setTimeout(hide, ms));
}

/** Show `message` in the error box `id` (`<base>-error[-n]`, next to the
 * action that failed). */
export function showError(id: string, message: string): void {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

/** Hide every error box (emptied, so a screen reader never re-reads a stale
 * alert) and every result box under `root`: a new action starts clean. */
export function clearMessages(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('.error[role="alert"]')) {
    el.hidden = true;
    el.textContent = '';
  }
  for (const el of root.querySelectorAll<HTMLElement>('.result')) el.hidden = true;
}
