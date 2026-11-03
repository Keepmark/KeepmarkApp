import { renderConnectQr } from './render-connect-qr.js';
import { InvalidCredentialsException } from '../shared/errors.js';
import {
  serializeConnectQrPayload,
  type ConnectQrPayload,
  type ConnectQrTarget,
} from '../shared/connect-qr.js';
import type { StatusResponse } from '../shared/messages.js';
import { t } from '../shared/i18n.js';

interface QrDependencies {
  prepare(password: string, target?: ConnectQrTarget): Promise<ConnectQrPayload>;
  render(canvas: HTMLCanvasElement, json: string): Promise<unknown>;
  now(): number;
  focused(): boolean;
}

/** Owns only transient UI state. Secrets remain in operation-local variables. */
export class ConnectQrController {
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline = 0;
  /** Identity of the ACTIVE sync (the card's own subject). */
  private activeIdentity = '';
  /** Set while the dialog was opened from a registry row: the dialog then
   *  belongs to that row, not to the active sync, and the status card may stay
   *  hidden (rows survive an unlink). */
  private target: ConnectQrTarget | undefined;
  private trigger: HTMLElement | undefined;
  /** The payload only accepts an https service URL: a plain-http link (self
   *  hosted on the LAN) gets the card disabled with the reason spelled out. */
  private httpsOk = false;
  private busy = false;
  private canvas: HTMLCanvasElement | undefined;
  private readonly deps: QrDependencies;
  private readonly input: HTMLInputElement;
  private readonly label: HTMLLabelElement;
  private readonly destination: HTMLElement;
  private readonly panel: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly output: HTMLElement;
  private readonly error: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly generate: HTMLButtonElement;
  private readonly open: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    prepare: QrDependencies['prepare'],
    overrides: Partial<QrDependencies> = {},
    /** Where the dialog lives. Outside the status card so a row can open it
     *  while the card is hidden (an unlinked browser keeps its dormant rows). */
    private readonly host: HTMLElement = root,
  ) {
    this.deps = {
      prepare,
      render: renderConnectQr,
      now: () => performance.now(),
      focused: () => document.visibilityState === 'visible' && document.hasFocus(),
      ...overrides,
    };
    this.input = host.querySelector('#qr-password')!;
    this.label = host.querySelector('#qr-password-label')!;
    this.destination = host.querySelector('#qr-destination')!;
    this.panel = host.querySelector('#qr-panel')!;
    this.form = host.querySelector('form')!;
    this.output = host.querySelector('#qr-output')!;
    this.error = host.querySelector('#qr-error')!;
    this.countdown = host.querySelector('#qr-countdown')!;
    this.generate = host.querySelector('#qr-generate')!;
    this.closeButton = host.querySelector('#qr-close')!;
    this.open = root.querySelector('#qr-open')!;
    this.input.addEventListener('input', () => {
      this.error.hidden = true;
      this.error.textContent = '';
      this.input.removeAttribute('aria-invalid');
    });
    this.open.addEventListener('click', () => {
      this.close();
      if (!this.activeIdentity || !this.deps.focused()) return;
      this.begin(undefined, this.open);
    });
    this.panel.addEventListener('cancel', (event) => { event.preventDefault(); this.close(true); });
    this.panel.addEventListener('close', () => { if (!this.panel.hidden && !this.panel.open) this.close(true); });
    let backdropDown = false;
    const outside = (event: MouseEvent): boolean => {
      const rect = this.panel.getBoundingClientRect();
      return event.target === this.panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    this.panel.addEventListener('pointerdown', (event) => { backdropDown = outside(event); });
    this.panel.addEventListener('click', (event) => {
      if (backdropDown && outside(event)) this.close(true);
      backdropDown = false;
    });
    this.closeButton.addEventListener('click', () => this.close(true));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.verify();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.close(true); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.close(); });
    window.addEventListener('blur', () => this.close());
    window.addEventListener('pagehide', () => this.close());
    window.addEventListener('pageshow', () => this.close());
    this.close();
  }

  updateStatus(status?: StatusResponse): void {
    const identity = status?.syncEnabled && status.serviceUrl && status.syncId
      ? `${status.serviceUrl}\n${status.syncId}` : '';
    const changed = identity !== this.activeIdentity;
    this.activeIdentity = identity;
    // The card's dialog follows the active sync; a row's dialog does not.
    if (changed && !this.target) this.close();
    this.httpsOk = /^https:\/\//i.test(status?.serviceUrl ?? '');
    // Nothing to link while the browser is unlinked: an inert card would only
    // push the "how to connect" hint further down the status section.
    this.root.hidden = !identity;
    if (!this.target) this.setSubject();
    this.open.disabled = !this.canPrepare();
    this.announce(this.standingMessage());
  }

  /** Row entry point: show the QR for one saved sync, active or not. The row
   *  carries its own service and ID, so the dialog no longer depends on the
   *  status card (which is hidden while unlinked). */
  openFor(target: ConnectQrTarget, trigger: HTMLElement): void {
    this.close();
    if (!this.deps.focused()) return;
    this.begin(target, trigger);
  }

  /** The payload refuses plain HTTP (Keepmark for Android will not consume it
   *  either): the button stays disabled and the card itself says why. */
  private canPrepare(): boolean {
    return !!this.activeIdentity && this.httpsOk && !this.busy;
  }

  /** Reason spelled out on the card while the dialog is closed ('' when the
   *  card is usable), so a disabled button is never a dead end. */
  private standingMessage(): string {
    return this.activeIdentity && !this.httpsOk ? t('qr.httpsRequired') : '';
  }

  /** Shared opening: the dialog is focused, one subject is named, nothing is
   *  generated until a password is proved. */
  private begin(target: ConnectQrTarget | undefined, trigger: HTMLElement): void {
    this.target = target;
    this.trigger = trigger;
    this.error.hidden = true;
    this.error.textContent = '';
    this.panel.hidden = false;
    this.open.hidden = true;
    this.panel.showModal();
    this.form.hidden = false;
    this.setSubject();
    if (target && !/^https:\/\//i.test(target.serviceUrl)) {
      this.error.textContent = t('qr.httpsRequired');
      this.error.hidden = false;
    }
    this.input.focus();
  }

  /** Names what the code will carry: the active sync, or the row that asked. */
  private setSubject(): void {
    if (this.target) {
      this.label.textContent = t('mgr.syncs.syncPassword');
      this.destination.textContent = `${this.target.serviceUrl} · ${this.target.syncId.slice(0, 8)}…`;
      return;
    }
    this.label.textContent = t('qr.password');
    this.destination.textContent = this.activeIdentity
      ? (this.httpsOk ? `${this.activeIdentity.split('\n')[0]} · ${this.activeIdentity.split('\n')[1].slice(0, 8)}…` : t('qr.httpsRequired'))
      : '';
  }

  close(restoreFocus = false): void {
    const wasOpen = !this.panel.hidden;
    const trigger = this.trigger ?? this.open;
    ++this.generation;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.deadline = 0;
    this.busy = false;
    this.target = undefined;
    this.trigger = undefined;
    this.open.disabled = !this.canPrepare();
    this.generate.disabled = false;
    this.setBusy(false);
    this.input.removeAttribute('aria-invalid');
    this.input.value = '';
    this.error.textContent = '';
    this.error.hidden = true;
    this.countdown.textContent = '';
    this.panel.hidden = true;
    if (this.panel.open) this.panel.close();
    this.open.hidden = false;
    if (this.canvas) this.erase(this.canvas);
    this.canvas = undefined;
    this.output.replaceChildren();
    this.announce(wasOpen ? t('qr.hidden') : this.standingMessage());
    if (restoreFocus && !trigger.hidden && this.deps.focused()) trigger.focus();
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.generate.setAttribute('aria-busy', String(busy));
    const label = this.generate.querySelector('[data-i18n="qr.generate"]');
    if (label) label.textContent = t(busy ? 'busy.checking' : 'qr.generate');
  }

  private announce(message: string): void {
    const feedback = this.root.querySelector<HTMLElement>('#qr-feedback');
    if (feedback) { feedback.textContent = message; feedback.hidden = !message; }
  }

  private erase(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }

  private valid(generation: number): boolean {
    return generation === this.generation && this.deps.focused() && !this.panel.hidden;
  }

  private async verify(): Promise<void> {
    if (this.busy || !this.deps.focused() || this.panel.hidden) return;
    if (!this.input.value) return;
    const generation = ++this.generation;
    const target = this.target;
    this.busy = true;
    this.open.disabled = true;
    this.generate.disabled = true;
    this.setBusy(true);
    this.input.removeAttribute('aria-invalid');
    this.announce('');
    this.error.hidden = true;
    this.error.textContent = '';
    let password = this.input.value;
    this.input.value = '';
    let payload: ConnectQrPayload | undefined;
    let json = '';
    let canvas: HTMLCanvasElement | undefined;
    try {
      const pending = this.deps.prepare(password, target);
      password = '';
      payload = await pending;
      if (!this.valid(generation)) {
        if (generation === this.generation) this.close();
        return;
      }
      json = serializeConnectQrPayload(payload);
      payload = undefined;
      canvas = document.createElement('canvas');
      await this.deps.render(canvas, json);
      json = '';
      if (!this.valid(generation)) {
        if (generation === this.generation) this.close();
        return;
      }
      this.deadline = this.deps.now() + 60_000;
      this.canvas = canvas;
      this.output.replaceChildren(canvas);
      this.form.hidden = true;
      this.closeButton.focus();
      canvas = undefined;
      this.tick();
      this.timer = setInterval(() => this.tick(), 250);
    } catch (error) {
      if (this.valid(generation)) {
        const wrongPassword = error instanceof InvalidCredentialsException
          && (error.message === t('core.currentPwWrong') || error.message === t('err.invalidCredentials'));
        this.input.value = '';
        this.input.removeAttribute('aria-invalid');
        if (wrongPassword) this.input.setAttribute('aria-invalid', 'true');
        this.error.textContent = wrongPassword ? t('core.currentPwWrong')
          : error instanceof Error && error.message === t('qr.tooLarge') ? t('qr.tooLarge')
          : error instanceof Error && error.message === t('qr.httpsRequired') ? t('qr.httpsRequired')
          : error instanceof Error && error.message === t('core.connectBusy') ? t('qr.busy')
          : t('qr.error');
        this.error.hidden = false;
        this.input.disabled = false;
        this.input.focus();
      }
    } finally {
      password = '';
      payload = undefined;
      json = '';
      if (canvas) this.erase(canvas);
      if (generation === this.generation) {
        this.busy = false;
        this.setBusy(false);
        // A visible code cannot be regenerated without closing and re-entering its password.
        this.generate.disabled = !!this.canvas;
      }
    }
  }

  private tick(): void {
    const remaining = this.deadline - this.deps.now();
    if (remaining <= 0 || !this.deps.focused()) {
      const expired = remaining <= 0;
      this.close();
      if (expired) {
        this.announce(t('qr.expired'));
      }
      return;
    }
    this.countdown.textContent = t('qr.countdown', { seconds: Math.ceil(remaining / 1000) });
  }
}
