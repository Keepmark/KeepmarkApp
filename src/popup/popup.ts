// Popup UI (vanilla TS, no framework). Display reads storage.local +
// decrypts locally; every mutation goes through background messages so the
// sync queue stays the only writer.

import browser from 'webextension-polyfill';
import { decryptData } from '../shared/crypto.js';
import { DefaultServiceUrl } from '../shared/constants.js';
import { fromWireError, MessageCommand, type MessagePayload, type MessageResponse, type StatusResponse, type DuplicateGroup } from '../shared/messages.js';
import type { BookmarkNode } from '../shared/models.js';
import { StoreKey, type SyncInfo } from '../shared/store.js';

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

let cachedTree: BookmarkNode[] = [];
let status: StatusResponse | undefined;

async function refreshStatus(): Promise<void> {
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch {
    status = undefined;
  }
  const state = $('sync-state');
  if (!status?.syncEnabled) {
    state.textContent = 'Not synced';
  } else if (status.syncing || status.queueLength > 0) {
    state.textContent = 'Syncing…';
  } else {
    state.textContent = status.lastUpdated ? `Synced ${new Date(status.lastUpdated).toLocaleString()}` : 'Synced';
  }
}

async function loadTree(): Promise<boolean> {
  const info = await readStorage<SyncInfo>(StoreKey.SyncInfo);
  const blob = await readStorage<string>(StoreKey.Bookmarks);
  if (!info?.id || !info.password || !blob) return false;
  try {
    const plain = await decryptData(blob, info.password);
    cachedTree = (plain ? JSON.parse(plain) : []) as BookmarkNode[];
    return true;
  } catch {
    return false;
  }
}

interface FlatHit {
  id?: number;
  title?: string;
  url?: string;
  path: string;
}

function flatten(query: string): FlatHit[] {
  const q = query.trim().toLowerCase();
  const hits: FlatHit[] = [];
  const walk = (nodes: BookmarkNode[] | undefined, trail: string[]): void => {
    for (const node of nodes ?? []) {
      const here = [...trail, node.title ?? ''];
      if (node.url && node.url !== 'xbs:separator') {
        const hay = `${node.title ?? ''} ${(node.description ?? '')} ${(node.tags ?? []).join(' ')} ${node.url}`.toLowerCase();
        if (!q || q.length < 2 || hay.includes(q)) {
          hits.push({ id: node.id, title: node.title, url: node.url, path: trail.join(' / ') });
        }
      }
      if (node.children) walk(node.children, here);
    }
  };
  for (const root of cachedTree) {
    if (root.children) walk(root.children, [root.title ?? '']);
  }
  return hits.slice(0, 100);
}

function renderResults(query: string): void {
  const list = $('results');
  list.textContent = '';
  for (const hit of flatten(query)) {
    const li = document.createElement('li');
    const link = document.createElement('span');
    link.className = 'link';
    link.textContent = hit.title || hit.url || '';
    link.title = hit.url ?? '';
    link.addEventListener('click', () => {
      if (hit.url) void browser.tabs.create({ url: hit.url }).then(() => window.close());
    });
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = hit.path;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete bookmark';
    del.addEventListener('click', async () => {
      clearErrors();
      try {
        if (hit.id !== undefined) await send({ command: MessageCommand.RemoveBookmark, id: hit.id });
        await reloadMain();
      } catch (err) {
        showError('main', (err as Error).message);
      }
    });
    const wrap = document.createElement('span');
    wrap.style.flex = '1';
    wrap.style.minWidth = '0';
    wrap.append(link, path);
    li.append(wrap, del);
    list.append(li);
  }
}

async function reloadMain(): Promise<void> {
  await refreshStatus();
  if (await loadTree()) {
    renderResults(input('search').value);
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
      await reloadMain();
    } catch (err) {
      showError('connect', (err as Error).message);
    }
  };
  $('btn-new-sync').addEventListener('click', () => void connect(false));
  $('btn-existing-sync').addEventListener('click', () => void connect(true));
}

function initMain(): void {
  input('search').addEventListener('input', (e) => renderResults((e.target as HTMLInputElement).value));
  $('btn-sync-now').addEventListener('click', async () => {
    clearErrors();
    try {
      await send({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } });
      await reloadMain();
    } catch (err) {
      showError('main', (err as Error).message);
    }
  });
  $('btn-settings').addEventListener('click', () => void openSettings());
  $('btn-add').addEventListener('click', async () => {
    clearErrors();
    const title = input('add-title').value.trim();
    const url = input('add-url').value.trim();
    const container = ($('add-container') as HTMLSelectElement).value;
    if (!title || !url) {
      showError('main', 'Title and URL are required.');
      return;
    }
    try {
      await send({ command: MessageCommand.AddBookmark, container, title, url });
      input('add-title').value = '';
      input('add-url').value = '';
      await reloadMain();
    } catch (err) {
      showError('main', (err as Error).message);
    }
  });
}

async function openSettings(): Promise<void> {
  clearErrors();
  showView('settings');
  const info = $('service-info');
  info.textContent = '';
  const rows: [string, string][] = [
    ['Sync ID', status?.syncId ?? '—'],
    ['Service', status?.serviceUrl ?? '—'],
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
            await reloadMain();
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
    void reloadMain();
  });
  $('btn-unlink').addEventListener('click', async () => {
    clearErrors();
    try {
      await send({ command: MessageCommand.DisableSync });
      cachedTree = [];
      showView('connect');
      await refreshStatus();
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
      const res = await send<{ count: number }>({ command: MessageCommand.ImportBackup, json, password });
      await reloadMain();
      await openSettings();
      showError('settings', `Imported ${res.count} nodes.`);
      ($('settings-error') as HTMLElement).hidden = false;
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
      await reloadMain();
      await openSettings();
    } catch (err) {
      showError('settings', (err as Error).message);
    }
  });
}

async function init(): Promise<void> {
  await initConnect();
  initMain();
  initSettings();
  // Prefill the add form with the current tab.
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.url && /^https?:/.test(tab.url)) {
      if (!input('add-url').value) input('add-url').value = tab.url;
      if (!input('add-title').value && tab.title) input('add-title').value = tab.title;
    }
  } catch {
    // No tab access (or no active tab); the form stays empty.
  }
  await refreshStatus();
  if (status?.syncEnabled && (await loadTree())) {
    showView('main');
    renderResults('');
  } else {
    showView('connect');
  }
}

void init();
