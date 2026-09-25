// Full-tab manager: sidebar sections, each with its own contextual
// busy/error/result evidence. Shares the status renderer + helpers with the
// popup via ../popup/ui.js. Display only; mutations go through background.

import browser from 'webextension-polyfill';
import { ApiVersion, MinApiVersion, SyncClientVersion } from '../shared/constants.js';
import {
  $,
  contractGate,
  copyText,
  describeUndo,
  validatePasswordChange,
  validateSwitch,
  input,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
} from '../popup/ui.js';
import {
  MessageCommand,
  type DuplicateGroup,
  type PingResponse,
  type StatusResponse,
  type SwitchPreviewResult,
  type UndoState,
} from '../shared/messages.js';
import { StoreKey } from '../shared/store.js';

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;
let preview: SwitchPreviewResult | undefined;

function sectionError(id: string, message: string): void {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function hideErrors(): void {
  for (const id of ['status-error', 'backup-error', 'dup-error', 'move-error', 'logs-error', 'settings-error', 'pw-error']) {
    $(id).hidden = true;
  }
}

function showSection(name: string): void {
  document.querySelectorAll('#sidebar button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.section === name);
  });
  for (const sec of ['status', 'backup', 'duplicates', 'move', 'logs', 'settings', 'about']) {
    ($(`sec-${sec}`) as HTMLElement).hidden = sec !== name;
  }
  if (name === 'status') void refreshStatus();
  if (name === 'duplicates') void scanDuplicates();
  if (name === 'logs') void refreshLogs();
  if (name === 'settings') void renderSettings();
  if (name === 'about') renderAbout();
}

async function refreshStatus(): Promise<void> {
  hideErrors();
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    sectionError('status-error', (err as Error).message);
    return;
  }
  const view: StatusView = { status, ping: undefined };
  renderStatusCard('m', view);
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    ping = undefined;
  }
  renderStatusCard('m', { status, ping });
  updateDangerZone();
  await refreshUndoBanner();
}

async function refreshUndoBanner(): Promise<void> {
  const banner = $('undo-banner') as HTMLElement;
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
  $('undo-text').textContent = describeUndo(undo.kind, undo.bookmarkCount, undo.timestamp);
  banner.hidden = false;
}

function initUndoBanner(): void {
  $('m-btn-undo').addEventListener('click', () =>
    withBusy('m-btn-undo', 'Undoing…', async () => {
      hideErrors();
      if (!window.confirm('Undo the last link operation? Changes made since will be discarded.')) return;
      try {
        const res = await send<{ undone: string }>({ command: MessageCommand.UndoLastLink });
        showResult('status-result', `Undone: ${res.undone}.`);
        await refreshStatus();
        await refreshUndoBanner();
      } catch (err) {
        sectionError('status-error', (err as Error).message);
      }
    }),
  );
  $('m-btn-undo-dismiss').addEventListener('click', async () => {
    await send({ command: MessageCommand.DismissUndo }).catch(() => undefined);
    ($('undo-banner') as HTMLElement).hidden = true;
  });
}

function initSidebar(): void {
  document.querySelectorAll('#sidebar button').forEach((b) => {
    b.addEventListener('click', () => showSection((b as HTMLElement).dataset.section!));
  });
  const initial = new URLSearchParams(location.search).get('section');
  if (initial && document.getElementById(`sec-${initial}`)) {
    showSection(initial);
  }
}

function initStatusSection(): void {
  $('m-btn-sync-now').addEventListener('click', () =>
    withBusy('m-btn-sync-now', 'Syncing…', async () => {
      hideErrors();
      try {
        await send({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } });
      } catch (err) {
        sectionError('status-error', (err as Error).message);
      }
      await refreshStatus();
    }),
  );
  $('m-btn-refresh').addEventListener('click', () => void refreshStatus());
  $('m-btn-copy-id').addEventListener('click', () => {
    if (status?.syncId) void copyText(status.syncId, 'Copy sync ID:');
  });
  $('m-btn-unlink').addEventListener('click', () =>
    withBusy('m-btn-unlink', 'Unlinking…', async () => {
      hideErrors();
      if (!window.confirm('Unlink this device? Sync stops; native bookmarks are untouched.')) return;
      try {
        await send({ command: MessageCommand.DisableSync });
        showResult('status-result', 'Unlinked. Native bookmarks are untouched.');
        status = undefined;
        ping = undefined;
        await refreshStatus();
      } catch (err) {
        sectionError('status-error', (err as Error).message);
      }
    }),
  );
  $('m-btn-delete-remote').addEventListener('click', () =>
    withBusy('m-btn-delete-remote', 'Deleting…', async () => {
      hideErrors();
      // Defense in depth: the background re-gates, but a disabled button
      // must never even reach the confirms.
      if (($('m-btn-delete-remote') as HTMLButtonElement).disabled) return;
      // No undo exists for this (the server has no undelete): two explicit
      // confirms plus the automatic backup download in the background.
      if (
        !window.confirm(
          'Delete the SERVER copy of your sync? Local bookmarks stay, but the server copy is gone forever. A backup file is downloaded first.',
        )
      )
        return;
      if (!window.confirm('Last chance: confirm deletion of the server copy.')) return;
      try {
        await send({ command: MessageCommand.DeleteRemoteSync });
        showResult('status-result', 'Server copy deleted. Device unlinked; local bookmarks untouched.');
        status = undefined;
        ping = undefined;
        await refreshStatus();
      } catch (err) {
        sectionError('status-error', (err as Error).message);
      }
    }),
  );
}

