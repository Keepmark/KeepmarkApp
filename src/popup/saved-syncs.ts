// Popup: the saved-syncs list (multi-sync). One panel per view (main and
// connect), same rows, same actions. Rows are metadata only — activating one
// always asks for that sync's password, which the background verifies by
// decrypting the remote copy before anything is rewritten.

import { $, input, send, withBusy } from './ui.js';
import { cancelConfirm, confirmInline, showError } from './flow.js';
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
export type SavedSyncsChange = 'activated' | 'removed';

export class SavedSyncsPanel {
  /** Remove-confirm anchors currently open (cancelled before a re-render, so
   *  a stale confirm never outlives the row it belongs to). */
  private readonly openConfirms: string[] = [];
  private syncs: SavedSync[] = [];
  private active?: { serviceUrl: string; syncId: string };
  /** Row waiting for its password. */
  private pending?: SavedSync;

  constructor(
    private readonly prefix: string,
    private readonly onChanged: (kind: SavedSyncsChange) => Promise<void>,
  ) {
    this.el('cancel').addEventListener('click', () => this.closeConfirm());
    this.el('activate').addEventListener('click', () => void this.submit());
    const password = this.password();
    password.addEventListener('input', () => this.clearError());
    password.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void this.submit();
    });
  }

  private el(suffix: string): HTMLElement {
    return $(`${this.prefix}-${suffix}`);
  }

  private password(): HTMLInputElement {
    return input(`${this.prefix}-password`);
  }

  private clearError(): void {
    const error = this.el('error');
    error.hidden = true;
    error.textContent = '';
  }

  /** Render the registry (the popup calls this after every status refresh). */
  render(data: SavedSyncsResponse): void {
    this.closeConfirm();
    for (const id of this.openConfirms) cancelConfirm(id);
    this.openConfirms.length = 0;
    this.syncs = data.syncs;
    this.active = data.active;
    const card = this.el('card');
    const list = this.el('list');
    list.replaceChildren();
    if (this.syncs.length === 0) {
      card.hidden = true;
      return;
    }
    this.el('title').textContent = t('popup.saved.titleCount', { n: this.syncs.length });
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
      activate.textContent = t('popup.saved.activate');
      activate.addEventListener('click', () => this.openConfirm(sync));
      actions.append(activate);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini danger';
      remove.id = `${this.prefix}-rm-${index}`;
      remove.title = t('popup.saved.remove');
      remove.setAttribute('aria-label', t('popup.saved.remove'));
      remove.textContent = '×';
      remove.addEventListener('click', () => void this.remove(sync, remove.id));
      actions.append(remove);
    }
    li.append(meta, actions);
    return li;
  }

  private openConfirm(sync: SavedSync): void {
    this.pending = sync;
    const name = savedSyncName(sync);
    this.el('confirm-text').textContent = t('popup.saved.activatePrompt', { name });
    this.el('hint').textContent = t('popup.saved.passwordHint', { name });
    this.password().value = '';
    this.clearError();
    this.el('confirm').hidden = false;
    this.password().focus();
  }

  private closeConfirm(): void {
    this.pending = undefined;
    this.password().value = '';
    this.el('confirm').hidden = true;
  }

  private async submit(): Promise<void> {
    const target = this.pending;
    if (!target) return;
    const password = this.password().value;
    if (!password) {
      showError(`${this.prefix}-error`, t('val.password.required'));
      return;
    }
    this.clearError();
    await withBusy(`${this.prefix}-activate`, t('busy.connecting'), async () => {
      try {
        await send({
          command: MessageCommand.ActivateSavedSync,
          serviceUrl: target.serviceUrl,
          syncId: target.syncId,
          password,
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

  private async remove(sync: SavedSync, anchorId: string): Promise<void> {
    this.clearError();
    const ok = await confirmInline(anchorId, {
      message: t('popup.saved.removePrompt', { name: savedSyncName(sync) }),
      implication: t('popup.saved.removeImplication'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    this.openConfirms.push(anchorId);
    try {
      await send({
        command: MessageCommand.RemoveSavedSync,
        serviceUrl: sync.serviceUrl,
        syncId: sync.syncId,
      });
      await this.onChanged('removed');
    } catch (err) {
      showError(`${this.prefix}-error`, (err as Error).message);
    }
  }
}
