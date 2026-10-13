// Small popup: connection status at a glance + sync now. Everything else
// lives in the full-tab manager (manager.html). Shares rendering + helpers
// with the manager via ./ui.js.

import browser from 'webextension-polyfill';
import { DefaultServiceUrl } from '../shared/constants.js';
import { formatDate, formatTime, t } from '../shared/i18n.js';
import type { BookmarkNode } from '../shared/models.js';
import {
  $,
  copyText,
  describeUndo,
  undoBannerRemainingMs,
  input,
  validateConnect,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
  initI18n,
} from './ui.js';
import {
  MessageCommand,
  type MergePreview,
  type PingResponse,
  type RemovedSyncSnapshot,
  type StatusResponse,
  type UndoState,
} from '../shared/messages.js';
import { cancelConfirm, clearMessages, confirmInline, showError, showFor } from './flow.js';
import {
  type Direction,
  RemovedSyncDismissImplication,
  directionConfirm,
  removedSyncText,
  undoConfirm,
  undoneText,
} from './texts.js';

function showView(name: 'connect' | 'main'): void {
  ($('view-connect') as HTMLElement).hidden = name !== 'connect';
  ($('view-main') as HTMLElement).hidden = name !== 'main';
}

/** Header pill text: time only for today, short date otherwise (the full
 * timestamp is in the card's "Last sync" row). */
function shortWhen(iso: string | number): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? formatTime(d, { hour: '2-digit', minute: '2-digit' })
    : formatDate(d, { day: 'numeric', month: 'short' });
}

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;
/** Generation token: stale refresh responses never overwrite newer state. */
let refreshSeq = 0;

/** `pickView`: choose connect vs main as soon as GetStatus answers, before
 * the slower service ping (the popup opens with both views hidden). */
async function refreshAll(pickView = false): Promise<void> {
  const my = ++refreshSeq;
  let statusErr: string | undefined;
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    status = undefined;
    statusErr = (err as Error)?.message ?? String(err);
  }
  if (my !== refreshSeq) return;
  if (pickView) showView(status?.syncEnabled ? 'main' : 'connect');
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
  if (statusErr) showError('main-error', t('popup.err.background', { message: statusErr }));
  else if (pingErr && status?.syncEnabled) showError('main-error', t('popup.err.probe', { message: pingErr }));
  else ($('main-error') as HTMLElement).hidden = true;
  const state = $('sync-state');
  if (!status?.syncEnabled) {
    state.textContent = t('popup.state.notSynced');
  } else if (status.syncing || status.queueLength > 0) {
    state.textContent = t('ui.pill.syncing');
  } else {
    state.textContent = status.lastUpdated ? t('popup.state.syncedAt', { when: shortWhen(status.lastUpdated) }) : t('popup.state.synced');
  }
  // Show/hide conflict resolution button
  const conflictAction = $('p-conflict-action') as HTMLElement;
  conflictAction.hidden = !status?.conflict;
  await refreshUndoBanner();
  await refreshRemovedCard();
}

/** Folders + bookmarks in a tree; callers skip the root containers. Kept
 * local: backup.js would pull crypto into the popup bundle. */
function countItems(nodes: BookmarkNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countItems(node.children ?? []), 0);
}

/** Server-removed sync: offer the plaintext copy the background kept. */
async function refreshRemovedCard(): Promise<void> {
  const card = $('p-removed') as HTMLElement;
  let removed: RemovedSyncSnapshot | null = null;
  if (status?.removedSync && !status.syncEnabled) {
    try {
      removed = await send<RemovedSyncSnapshot | null>({ command: MessageCommand.GetRemovedSync });
    } catch {
      removed = null;
    }
  }
  if (!removed) {
    card.hidden = true;
    return;
  }
  $('p-removed-text').textContent = removedSyncText(
    removed.bookmarks.reduce((n, root) => n + countItems(root.children ?? []), 0),
    removed.lastUpdated,
  );
  card.hidden = false;
}

