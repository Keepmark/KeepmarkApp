// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidCredentialsException } from '../src/shared/errors';
import { t } from '../src/shared/i18n';
import { ConnectQrController } from '../src/manager/connect-qr';
import type { ConnectQrPayload } from '../src/shared/connect-qr';
const payload: ConnectQrPayload = { app: 'Keepmark', format: 1, serviceType: 'xbrowsersync', serviceUrl: 'https://example.test:8443/sync', id: 'synthetic-id', version: '1.8.0', password: 'À 日本 🔑' };
let controller: ConnectQrController;
let focus: boolean;
let render: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
const el = (id: string): HTMLElement => document.getElementById(id)!;
function submit(): void {
  (el('qr-password') as HTMLInputElement).value = payload.password;
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
beforeEach(() => {
  vi.useFakeTimers(); focus = true;
  document.body.innerHTML = '<div id="root"><button id="qr-open"></button><dialog id="qr-panel"><form><input id="qr-password"><button id="qr-generate"></button><div id="qr-error"></div></form><div id="qr-output"></div><p id="qr-countdown"></p><button id="qr-close"></button></dialog><p id="qr-feedback"></p></div>';
  render = vi.fn(async (canvas: HTMLCanvasElement) => { canvas.width = 320; canvas.height = 320; });
  prepare = vi.fn(async () => payload);
  controller = new ConnectQrController(el('root'), prepare, { render, focused: () => focus, now: () => Date.now() });
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  el('qr-open').click();
});
afterEach(() => { controller.close(); vi.useRealTimers(); });
it('clears password, renders a detached canvas and expires at 60 seconds', async () => {
  submit(); expect((el('qr-password') as HTMLInputElement).value).toBe(''); await settle();
  expect(render.mock.calls[0][0].isConnected).toBe(true);
  expect(el('qr-output').children).toHaveLength(1);
  vi.advanceTimersByTime(59_000); expect(el('qr-panel').hidden).toBe(false);
  vi.advanceTimersByTime(1000); expect(el('qr-panel').hidden).toBe(true);
  expect(el('qr-output').children).toHaveLength(0);
  expect(render.mock.calls[0][0].width).toBe(0);
});
it.each(['blur', 'pagehide', 'pageshow'])('closes on %s and erases pixels', async (event) => {
  submit(); await settle(); window.dispatchEvent(new Event(event));
  expect(el('qr-output').children).toHaveLength(0); expect(render.mock.calls[0][0].width).toBe(0);
});
it('rejects delayed verification after close and does not expose error details', async () => {
  let resolve!: (value: ConnectQrPayload) => void;
  prepare.mockImplementation(() => new Promise<ConnectQrPayload>((r) => { resolve = r; }));
  submit(); controller.close(); resolve(payload); await settle(); expect(render).not.toHaveBeenCalled();
  el('qr-open').click(); prepare.mockRejectedValue(new Error(payload.password)); submit(); await settle();
  expect(el('qr-error').textContent).not.toContain(payload.password); expect(el('qr-output').children).toHaveLength(0);
});
it('erases detached canvas when closed during rendering', async () => {
  let complete!: () => void;
  render.mockImplementation((canvas: HTMLCanvasElement) => { canvas.width = 320; expect(canvas.isConnected).toBe(false); return new Promise<void>((r) => { complete = r; }); });
  submit(); await settle(); controller.close(); complete(); await settle();
  expect(render.mock.calls[0][0].width).toBe(0); expect(el('qr-output').children).toHaveLength(0);
});
it('requires focus before starting and after each async step', async () => {
  focus = false; submit(); expect(prepare).not.toHaveBeenCalled();
  focus = true; submit(); focus = false; await settle(); expect(render).not.toHaveBeenCalled();
});
it('closes on identity changes and Escape', async () => {
  submit(); await settle(); controller.updateStatus(); expect(el('qr-panel').hidden).toBe(true);
  expect((el('qr-open') as HTMLButtonElement).disabled).toBe(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(el('qr-output').children).toHaveLength(0);
});
it('closes on hidden visibility and Escape', async () => {
  submit(); await settle();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(el('qr-output').children).toHaveLength(0);
  el('qr-open').click(); submit(); await settle();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(el('qr-output').children).toHaveLength(0);
  hidden.mockRestore();
});
it('a stale generation cannot replace a newer QR', async () => {
  let resolve!: (value: ConnectQrPayload) => void;
  prepare.mockImplementationOnce(() => new Promise<ConnectQrPayload>((r) => { resolve = r; }));
  submit(); controller.close(); el('qr-open').click(); submit(); await settle();
  const current = el('qr-output').firstElementChild;
  resolve(payload); await settle();
  expect(el('qr-output').firstElementChild).toBe(current); expect(render).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain(payload.password);
  expect(document.querySelector('[data-password]')).toBeNull();
});
it('opens a modal with focus on password, hides launch and restores it on close', () => {
  expect((el('qr-panel') as HTMLDialogElement).open).toBe(true);
  expect(el('qr-open').hidden).toBe(true);
  expect(document.activeElement).toBe(el('qr-password'));
  el('qr-close').click();
  expect((el('qr-panel') as HTMLDialogElement).open).toBe(false);
  expect(el('qr-open').hidden).toBe(false);
  expect(document.activeElement).toBe(el('qr-open'));
});
it('outside clicks close and erase the QR, while inside clicks and drags do not', async () => {
  submit(); await settle();
  const panel = el('qr-panel');
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, right: 400, bottom: 500 } as DOMRect);
  panel.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 30 }));
  panel.dispatchEvent(new MouseEvent('click', { clientX: 30, clientY: 30 }));
  expect(panel.hidden).toBe(false);
  panel.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 30 }));
  panel.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
  expect(panel.hidden).toBe(false);
  panel.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0 }));
  panel.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
  expect(panel.hidden).toBe(true);
  expect(render.mock.calls[0][0].width).toBe(0);
});
it('native cancellation and external dialog close invalidate verification', async () => {
  let resolve!: (value: ConnectQrPayload) => void;
  prepare.mockImplementation(() => new Promise<ConnectQrPayload>((r) => { resolve = r; }));
  submit();
  const event = new Event('cancel', { cancelable: true });
  el('qr-panel').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  resolve(payload); await settle();
  expect(render).not.toHaveBeenCalled();
  el('qr-open').click();
  (el('qr-panel') as HTMLDialogElement).close();
  await settle();
  expect(el('qr-panel').hidden).toBe(true);
  el('qr-open').click();
  // A queued close event from a previous instance must not close the reopened dialog.
  el('qr-panel').dispatchEvent(new Event('close'));
  expect(el('qr-panel').hidden).toBe(false);
});

