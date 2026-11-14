// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidSwitchPasswordException, ServiceOfflineException, XbsException } from '../src/shared/errors';
import { t } from '../src/shared/i18n';
import { ConnectQrController } from '../src/manager/connect-qr';
import type { ConnectQrPayload } from '../src/shared/connect-qr';
import { parseShareLink } from '../src/shared/share-link';
import { ShareLinkField } from '../src/popup/share-link-field';
import type { ServicePicker } from '../src/popup/service-picker';

vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));

const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const payload: ConnectQrPayload = { app: 'Keepmark', format: 2, serviceType: 'xbrowsersync', serviceUrl: 'https://api.example.test/sync', id: '0123456789abcdef0123456789abcdef', version: '1.8.0', key };
const vector = 'keepmark://sync?v=1&s=https%3A%2F%2Fapi.example.test%2Fsync&id=0123456789abcdef0123456789abcdef&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const el = (id: string): HTMLElement => document.getElementById(id)!;
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await Promise.resolve(); }

const dialogHtml = '<div id="root"><button id="qr-open"></button><dialog id="qr-panel"><h2 id="qr-dialog-title"></h2><p id="qr-instructions"></p><label id="qr-password-label"></label><p id="qr-destination"></p><form><div class="qr-password-entry"><input id="qr-password"></div><button id="qr-generate"><span id="qr-generate-label"></span></button><div id="qr-error"></div></form><div id="qr-output"></div><p id="qr-countdown"></p><p id="qr-security-note"></p><button id="qr-close"></button></dialog><p id="qr-feedback"></p></div><button id="row-share"></button>';

let controller: ConnectQrController;
let focus: boolean;
let render: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
let lockSet: ReturnType<typeof vi.fn>;
let copy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  focus = true;
  document.body.innerHTML = dialogHtml;
  render = vi.fn(async () => undefined);
  prepare = vi.fn(async () => payload);
  lockSet = vi.fn(async () => true);
  copy = vi.fn(async () => undefined);
  controller = new ConnectQrController(el('root'), prepare, { render, lockSet, copy, focused: () => focus, now: () => Date.now() });
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
});
afterEach(() => controller.close());

