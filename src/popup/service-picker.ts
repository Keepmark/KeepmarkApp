import { DefaultServiceUrl } from '../shared/constants.js';
import { getLang, t } from '../shared/i18n.js';
import { MessageCommand, type ServiceProbeResponse } from '../shared/messages.js';
import { ServiceStatus } from '../shared/models.js';
import { mergeServiceCatalog, normalizeServiceUrl, type ServiceOption } from '../shared/service-catalog.js';
import { formatBytes, send, validateServiceUrl } from './ui.js';

/** One URL selector for connect and move. Probes never save an address. */
export class ServicePicker {
  private readonly root = document.createElement('div');
  private readonly menu = document.createElement('details');
  private readonly summary = document.createElement('summary');
  private readonly selected = document.createElement('span');
  private readonly options = document.createElement('fieldset');
  private readonly customLabel: HTMLLabelElement;
  private readonly test = document.createElement('button');
  private readonly feedback = document.createElement('div');
  private entries = mergeServiceCatalog();
  private custom = false;
  private generation = 0;
  private checkedUrl = '';
  private result?: ServiceProbeResponse;
  private busy = false;
  private loaded = false;

  constructor(private readonly config: {
    input: HTMLInputElement;
    mode: () => 'new' | 'existing';
    onChange: () => void;
    onState: () => void;
  }) {
    const { input } = config;
    this.customLabel = input.closest('label')!;
    this.customLabel.before(this.root);
    this.root.className = 'service-picker';
    const label = document.createElement('span');
    label.className = 'service-picker-label';
    label.textContent = t('servicePicker.label');
    label.id = `${input.id}-label`;
    this.menu.className = 'service-picker-menu';
    this.summary.setAttribute('aria-labelledby', label.id);
    this.summary.append(this.selected);
    this.options.className = 'service-picker-options';
    const legend = document.createElement('legend');
    legend.className = 'sr-only';
    legend.textContent = label.textContent;
    this.options.append(legend);
    this.menu.append(this.summary, this.options);
    const hint = document.createElement('small');
    hint.className = 'hint';
    hint.textContent = t('servicePicker.customHint');
    this.customLabel.querySelector('span')!.textContent = t('servicePicker.url');
    this.customLabel.append(hint);
    this.test.type = 'button';
    this.test.className = 'service-picker-test';
    this.test.textContent = t('servicePicker.check');
    this.test.id = `${input.id}-check`;
    this.feedback.id = `${input.id}-feedback`;
    this.feedback.className = 'service-picker-feedback';
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    this.root.append(label, this.menu, this.customLabel, this.test, this.feedback);
    this.customLabel.hidden = this.test.hidden = true;
    input.value ||= DefaultServiceUrl;
    input.addEventListener('input', () => {
      this.generation++;
      this.checkedUrl = '';
      this.result = undefined;
      this.config.onChange();
      this.show(t('servicePicker.needsCheck'));
      this.notify();
    });
    this.test.addEventListener('click', () => void this.probe());
    this.summary.addEventListener('click', event => { if (this.busy) event.preventDefault(); });
    this.renderOptions();
  }

  get ready(): boolean {
    const info = this.result;
    return !!info && this.checkedUrl === this.url && info.reachable && info.versionCompatible &&
      (info.status === ServiceStatus.Online ||
        (info.status === ServiceStatus.NoNewSyncs && this.config.mode() === 'existing'));
  }

  get url(): string { return this.config.input.value.trim(); }

