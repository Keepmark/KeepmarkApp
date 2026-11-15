// @vitest-environment happy-dom
// Popup -> full tab: the connect form's choices and identifiers carry over
// through one short-lived key, read once; passwords never do.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyConnectDraft,
  captureConnectDraft,
  ConnectDraftTtlMs,
  defaultConnectMode,
  parseConnectDraft,
  saveConnectDraft,
  takeConnectDraft,
  type DraftArea,
} from '../src/popup/handover';
import { StoreKey } from '../src/shared/store';

const syncId = '432a397288db410e9f733e5dbda9d4af';

function loadPopup(): void {
  const html = readFileSync('src/popup.html', 'utf8');
  // Body only: parsing the <head> would make happy-dom fetch the stylesheets.
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
}
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;

class FakeArea implements DraftArea {
  data = new Map<string, unknown>();
  async get(key: string) { return this.data.has(key) ? { [key]: this.data.get(key) } : {}; }
  async set(items: Record<string, unknown>) { for (const [k, v] of Object.entries(items)) this.data.set(k, v); }
  async remove(key: string) { this.data.delete(key); }
}

function fillPopup(): void {
  radio('conn-mode', 'creds').checked = true;
  radio('conn-direction', 'merge').checked = true;
  field('service-url').value = ' https://sync.example.test ';
  field('sync-id').value = syncId;
  field('sync-name').value = 'Home';
  field('password').value = 'hunter2-long-secret';
  field('confirm-password').value = 'hunter2-long-secret';
  field('conn-switch-password').value = '1234';
}

describe('connect form handover', () => {
  beforeEach(loadPopup);

  it('captures mode, direction, service, sync ID and name, never a password', () => {
    fillPopup();
    const draft = captureConnectDraft(document, true, 1000);
    expect(draft).toEqual({
      mode: 'creds', direction: 'merge', serviceUrl: 'https://sync.example.test',
      syncId, name: 'Home', nameTouched: true, savedAt: 1000,
    });
    const json = JSON.stringify(draft);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('1234');
  });

  it('round-trips into a fresh page with empty password fields', async () => {
    fillPopup();
    const area = new FakeArea();
    await saveConnectDraft(area, captureConnectDraft(document, false, Date.now()));
    expect(JSON.stringify([...area.data.values()])).not.toContain('hunter2');
    loadPopup();
    const draft = await takeConnectDraft(area);
    expect(draft).toBeDefined();
    applyConnectDraft(document, draft!);
    expect(radio('conn-mode', 'creds').checked).toBe(true);
    expect(radio('conn-direction', 'merge').checked).toBe(true);
    expect(field('service-url').value).toBe('https://sync.example.test');
    expect(field('sync-id').value).toBe(syncId);
    expect(field('sync-name').value).toBe('Home');
    expect(field('password').value).toBe('');
    expect(field('confirm-password').value).toBe('');
  });

  it('clears the key on read: a second read (reload, other tab) gets nothing', async () => {
    const area = new FakeArea();
    await saveConnectDraft(area, captureConnectDraft(document, false, Date.now()));
    expect(area.data.has(StoreKey.ConnectDraft)).toBe(true);
    expect(await takeConnectDraft(area)).toBeDefined();
    expect(area.data.has(StoreKey.ConnectDraft)).toBe(false);
    expect(await takeConnectDraft(area)).toBeUndefined();
  });

  it('drops expired or malformed drafts and still clears them', async () => {
    const area = new FakeArea();
    const now = 10_000_000;
    await saveConnectDraft(area, captureConnectDraft(document, false, now - ConnectDraftTtlMs - 1));
    expect(await takeConnectDraft(area, now)).toBeUndefined();
    expect(area.data.size).toBe(0);
    expect(parseConnectDraft({ mode: 'x', direction: 'pull', savedAt: now }, now)).toBeUndefined();
    expect(parseConnectDraft({ mode: 'new', direction: 'drop', savedAt: now }, now)).toBeUndefined();
    expect(parseConnectDraft('nope', now)).toBeUndefined();
    const ok = parseConnectDraft({ mode: 'new', direction: 'pull', savedAt: now, name: 'x'.repeat(99), syncId: 5 }, now);
    expect(ok?.name).toHaveLength(40);
    expect(ok?.syncId).toBe('');
    // Pre-0.1.71 drafts said 'existing' for both link and credentials.
    expect(parseConnectDraft({ mode: 'existing', direction: 'pull', savedAt: now }, now)?.mode).toBe('creds');
    expect(parseConnectDraft({ mode: 'link', direction: 'pull', savedAt: now }, now)?.mode).toBe('link');
  });

  it('a storage failure never blocks the tab', async () => {
    const broken: DraftArea = {
      get: async () => { throw new Error('denied'); },
      set: async () => undefined,
      remove: async () => undefined,
    };
    expect(await takeConnectDraft(broken)).toBeUndefined();
  });
});

describe('first connect default', () => {
  it('starts on "Create a new sync" only while no sync is saved in this browser', () => {
    expect(defaultConnectMode(0)).toBe('new');
    expect(defaultConnectMode(1)).toBe('link');
    expect(defaultConnectMode(3)).toBe('link');
  });

  it('is settled before the connect view shows and never over a user or draft choice', () => {
    const src = readFileSync('src/popup/popup.ts', 'utf8');
    const pick = src.slice(src.indexOf('if (pickView) {'));
    expect(pick.indexOf('settleConnectMode()')).toBeLessThan(pick.indexOf('showView('));
    const settle = src.slice(src.indexOf('async function settleConnectMode'));
    expect(settle).toMatch(/if \(connectModeSettled \|\| resumedDraft\) return;/);
    expect(src).toMatch(/addEventListener\('change', \(\) => \{\s*connectModeSettled = true;/);
  });
});
