// Popup: server-link management panel (status, space, backup, move, logs).
// Display reads storage.local directly; ALL mutations go through background
// messages so the sync queue stays the only writer. Bookmark browsing lives
// in the browser's native UI — this panel manages the link, like the
// official xBrowserSync app.

import browser from 'webextension-polyfill';
import { DefaultServiceUrl } from '../shared/constants.js';
import {
  fromWireError,
  MessageCommand,
  type MessagePayload,
  type MessageResponse,
  type PingResponse,
  type StatusResponse,
  type DuplicateGroup,
} from '../shared/messages.js';
import { StoreKey } from '../shared/store.js';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

async function send<T>(msg: MessagePayload): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as MessageResponse;
  if (!res || typeof res !== 'object' || !('ok' in res)) {
    throw new Error('Background did not respond.');
  }
  if (!res.ok) throw fromWireError({ errorName: (res as { errorName: string }).errorName, message: (res as { message: string }).message });
  return (res as { data?: T }).data as T;
}

async function readStorage<T>(key: string): Promise<T | undefined> {
  const result = await browser.storage.local.get(key);
  return result[key] as T | undefined;
}

function showError(where: 'connect' | 'main' | 'settings', message: string): void {
  const el = $(`${where}-error`);
  el.textContent = message;
  el.hidden = false;
}

function clearErrors(): void {
  for (const id of ['connect-error', 'main-error', 'settings-error']) $(id).hidden = true;
}

function showView(name: 'connect' | 'main' | 'settings'): void {
  ($('view-connect') as HTMLElement).hidden = name !== 'connect';
  ($('view-main') as HTMLElement).hidden = name !== 'main';
  ($('view-settings') as HTMLElement).hidden = name !== 'settings';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;

function setPill(text: string, kind: 'ok' | 'warn' | 'bad' | 'busy'): void {
  const pill = $('pill');
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

async function refreshAll(): Promise<void> {
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch {
    status = undefined;
  }
  renderStatus();
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    ping = undefined;
  }
  renderStatus();
  const state = $('sync-state');
  if (!status?.syncEnabled) {
    state.textContent = 'Not synced';
  } else if (status.syncing || status.queueLength > 0) {
    state.textContent = 'Syncing…';
  } else {
    state.textContent = status.lastUpdated ? `Synced ${new Date(status.lastUpdated).toLocaleString()}` : 'Synced';
  }
}

function renderStatus(): void {
  if (!status?.syncEnabled) return;
  const serviceUrl = status.serviceUrl ?? DefaultServiceUrl;
  $('st-server').textContent = serviceUrl;
  const badge = $('service-badge');
  const official = serviceUrl.replace(/\/+$/, '') === DefaultServiceUrl;
  badge.textContent = official ? 'Official service' : 'Custom service';
  badge.className = `badge ${official ? 'official' : 'custom'}`;
  $('st-syncid').textContent = status.syncId ?? '—';
  $('st-last').textContent = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : '—';

  const used = status.usedBytes ?? 0;
  const max = ping?.maxSyncSize;
  $('st-space').textContent = max ? `${formatBytes(used)} of ${formatBytes(max)}` : formatBytes(used);
  $('space-fill').style.width = max ? `${Math.min(100, (used / max) * 100).toFixed(1)}%` : '0%';

  if (status.syncing || status.queueLength > 0) {
    setPill('Syncing…', 'busy');
  } else if (!ping) {
    setPill('Checking…', 'busy');
  } else if (!ping.reachable) {
    setPill('Offline', 'bad');
  } else if (ping.remoteLastUpdated && status.lastUpdated && ping.remoteLastUpdated !== status.lastUpdated) {
    setPill('Behind', 'warn');
  } else {
    setPill('Synced', 'ok');
  }
}

async function initConnect(): Promise<void> {
  input('service-url').value = DefaultServiceUrl;
  const connect = async (existing: boolean): Promise<void> => {
    clearErrors();
    const serviceUrl = input('service-url').value.trim() || DefaultServiceUrl;
    const syncId = input('sync-id').value.trim();
    const password = input('password').value;
    if (!password) {
      showError('connect', 'Password is required.');
      return;
    }
    if (existing && !syncId) {
      showError('connect', 'Sync ID is required for an existing sync.');
      return;
    }
    try {
      if (existing) {
        await send({ command: MessageCommand.ConnectExisting, serviceUrl, syncId, password });
      } else {
        await send({ command: MessageCommand.ConnectNew, serviceUrl, password });
      }
      input('password').value = '';
      showView('main');
      await refreshAll();
    } catch (err) {
      showError('connect', (err as Error).message);
    }
  };
  $('btn-new-sync').addEventListener('click', () => void connect(false));
  $('btn-existing-sync').addEventListener('click', () => void connect(true));
  $('btn-open-tab').addEventListener('click', () => {
    // Popups close on focus loss (by design) — a full tab stays open while
    // copying credentials from a vault. State carries over via storage.
    const url = browser.runtime.getURL('popup.html?fullpage=1');
    void browser.tabs.create({ url }).then(() => window.close());
  });
}

function initMain(): void {
  $('btn-sync-now').addEventListener('click', async () => {
    clearErrors();
    try {
      await send({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } });
      await refreshAll();
    } catch (err) {
      showError('main', (err as Error).message);
      await refreshAll();
    }
  });
  $('btn-settings').addEventListener('click', () => void openSettings());
  $('btn-copy-id').addEventListener('click', async () => {
    const id = status?.syncId ?? '';
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      window.prompt('Copy sync ID:', id);
    }
  });
}

