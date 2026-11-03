// Popup: the saved-syncs list (multi-sync), read-only. The popup can switch
// to a dormant sync (asking the sync lock password when one is set)
// but never renames, removes or manages rows: those live in the manager.
// Activating a wrapped row asks for the switch password (never the sync's own
// one); a plain row is a plain confirmation.

import { $, input, send, withBusy } from './ui.js';
import { showError } from './flow.js';
import { t } from '../shared/i18n.js';
import { MessageCommand, type SavedSyncsResponse } from '../shared/messages.js';
import {
  isActiveSavedSync,
  savedSyncName,
  serviceHost,
  shortSyncId,
  type SavedSync,
} from '../shared/saved-syncs.js';

/** What the panel just did, so the popup can pick the right view. */
export type SavedSyncsChange = 'activated';

export class SavedSyncsPanel {
  private syncs: SavedSync[] = [];
  private active?: { serviceUrl: string; syncId: string };
  private switchLockSet = false;
  /** Row waiting for the switch password (only when a lock is set). */
  private pending?: SavedSync;
  constructor(
    private readonly prefix: string,
    private readonly onChanged: (kind: SavedSyncsChange) => Promise<void>,
  ) {
    this.el('cancel').addEventListener('click', () => this.closeConfirm());
    this.el('activate').addEventListener('click', () => void this.submit());
    this.password().addEventListener('input', () => this.clearError());
    this.password().addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void this.submit();
    });
    // Escape closes natively; the `close` event clears the pending row so a
    // re-open never inherits a stale target or password.
    this.dialog().addEventListener('close', () => {
      this.pending = undefined;
      this.password().value = '';
    });
    // A click on the backdrop (the dialog element itself) closes it too.
    this.dialog().addEventListener('click', (event) => {
      if (event.target === this.dialog()) this.closeConfirm();
    });
  }

  private el(suffix: string): HTMLElement {
    return $(`${this.prefix}-${suffix}`);
  }

  private dialog(): HTMLDialogElement {
    return this.el('dialog') as HTMLDialogElement;
  }

  private password(): HTMLInputElement {
    return input(`${this.prefix}-password`);
  }

  private clearError(): void {
    const error = this.el('error');
    error.hidden = true;
    error.textContent = '';
  }

  /** Render the registry (the popup calls this after every status refresh).
   *  With a single active sync there is nothing to switch to: hide the card
   *  until a second sync (or an unlinked registry) makes it useful. */
  render(data: SavedSyncsResponse): void {
    this.closeConfirm();
    // A new render is a new state: never resurrect an error from the old one.
    this.clearError();
    this.syncs = data.syncs;
    this.active = data.active;
    this.switchLockSet = data.switchLockSet;
    const card = this.el('card');
    const list = this.el('list');
    list.replaceChildren();
    const hasActive = this.syncs.some((sync) => isActiveSavedSync(sync, this.active));
    const useful = this.syncs.length > 0 && !(hasActive && this.syncs.length === 1);
    if (!useful) {
      card.hidden = true;
      return;
    }
    // No count: the list below already shows how many there are.
    this.el('title').textContent = t('popup.saved.title');
    this.syncs.forEach((sync, index) => list.append(this.row(sync, index)));
    card.hidden = false;
  }

  private row(sync: SavedSync, index: number): HTMLElement {
    const isActive = isActiveSavedSync(sync, this.active);
    const li = document.createElement('li');
    li.className = isActive ? 'saved-row saved-active' : 'saved-row';

    const meta = document.createElement('span');
    meta.className = 'saved-meta';
    const name = document.createElement('strong');
    name.textContent = savedSyncName(sync);
    const sub = document.createElement('small');
    // The sync ID is a bearer token: a prefix only (the full one stays in the
    // status card, copyable).
    sub.textContent = `${serviceHost(sync.serviceUrl)} · ${shortSyncId(sync.syncId)}`;
    meta.append(name, sub);

    const actions = document.createElement('span');
    actions.className = 'saved-actions';
    if (isActive) {
      const tag = document.createElement('span');
      tag.className = 'tag ok';
      tag.textContent = t('popup.saved.active');
      actions.append(tag);
    } else {
      const activate = document.createElement('button');
      activate.type = 'button';
      activate.className = 'mini';
      activate.id = `${this.prefix}-act-${index}`;
      activate.textContent = t('popup.saved.activate');
      activate.addEventListener('click', () => this.openConfirm(sync));
      actions.append(activate);
    }
    li.append(meta, actions);
    return li;
  }

  private openConfirm(sync: SavedSync): void {
    this.pending = sync;
    const name = savedSyncName(sync);
    this.el('confirm-text').textContent = t('popup.saved.activatePrompt', { name });
    this.el('hint').textContent = this.switchLockSet
      ? t('popup.saved.passwordHint', { name })
      : t('popup.saved.activateHintNoPassword', { name });
    ($(`${this.prefix}-pw-row`) as HTMLElement).hidden = !this.switchLockSet;
    this.password().value = '';
    this.clearError();
    this.dialog().showModal();
    if (this.switchLockSet) this.password().focus();
    else this.el('activate').focus();
  }

  private closeConfirm(): void {
    this.pending = undefined;
    this.password().value = '';
    if (this.dialog().open) this.dialog().close();
  }

  private async submit(): Promise<void> {
    const target = this.pending;
    if (!target) return;
    const password = this.password().value;
    if (this.switchLockSet && !password) {
      showError(`${this.prefix}-error`, t('core.switchPasswordRequired'));
      return;
    }
    this.clearError();
    await withBusy(`${this.prefix}-activate`, t('busy.connecting'), async () => {
      try {
        await send({
          command: MessageCommand.ActivateSavedSync,
          serviceUrl: target.serviceUrl,
          syncId: target.syncId,
          ...(this.switchLockSet ? { switchPassword: password } : {}),
        });
        this.closeConfirm();
        await this.onChanged('activated');
      } catch (err) {
        // Wrong password: the field keeps its content (the message says what
        // failed), and nothing was rewritten.
        showError(`${this.prefix}-error`, (err as Error).message);
      }
    });
  }
}
