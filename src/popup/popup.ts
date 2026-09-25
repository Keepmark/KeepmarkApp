// Small popup: connection status at a glance + sync now. Everything else
// lives in the full-tab manager (manager.html). Shares rendering + helpers
// with the manager via ./ui.js.

import browser from 'webextension-polyfill';
import { DefaultServiceUrl } from '../shared/constants.js';
import {
  $,
  copyText,
  input,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
} from './ui.js';
import {
  MessageCommand,
  type PingResponse,
  type StatusResponse,
} from '../shared/messages.js';

function showError(where: 'connect' | 'main', message: string): void {
  const el = $(`${where}-error`);
  el.textContent = message;
  el.hidden = false;
}

function clearErrors(): void {
  for (const id of ['connect-error', 'main-error']) $(id).hidden = true;
}

function showView(name: 'connect' | 'main'): void {
  ($('view-connect') as HTMLElement).hidden = name !== 'connect';
  ($('view-main') as HTMLElement).hidden = name !== 'main';
}

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;

async function refreshAll(): Promise<void> {
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch {
    status = undefined;
  }
  renderStatusCard('p', { status, ping: undefined });
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    ping = undefined;
  }
  const view: StatusView = { status, ping };
  renderStatusCard('p', view);
  const state = $('sync-state');
  if (!status?.syncEnabled) {
    state.textContent = 'Not synced';
  } else if (status.syncing || status.queueLength > 0) {
    state.textContent = 'Syncing…';
  } else {
    state.textContent = status.lastUpdated ? `Synced ${new Date(status.lastUpdated).toLocaleString()}` : 'Synced';
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
  $('btn-new-sync').addEventListener('click', () =>
    withBusy('btn-new-sync', 'Connecting…', () => connect(false)),
  );
  $('btn-existing-sync').addEventListener('click', () =>
    withBusy('btn-existing-sync', 'Connecting…', () => connect(true)),
  );
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
    await withBusy('btn-sync-now', 'Syncing…', async () => {
      try {
        await send({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } });
      } catch (err) {
        showError('main', (err as Error).message);
      }
      await refreshAll();
    });
  });
  $('btn-manage').addEventListener('click', () => {
    const url = browser.runtime.getURL('manager.html');
    if (new URLSearchParams(location.search).has('fullpage')) {
      location.href = url;
    } else {
      void browser.tabs.create({ url }).then(() => window.close());
    }
  });
  $('btn-copy-id').addEventListener('click', () => {
    if (status?.syncId) void copyText(status.syncId, 'Copy sync ID:');
  });
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).has('fullpage')) {
    document.body.classList.add('fullpage');
  }
  await initConnect();
  initMain();
  await refreshAll();
  showView(status?.syncEnabled ? 'main' : 'connect');
}

void init();
