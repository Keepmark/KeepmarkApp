import { renderConnectQr } from './render-connect-qr.js';
import { InvalidCredentialsException } from '../shared/errors.js';
import { serializeConnectQrPayload, type ConnectQrPayload } from '../shared/connect-qr.js';
import type { StatusResponse } from '../shared/messages.js';
import { t } from '../shared/i18n.js';

interface QrDependencies {
  prepare(password: string): Promise<ConnectQrPayload>;
  render(canvas: HTMLCanvasElement, json: string): Promise<unknown>;
  now(): number;
  focused(): boolean;
}

/** Owns only transient UI state. Secrets remain in operation-local variables. */
export class ConnectQrController {
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline = 0;
  private identity = '';
  /** The payload only accepts an https service URL: a plain-http link (self
   *  hosted on the LAN) gets the card disabled with the reason spelled out. */
  private httpsOk = false;
  private busy = false;
  private canvas: HTMLCanvasElement | undefined;
  private readonly deps: QrDependencies;
  private readonly input: HTMLInputElement;
  private readonly panel: HTMLDialogElement;
  private readonly output: HTMLElement;
  private readonly error: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly generate: HTMLButtonElement;
  private readonly open: HTMLButtonElement;

  constructor(private readonly root: HTMLElement, prepare: QrDependencies['prepare'], overrides: Partial<QrDependencies> = {}) {
    this.deps = {
      prepare,
      render: renderConnectQr,
      now: () => performance.now(),
      focused: () => document.visibilityState === 'visible' && document.hasFocus(),
      ...overrides,
    };
    this.input = root.querySelector('#qr-password')!;
    this.panel = root.querySelector('#qr-panel')!;
    this.output = root.querySelector('#qr-output')!;
    this.error = root.querySelector('#qr-error')!;
    this.countdown = root.querySelector('#qr-countdown')!;
    this.generate = root.querySelector('#qr-generate')!;
    this.open = root.querySelector('#qr-open')!;
    this.input.addEventListener('input', () => {
      this.error.hidden = true;
      this.error.textContent = '';
      this.input.removeAttribute('aria-invalid');
    });
    this.open.addEventListener('click', () => {
      this.close();
      if (!this.identity || !this.deps.focused()) return;
      this.error.hidden = true;
      this.error.textContent = '';
      this.panel.hidden = false;
      this.open.hidden = true;
      this.panel.showModal();
      this.root.querySelector('form')!.hidden = false;
      this.input.focus();
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
    root.querySelector('#qr-close')!.addEventListener('click', () => this.close(true));
    root.querySelector('form')!.addEventListener('submit', (event) => {
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
    if (identity !== this.identity) this.close();
    this.identity = identity;
    this.httpsOk = /^https:\/\//i.test(status?.serviceUrl ?? '');
    // Nothing to link while the browser is unlinked: an inert card would only
    // push the "how to connect" hint further down the status section.
    this.root.hidden = !identity;
    const destination = this.root.querySelector('#qr-destination');
    if (destination) {
      destination.textContent = identity
        ? (this.httpsOk ? `${status!.serviceUrl} · ${status!.syncId!.slice(0, 8)}…` : t('qr.httpsRequired'))
        : '';
    }
    this.open.disabled = !this.canPrepare();
    this.announce(this.standingMessage());
  }

  /** The payload refuses plain HTTP (Keepmark for Android will not consume it
   *  either): the button stays disabled and the card itself says why. */
  private canPrepare(): boolean {
    return !!this.identity && this.httpsOk && !this.busy;
  }

  /** Reason spelled out on the card while the dialog is closed ('' when the
   *  card is usable), so a disabled button is never a dead end. */
  private standingMessage(): string {
    return this.identity && !this.httpsOk ? t('qr.httpsRequired') : '';
  }

  close(restoreFocus = false): void {
    const wasOpen = !this.panel.hidden;
    ++this.generation;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.deadline = 0;
    this.busy = false;
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
    if (restoreFocus && !this.root.hidden && this.deps.focused()) this.open.focus();
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
    return generation === this.generation && this.deps.focused() && !this.panel.hidden && !this.root.hidden;
  }

  private async verify(): Promise<void> {
    if (this.busy || !this.identity || !this.deps.focused() || this.panel.hidden) return;
    if (!this.input.value) return;
    const generation = ++this.generation;
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
      const pending = this.deps.prepare(password);
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
      this.root.querySelector('form')!.hidden = true;
      this.root.querySelector<HTMLButtonElement>('#qr-close')!.focus();
      canvas = undefined;
      this.tick();
      this.timer = setInterval(() => this.tick(), 250);
    } catch (error) {
      if (this.valid(generation)) {
        const wrongPassword = error instanceof InvalidCredentialsException && error.message === t('core.currentPwWrong');
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