/**
 * v1.2 gating for the danger zone: the delete button is enabled only when
 * the linked service speaks v1.2 (live probe wins, stored flag as fallback
 * when offline). Legacy services see the button disabled plus the reason.
 */
function updateDangerZone(): void {
  const btn = $('m-btn-delete-remote') as HTMLButtonElement;
  const hint = $('m-delete-v12-hint') as HTMLElement;
  const contract = $('m-api-contract');
  const gate = contractGate({
    liveV12: ping?.supportsV12,
    storedV12: status?.supportsV12,
    syncEnabled: !!status?.syncEnabled,
  });
  btn.disabled = !gate.enabled;
  btn.title = gate.title;
  hint.hidden = gate.hintHidden;
  contract.textContent = gate.badge;
}

function showResult(id: string, text: string): void {
  const el = $(id);
  el.textContent = text;
  el.hidden = false;
}

function initBackupSection(): void {
  $('m-btn-export').addEventListener('click', () =>
    withBusy('m-btn-export', 'Exporting…', async () => {
      hideErrors();
      const password = window.prompt('Backup password (min 8 chars):') ?? '';
      if (!password) return;
      try {
        const json = await send<string>({ command: MessageCommand.ExportBackup, password });
        await send({
          command: MessageCommand.DownloadFile,
          filename: `keepmark-backup-${new Date().toISOString().slice(0, 10)}.xbs.json`,
          text: json,
        });
        showResult('backup-result', 'Backup exported to your downloads.');
      } catch (err) {
        sectionError('backup-error', (err as Error).message);
      }
    }),
  );
  $('m-btn-import').addEventListener('click', () => ($('m-import-file') as HTMLInputElement).click());
  ($('m-import-file') as HTMLInputElement).addEventListener('change', async (e) => {
    hideErrors();
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const password = window.prompt('Backup password:') ?? '';
    if (!password) return;
    await withBusy('m-btn-import', 'Importing…', async () => {
      try {
        const json = await file.text();
        const res = await send<{ count: number }>({ command: MessageCommand.ImportBackup, json, password });
        showResult('backup-result', `Imported ${res.count} nodes and pushed to the service.`);
      } catch (err) {
        sectionError('backup-error', (err as Error).message);
      }
    });
  });
}

async function scanDuplicates(): Promise<void> {
  const box = $('m-dup-list');
  box.textContent = '';
  $('nav-dup-count').textContent = '';
  let groups: DuplicateGroup[] = [];
  try {
    groups = await send<DuplicateGroup[]>({ command: MessageCommand.GetDuplicates });
  } catch (err) {
    sectionError('dup-error', (err as Error).message);
    return;
  }
  if (groups.length === 0) {
    box.innerHTML = '<p class="clean">No duplicates — everything is clean ✓</p>';
    return;
  }
  $('nav-dup-count').textContent = `(${groups.length})`;
  groups.forEach((group, gi) => {
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
        btn.id = `dup-del-${gi}-${entry.id}`;
        btn.addEventListener('click', () => {
          hideErrors();
          btn.disabled = true;
          btn.textContent = 'Deleting…';
          send({ command: MessageCommand.RemoveBookmark, id: entry.id })
            .then(() => scanDuplicates())
            .catch((err: Error) => {
              sectionError('dup-error', err.message);
              btn.disabled = false;
              btn.textContent = 'Delete';
            });
        });
        li.append(' ', btn);
      }
      ul.append(li);
    });
    div.append(head, ul);
    box.append(div);
  });
}

function initDuplicatesSection(): void {
  $('m-btn-duplicates').addEventListener('click', () => void scanDuplicates());
}

function switchMode(): 'new' | 'existing' {
  return (document.querySelector('input[name="m-switch-mode"]:checked') as HTMLInputElement).value as
    | 'new'
    | 'existing';
}