it('wrong password keeps contextual feedback in the modal and allows an immediate retry', async () => {
  prepare.mockRejectedValueOnce(new InvalidCredentialsException(t('core.currentPwWrong')));
  submit(); await settle();
  expect((el('qr-panel') as HTMLDialogElement).open).toBe(true);
  expect(el('qr-error').closest('dialog')).toBe(el('qr-panel'));
  expect(el('qr-error').textContent).toBe(t('core.currentPwWrong'));
  expect(el('qr-password').getAttribute('aria-invalid')).toBe('true');
  expect((el('qr-password') as HTMLInputElement).value).toBe('');
  expect(document.activeElement).toBe(el('qr-password'));
  expect((el('qr-generate') as HTMLButtonElement).disabled).toBe(false);
  el('qr-password').dispatchEvent(new Event('input'));
  expect(el('qr-error').hidden).toBe(true);
  expect(el('qr-password').hasAttribute('aria-invalid')).toBe(false);
  submit(); await settle();
  expect(el('qr-output').children).toHaveLength(1);
});
it('render failure keeps the dialog open, clears the detached canvas and hides arbitrary error text', async () => {
  render.mockRejectedValueOnce(new Error(payload.password));
  submit(); await settle();
  expect((el('qr-panel') as HTMLDialogElement).open).toBe(true);
  expect(el('qr-error').textContent).not.toContain(payload.password);
  expect(render.mock.calls[0][0].width).toBe(0);
  expect(el('qr-output').children).toHaveLength(0);
  expect((el('qr-password') as HTMLInputElement).value).toBe('');
  el('qr-close').click();
  expect((el('qr-panel') as HTMLDialogElement).open).toBe(false);
});

it('hides the card while unlinked and explains a plain-HTTP service instead of failing silently', () => {
  const root = el('root');
  controller.updateStatus({ syncEnabled: false, serviceUrl: 'https://example.test/sync', syncId: payload.id, queueLength: 0, syncing: false });
  expect(root.hidden).toBe(true);
  expect((el('qr-open') as HTMLButtonElement).disabled).toBe(true);

  // Linked, but the service is plain HTTP: card visible, door closed, reason shown.
  el('root').insertAdjacentHTML('beforeend', '<small id="qr-destination"></small>');
  controller.updateStatus({ syncEnabled: true, serviceUrl: 'http://sync.example.test:8090/', syncId: payload.id, queueLength: 0, syncing: false });
  expect(root.hidden).toBe(false);
  expect((el('qr-open') as HTMLButtonElement).disabled).toBe(true);
  expect(el('qr-destination').textContent).toBe(t('qr.httpsRequired'));
  // The dialog cannot open while the button is disabled: the reason must be on
  // the card, not only inside the dialog.
  expect(el('qr-feedback').textContent).toBe(t('qr.httpsRequired'));
  expect(el('qr-feedback').hidden).toBe(false);

  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  expect((el('qr-open') as HTMLButtonElement).disabled).toBe(false);
  expect(el('qr-destination').textContent).toContain(payload.serviceUrl);
  expect(el('qr-feedback').hidden).toBe(true);
});

it('shows the HTTPS requirement when the background refuses to build the payload', async () => {
  prepare.mockRejectedValueOnce(new Error(t('qr.httpsRequired')));
  submit(); await settle();
  expect(el('qr-error').textContent).toBe(t('qr.httpsRequired'));
  expect(el('qr-error').hidden).toBe(false);
  expect((el('qr-generate') as HTMLButtonElement).disabled).toBe(false);
});
