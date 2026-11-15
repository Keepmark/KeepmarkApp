import { HandoffAuthFailedException, ServiceOfflineException } from '../shared/errors.js';
import { buildHandoffLink, isHandoffCode, parseHandoffLink, type HandoffSecret } from '../shared/handoff.js';
import { t } from '../shared/i18n.js';
import { MessageCommand, type RedeemedShareLink } from '../shared/messages.js';
import { normalizeServiceUrl } from '../shared/service-catalog.js';
import { looksLikeShareLink, parseShareLink } from '../shared/share-link.js';
import type { ServicePicker } from './service-picker.js';
import { send, validateServiceUrl } from './ui.js';

/**
 * "Shared link" entry of the existing-sync forms (popup and manager). A
 * pasted `keepmark://sync?…` link fills the service and the sync ID and
 * keeps its key in memory only: the password row is hidden while the form
 * still names that same service and ID. Editing either drops the key (the
 * password is asked again). The link text itself is cleared from the field
 * as soon as it is read.
 *
 * A one-time link (format 2) carries no key: it is offered first (service
 * named, code asked when the link needs one) and only "Open link" redeems it,
 * which uses it up. The key it returns is then bound exactly like a format-1
 * key, with the sender's sync name as a suggestion.
 */
export class ShareLinkField {
  readonly root = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly use = document.createElement('button');
  private readonly note = document.createElement('p');
  /** Paste row (field + Use link): hidden once a link was read. */
  private readonly entry = document.createElement('div');
  /** What the link brought ("service · ID") with "Use another link", in place of the entry. */
  private readonly summary = document.createElement('div');
  private readonly summaryText = document.createElement('strong');
  private readonly change = document.createElement('button');
  /** Asks before dropping a key that came from a one-time link (used up). */
  private readonly discard = document.createElement('div');
  private readonly discardYes = document.createElement('button');
  private readonly discardNo = document.createElement('button');
  private readonly error = document.createElement('div');
  private bound: { serviceUrl: string; syncId: string; key: string; label?: string; once?: boolean } | undefined;
  private generation = 0;
  /** A parsed one-time link waiting for "Open link" (nothing redeemed yet). */
  private pending: HandoffSecret | undefined;
  private redeeming = false;
  private readonly once = document.createElement('div');
  private readonly onceNote = document.createElement('p');
  private readonly codeRow = document.createElement('label');
  private readonly code = document.createElement('input');
  private readonly openOnce = document.createElement('button');