function switchDirection(): 'push' | 'pull' {
  return (document.querySelector('input[name="m-switch-direction"]:checked') as HTMLInputElement).value as
    | 'push'
    | 'pull';
}

function updateMoveForm(): void {
  const mode = switchMode();
  ($('m-switch-id-row') as HTMLElement).hidden = mode !== 'existing';
  ($('m-switch-direction-row') as HTMLElement).hidden = mode !== 'existing';
  ($('m-switch-confirm-row') as HTMLElement).hidden = mode !== 'new';
  preview = undefined;
  $('m-btn-switch').toggleAttribute('disabled', true);
  $('move-error').hidden = true;
  $('move-preview').hidden = true;
  $('move-result').hidden = true;
  const url = input('m-switch-url').value.trim() || '…';
  const n = status?.bookmarkCount;
  const direction = switchDirection();
  $('move-summary').textContent =
    mode === 'new'
      ? `Will create a new sync on ${url} and upload ${n ?? 'your'} bookmarks.`
      : direction === 'push'
        ? `Will overwrite the remote sync on ${url} with ${n ?? 'your'} local bookmarks.`
        : `Will replace local bookmarks with the remote sync from ${url}.`;
}

async function previewTarget(): Promise<void> {
  hideErrors();
  const newServiceUrl = input('m-switch-url').value.trim();
  if (!newServiceUrl) {
    sectionError('move-error', 'New service URL is required.');
    return;
  }
  const mode = switchMode();
  const syncId = input('m-switch-id').value.trim() || undefined;
  if (mode === 'existing' && !syncId) {
    sectionError('move-error', 'Sync ID is required for an existing sync.');
    return;
  }
  await withBusy('m-btn-preview', 'Checking…', async () => {
    try {
      preview = await send<SwitchPreviewResult>({
        command: MessageCommand.SwitchPreview,
        newServiceUrl,
        mode,
        syncId,
      });
    } catch (err) {
      sectionError('move-error', (err as Error).message);
      return;
    }
    const box = $('move-preview');
    if (!preview.reachable) {
      box.textContent = 'Target service is unreachable.';
    } else {
      const lines = [
        `Service v${preview.serviceVersion ?? '?'} (${preview.versionCompatible ? 'compatible' : 'TOO OLD — move blocked'})`,
        `Remote sync: ${mode === 'new' ? 'n/a (will be created)' : preview.remoteExists ? `found, updated ${preview.remoteLastUpdated ?? '?'}` : 'NOT FOUND — check the ID'}`,
        `Local bookmarks: ${preview.localCount ?? '?'}`,
      ];
      box.textContent = lines.join('\n');
    }
    box.hidden = false;
    const ok =
      preview.reachable &&
      preview.versionCompatible !== false &&
      (mode === 'new' || preview.remoteExists === true);
    ($('m-btn-switch') as HTMLButtonElement).disabled = !ok;
  });
}

async function submitMove(): Promise<void> {
  hideErrors();
  const newServiceUrl = input('m-switch-url').value.trim();
  const mode = switchMode();
  const direction = switchDirection();
  const syncId = input('m-switch-id').value.trim() || undefined;
  const newPassword = input('m-switch-password').value;
  const confirm = input('m-switch-confirm').value;
  const invalid = validateSwitch({ mode, newServiceUrl, syncId, newPassword, confirm });
  if (invalid) {
    sectionError('move-error', invalid);
    return;
  }
  await withBusy('m-btn-switch', 'Moving…', async () => {
    ($('move-result') as HTMLElement).hidden = true;
    try {
      const res = await send<{ id: string }>({
        command: MessageCommand.SwitchService,
        switch: { newServiceUrl, mode, syncId, newPassword, direction },
      });
      input('m-switch-password').value = '';
      input('m-switch-confirm').value = '';
      showResult('move-result', `Moved. New sync ID: ${res.id}`);
      await refreshStatus();
    } catch (err) {
      input('m-switch-confirm').value = '';
      sectionError('move-error', (err as Error).message);
    }
  });
}

function initMoveSection(): void {
  document.querySelectorAll('input[name="m-switch-mode"], input[name="m-switch-direction"]').forEach((el) => {
    el.addEventListener('change', updateMoveForm);
  });
  input('m-switch-url').addEventListener('input', updateMoveForm);
  $('m-btn-preview').addEventListener('click', () => void previewTarget());
  $('m-btn-switch').addEventListener('click', () => void submitMove());
  updateMoveForm();
}

