// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServicePicker } from '../src/popup/service-picker';
import { MessageCommand, type ServiceProbeResponse } from '../src/shared/messages';
import { ServiceStatus } from '../src/shared/models';
import { PublicServices } from '../src/shared/service-catalog';

const harness = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/popup/ui', async original => ({ ...await original<object>(), send: harness.send }));
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));
const online: ServiceProbeResponse = { reachable: true, versionCompatible: true, version: '1.1.13', status: ServiceStatus.Online, maxSyncSize: 1048576 };
const el = (id: string) => document.getElementById(id)!;
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
let mode: 'new' | 'existing';
function picker() {
  return new ServicePicker({ input: el('url') as HTMLInputElement, mode: () => mode, onChange: vi.fn(), onState: vi.fn() });
}
function customUrl(value: string) {
  (document.querySelector('input[value="custom"]') as HTMLInputElement).click();
  (el('url') as HTMLInputElement).value = value;
  el('url').dispatchEvent(new Event('input'));
}
beforeEach(() => {
  document.body.innerHTML = '<label><span>URL</span><input id="url" type="url"></label>';
  mode = 'new';
  harness.send.mockReset().mockImplementation(async msg => msg.command === MessageCommand.GetServices ? [] : online);
});
describe('shared service picker', () => {
  it('keeps the default first and probes only the selected service without a manual button', async () => {
    const control = picker(); await control.load();
    expect(document.querySelector<HTMLInputElement>('fieldset input')!.value).toBe(PublicServices[0].url);
    expect(harness.send.mock.calls.filter(([m]) => m.command === MessageCommand.ProbeService)).toHaveLength(1);
    expect(control.ready).toBe(true);
    expect(el('url-check').hidden).toBe(true);
    expect(el('url').closest('label')!.hidden).toBe(true);
    expect(document.body.textContent).not.toContain('official');
  });
  it('requires manual verification for custom URLs, reports metadata, and invalidates on edit', async () => {
    const control = picker(); await control.load(); harness.send.mockClear();
    customUrl('https://custom.test/sync');
    expect(control.ready).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
    expect(el('url-check').hidden).toBe(false);
    el('url-check').click(); await tick();
    expect(control.ready).toBe(true);
    expect(el('url-feedback').textContent).toContain('1.1.13');
    (el('url') as HTMLInputElement).value = 'https://different.test'; el('url').dispatchEvent(new Event('input'));
    expect(control.ready).toBe(false);
  });
  it('ignores a late successful probe after another target is selected', async () => {
    const control = picker(); await control.load();
    let resolve!: (result: ServiceProbeResponse) => void;
    harness.send.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = control.select(PublicServices[1].url);
    customUrl('https://other.test');
    resolve(online); await pending;
    expect(control.ready).toBe(false);
    expect(control.url).toBe('https://other.test');
    expect((el('url-check') as HTMLButtonElement).disabled).toBe(false);
  });
  it('blocks offline/incompatible servers and permits NoNewSyncs only for existing syncs', async () => {
    const control = picker(); await control.load();
    for (const response of [{ ...online, reachable: false }, { ...online, versionCompatible: false }, { ...online, status: ServiceStatus.Offline }]) {
      harness.send.mockResolvedValueOnce(response); await control.select(PublicServices[1].url);
      expect(control.ready).toBe(false);
    }
    harness.send.mockResolvedValueOnce({ ...online, status: ServiceStatus.NoNewSyncs });
    await control.select(PublicServices[1].url); expect(control.ready).toBe(false);
    mode = 'existing'; control.updateMode(); expect(control.ready).toBe(true);
  });
  it('loads saved services into the same list and automatically verifies them', async () => {
    harness.send.mockImplementation(async msg => msg.command === MessageCommand.GetServices ? [{ url: 'https://saved.test/', saved: true }] : online);
    const control = picker(); await control.load('https://saved.test/');
    expect(control.url).toBe('https://saved.test/');
    expect(control.ready).toBe(true); expect(el('url-check').hidden).toBe(true);
    expect(document.querySelector('fieldset')!.textContent).toContain('Saved');
  });
  it('promotes a successfully remembered custom service to a saved choice without losing its valid proof', async () => {
    const control = picker(); await control.load(); customUrl('https://custom.test');
    el('url-check').click(); await tick(); expect(control.ready).toBe(true);
    harness.send.mockResolvedValueOnce([{ url: 'https://custom.test/', saved: true }]);
    await control.refreshCatalog();
    expect(control.ready).toBe(true);
    expect(control.url).toBe('https://custom.test/');
    expect(el('url-check').hidden).toBe(true);
    expect(el('url').closest('label')!.hidden).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[value="https://custom.test/"]')!.checked).toBe(true);
  });
  it('never interprets a service message as markup', async () => {
    const control = picker(); await control.load(); customUrl('https://custom.test');
    harness.send.mockResolvedValueOnce({ ...online, message: '<img src=x onerror=alert(1)>' });
    el('url-check').click(); await tick();
    expect(el('url-feedback').textContent).toContain('<img');
    expect(el('url-feedback').querySelector('img')).toBeNull();
  });
});