function openShare(): void {
  controller.openFor({ serviceUrl: payload.serviceUrl, syncId: payload.id }, el('row-share'), 'link');
}
function submit(password = 'lock pw'): void {
  (el('qr-password') as HTMLInputElement).value = password;
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

it('asks the sync lock password, then shows the link (never a QR) and copies it', async () => {
  openShare(); await settle();
  expect(el('qr-dialog-title').textContent).toBe(t('share.title'));
  expect(el('qr-security-note').textContent).toBe(t('share.warning'));
  expect(el('qr-generate-label').textContent).toBe(t('share.generate'));
  expect((el('qr-password') as HTMLInputElement).hidden).toBe(false);
  expect(el('share-link-text')).toBeNull();
  submit(); await settle();
  expect(prepare).toHaveBeenCalledWith('lock pw', { serviceUrl: payload.serviceUrl, syncId: payload.id });
  expect(render).not.toHaveBeenCalled();
  const box = el('share-link-text') as HTMLTextAreaElement;
  expect(box.value).toBe(vector);
  expect(parseShareLink(box.value)?.key).toBe(key);
  expect(el('qr-countdown').textContent).toBe('');
  el('share-link-copy').click(); await settle();
  expect(copy).toHaveBeenCalledWith(vector);
  expect(el('qr-countdown').textContent).toBe(t('share.copied'));
});

it('without a sync lock the link is shown at once', async () => {
  lockSet.mockResolvedValue(false);
  openShare(); await settle();
  expect(prepare).toHaveBeenCalledWith(undefined, { serviceUrl: payload.serviceUrl, syncId: payload.id });
  expect((el('share-link-text') as HTMLTextAreaElement).value).toBe(vector);
});

it('a wrong lock password shows no link', async () => {
  prepare.mockRejectedValue(new InvalidSwitchPasswordException('x'));
  openShare(); await settle(); submit(); await settle();
  expect(el('share-link-text')).toBeNull();
  expect(el('qr-error').textContent).toBe(t('core.switchWrongPassword'));
});

it('the card Share link button opens the link dialog for the active sync', async () => {
  controller.close();
  document.body.innerHTML = dialogHtml.replace('<button id="qr-open"></button>', '<button id="qr-open"></button><button id="qr-share"></button>');
  controller = new ConnectQrController(el('root'), prepare, { render, lockSet, copy, focused: () => focus, now: () => Date.now() });
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  expect((el('qr-share') as HTMLButtonElement).disabled).toBe(false);
  el('qr-share').click(); await settle();
  expect(el('qr-dialog-title').textContent).toBe(t('share.title'));
  expect(el('qr-share').hidden).toBe(true);
  submit(); await settle();
  expect(prepare).toHaveBeenCalledWith('lock pw', undefined);
  expect(render).not.toHaveBeenCalled();
  expect((el('share-link-text') as HTMLTextAreaElement).value).toBe(vector);
  el('qr-close').click();
  expect(el('qr-share').hidden).toBe(false);
  // The QR button still opens the QR, not the link.
  el('qr-open').click(); await settle();
  expect(el('qr-dialog-title').textContent).toBe(t('qr.title'));
});

it('a failed link says why when the error has a reason, else a link (not QR) message', async () => {
  prepare.mockRejectedValue(new ServiceOfflineException('Service offline (TypeError: Failed to fetch)'));
  openShare(); await settle(); submit(); await settle();
  expect(el('share-link-text')).toBeNull();
  expect(el('qr-error').textContent).toBe('Service offline (TypeError: Failed to fetch)');
  prepare.mockRejectedValue(new XbsException('raw internal text'));
  submit(); await settle();
  expect(el('qr-error').textContent).toBe(t('share.error'));
  prepare.mockRejectedValue(new Error('boom'));
  submit(); await settle();
  expect(el('qr-error').textContent).toBe(t('share.error'));
});

it('leaving the view removes the link; the next QR open uses the QR copy again', async () => {
  lockSet.mockResolvedValue(false);
  openShare(); await settle();
  window.dispatchEvent(new Event('blur'));
  expect(el('share-link-text')).toBeNull();
  expect(el('qr-dialog-title').textContent).toBe(t('qr.title'));
  expect(el('qr-generate-label').textContent).toBe(t('qr.generate'));
});

it('a failed copy says so and selects the link', async () => {
  lockSet.mockResolvedValue(false);
  copy.mockRejectedValue(new Error('denied'));
  openShare(); await settle();
  el('share-link-copy').click(); await settle();
  expect(el('qr-countdown').textContent).toBe(t('share.copyFailed'));
});

function fieldFixture(): { field: ShareLinkField; picker: { url: string; select: ReturnType<typeof vi.fn> }; id: HTMLInputElement; changes: number[] } {
  document.body.innerHTML = '<input id="sid">';
  const id = el('sid') as HTMLInputElement;
  const picker = { url: 'https://api.xbrowsersync.org/', select: vi.fn(async (value: string) => { picker.url = value; }) };
  const changes: number[] = [];
  const field = new ShareLinkField({ prefix: 't', picker: () => picker as unknown as ServicePicker, syncId: id, onChange: () => changes.push(1) });
  document.body.append(field.root);
  return { field, picker, id, changes };
}

it('paste field: a link fills service and ID, keeps the key until either changes', async () => {
  const { field, picker, id } = fieldFixture();
  const input = el('t-share-link') as HTMLInputElement;
  input.value = `join me: ${vector} thanks`;
  el('t-share-link-use').click(); await settle();
  expect(input.value).toBe('');
  expect(id.value).toBe(payload.id);
  expect(picker.select).toHaveBeenCalledWith('https://api.example.test/sync', true, true);
  expect(field.key('https://api.example.test/sync/', id.value)).toBe(key);
  expect(el('t-share-link-note').hidden).toBe(false);
  id.value = 'other';
  id.dispatchEvent(new Event('input'));
  expect(field.key(picker.url, id.value)).toBeUndefined();
  expect(el('t-share-link-note').hidden).toBe(true);
});

it('paste field: a different service drops the key; reset clears everything', async () => {
  const { field, picker, id } = fieldFixture();
  (el('t-share-link') as HTMLInputElement).value = vector;
  el('t-share-link-use').click(); await settle();
  picker.url = 'https://elsewhere.test/';
  field.refresh();
  expect(field.key(picker.url, id.value)).toBeUndefined();
  (el('t-share-link') as HTMLInputElement).value = vector;
  el('t-share-link-use').click(); await settle();
  field.reset();
  expect(field.key(picker.url, id.value)).toBeUndefined();
});

it('paste field: invalid or plain-http links are refused with a reason', async () => {
  const { field, id } = fieldFixture();
  (el('t-share-link') as HTMLInputElement).value = 'keepmark://sync?v=9';
  el('t-share-link-use').click(); await settle();
  expect(el('t-share-link-error').textContent).toBe(t('link.invalid'));
  expect((el('t-share-link') as HTMLInputElement).value).toBe('');
  const http = vector.replace('https%3A', 'http%3A');
  (el('t-share-link') as HTMLInputElement).value = http;
  el('t-share-link-use').click(); await settle();
  expect(el('t-share-link-error').textContent).toBe(t('val.url.https'));
  expect(id.value).toBe('');
  expect(field.key('http://api.example.test/sync', payload.id)).toBeUndefined();
});

// ---- One-time links (format 2) ----

const onceLink = 'keepmark://sync?v=2&s=https%3A%2F%2Fapi.example.test%2Fsync&t=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&c=1';

function onceController(createLink: ReturnType<typeof vi.fn>, revoke: ReturnType<typeof vi.fn>): ConnectQrController {
  controller.close();
  document.body.innerHTML = dialogHtml;
  return new ConnectQrController(el('root'), prepare, {
    render, lockSet, copy, focused: () => focus, now: () => Date.now(),
    shareMode: async () => ({ oneTime: true, maxTtlSeconds: 3600 }),
    createLink, revoke,
  });
}

it('one-time share: waits for the options, sends duration + code, shows code and revokes', async () => {
  lockSet.mockResolvedValue(false);
  const result = { format: 2 as const, link: onceLink, code: '042137', expiresAt: new Date(Date.now() + 600_000).toISOString(), handoffId: 'h', serviceUrl: payload.serviceUrl, syncId: payload.id };
  const createLink = vi.fn(async () => result);
  const revoke = vi.fn(async () => true);
  controller = onceController(createLink, revoke);
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  openShare(); await settle();
  expect(createLink).not.toHaveBeenCalled();
  expect(el('qr-security-note').textContent).toBe(t('share.warningOnce'));
  const ttl = el('share-ttl') as HTMLSelectElement;
  expect(Array.from(ttl.options, (o) => o.value)).toEqual(['600', '3600']);
  expect((el('share-code') as HTMLInputElement).checked).toBe(false);
  ttl.value = '3600';
  (el('share-code') as HTMLInputElement).checked = true;
  submit(''); await settle();
  expect(createLink).toHaveBeenCalledWith(undefined, { serviceUrl: payload.serviceUrl, syncId: payload.id }, { ttlSeconds: 3600, withCode: true });
  expect((el('share-link-text') as HTMLTextAreaElement).value).toBe(onceLink);
  expect(el('share-code-value').textContent).toBe('042 137');
  el('share-revoke').click(); await settle();
  expect(revoke).toHaveBeenCalledWith(result);
  expect(el('share-link-text')).toBeNull();
  expect(el('share-revoked').textContent).toBe(t('share.revoked'));
});

it('one-time share: a voucher that lands after the dialog lost focus is revoked, never shown', async () => {
  lockSet.mockResolvedValue(false);
  const result = { format: 2 as const, link: onceLink, expiresAt: new Date(Date.now() + 600_000).toISOString(), handoffId: 'h', serviceUrl: payload.serviceUrl, syncId: payload.id };
  let resolve!: (value: typeof result) => void;
  const createLink = vi.fn(() => new Promise<typeof result>((r) => { resolve = r; }));
  const revoke = vi.fn(async () => true);
  controller = onceController(createLink, revoke);
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  openShare(); await settle();
  submit(''); await settle();
  focus = false;
  resolve(result); await settle();
  focus = true;
  expect(revoke).toHaveBeenCalledWith(result);
  expect(el('share-link-text')).toBeNull();
});

it('one-time share: a service without vouchers falls back to the lasting link with a notice', async () => {
  lockSet.mockResolvedValue(false);
  const createLink = vi.fn(async () => ({ format: 1 as const, link: vector }));
  controller = onceController(createLink, vi.fn());
  controller.updateStatus({ syncEnabled: true, serviceUrl: payload.serviceUrl, syncId: payload.id, queueLength: 0, syncing: false });
  openShare(); await settle();
  submit(''); await settle();
  expect((el('share-link-text') as HTMLTextAreaElement).value).toBe(vector);
  expect(el('share-mode-note').textContent).toBe(t('share.noOneTime'));
});

function onceField(redeem: ReturnType<typeof vi.fn>): { field: ShareLinkField; picker: { url: string; select: ReturnType<typeof vi.fn> }; id: HTMLInputElement } {
  document.body.innerHTML = '<input id="sid">';
  const id = el('sid') as HTMLInputElement;
  const picker = { url: 'https://api.xbrowsersync.org/', select: vi.fn(async (value: string) => { picker.url = value; }) };
  const field = new ShareLinkField({ prefix: 't', picker: () => picker as unknown as ServicePicker, syncId: id, onChange: () => undefined, redeem });
  document.body.append(field.root);
  return { field, picker, id };
}

it('paste field: a one-time link is offered, nothing is redeemed before Open link', async () => {
  const redeem = vi.fn(async () => ({ serviceUrl: payload.serviceUrl, id: payload.id, key, label: 'Laptop' }));
  const { field, picker, id } = onceField(redeem);
  (el('t-share-link') as HTMLInputElement).value = `here: ${onceLink}`;
  el('t-share-link-use').click(); await settle();
  expect(redeem).not.toHaveBeenCalled();
  expect(el('t-share-once').hidden).toBe(false);
  expect(el('t-share-once-note').textContent).toBe(t('link.onceNote', { service: payload.serviceUrl }));
  expect(el('t-share-code-row').hidden).toBe(false);
  el('t-share-open').click(); await settle();
  expect(redeem).not.toHaveBeenCalled();
  expect(el('t-share-link-error').textContent).toBe(t('handoff.codeRequired'));
  (el('t-share-code') as HTMLInputElement).value = '123 456';
  el('t-share-open').click(); await settle();
  expect(redeem).toHaveBeenCalledWith(onceLink, '123456');
  expect(id.value).toBe(payload.id);
  expect(picker.select).toHaveBeenCalledWith(payload.serviceUrl, true, true);
  expect(field.key(payload.serviceUrl, payload.id)).toBe(key);
  expect(field.label(payload.serviceUrl, payload.id)).toBe('Laptop');
  expect(el('t-share-once').hidden).toBe(true);
});

it('paste field: a wrong code keeps the link; a used-up link drops it', async () => {
  const { HandoffAuthFailedException, HandoffNotFoundException } = await import('../src/shared/errors');
  const redeem = vi.fn()
    .mockRejectedValueOnce(new HandoffAuthFailedException(t('handoff.wrongCode', { left: 2 })))
    .mockRejectedValueOnce(new HandoffNotFoundException(t('handoff.notFound')));
  const { field } = onceField(redeem);
  (el('t-share-link') as HTMLInputElement).value = onceLink;
  el('t-share-link-use').click(); await settle();
  (el('t-share-code') as HTMLInputElement).value = '000000';
  el('t-share-open').click(); await settle();
  expect(el('t-share-link-error').textContent).toBe(t('handoff.wrongCode', { left: 2 }));
  expect(el('t-share-once').hidden).toBe(false);
  expect((el('t-share-code') as HTMLInputElement).value).toBe('');
  (el('t-share-code') as HTMLInputElement).value = '111111';
  el('t-share-open').click(); await settle();
  expect(el('t-share-link-error').textContent).toBe(t('handoff.notFound'));
  expect(el('t-share-once').hidden).toBe(true);
  expect(field.key(payload.serviceUrl, payload.id)).toBeUndefined();
});