  /** Lazy: opening a linked popup or another manager section probes no targets. */
  async load(initialUrl = this.url): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const entries = await send<ServiceOption[]>({ command: MessageCommand.GetServices });
      this.entries = mergeServiceCatalog(entries ?? []);
    } catch (err) {
      this.show((err as Error).message, true);
    }
    // Preserve edits made while the catalog was loading.
    await this.select(this.url === DefaultServiceUrl || !this.url ? initialUrl : this.url, false);
  }

  /** Restore a URL supplied by current credentials without treating it as verified. */
  async select(value: string, emit = true): Promise<void> {
    this.generation++;
    this.result = undefined;
    this.checkedUrl = '';
    let normalized = value;
    try { normalized = normalizeServiceUrl(value); } catch { /* Custom input is validated by probe. */ }
    const match = this.entries.find(entry => entry.url === normalized);
    this.custom = !match;
    this.config.input.value = match?.url ?? value;
    this.customLabel.hidden = this.test.hidden = !this.custom;
    this.menu.open = false;
    this.renderOptions();
    if (emit) this.config.onChange();
    this.show(t('servicePicker.needsCheck'));
    this.notify();
    if (!this.custom) await this.probe();
  }

  updateMode(): void { this.renderFeedback(); this.notify(); }

  setBusy(value: boolean): void {
    this.busy = value;
    if (value) this.menu.open = false;
    this.summary.setAttribute('aria-disabled', String(value));
    this.config.input.disabled = value;
    this.options.querySelectorAll('input').forEach(input => { input.disabled = value; });
    this.test.disabled = value;
  }

  private notify(): void { this.config.onState(); }

  private location(entry: ServiceOption): string {
    const key = { GB: 'servicePicker.countryGB', CA: 'servicePicker.countryCA', DE: 'servicePicker.countryDE', IT: 'servicePicker.countryIT' } as const;
    const country = entry.location;
    if (!country) return t('servicePicker.unknown');
    if (country in key) return t(key[country as keyof typeof key]);
    // /info may return a country name rather than a country code.
    if (/^[A-Z]{2}$/.test(country)) return new Intl.DisplayNames([getLang()], { type: 'region' }).of(country) ?? country;
    return country;
  }

  private describe(entry: ServiceOption): string {
    return `${this.location(entry)} · ${entry.maxSyncSize === undefined ? t('servicePicker.unknown') : formatBytes(entry.maxSyncSize)} · API ${entry.version ?? '—'}`;
  }

  private renderOptions(): void {
    const legend = this.options.querySelector('legend')!;
    this.options.replaceChildren(legend);
    let current: ServiceOption | undefined;
    for (const [index, entry] of this.entries.entries()) {
      const row = document.createElement('label');
      row.className = 'service-picker-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `${this.config.input.id}-provider`;
      radio.value = entry.url;
      try { radio.checked = !this.custom && normalizeServiceUrl(this.url) === entry.url; } catch { radio.checked = false; }
      if (radio.checked) current = entry;
      radio.disabled = this.busy;
      // Click also retries the selected service, with no separate test button.
      radio.addEventListener('click', () => void this.select(entry.url));
      const text = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'service-picker-host';
      title.textContent = entry.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const badge = index === 0 ? t('servicePicker.default') : entry.saved ? t('servicePicker.saved') : '';
      if (badge) title.append(` · ${badge}`);
      const meta = document.createElement('small');
      meta.textContent = this.describe(entry);
      text.append(title, meta);
      row.append(radio, text);
      this.options.append(row);
    }
    const customRow = document.createElement('label');
    customRow.className = 'service-picker-option';
    const custom = document.createElement('input');
    custom.type = 'radio';
    custom.name = `${this.config.input.id}-provider`;
    custom.value = 'custom';
    custom.checked = this.custom;
    custom.disabled = this.busy;
    custom.addEventListener('click', () => {
      this.generation++;
      this.custom = true;
      this.checkedUrl = '';
      this.result = undefined;
      this.config.input.value = '';
      this.menu.open = false;
      this.customLabel.hidden = this.test.hidden = false;
      this.renderOptions();
      this.config.onChange();
      this.show(t('servicePicker.needsCheck'));
      this.notify();
      this.config.input.focus();
    });
    customRow.append(custom, t('servicePicker.custom'));
    this.options.append(customRow);
    this.selected.replaceChildren();
    const name = document.createElement('span');
    name.textContent = this.custom ? t('servicePicker.custom') : (current?.url ?? this.url).replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.selected.append(name);
    if (current) {
      const meta = document.createElement('small');
      meta.textContent = this.describe(current);
      this.selected.append(meta);
    }
  }

  private show(text: string, error = false): void {
    this.feedback.textContent = text;
    this.feedback.classList.toggle('service-picker-error', error);
  }

  private renderFeedback(): void {
    if (!this.result) return;
    const info = this.result;
    if (!info.reachable || info.status === ServiceStatus.Offline || info.status === ServiceStatus.Error) this.show(t('servicePicker.unreachable'), true);
    else if (!info.versionCompatible) this.show(t('servicePicker.incompatible'), true);
    else if (info.status === ServiceStatus.NoNewSyncs && this.config.mode() === 'new') this.show(t('servicePicker.noNew'), true);
    else {
      this.show(t('servicePicker.available'));
      if (this.custom) {
        const detail = document.createElement('small');
        detail.textContent = t('servicePicker.details', { version: info.version ?? '—', size: info.maxSyncSize === undefined ? '—' : formatBytes(info.maxSyncSize) });
        if (info.location) detail.append(` · ${this.location({ url: this.url, location: info.location })}`);
        this.feedback.append(detail);
        if (info.message) {
          const message = document.createElement('small');
          message.textContent = info.message;
          this.feedback.append(message);
        }
      }
    }
  }

  private async probe(): Promise<void> {
    const generation = ++this.generation;
    this.result = undefined;
    this.checkedUrl = '';
    this.notify();
    const error = validateServiceUrl(this.url);
    if (error) { this.show(error, true); return; }
    const url = this.url;
    this.test.disabled = true;
    this.show(t('servicePicker.checking'));
    try {
      const result = await send<ServiceProbeResponse>({ command: MessageCommand.ProbeService, serviceUrl: url });
      if (generation !== this.generation) return;
      this.result = result;
      this.checkedUrl = url;
      if (result.reachable) {
        const entry = this.entries.find(entry => entry.url === url);
        if (entry) {
          entry.location = result.location ?? entry.location;
          entry.maxSyncSize = result.maxSyncSize ?? entry.maxSyncSize;
          entry.version = result.version ?? entry.version;
          this.renderOptions();
        }
      }
      this.renderFeedback();
    } catch (err) {
      if (generation === this.generation) this.show((err as Error).message, true);
    } finally {
      if (generation === this.generation) { this.test.disabled = this.busy; this.notify(); }
    }
  }
}