function initRemovedCard(): void {
  const error = $('removed-error');
  const fail = (err: unknown): void => {
    error.textContent = (err as Error)?.message ?? String(err);
    error.hidden = false;
  };
  $('btn-removed-download').addEventListener('click', () =>
    void withBusy('btn-removed-download', t('busy.downloading'), async () => {
      error.hidden = true;
      try {
        const removed = await send<RemovedSyncSnapshot | null>({ command: MessageCommand.GetRemovedSync });
        if (!removed) return refreshRemovedCard();
        const day = removed.savedAt.slice(0, 10);
        await send({
          command: MessageCommand.DownloadFile,
          filename: `keepmark-removed-sync-${day}.json`,
          text: JSON.stringify(removed, null, 2),
        });
      } catch (err) {
        fail(err);
      }
    }),
  );
  $('btn-removed-dismiss').addEventListener('click', () =>
    void (async () => {
      error.hidden = true;
      const ok = await confirmInline('btn-removed-dismiss', {
        message: t('popup.removed.deleteConfirm'),
        implication: RemovedSyncDismissImplication(),
        confirmLabel: t('common.yesDelete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await send({ command: MessageCommand.ClearRemovedSync });
        ($('p-removed') as HTMLElement).hidden = true;
      } catch (err) {
        fail(err);
      }
    })(),
  );
}

/** Kind of the undo slot the banner shows (its confirm names it). */
let undoKind = '';

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
  undoKind = undo.kind;
  $('p-undo-text').textContent = describeUndo(undo.kind, undo.bookmarkCount, undo.timestamp);
  showFor('p-undo', undoBannerRemainingMs(undo.timestamp), 'btn-undo');
}

async function initConnect(): Promise<void> {
  input('service-url').value = DefaultServiceUrl;
  const updateMode = (): void => {
    const mode = (document.querySelector('input[name="conn-mode"]:checked') as HTMLInputElement).value;
    ($('conn-existing-only') as HTMLElement).hidden = mode !== 'existing';
    ($('conn-existing-direction') as HTMLElement).hidden = mode !== 'existing';
    ($('conn-new-only') as HTMLElement).hidden = mode !== 'new';
    updateDirection();
  };
  const updateDirection = (): void => {
    const direction = (document.querySelector('input[name="conn-direction"]:checked') as HTMLInputElement).value;
    cancelConfirm('btn-connect');
    // Say what the click does: "Connect" alone hid create vs link-and-overwrite.
    const mode = (document.querySelector('input[name="conn-mode"]:checked') as HTMLInputElement).value;
    $('btn-connect').textContent =
      mode === 'new'
        ? t('popup.connect.createSync')
        : direction === 'push'
          ? t('popup.connect.linkUpload')
          : direction === 'merge'
            ? t('popup.connect.linkMerge')
            : t('popup.connect.linkDownload');
  };
  document.querySelectorAll('input[name="conn-mode"], input[name="conn-direction"]').forEach((el) => {
    el.addEventListener('change', updateMode);
  });
  updateMode();
  // Editing the form while the confirm is open drops it: never connect with
  // what was not confirmed.
  ['service-url', 'sync-id', 'password', 'confirm-password'].forEach((id) =>
    $(id).addEventListener('input', () => cancelConfirm('btn-connect')),
  );
  $('btn-connect').addEventListener('click', () => void submitConnect());
  $('btn-open-tab').addEventListener('click', () => {
    // Popups close on focus loss (by design) — a full tab stays open while
    // copying credentials from a vault. State carries over via storage.
    const url = browser.runtime.getURL('popup.html?fullpage=1');
    void browser.tabs.create({ url }).then(() => window.close());
  });
}

/**
 * Connect: new creates without a confirm (nothing is replaced); existing
 * always confirms inline with the direction's loss line, merge with its
 * counts first. Asked BEFORE the busy wrapper (confirmInline owns the
 * button while open).
 */
async function submitConnect(): Promise<void> {
  clearMessages();
  const mode = (document.querySelector('input[name="conn-mode"]:checked') as HTMLInputElement).value as
    | 'new'
    | 'existing';
  const direction = (document.querySelector('input[name="conn-direction"]:checked') as HTMLInputElement)
    .value as Direction;
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
  });
  if (invalid) {
    showError('connect-error', invalid);
    return;
  }
  if (mode === 'existing') {
    let counts = '';
    if (direction === 'merge') {
      // Two-phase: preview first so the confirm shows exactly what the union
      // will upload/download before anything mutates.
      let preview: MergePreview | undefined;
      await withBusy('btn-connect', t('busy.checking'), async () => {
        try {
          preview = await send<MergePreview>({ command: MessageCommand.PreviewMerge, serviceUrl, syncId, password });
        } catch (err) {
          showError('connect-error', (err as Error).message);
        }
      });
      if (!preview) return;
      counts = t('popup.merge.counts', {
        local: preview.localOnly,
        remote: preview.remoteOnly,
        titles: preview.titleConflicts,
      });
    }
    const ok = await confirmInline('btn-connect', {
      message: directionConfirm(direction).message,
      implication: `${counts}${directionConfirm(direction).implication}`,
      confirmLabel: directionConfirm(direction).confirmLabel,
      danger: direction !== 'merge',
    });
    if (!ok) return;
  }
  await withBusy('btn-connect', t('busy.connecting'), async () => {
    try {
      if (mode === 'new') {
        await send({ command: MessageCommand.ConnectNew, serviceUrl, password });
      } else {
        await send({ command: MessageCommand.ConnectExisting, serviceUrl, syncId, password, direction });
      }
      input('password').value = '';
      input('confirm-password').value = '';
      showView('main');
      await refreshAll();
    } catch (err) {
      // Never leave the confirmation in the DOM; the main password stays so
      // a transient failure doesn't force a full retype from the vault.
      input('confirm-password').value = '';
      showError('connect-error', (err as Error).message);
    }
  });
}

