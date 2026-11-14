import { renderConnectQr } from './render-connect-qr.js';
import { InvalidCredentialsException, InvalidSwitchPasswordException } from '../shared/errors.js';
import {
  serializeConnectQrPayload,
  type ConnectQrPayload,
  type ConnectQrTarget,
} from '../shared/connect-qr.js';
import { buildShareLink } from '../shared/share-link.js';
import type { StatusResponse } from '../shared/messages.js';
import { t } from '../shared/i18n.js';

interface QrDependencies {
  /** `switchPassword` is passed only when a sync lock is set. */
  prepare(switchPassword: string | undefined, target?: ConnectQrTarget): Promise<ConnectQrPayload>;
  /** Whether a sync lock is set: only then is a password asked. */
  lockSet(): Promise<boolean>;
  render(canvas: HTMLCanvasElement, json: string): Promise<unknown>;
  now(): number;
  focused(): boolean;
  /** Clipboard write for the shared link (rejects when denied). */
  copy(text: string): Promise<void>;
}

/** What the dialog hands out: the 60-second QR for the owner's phone, or
 *  the shared link (same key, text form) to send to someone else. */
export type ConnectQrKind = 'qr' | 'link';

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
  private kind: ConnectQrKind = 'qr';
  /** The payload only accepts an https service URL: a plain-http link (self
   *  hosted on the LAN) gets the card disabled with the reason spelled out. */
  private httpsOk = false;
  private busy = false;
  /** True while the sync lock state is unknown or set: the password field is
   *  shown (fail closed). False = no lock, the code is prepared at once. */
  private needsPassword = true;
  /** Set while the lock state is being read: no submit can run meanwhile. */
  private lockPending = false;
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

  private readonly entry: HTMLElement;

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
      lockSet: () => Promise.resolve(true),
      render: renderConnectQr,
      now: () => performance.now(),
      focused: () => document.visibilityState === 'visible' && document.hasFocus(),
      copy: (text) => navigator.clipboard.writeText(text),
      ...overrides,
    };
    this.input = host.querySelector('#qr-password')!;
    this.label = host.querySelector('#qr-password-label')!;
    this.destination = host.querySelector('#qr-destination')!;
    this.entry = host.querySelector('.qr-password-entry')!;
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
  openFor(target: ConnectQrTarget, trigger: HTMLElement, kind: ConnectQrKind = 'qr'): void {
    this.close();
    if (!this.deps.focused()) return;
    this.kind = kind;
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

  /** Shared opening: the dialog is focused and one subject is named. Without a
   *  sync lock the code is prepared at once; with one, nothing is generated
   *  until its password is proved. */
  private begin(target: ConnectQrTarget | undefined, trigger: HTMLElement): void {
    const generation = this.generation;
    this.target = target;
    this.trigger = trigger;
    this.error.hidden = true;
    this.error.textContent = '';
    this.panel.hidden = false;
    this.open.hidden = true;
    this.panel.showModal();
    this.form.hidden = false;
    this.applyKind();
    this.setSubject();
    if (target && !/^https:\/\//i.test(target.serviceUrl)) {
      this.error.textContent = t('qr.httpsRequired');
      this.error.hidden = false;
      // Nothing can be generated for a plain-HTTP service: no field to fill.
      this.showPassword(false);
      this.generate.disabled = true;
      return;
    }
    // Until the lock state is known the dialog stays inert (no field, no
    // button), then either asks the lock password or prepares the code.
    this.showPassword(false);
    this.generate.disabled = true;
    this.setBusy(true);
    this.lockPending = true;
    void this.deps.lockSet().catch(() => true).then((set) => {
      if (generation !== this.generation || this.panel.hidden) return;
      this.lockPending = false;
      this.setBusy(false);
      this.generate.disabled = false;
      this.needsPassword = set;
      this.showPassword(set);
      if (set) this.input.focus();
      else void this.verify();
    });
  }

  /** Dialog copy for the current kind: the same gate, two different handouts. */
  private applyKind(): void {
    const link = this.kind === 'link';
    const text = (id: string, key: Parameters<typeof t>[0]): void => {
      const el = this.host.querySelector<HTMLElement>(`#${id}`);
      if (el) el.textContent = t(key);
    };
    text('qr-dialog-title', link ? 'share.title' : 'qr.title');
    text('qr-instructions', link ? 'share.intro' : 'qr.scan');
    text('qr-security-note', link ? 'share.warning' : 'qr.explanation');
    this.panel.classList.toggle('share-link', link);
    this.setBusy(this.busy);
  }

  /** The password row exists only for a sync lock. */
  private showPassword(show: boolean): void {
    this.needsPassword = show;
    this.label.hidden = !show;
    this.input.hidden = !show;
    this.input.required = show;
    this.entry.classList.toggle('qr-no-password', !show);
  }

  /** Names what the code will carry: the active sync, or the row that asked. */
  private setSubject(): void {
    this.label.textContent = t('popup.saved.changePasswordLabel');
    if (this.target) {
      this.destination.textContent = `${this.target.serviceUrl} · ${this.target.syncId.slice(0, 8)}…`;
      return;
    }
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
    this.kind = 'qr';
    this.showPassword(true);
    this.lockPending = false;
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
    this.applyKind();
    if (restoreFocus && !trigger.hidden && this.deps.focused()) trigger.focus();
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.generate.setAttribute('aria-busy', String(busy));
    const label = this.generate.querySelector('#qr-generate-label');
    if (label) label.textContent = t(busy ? 'busy.checking' : this.kind === 'link' ? 'share.generate' : 'qr.generate');
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
    if (this.busy || this.lockPending || !this.deps.focused() || this.panel.hidden) return;
    if (this.needsPassword && !this.input.value) return;
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
    let password: string | undefined = this.needsPassword ? this.input.value : undefined;
    this.input.value = '';
    let payload: ConnectQrPayload | undefined;
    let json = '';
    let canvas: HTMLCanvasElement | undefined;
    try {
      const pending = this.deps.prepare(password, target);
      password = undefined;
      payload = await pending;
      if (!this.valid(generation)) {
        if (generation === this.generation) this.close();
        return;
      }
      if (this.kind === 'link') {
        const link = buildShareLink({ serviceUrl: payload.serviceUrl, id: payload.id, key: payload.key });
        payload = undefined;
        this.showLink(link);
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
        const wrongPassword = error instanceof InvalidSwitchPasswordException;
        this.input.value = '';
        this.input.removeAttribute('aria-invalid');
        if (wrongPassword) this.input.setAttribute('aria-invalid', 'true');
        this.error.textContent = wrongPassword ? t('core.switchWrongPassword')
          : error instanceof InvalidCredentialsException && error.message === t('qr.keyStale') ? t('qr.keyStale')
          : error instanceof Error && error.message === t('core.switchPasswordRequired') ? t('core.switchPasswordRequired')
          : error instanceof Error && error.message === t('qr.tooLarge') ? t('qr.tooLarge')
          : error instanceof Error && error.message === t('qr.httpsRequired') ? t('qr.httpsRequired')
          : error instanceof Error && error.message === t('core.connectBusy') ? t('qr.busy')
          : t('qr.error');
        this.error.hidden = false;
        this.input.disabled = false;
        // The lock may have been set meanwhile: ask for it from now on.
        if (error instanceof Error && error.message === t('core.switchPasswordRequired')) this.showPassword(true);
        if (this.needsPassword) this.input.focus();
        else this.generate.focus();
      }
    } finally {
      password = undefined;
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

  /** The link stays on screen while the dialog is open and in front (it is
   *  hidden on leave like the QR); Copy marks the clipboard item sensitive
   *  where the browser can (it cannot: say so in the warning). */
  private showLink(link: string): void {
    const box = document.createElement('textarea');
    box.id = 'share-link-text';
    box.readOnly = true;
    box.rows = 4;
    box.spellcheck = false;
    box.value = link;
    box.setAttribute('aria-label', t('share.linkLabel'));
    box.addEventListener('focus', () => box.select());
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.id = 'share-link-copy';
    copy.className = 'primary';
    copy.textContent = t('common.copy');
    copy.addEventListener('click', () => {
      const generation = this.generation;
      void this.deps.copy(box.value).then(
        () => { if (generation === this.generation) this.countdown.textContent = t('share.copied'); },
        () => {
          if (generation !== this.generation) return;
          box.focus();
          box.select();
          this.countdown.textContent = t('share.copyFailed');
        },
      );
    });
    this.output.replaceChildren(box, copy);
    this.form.hidden = true;
    this.countdown.textContent = '';
    box.focus();
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