async function openSettings(): Promise<void> {
  clearErrors();
  showView('settings');
  const info = $('service-info');
  info.textContent = '';
  const statusName = ping?.reachable ? `Online${ping.status !== undefined ? ` (${ping.status})` : ''}` : 'Unreachable';
  const rows: [string, string][] = [
    ['Reachability', statusName],
    ['Service', status?.serviceUrl ?? '—'],
    ['API version', ping?.version ?? '—'],
    ['Location', ping?.location ?? '—'],
    ['Message', ping?.message ?? '—'],
    ['Sync ID', status?.syncId ?? '—'],
    ['Last updated', status?.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    info.append(dt, dd);
  }
  const toolbar = await readStorage<boolean>(StoreKey.SyncBookmarksToolbar);
  (input('opt-toolbar') as HTMLInputElement).checked = toolbar ?? true;
  await loadDuplicates();
}

async function loadDuplicates(): Promise<void> {
  const box = $('dup-list');
  box.textContent = '';
  let groups: DuplicateGroup[] = [];
  try {
    groups = await send<DuplicateGroup[]>({ command: MessageCommand.GetDuplicates });
  } catch (err) {
    showError('settings', (err as Error).message);
    return;
  }
  $('dup-count').textContent = groups.length ? `(${groups.length})` : '';
  for (const group of groups) {
    const div = document.createElement('div');
    div.className = 'dup-group';
    const head = document.createElement('div');
    head.textContent = `${group.url} — keep newest, delete ${group.entries.length - 1}`;
    const ul = document.createElement('ul');
    group.entries.forEach((entry, i) => {
      const li = document.createElement('li');
      const locked = i === group.entries.length - 1;
      li.textContent = `${locked ? '🔒 ' : ''}${entry.title ?? ''} (${entry.path})`;
      if (!locked) {
        const btn = document.createElement('button');
        btn.textContent = 'Delete';
        btn.addEventListener('click', async () => {
          clearErrors();
          try {
            await send({ command: MessageCommand.RemoveBookmark, id: entry.id });
            await openSettings();
            await refreshAll();
          } catch (err) {
            showError('settings', (err as Error).message);
          }
        });
        li.append(' ', btn);
      }
      ul.append(li);
    });
    div.append(head, ul);
    box.append(div);
  }
}

function initSettings(): void {
  (input('opt-toolbar') as HTMLInputElement).addEventListener('change', (e) => {
    void browser.storage.local.set({ [StoreKey.SyncBookmarksToolbar]: (e.target as HTMLInputElement).checked });
  });
  $('btn-back').addEventListener('click', () => {
    showView('main');
    void refreshAll();
  });
  $('btn-unlink').addEventListener('click', async () => {
    clearErrors();
    try {
      await send({ command: MessageCommand.DisableSync });
      ping = undefined;
      showView('connect');
      await refreshAll();
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
  $('btn-export').addEventListener('click', async () => {
    clearErrors();
    const password = window.prompt('Backup password (min 8 chars):') ?? '';
    if (!password) return;
    try {
      const json = await send<string>({ command: MessageCommand.ExportBackup, password });
      await send({
        command: MessageCommand.DownloadFile,
        filename: `keepmark-backup-${new Date().toISOString().slice(0, 10)}.xbs.json`,
        text: json,
      });
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
  $('btn-import').addEventListener('click', () => ($('import-file') as HTMLInputElement).click());
  ($('import-file') as HTMLInputElement).addEventListener('change', async (e) => {
    clearErrors();
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const password = window.prompt('Backup password:') ?? '';
    if (!password) return;
    try {
      const json = await file.text();
      await send<{ count: number }>({ command: MessageCommand.ImportBackup, json, password });
      await refreshAll();
      await openSettings();
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
  $('btn-switch').addEventListener('click', async () => {
    clearErrors();
    const newServiceUrl = input('switch-url').value.trim();
    const newPassword = input('switch-password').value;
    if (!newServiceUrl || !newPassword) {
      showError('settings', 'New service URL and password are required.');
      return;
    }
    try {
      await send({ command: MessageCommand.SwitchService, newServiceUrl, newPassword });
      input('switch-password').value = '';
      await refreshAll();
      await openSettings();
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
  $('btn-logs').addEventListener('click', async () => {
    clearErrors();
    try {
      const entries = await send<{ timestamp: string; level: number; tag: string; message: string }[]>({
        command: MessageCommand.GetLogs,
      });
      const names = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
      $('log-list').textContent = entries
        .map((e) => `${e.timestamp} [${names[e.level] ?? e.level}] ${e.tag}: ${e.message}`)
        .join('\n');
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).has('fullpage')) {
    document.body.classList.add('fullpage');
  }
  await initConnect();
  initMain();
  initSettings();
  await refreshAll();
  if (status?.syncEnabled) {
    showView('main');
  } else {
    showView('connect');
  }
}

void init();
