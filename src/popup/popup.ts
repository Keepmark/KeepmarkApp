// Small popup: connection status at a glance + sync now. Everything else
// lives in the full-tab manager (manager.html). Shares rendering + helpers
// with the manager via ./ui.js.

import browser from 'webextension-polyfill';
import { DefaultServiceUrl } from '../shared/constants.js';
import {
  $,
  copyText,
  describeUndo,
  input,
  validateConnect,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
} from './ui.js';
import {
  MessageCommand,
  type PingResponse,
  type StatusResponse,
  type UndoState,
} from '../shared/messages.js';

function showError(where: 'connect' | 'main', message: string): void {
  const el = $(`${where}-error`);
  el.textContent = message;
  el.hidden = false;
}

function clearErrors(): void {
  for (const id of ['connect-error', 'main-error']) {
    const el = $(id);
    el.hidden = true;
    // Empty the text: a hidden-but-stale alert is re-read by screen readers
    // when unhidden with a new message.
    el.textContent = '';
  }
}

function showView(name: 'connect' | 'main'): void {
  ($('view-connect') as HTMLElement).hidden = name !== 'connect';
  ($('view-main') as HTMLElement).hidden = name !== 'main';
}

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;
/** Generation token: stale refresh responses never overwrite newer state. */
let refreshSeq = 0;

async function refreshAll(): Promise<void> {
  const my = ++refreshSeq;
  let statusErr: string | undefined;
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    status = undefined;
    statusErr = (err as Error)?.message ?? String(err);
  }
  if (my !== refreshSeq) return;
  renderStatusCard('p', { status, ping: undefined });
  let pingErr: string | undefined;
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch (err) {
    ping = undefined;
    pingErr = (err as Error)?.message ?? String(err);
  }
  if (my !== refreshSeq) return;
  const view: StatusView = { status, ping };
  renderStatusCard('p', view);
  // A GetStatus throw always means the background is unreachable (unlinked
  // links resolve fine), so report it instead of showing a bare "Not synced".
  if (statusErr) showError('main', `Background error: ${statusErr}`);
  else if (pingErr && status?.syncEnabled) showError('main', `Service probe failed: ${pingErr}`);
  else ($('main-error') as HTMLElement).hidden = true;
  const state = $('sync-state');
  if (!status?.syncEnabled) {
    state.textContent = 'Not synced';
  } else if (status.syncing || status.queueLength > 0) {
    state.textContent = 'Syncing…';
  } else {
    state.textContent = status.lastUpdated ? `Synced ${new Date(status.lastUpdated).toLocaleString()}` : 'Synced';
  }
  await refreshUndoBanner();
}

async function refreshUndoBanner(): Promise<void> {
  const banner = $('p-undo') as HTMLElement;
  let undo: UndoState | null = null;
  try {
    undo = await send<UndoState | null>({ command: MessageCommand.GetUndoState });
  } catch {
    undo = null;
  }
  if (!undo) {
    banner.hidden = true;
    return;
  }
  $('p-undo-text').textContent = describeUndo(undo.kind, undo.bookmarkCount, undo.timestamp);
  banner.hidden = false;
}

async function initConnect(): Promise<void> {
  input('service-url').value = DefaultServiceUrl;
  const updateMode = (): void => {
    const mode = (document.querySelector('input[name="conn-mode"]:checked') as HTMLInputElement).value;
    ($('conn-existing-only') as HTMLElement).hidden = mode !== 'existing';
    ($('conn-new-only') as HTMLElement).hidden = mode !== 'new';
    updateDirection();
  };
  const updateDirection = (): void => {
    const direction = (document.querySelector('input[name="conn-direction"]:checked') as HTMLInputElement).value;
    ($('conn-push-warn') as HTMLElement).hidden = direction !== 'push';
  };
  document.querySelectorAll('input[name="conn-mode"], input[name="conn-direction"]').forEach((el) => {
    el.addEventListener('change', updateMode);
  });
  updateMode();
  $('btn-connect').addEventListener('click', () =>
    withBusy('btn-connect', 'Connecting…', async () => {
      clearErrors();
      const mode = (document.querySelector('input[name="conn-mode"]:checked') as HTMLInputElement).value as
        | 'new'
        | 'existing';
      const direction = (document.querySelector('input[name="conn-direction"]:checked') as HTMLInputElement).value as
        | 'pull'
        | 'push';
      const serviceUrl = input('service-url').value.trim() || DefaultServiceUrl;
      const syncId = input('sync-id').value.trim();
      const password = input('password').value;
      const invalid = validateConnect({
        mode,
        direction,
        serviceUrl,
        syncId,
        password,
        confirm: input('confirm-password').value,
        pushConfirmed: (input('conn-push-confirm') as HTMLInputElement).checked,
      });
      if (invalid) {
        showError('connect', invalid);
        return;
      }
      try {
        if (mode === 'new') {
          await send({ command: MessageCommand.ConnectNew, serviceUrl, password });
        } else {
          await send({ command: MessageCommand.ConnectExisting, serviceUrl, syncId, password, direction });
        }
        input('password').value = '';
        input('confirm-password').value = '';
        (input('conn-push-confirm') as HTMLInputElement).checked = false;
        showView('main');
        await refreshAll();
      } catch (err) {
        // Never leave the confirmation in the DOM; the main password stays so
        // a transient failure doesn't force a full retype from the vault.
        input('confirm-password').value = '';
        showError('connect', (err as Error).message);
      }
    }),
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
  $('btn-undo').addEventListener('click', async () => {
    clearErrors();
    if (!window.confirm('Undo the last link operation? Changes made since will be discarded.')) return;
    await withBusy('btn-undo', 'Undoing…', async () => {
      try {
        await send({ command: MessageCommand.UndoLastLink });
        await refreshAll();
      } catch (err) {
        showError('main', (err as Error).message);
      }
    });
  });
  $('btn-undo-dismiss').addEventListener('click', async () => {
    await send({ command: MessageCommand.DismissUndo }).catch(() => undefined);
    ($('p-undo') as HTMLElement).hidden = true;
  });
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).has('fullpage')) {
    document.body.classList.add('fullpage');
    ($('btn-open-tab') as HTMLButtonElement).hidden = true;
  }
  await initConnect();
  initMain();
  await refreshAll();
  showView(status?.syncEnabled ? 'main' : 'connect');
}

void init();