  constructor(private readonly config: {
    /** Prefix for element ids (`<prefix>-share-link`, …). */
    prefix: string;
    picker: () => ServicePicker;
    syncId: HTMLInputElement;
    /** Called whenever the key starts or stops applying. */
    onChange: () => void;
    /** Redeems a one-time link (tests inject it). */
    redeem?: (link: string, code?: string) => Promise<RedeemedShareLink>;
  }) {
    const { prefix } = config;
    this.root.className = 'share-link-field';
    this.root.id = `${prefix}-share-link-row`;
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = t('link.label');
    this.input.id = `${prefix}-share-link`;
    this.input.type = 'text';
    this.input.className = 'mono';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = t('link.placeholder');
    label.append(caption, this.input);
    this.use.type = 'button';
    this.use.id = `${prefix}-share-link-use`;
    this.use.className = 'mini';
    this.use.textContent = t('link.use');
    this.entry.className = 'share-link-entry';
    this.entry.append(label, this.use);
    this.note.id = `${prefix}-share-link-note`;
    this.note.className = 'hint';
    this.summary.id = `${prefix}-share-summary`;
    this.summary.className = 'share-link-summary';
    this.summary.hidden = true;
    this.summaryText.className = 'share-link-summary-text';
    this.change.type = 'button';
    this.change.id = `${prefix}-share-change`;
    this.change.className = 'mini';
    this.change.textContent = t('link.change');
    const head = document.createElement('div');
    head.className = 'share-link-summary-head';
    head.append(this.summaryText, this.change);
    this.buildDiscard(prefix);
    this.summary.append(head, this.note, this.discard);
    this.change.addEventListener('click', () => this.startOver());
    this.error.id = `${prefix}-share-link-error`;
    this.error.className = 'error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    this.buildOnce(prefix);
    this.root.append(this.entry, this.summary, this.once, this.error);
    this.use.addEventListener('click', () => void this.apply());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.apply(); }
    });
    this.input.addEventListener('input', () => { this.error.hidden = true; });
    // A pasted link is applied at once: no extra click for the common case.
    this.input.addEventListener('paste', () => setTimeout(() => { if (looksLikeShareLink(this.input.value)) void this.apply(); }, 0));
    config.syncId.addEventListener('input', () => this.refresh());
  }

  private buildDiscard(prefix: string): void {
    this.discard.id = `${prefix}-share-discard`;
    this.discard.className = 'confirm danger';
    this.discard.setAttribute('role', 'group');
    this.discard.hidden = true;
    const text = document.createElement('p');
    text.textContent = t('link.onceDiscard');
    this.discardYes.type = 'button';
    this.discardYes.id = `${prefix}-share-discard-yes`;
    this.discardYes.className = 'danger';
    this.discardYes.textContent = t('link.onceDiscardYes');
    this.discardNo.type = 'button';
    this.discardNo.id = `${prefix}-share-discard-cancel`;
    this.discardNo.textContent = t('common.cancel');
    const row = document.createElement('div');
    row.className = 'row';
    row.append(this.discardYes, this.discardNo);
    this.discard.append(text, row);
    this.discard.setAttribute('aria-label', t('link.onceDiscard'));
    this.discardYes.addEventListener('click', () => this.startOver(true));
    this.discardNo.addEventListener('click', () => this.hideDiscard(true));
  }

  private hideDiscard(refocus = false): void {
    if (this.discard.hidden) return;
    this.discard.hidden = true;
    this.change.disabled = false;
    if (refocus) this.change.focus();
  }

  private buildOnce(prefix: string): void {
    this.once.id = `${prefix}-share-once`;
    this.once.className = 'share-once';
    this.once.hidden = true;
    this.onceNote.id = `${prefix}-share-once-note`;
    this.onceNote.className = 'notice';
    const caption = document.createElement('span');
    caption.textContent = t('link.codeLabel');
    this.code.id = `${prefix}-share-code`;
    this.code.type = 'text';
    this.code.className = 'mono share-code-input';
    this.code.inputMode = 'numeric';
    this.code.autocomplete = 'one-time-code';
    this.code.maxLength = 7;
    this.code.spellcheck = false;
    this.code.setAttribute('aria-describedby', this.error.id || `${prefix}-share-link-error`);
    this.codeRow.id = `${prefix}-share-code-row`;
    this.codeRow.append(caption, this.code);
    this.openOnce.type = 'button';
    this.openOnce.id = `${prefix}-share-open`;
    this.openOnce.className = 'primary';
    this.openOnce.textContent = t('link.open');
    const actions = document.createElement('div');
    actions.className = 'share-once-entry';
    actions.append(this.codeRow, this.openOnce);
    this.once.append(this.onceNote, actions);
    this.openOnce.addEventListener('click', () => void this.redeemOnce());
    this.code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.redeemOnce(); }
    });
    this.code.addEventListener('input', () => { this.error.hidden = true; this.code.removeAttribute('aria-invalid'); });
  }

  /** The sender's sync name, only while the key it came with still applies. */
  label(serviceUrl: string, syncId: string): string | undefined {
    return this.key(serviceUrl, syncId) ? this.bound?.label : undefined;
  }

  /** The link key, only while the form still names the link's service and ID. */
  key(serviceUrl: string, syncId: string): string | undefined {
    const bound = this.bound;
    if (!bound || syncId.trim() !== bound.syncId) return undefined;
    return sameService(serviceUrl, bound.serviceUrl) ? bound.key : undefined;
  }

  /** Re-evaluates whether the key still applies (after any form edit). */
  refresh(): void {
    const bound = this.bound;
    if (bound && !this.key(this.config.picker().url, this.config.syncId.value)) {
      this.bound = undefined;
      this.hideDiscard();
      this.showEntry();
      this.config.onChange();
    }
  }

  reset(): void {
    this.generation++;
    this.bound = undefined;
    this.dropOnce();
    this.input.value = '';
    this.hideDiscard();
    this.showEntry();
    this.error.hidden = true;
    this.error.textContent = '';
  }

  /** True while a link was read or a one-time link waits to be opened. */
  get engaged(): boolean {
    return !!this.bound || !!this.pending;
  }

  /** Focus target when the field is shown. */
  focus(): void {
    (this.entry.hidden ? this.change : this.input).focus();
  }

  /** "Use another link": forget the link (and its key) and offer the paste
   *  field again. A key from a one-time link cannot be read again (the link
   *  is used up), so that case asks first. */
  private startOver(confirmed = false): void {
    if (this.bound?.once && !confirmed) {
      this.discard.hidden = false;
      this.change.disabled = true;
      this.discardNo.focus();
      return;
    }
    const had = !!this.bound;
    this.reset();
    if (had) this.config.onChange();
    this.input.focus();
  }

  private showEntry(): void {
    this.entry.hidden = false;
    this.summary.hidden = true;
    this.note.textContent = '';
    this.note.hidden = true;
  }

  /** Replaces the paste row with what the link brought. */
  private showSummary(serviceUrl: string, syncId: string | undefined, note: string): void {
    this.entry.hidden = true;
    this.summaryText.textContent = syncId ? `${hostOf(serviceUrl)} · ${syncId.slice(0, 8)}…` : hostOf(serviceUrl);
    this.note.textContent = note;
    this.note.hidden = !note;
    this.summary.hidden = false;
  }

  private fail(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.input.focus();
  }

  private dropOnce(): void {
    this.pending = undefined;
    this.redeeming = false;
    this.once.hidden = true;
    this.code.value = '';
    this.code.removeAttribute('aria-invalid');
    this.openOnce.disabled = false;
    this.code.disabled = false;
    this.openOnce.removeAttribute('aria-busy');
  }

  /** Shows a parsed one-time link: nothing is sent until "Open link". */
  private offerOnce(parsed: HandoffSecret): void {
    this.generation++;
    if (this.bound) { this.bound = undefined; this.showEntry(); this.config.onChange(); }
    this.dropOnce();
    this.pending = parsed;
    this.error.hidden = true;
    this.showSummary(parsed.serviceUrl, undefined, '');
    this.onceNote.textContent = t('link.onceNote', { service: parsed.serviceUrl });
    this.codeRow.hidden = !parsed.codeRequired;
    this.once.hidden = false;
    (parsed.codeRequired ? this.code : this.openOnce).focus();
  }

  private failOnce(message: string, focus: HTMLElement): void {
    this.error.textContent = message;
    this.error.hidden = false;
    focus.focus();
  }

  /** Redeems the pending link once. A wrong code keeps it (attempts are
   *  counted by the service); a transport failure keeps it too, so the user
   *  may try again knowingly; anything else drops it. */
  private async redeemOnce(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.redeeming) return;
    const code = this.code.value.replace(/\s+/g, '');
    if (pending.codeRequired && !isHandoffCode(code)) {
      this.code.setAttribute('aria-invalid', 'true');
      this.failOnce(t('handoff.codeRequired'), this.code);
      return;
    }
    const generation = ++this.generation;
    this.redeeming = true;
    this.openOnce.disabled = true;
    this.code.disabled = true;
    this.openOnce.setAttribute('aria-busy', 'true');
    this.error.hidden = true;
    const link = buildHandoffLink(pending.serviceUrl, pending.token, pending.codeRequired);
    const redeem = this.config.redeem
      ?? ((value: string, c?: string) => send<RedeemedShareLink>({ command: MessageCommand.RedeemShareLink, link: value, ...(c ? { code: c } : {}) }));
    try {
      const result = await redeem(link, pending.codeRequired ? code : undefined);
      if (generation !== this.generation) return;
      this.dropOnce();
      await this.adopt(result, t('link.acquiredOnce', { id: `${result.id.slice(0, 8)}…` }), generation, true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.redeeming = false;
      this.openOnce.disabled = false;
      this.code.disabled = false;
      this.openOnce.removeAttribute('aria-busy');
      const message = error instanceof Error && error.message ? error.message : t('handoff.damaged');
      if (error instanceof HandoffAuthFailedException) {
        this.code.value = '';
        this.code.setAttribute('aria-invalid', 'true');
        this.failOnce(message, this.code);
      } else if (error instanceof ServiceOfflineException) {
        this.failOnce(message, this.openOnce);
      } else {
        this.dropOnce();
        this.showEntry();
        this.failOnce(message, this.input);
      }
    }
  }

  /** Binds a key (from either format) to its service and ID. */
  private async adopt(parsed: RedeemedShareLink, note: string, generation: number, once = false): Promise<void> {
    this.error.hidden = true;
    this.config.syncId.value = parsed.id;
    this.bound = { serviceUrl: parsed.serviceUrl, syncId: parsed.id, key: parsed.key, ...(parsed.label ? { label: parsed.label } : {}), ...(once ? { once } : {}) };
    this.showSummary(parsed.serviceUrl, parsed.id, note);
    this.config.onChange();
    await this.config.picker().select(parsed.serviceUrl, true, true);
    if (generation !== this.generation) return;
    this.config.onChange();
  }

  private async apply(): Promise<void> {
    const text = this.input.value;
    if (!text.trim()) return;
    const once = parseHandoffLink(text);
    if (once) {
      this.input.value = '';
      const urlError = validateServiceUrl(once.serviceUrl);
      if (urlError) { this.dropOnce(); this.fail(urlError); return; }
      this.offerOnce(once);
      return;
    }
    const parsed = parseShareLink(text);
    if (!parsed) {
      this.input.value = '';
      this.fail(t('link.invalid'));
      return;
    }
    this.input.value = '';
    const urlError = validateServiceUrl(parsed.serviceUrl);
    if (urlError) {
      this.fail(urlError);
      return;
    }
    const generation = ++this.generation;
    this.dropOnce();
    await this.adopt(parsed, t('link.acquired', { id: `${parsed.id.slice(0, 8)}…` }), generation);
  }
}

function hostOf(serviceUrl: string): string {
  try { return new URL(serviceUrl).host + new URL(serviceUrl).pathname.replace(/\/+$/, ''); } catch { return serviceUrl; }
}

function sameService(a: string, b: string): boolean {
  try { return normalizeServiceUrl(a) === normalizeServiceUrl(b); } catch { return a.trim() === b.trim(); }
}
