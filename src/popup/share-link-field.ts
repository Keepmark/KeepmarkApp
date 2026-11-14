import { t } from '../shared/i18n.js';
import { normalizeServiceUrl } from '../shared/service-catalog.js';
import { looksLikeShareLink, parseShareLink } from '../shared/share-link.js';
import type { ServicePicker } from './service-picker.js';
import { validateServiceUrl } from './ui.js';

/**
 * "Shared link" entry of the existing-sync forms (popup and manager). A
 * pasted `keepmark://sync?…` link fills the service and the sync ID and
 * keeps its key in memory only: the password row is hidden while the form
 * still names that same service and ID. Editing either drops the key (the
 * password is asked again). The link text itself is cleared from the field
 * as soon as it is read.
 */
export class ShareLinkField {
  readonly root = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly use = document.createElement('button');
  private readonly note = document.createElement('p');
  private readonly error = document.createElement('div');
  private bound: { serviceUrl: string; syncId: string; key: string } | undefined;
  private generation = 0;

  constructor(private readonly config: {
    /** Prefix for element ids (`<prefix>-share-link`, …). */
    prefix: string;
    picker: () => ServicePicker;
    syncId: HTMLInputElement;
    /** Called whenever the key starts or stops applying. */
    onChange: () => void;
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
    const row = document.createElement('div');
    row.className = 'share-link-entry';
    row.append(label, this.use);
    const hint = document.createElement('small');
    hint.className = 'hint';
    hint.textContent = t('link.hint');
    this.note.id = `${prefix}-share-link-note`;
    this.note.className = 'notice';
    this.note.hidden = true;
    this.error.id = `${prefix}-share-link-error`;
    this.error.className = 'error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    this.root.append(row, hint, this.note, this.error);
    this.use.addEventListener('click', () => void this.apply());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.apply(); }
    });
    this.input.addEventListener('input', () => { this.error.hidden = true; });
    // A pasted link is applied at once: no extra click for the common case.
    this.input.addEventListener('paste', () => setTimeout(() => { if (looksLikeShareLink(this.input.value)) void this.apply(); }, 0));
    config.syncId.addEventListener('input', () => this.refresh());
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
      this.note.hidden = true;
      this.config.onChange();
    }
  }

  reset(): void {
    this.generation++;
    this.bound = undefined;
    this.input.value = '';
    this.note.hidden = true;
    this.error.hidden = true;
    this.error.textContent = '';
  }

  private fail(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.input.focus();
  }

  private async apply(): Promise<void> {
    const text = this.input.value;
    if (!text.trim()) return;
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
    this.error.hidden = true;
    this.config.syncId.value = parsed.id;
    this.bound = { serviceUrl: parsed.serviceUrl, syncId: parsed.id, key: parsed.key };
    this.note.textContent = t('link.acquired', { id: `${parsed.id.slice(0, 8)}…` });
    this.note.hidden = false;
    this.config.onChange();
    await this.config.picker().select(parsed.serviceUrl, true, true);
    if (generation !== this.generation) return;
    this.config.onChange();
  }
}

function sameService(a: string, b: string): boolean {
  try { return normalizeServiceUrl(a) === normalizeServiceUrl(b); } catch { return a.trim() === b.trim(); }
}