async function refreshLogs(): Promise<void> {
  hideErrors();
  try {
    const entries = await send<{ timestamp: string; level: number; tag: string; message: string }[]>({
      command: MessageCommand.GetLogs,
    });
    const names = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
    $('m-log-list').textContent = entries
      .map((e) => `${e.timestamp} [${names[e.level] ?? e.level}] ${e.tag}: ${e.message}`)
      .join('\n');
  } catch (err) {
    sectionError('logs-error', (err as Error).message);
  }
}

function initLogsSection(): void {
  $('m-btn-logs').addEventListener('click', () => void refreshLogs());
}

async function renderSettings(): Promise<void> {
  hideErrors();
  const info = $('m-service-info');
  info.textContent = '';
  let st: StatusResponse | undefined;
  try {
    st = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    sectionError('settings-error', (err as Error).message);
    return;
  }
  let pg: PingResponse | undefined;
  try {
    pg = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    pg = undefined;
  }
  const rows: [string, string][] = [
    ['Reachability', pg?.reachable ? 'Online' : 'Unreachable'],
    ['Service', st?.serviceUrl ?? '—'],
    ['API version', pg?.version ?? '—'],
    ['API contract', pg?.supportsV12 ?? st?.supportsV12 ? 'v1.2 (revision sync + server delete)' : 'v1.1'],
    ['Sync ID', st?.syncId ?? '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    info.append(dt, dd);
  }
  const toolbar = await browser.storage.local.get(StoreKey.SyncBookmarksToolbar);
  (input('m-opt-toolbar') as HTMLInputElement).checked =
    (toolbar[StoreKey.SyncBookmarksToolbar] as boolean | undefined) ?? true;
  const level = st?.logLevel ?? 2;
  ($('m-opt-verbosity') as HTMLSelectElement).value = String(level);
}

function initSettingsSection(): void {
  (input('m-opt-toolbar') as HTMLInputElement).addEventListener('change', (e) => {
    void browser.storage.local.set({ [StoreKey.SyncBookmarksToolbar]: (e.target as HTMLInputElement).checked });
  });
  ($('m-opt-verbosity') as HTMLSelectElement).addEventListener('change', async (e) => {
    hideErrors();
    const level = Number((e.target as HTMLSelectElement).value);
    try {
      await send({ command: MessageCommand.SetVerbosity, level });
      showResult('settings-result', `Log verbosity set to ${['Error', 'Warning', 'Info', 'Debug', 'Verbose'][level]}.`);
    } catch (err) {
      sectionError('settings-error', (err as Error).message);
    }
  });
  $('m-btn-password').addEventListener('click', () =>
    withBusy('m-btn-password', 'Changing…', async () => {
      hideErrors();
      ($('pw-result') as HTMLElement).hidden = true;
      const current = input('m-current-password').value;
      const next = input('m-new-password').value;
      const invalid = validatePasswordChange({ current, next, confirm: input('m-new-password-confirm').value });
      if (invalid) {
        sectionError('pw-error', invalid);
        return;
      }
      try {
        await send({ command: MessageCommand.ChangePassword, currentPassword: current, newPassword: next });
        input('m-current-password').value = '';
        input('m-new-password').value = '';
        input('m-new-password-confirm').value = '';
        showResult('pw-result', 'Password changed. Update your other devices and vault now.');
        await refreshStatus();
      } catch (err) {
        // Never leave the current password or its confirmation in the DOM;
        // the new password stays so only the proof has to be retyped.
        input('m-current-password').value = '';
        input('m-new-password-confirm').value = '';
        sectionError('pw-error', (err as Error).message);
      }
    }),
  );
}

function renderAbout(): void {
  $('about-version').textContent = `v${browser.runtime.getManifest().version}`;
  $('about-api').textContent = `v${ApiVersion}`;
  $('about-minapi').textContent = `v${MinApiVersion}`;
  $('about-syncver').textContent = `v${SyncClientVersion}`;
  // Registered on every section visit: guard so N visits stack a single handler.
  const bug = $('about-bug');
  if (!bug.dataset.bound) {
    bug.dataset.bound = '1';
    bug.addEventListener('click', () => {
      const version = browser.runtime.getManifest().version;
      const subject = encodeURIComponent(`[Keepmark ${version}] Bug report`);
      const body = encodeURIComponent(
        `App version: ${version}\nAPI version: ${ApiVersion}\nSync format: ${SyncClientVersion}\n\nDescribe the issue:\n`,
      );
      location.href = `mailto:keepmark@proton.me?subject=${subject}&body=${body}`;
    });
  }
}

function init(): void {
  initSidebar();
  initStatusSection();
  initUndoBanner();
  initBackupSection();
  initDuplicatesSection();
  initMoveSection();
  initLogsSection();
  initSettingsSection();
  void refreshStatus();
}
void init();