function initMain(): void {
  $('btn-sync-now').addEventListener('click', async () => {
    clearMessages();
    await withBusy('btn-sync-now', t('ui.pill.syncing'), async () => {
      try {
        const result = await send<{ queued: boolean; conflict?: boolean }>({
          command: MessageCommand.SyncBookmarks,
          sync: { type: 'remote', runSync: true },
        });
        if (result.conflict) {
          // Conflict captured — will be shown on next refresh
          return;
        }
      } catch (err) {
        showError('main-error', (err as Error).message);
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
  $('btn-resolve-conflict').addEventListener('click', () => {
    const url = browser.runtime.getURL('manager.html?section=status');
    if (new URLSearchParams(location.search).has('fullpage')) {
      location.href = url;
    } else {
      void browser.tabs.create({ url }).then(() => window.close());
    }
  });
  $('btn-copy-id').addEventListener('click', () => {
    if (status?.syncId) void copyText(status.syncId, t('popup.copyIdPrompt'));
  });
  $('btn-undo').addEventListener('click', async () => {
    clearMessages();
    // Asked BEFORE withBusy (confirmInline owns the button while open).
    if (!(await confirmInline('btn-undo', { ...undoConfirm(undoKind), danger: true }))) return;
    await withBusy('btn-undo', t('busy.undoing'), async () => {
      try {
        const res = await send<{ undone: string }>({ command: MessageCommand.UndoLastLink });
        await refreshAll();
        const done = $('main-result');
        done.textContent = undoneText(res.undone);
        done.hidden = false;
      } catch (err) {
        showError('main-error', (err as Error).message);
      }
    });
  });
  $('btn-undo-dismiss').addEventListener('click', async () => {
    await send({ command: MessageCommand.DismissUndo }).catch(() => undefined);
    ($('p-undo') as HTMLElement).hidden = true;
  });
}

async function init(): Promise<void> {
  await initI18n();
  if (new URLSearchParams(location.search).has('fullpage')) {
    document.body.classList.add('fullpage');
    ($('btn-open-tab') as HTMLButtonElement).hidden = true;
  }
  await initConnect();
  initMain();
  initRemovedCard();
  await refreshAll(true);
}

void init();
