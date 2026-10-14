// Full-tab manager: sidebar sections, each with its own contextual
// busy/error/result evidence. Shares the status renderer + helpers with the
// popup via ../popup/ui.js. Display only; mutations go through background.

import browser from 'webextension-polyfill';
import { ApiVersion, ApiVersion12, MinApiVersion, PasswordTooShort, SyncClientVersion } from '../shared/constants.js';
import {
  $,
  contractGate,
  copyText,
  describeMoveResult,
  describeSyncExpiry,
  describeUndo,
  undoBannerRemainingMs,
  formatBytes,
  validatePasswordChange,
  validateServiceUrl,
  validateSwitch,
  input,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
  initI18n,
} from '../popup/ui.js';
import { StoreKey } from '../shared/store.js';
import { displayPath, formatDateTime, t, tn, type MessageKey } from '../shared/i18n.js';
import type { LangSetting } from '../shared/i18n.js';
import { cancelConfirm, clearMessages, confirmInline, showError, showFor } from '../popup/flow.js';
import {
  ChangePasswordDone,
  ChangePasswordImplication,
  DeleteRemoteDone,
  DeleteRemoteImplication,
  MoveDoneNext,
  MoveImplication,
  DirectionOrder,
  directionConfirm,
  dupDeleteConfirm,
  dupDeleteDone,
  moveNewConfirm,
  UnlinkDone,
  UnlinkImplication,
  ImportImplication,
  SafetyDeleteImplication,
  exportDone,
  importChecked,
  importDone,
  safetyRestoreDone,
  safetyRestoreImplication,
  undoConfirm,
  undoneText,
} from '../popup/texts.js';
import {
  MessageCommand,
  type DuplicateGroup,
  type MergePreview,
  type PingResponse,
  type SafetyEntry,
  type StatusResponse,
  type SwitchPreviewResult,
  type UndoState,
  // Conflict resolution types
  type ConflictPreviewResponse,
  type ConflictResolutionDirection,
  type ConflictStateResponse,
} from '../shared/messages.js';
import { MaxBackupBytes, MinBackupPasswordLength } from '../shared/backup.js';
import { defaultMarkedIds, isSelectionLocked } from '../shared/duplicates.js';

let status: StatusResponse | undefined;
let ping: PingResponse | undefined;
let preview: SwitchPreviewResult | undefined;
/** Merge dry-run from the last Check target (merge direction only). */
let mergeStats: MergePreview | undefined;
/** Move URL prefilled once from the current link (never clobbers typing). */
let moveUrlPrefilled = false;
/** Current conflict preview (fetched when status.conflict === true). */
let conflictPreview: ConflictPreviewResponse | undefined;

/** Fill an empty move URL with the current link (same host is the common
 * case). Runs on section visits and status refreshes until it sticks. */
function prefillMoveUrl(): void {
  if (moveUrlPrefilled) return;
  if (input('m-switch-url').value.trim()) {
    moveUrlPrefilled = true;
    return;
  }
  if (status?.serviceUrl) {
    input('m-switch-url').value = status.serviceUrl;
    moveUrlPrefilled = true;
  }
}
/** Generation token: stale refresh responses never overwrite newer state. */
let statusSeq = 0;
/** Inputs the current preview was made for — submit requires an exact match. */
let previewFor: { newServiceUrl: string; mode: string; syncId?: string; direction: 'push' | 'pull' | 'merge' } | undefined;

function showSection(name: string, moveFocus = false): void {
  document.querySelectorAll('#sidebar button').forEach((b) => {
    const active = (b as HTMLElement).dataset.section === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  for (const sec of ['status', 'backup', 'duplicates', 'move', 'logs', 'settings', 'about']) {
    ($(`sec-${sec}`) as HTMLElement).hidden = sec !== name;
  }
  if (moveFocus) {
    // Keyboard/screen-reader users stay on the sidebar while content swaps
    // elsewhere: move focus to the new heading (tabindex -1, no tab stop).
    const heading = document.querySelector(`#sec-${name} h2`);
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
  if (name === 'status') void refreshStatus();
  if (name === 'backup') void refreshSafety();
  if (name === 'move') updateMoveForm();
  if (name === 'duplicates') void scanDuplicates();
  if (name === 'logs') void refreshLogs();
  if (name === 'settings') void renderSettings();
  if (name === 'about') renderAbout();
}

/** Status refresh clears stale ERROR boxes only: it runs right after every
 *  successful action (and on storage changes), so hiding result boxes here
 *  would erase the success evidence the action just showed. */
function hideStatusErrors(): void {
  for (const id of ['status-error', 'status-error-2', 'conflict-error']) {
    const el = $(id);
    el.hidden = true;
    el.textContent = '';
  }
}

async function refreshStatus(): Promise<void> {
  const my = ++statusSeq;
  hideStatusErrors();
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    if (my !== statusSeq) return;
    // Never leave a stale linked card: redraw cleared, then report.
    status = undefined;
    ping = undefined;
    conflictPreview = undefined;
    renderStatusCard('m', { status, ping });
    updateStatusActions();
    updateDangerZone();
    updateLinkGates();
    renderConflictSection();
    ($('m-notlinked-hint') as HTMLElement).hidden = true;
    showError('status-error', (err as Error).message);
    return;
  }
  if (my !== statusSeq) return;
  const view: StatusView = { status, ping: undefined };
  renderStatusCard('m', view);
  prefillMoveUrl();
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    ping = undefined;
  }
  if (my !== statusSeq) return;
  renderStatusCard('m', { status, ping });
  updateStatusActions();
  updateDangerZone();
  updateLinkGates();
  ($('m-notlinked-hint') as HTMLElement).hidden = !!status?.syncEnabled;
  await refreshUndoBanner();

  // If there's a conflict, fetch the preview and render resolution UI.
  if (status?.conflict) {
    await loadConflictPreview();
  } else {
    conflictPreview = undefined;
    renderConflictSection();
  }
}

/** Kind of the undo slot the banner shows (its confirm names it). */
let undoKind = '';

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
  undoKind = undo.kind;
  $('undo-text').textContent = describeUndo(undo.kind, undo.bookmarkCount, undo.timestamp);
  showFor('undo-banner', undoBannerRemainingMs(undo.timestamp), 'm-btn-undo');
}

/** Fetch detailed conflict preview from background. */
async function loadConflictPreview(): Promise<void> {
  try {
    conflictPreview = await send<ConflictPreviewResponse>({ command: MessageCommand.GetConflictPreview });
    if (conflictPreview.diff.identical) {
      // The background already adopted the server copy and cleared it.
      conflictPreview = undefined;
      showResult('status-result', t('mgr.conflict.identical'));
      await refreshStatus();
      return;
    }
  } catch (err) {
    conflictPreview = undefined;
    showError('conflict-error', (err as Error).message);
  }
  renderConflictSection();
}

/** Fill a sample list with plain text (bookmark titles come from web pages:
 *  never interpolate them into HTML). */
function fillList(id: string, items: string[], total: number): void {
  const list = $(id);
  list.replaceChildren();
  const rows = total > 0 ? items : [];
  for (const text of rows.length > 0 ? rows : ['—']) {
    const li = document.createElement('li');
    li.textContent = displayPath(text);
    if (rows.length === 0) li.className = 'empty';
    list.appendChild(li);
  }
}

/** Render the conflict resolution UI in the status section (text only). */
function renderConflictSection(): void {
  const section = $('m-conflict-section');
  if (!status?.conflict || !conflictPreview) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const { mergeStats } = conflictPreview;
  $('m-conflict-intro').textContent = t(
    conflictPreview.reason === 'roots' ? 'manager.conflict.introRoots' : 'manager.conflict.intro',
  );
  $('m-conflict-local-count').textContent = String(mergeStats.localCount);
  $('m-conflict-remote-count').textContent = String(mergeStats.remoteCount);
  $('m-conflict-remote-time').textContent = mergeStats.remoteCount > 0 ? t('common.items') : t('mgr.conflict.itemsEmpty');
  $('conflict-stat-local').textContent = String(mergeStats.localOnly);
  $('conflict-stat-remote').textContent = String(mergeStats.remoteOnly);
  $('conflict-stat-titles').textContent = String(mergeStats.titleConflicts);
  $('conflict-stat-folders').textContent = String(mergeStats.foldersCreated);
  $('conflict-stat-separators').textContent = String(mergeStats.separatorsAdopted);
  $('conflict-hint-merge').textContent = t(
    mergeStats.titleConflicts > 0 ? 'mgr.conflict.hintMergeTitles' : 'mgr.conflict.hintMerge',
    { local: mergeStats.localOnly, remote: mergeStats.remoteOnly, titles: mergeStats.titleConflicts },
  );
  $('conflict-hint-pull').textContent = t('mgr.conflict.hintPull', { count: mergeStats.remoteCount });
  $('conflict-hint-push').textContent = t('mgr.conflict.hintPush', { count: mergeStats.localCount });
  fillList('conflict-list-local', conflictPreview.localOnlySample, mergeStats.localOnly);
  fillList('conflict-list-remote', conflictPreview.remoteOnlySample, mergeStats.remoteOnly);
  fillList('conflict-list-titles', conflictPreview.titleConflictsSample, mergeStats.titleConflicts);
  fillList('conflict-list-folders', conflictPreview.foldersCreatedSample, mergeStats.foldersCreated);
  const { diff } = conflictPreview;
  $('conflict-stat-moved').textContent = String(diff.moved);
  $('conflict-stat-meta').textContent = String(diff.metadataChanged);
  fillList('conflict-list-moved', diff.movedSample, diff.moved);
  fillList('conflict-list-meta', diff.metadataSample, diff.metadataChanged);
  $('conflict-explain').textContent = explainConflict(conflictPreview);
  $('conflict-explain').hidden = false;
}

/** One plain sentence on what actually differs, so all-zero URL counters
 *  never leave the user guessing. */
function explainConflict(p: ConflictPreviewResponse): string {
  const { mergeStats: m, diff: d } = p;
  const urlLevel = m.localOnly + m.remoteOnly + m.titleConflicts;
  if (d.orderOnly) {
    return t('mgr.conflict.explainOrder');
  }
  if (urlLevel === 0 && d.moved === 0 && d.metadataChanged === 0 && d.foldersDiffer) {
    return t('mgr.conflict.explainFolders');
  }
  if (urlLevel === 0) {
    const parts = [];
    if (d.moved > 0) parts.push(t('mgr.conflict.partMoved', { count: d.moved }));
    if (d.metadataChanged > 0) parts.push(t('mgr.conflict.partMeta', { count: d.metadataChanged }));
    return t('mgr.conflict.explainDiff', { parts: parts.join(', ') });
  }
  return t('mgr.conflict.explainCounts', {
    local: m.localOnly,
    remote: m.remoteOnly,
    titles: m.titleConflicts,
    moved: d.moved > 0 ? t('mgr.conflict.suffixMoved', { count: d.moved }) : '',
    meta: d.metadataChanged > 0 ? t('mgr.conflict.suffixMeta', { count: d.metadataChanged }) : '',
  });
}

const conflictDone = (d: ConflictResolutionDirection): string =>
  t(d === 'pull' ? 'mgr.conflict.donePull' : d === 'push' ? 'mgr.conflict.donePush' : 'mgr.conflict.doneMerge');

const conflictButtons = DirectionOrder.map((d) => `conflict-btn-${d}`);

/** Execute the chosen conflict resolution (confirmed, busy-guarded). */
async function resolveConflict(direction: ConflictResolutionDirection): Promise<void> {
  clearMessages();
  // One open confirm at a time: picking another side replaces it.
  conflictButtons.forEach((id) => cancelConfirm(id));
  const ok = await confirmInline(`conflict-btn-${direction}`, {
    ...directionConfirm(direction),
    danger: direction !== 'merge',
  });
  if (!ok) return;
  // Not withBusy(): it swaps textContent and would flatten the <b>/<small>
  // markup. Lock all three, retitle only the chosen one's label.
  const buttons = conflictButtons.map((id) => $(id) as HTMLButtonElement);
  const prev = buttons.map((b) => b.disabled);
  const label = $(`conflict-btn-${direction}`).querySelector('b') as HTMLElement;
  const original = [...label.childNodes];
  const busy: Record<ConflictResolutionDirection, string> = {
    pull: t('busy.downloading'),
    push: t('busy.uploading'),
    merge: t('busy.merging'),
  };
  buttons.forEach((b) => (b.disabled = true));
  label.textContent = busy[direction];
  try {
    await send({ command: MessageCommand.ResolveConflict, direction });
    // The conflict section hides as soon as the conflict clears: the
    // success evidence (naming the safety backups) sits right below it.
    showResult('conflict-result', conflictDone(direction));
    await refreshStatus();
  } catch (err) {
    showError('conflict-error', (err as Error).message);
  } finally {
    label.replaceChildren(...original);
    buttons.forEach((b, i) => (b.disabled = prev[i]));
  }
}

function initConflictSection(): void {
  $('conflict-btn-pull').addEventListener('click', () => void resolveConflict('pull'));
  $('conflict-btn-push').addEventListener('click', () => void resolveConflict('push'));
  $('conflict-btn-merge').addEventListener('click', () => void resolveConflict('merge'));
}

function initUndoBanner(): void {
  $('m-btn-undo').addEventListener('click', async () => {
    clearMessages();
    // Asked BEFORE withBusy (confirmInline owns the button while open).
    if (!(await confirmInline('m-btn-undo', { ...undoConfirm(undoKind), danger: true }))) return;
    await withBusy('m-btn-undo', t('busy.undoing'), async () => {
      try {
        const res = await send<{ undone: string }>({ command: MessageCommand.UndoLastLink });
        showResult('status-result', undoneText(res.undone));
        await refreshStatus();
        await refreshUndoBanner();
      } catch (err) {
        showError('status-error-2', (err as Error).message);
      }
    });
  });
  $('m-btn-undo-dismiss').addEventListener('click', async () => {
    await send({ command: MessageCommand.DismissUndo }).catch(() => undefined);
    ($('undo-banner') as HTMLElement).hidden = true;
  });
}

function initSidebar(): void {
  document.querySelectorAll('#sidebar button').forEach((b) => {
    b.addEventListener('click', () => showSection((b as HTMLElement).dataset.section!, true));
  });
  const initial = new URLSearchParams(location.search).get('section');
  if (initial && document.getElementById(`sec-${initial}`)) {
    showSection(initial);
  } else {
    // Default landing is Status (already visible in markup): only expose it
    // to assistive tech without re-running the section loaders (init runs
    // refreshStatus already).
    document.querySelector('#sidebar button[data-section="status"]')?.setAttribute('aria-current', 'page');
  }
}

function initStatusSection(): void {
  $('m-btn-sync-now').addEventListener('click', () => {
    if (($('m-btn-sync-now') as HTMLButtonElement).disabled) return;
    void withBusy('m-btn-sync-now', t('ui.pill.syncing'), async () => {
      clearMessages();
      try {
        const result = await send<{ queued: boolean; conflict?: boolean }>({
          command: MessageCommand.SyncBookmarks,
          sync: { type: 'remote', runSync: true },
        });
        if (result.conflict) {
          // Conflict captured — UI will show resolution options via refreshStatus
          return;
        }
      } catch (err) {
        showError('status-error-2', (err as Error).message);
      }
      await refreshStatus();
    });
  });
  $('m-btn-refresh').addEventListener('click', () => {
    if (($('m-btn-refresh') as HTMLButtonElement).disabled) return;
    void withBusy('m-btn-refresh', t('busy.refreshing'), () => refreshStatus());
  });
  $('m-btn-copy-id').addEventListener('click', () => {
    if (status?.syncId) void copyText(status.syncId, t('popup.copyIdPrompt'));
  });
  $('m-btn-unlink').addEventListener('click', () => void unlink());
  $('m-btn-delete-remote').addEventListener('click', () => void deleteRemote());
}

async function unlink(): Promise<void> {
  // Disabled buttons don't fire clicks anyway; deleting the server sync
  // already unlinks, so there is nothing left to unlink afterwards.
  // Checked BEFORE withBusy (it disables the button while running, so a
  // check inside would always self-trigger).
  if (($('m-btn-unlink') as HTMLButtonElement).disabled) return;
  clearMessages();
  const ok = await confirmInline('m-btn-unlink', {
    message: t('mgr.status.unlinkMessage'),
    implication: UnlinkImplication(),
    confirmLabel: t('common.yesUnlink'),
    danger: true,
  });
  if (!ok) return;
  await withBusy('m-btn-unlink', t('busy.unlinking'), async () => {
    try {
      await send({ command: MessageCommand.DisableSync });
      showResult('status-result', UnlinkDone());
      status = undefined;
      ping = undefined;
      await refreshStatus();
    } catch (err) {
      showError('status-error-2', (err as Error).message);
    }
  });
}

async function deleteRemote(): Promise<void> {
  // Defense in depth (checked BEFORE withBusy: the wrapper disables the
  // button while running, so a check inside would always self-trigger).
  // Disabled buttons don't fire clicks anyway; the background re-gates.
  if (($('m-btn-delete-remote') as HTMLButtonElement).disabled) return;
  clearMessages();
  // No undo exists for this (the server has no undelete): two explicit
  // confirms plus the fail-closed safety backup of the server copy in the
  // background.
  const first = await confirmInline('m-btn-delete-remote', {
    message: t('mgr.status.deleteMessage'),
    implication: DeleteRemoteImplication(),
    confirmLabel: t('common.yesDelete'),
    danger: true,
  });
  if (!first) return;
  const second = await confirmInline('m-btn-delete-remote', {
    message: t('mgr.status.deleteLastChance'),
    confirmLabel: t('common.yesDeleteForGood'),
    danger: true,
  });
  if (!second) return;
  await withBusy('m-btn-delete-remote', t('busy.deleting'), async () => {
    try {
      await send({ command: MessageCommand.DeleteRemoteSync });
      showResult('status-result', DeleteRemoteDone());
      status = undefined;
      ping = undefined;
      await refreshStatus();
    } catch (err) {
      showError('status-error-2', (err as Error).message);
    }
  });
  // withBusy restores the pre-click disabled state last: re-assert the
  // v1.2 gate after it, so neither success (now unlinked) nor failure
  // (legacy service) leaves a stale enabled button behind.
  updateDangerZone();
}

/**
 * Link gating for the status actions: Sync now needs a link to sync, and
 * Refresh status re-reads the link — both stay disabled while unlinked.
 * (Linking from the popup re-enables them via the storage listener in
 * init(): no manual refresh needed.)
 */
function updateStatusActions(): void {
  const linked = !!status?.syncEnabled;
  const syncNow = $('m-btn-sync-now') as HTMLButtonElement;
  syncNow.disabled = !linked;
  syncNow.title = linked ? '' : t('mgr.status.nothingToSync');
  const refresh = $('m-btn-refresh') as HTMLButtonElement;
  refresh.disabled = !linked;
  refresh.title = linked ? '' : t('mgr.status.nothingToRefresh');
}

/**
 * Danger-zone gating: both buttons act on the current link, so both stay
 * disabled while unlinked (deleting the server sync already unlinks — after
 * that there is nothing left to unlink). The delete button additionally
 * needs a v1.2-speaking service (live probe wins, stored flag as fallback
 * when offline). Legacy services see the button disabled plus the reason.
 */
function updateDangerZone(): void {
  const linked = !!status?.syncEnabled;
  const unlink = $('m-btn-unlink') as HTMLButtonElement;
  unlink.disabled = !linked;
  unlink.title = linked ? '' : t('mgr.status.nothingToUnlink');
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

/**
 * Up-front link gating (docs/WORKFLOWS.md rule 1): every action marked
 * `data-needs-link` is disabled while unlinked and its section shows a
 * `.needs-link-notice`, so nobody learns about a missing link from an error
 * after submit. Only buttons disabled HERE are re-enabled on link, so other
 * gates (preview locks, busy state) survive.
 */
function updateLinkGates(): void {
  const linked = !!status?.syncEnabled;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-needs-link]')) {
    if (!linked && !btn.disabled) {
      btn.disabled = true;
      btn.dataset.linkGated = '1';
      btn.title = t('mgr.needsLinkTitle');
    } else if (linked && btn.dataset.linkGated) {
      btn.disabled = false;
      delete btn.dataset.linkGated;
      btn.title = '';
    }
  }
  for (const notice of document.querySelectorAll<HTMLElement>('.needs-link-notice')) notice.hidden = linked;
}

function showResult(id: string, text: string): void {
  const el = $(id);
  el.textContent = text;
  el.hidden = false;
}

function initBackupSection(): void {
  $('m-btn-export').addEventListener('click', () => void exportBackup());
  // Restore is three visible steps: choose file → type its password and Check
  // (dry-run, nothing changes) → Replace (inline confirm). Choosing a file
  // again always starts over.
  $('m-btn-import').addEventListener('click', () => {
    resetImport();
    clearMessages();
    ($('m-import-file') as HTMLInputElement).click();
  });
  ($('m-import-file') as HTMLInputElement).addEventListener('change', (e) => {
    clearMessages();
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > MaxBackupBytes) {
      resetImport();
      showError('backup-error-2', t('mgr.backup.tooLarge'));
      return;
    }
    $('m-import-file-name').textContent = file.name;
    ($('m-import-step') as HTMLElement).hidden = false;
    input('m-import-password').focus();
  });
  $('m-btn-import-check').addEventListener('click', () => void checkImport());
  input('m-import-password').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void checkImport();
  });
  $('m-btn-import-confirm').addEventListener('click', () => void confirmImport());
  $('m-btn-safety').addEventListener('click', () => withBusy('m-btn-safety', t('busy.loading'), () => refreshSafety()));
}

/** Export: a new backup password typed twice (docs/WORKFLOWS.md rule 4). The
 * fields survive a failure so the user can retry. */
async function exportBackup(): Promise<void> {
  clearMessages();
  const password = input('m-backup-password').value;
  const confirm = input('m-backup-confirm').value;
  if (password.length < MinBackupPasswordLength) return showError('backup-error', PasswordTooShort());
  if (password !== confirm) return showError('backup-error', t('val.passwords.mismatch'));
  await withBusy('m-btn-export', t('busy.exporting'), async () => {
    try {
      const json = await send<string>({ command: MessageCommand.ExportBackup, password });
      const filename = `keepmark-backup-${new Date().toISOString().slice(0, 10)}.xbs.json`;
      await send({ command: MessageCommand.DownloadFile, filename, text: json });
      input('m-backup-password').value = '';
      input('m-backup-confirm').value = '';
      showResult('backup-result', exportDone(filename));
    } catch (err) {
      showError('backup-error', (err as Error).message);
    }
  });
}

/** Step 2: decrypt + count without touching anything. On success the
 * password locks and Replace appears; on a wrong password only the password
 * is cleared (the file stays chosen for the retry). */
async function checkImport(): Promise<void> {
  clearMessages();
  const file = ($('m-import-file') as HTMLInputElement).files?.[0];
  if (!file) return showError('backup-error-2', t('mgr.backup.chooseFirst'));
  const password = input('m-import-password').value;
  if (!password) return showError('backup-error-2', t('mgr.backup.enterPassword'));
  await withBusy('m-btn-import-check', t('busy.checking'), async () => {
    try {
      const preview = await send<{ count: number }>({
        command: MessageCommand.PreviewBackup,
        json: await file.text(),
        password,
      });
      importPreview = { name: file.name, size: file.size, lastModified: file.lastModified, password, count: preview.count };
      input('m-import-password').disabled = true;
      ($('m-btn-import-check') as HTMLElement).hidden = true;
      const box = $('m-import-preview');
      box.textContent = importChecked(file.name, preview.count);
      box.hidden = false;
      ($('m-import-confirm-row') as HTMLElement).hidden = false;
    } catch (err) {
      input('m-import-password').value = '';
      showError('backup-error-2', (err as Error).message);
    }
  });
}

/** Step 3: inline confirm, then replace local + server with the checked file. */
async function confirmImport(): Promise<void> {
  clearMessages();
  const file = ($('m-import-file') as HTMLInputElement).files?.[0];
  const pending = importPreview;
  if (
    !file ||
    !pending ||
    pending.name !== file.name ||
    pending.size !== file.size ||
    pending.lastModified !== file.lastModified
  ) {
    resetImport();
    return showError('backup-error-2', t('mgr.backup.fileChanged'));
  }
  const ok = await confirmInline('m-btn-import-confirm', {
    message: tn('mgr.backup.replaceMessage', pending.count),
    implication: ImportImplication(),
    confirmLabel: t('common.yesRestore'),
    danger: true,
  });
  if (!ok) return;
  await withBusy('m-btn-import-confirm', t('busy.restoring'), async () => {
    try {
      const res = await send<{ count: number; safety: string }>({
        command: MessageCommand.ImportBackup,
        json: await file.text(),
        password: pending.password,
      });
      resetImport();
      showResult('backup-result-2', importDone(res.count));
      await refreshSafety();
    } catch (err) {
      // Never leave a used password pinned: back to the password step, the
      // file stays chosen for the retry.
      backToPasswordStep();
      showError('backup-error-2', (err as Error).message);
    }
  });
}

/** Back to step 1: forget file, password and check. */
function resetImport(): void {
  backToPasswordStep();
  ($('m-import-file') as HTMLInputElement).value = '';
  $('m-import-file-name').textContent = '';
  ($('m-import-step') as HTMLElement).hidden = true;
}

/** Back to step 2: the file stays, the password and the check are dropped. */
function backToPasswordStep(): void {
  importPreview = undefined;
  const pw = input('m-import-password');
  pw.value = '';
  pw.disabled = false;
  ($('m-btn-import-check') as HTMLElement).hidden = false;
  ($('m-import-preview') as HTMLElement).hidden = true;
  ($('m-import-confirm-row') as HTMLElement).hidden = true;
}

/** File (and verified password) the check was made for — Replace requires
 * the same file and reuses that password. */
let importPreview:
  | { name: string; size: number; lastModified: number; password: string; count: number }
  | undefined;

const SafetyOperations: Record<string, MessageKey> = {
  'take-remote': 'mgr.safety.op.takeRemote',
  'upload-local': 'mgr.safety.op.uploadLocal',
  'create-empty': 'mgr.safety.op.createEmpty',
  'import-backup': 'mgr.safety.op.importBackup',
  'change-password': 'mgr.safety.op.changePassword',
  'switch-take-remote': 'mgr.safety.op.switchTakeRemote',
  'switch-upload': 'mgr.safety.op.switchUpload',
  'duplicates-cleanup': 'mgr.safety.op.duplicatesCleanup',
  'pre-restore': 'mgr.safety.op.preRestore',
  restore: 'mgr.safety.op.restore',
  'delete-remote': 'mgr.safety.op.deleteRemote',
  'merge-local': 'mgr.safety.op.mergeLocal',
  'merge-remote': 'mgr.safety.op.mergeRemote',
};

async function refreshSafety(): Promise<void> {
  const box = $('m-safety-list');
  box.textContent = '';
  let entries: SafetyEntry[] = [];
  try {
    entries = await send<SafetyEntry[]>({ command: MessageCommand.GetSafetyList });
  } catch (err) {
    showError('backup-error-3', (err as Error).message);
    return;
  }
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('mgr.safety.none');
    box.append(p);
    return;
  }
  const ul = document.createElement('ul');
  for (const [index, entry] of entries.entries()) {
    const li = document.createElement('li');
    const when = formatDateTime(entry.createdAtUtc);
    const opKey = SafetyOperations[entry.operation];
    const what = opKey ? t(opKey) : entry.operation;
    const side = entry.side === 'local' ? t('mgr.safety.sideLocal') : t('mgr.safety.sideRemote');
    li.textContent = tn('mgr.safety.line', entry.items, {
      when,
      what,
      side,
      size: formatBytes(entry.sizeBytes),
      syncId: entry.syncId,
      enc: entry.enc ? t('mgr.safety.encrypted') : t('mgr.safety.notEncrypted'),
    });
    const restore = document.createElement('button');
    restore.textContent = t('mgr.safety.restoreBtn');
    restore.className = 'mini';
    restore.setAttribute('aria-label', t('mgr.safety.restoreAria', { fileName: entry.fileName }));
    restore.id = `safety-restore-${index}`;
    restore.addEventListener('click', () => void restoreSafety(entry, restore.id));
    const del = document.createElement('button');
    del.textContent = t('mgr.safety.deleteBtn');
    del.className = 'mini danger';
    del.setAttribute('aria-label', t('mgr.safety.deleteAria', { fileName: entry.fileName }));
    del.id = `safety-delete-${index}`;
    del.addEventListener('click', () => void deleteSafety(entry, del.id));
    li.append(restore, ' ', del);
    ul.append(li);
  }
  box.append(ul);
}

async function restoreSafety(entry: SafetyEntry, anchorId: string): Promise<void> {
  clearMessages();
  const ok = await confirmInline(anchorId, {
    message: t('mgr.safety.restoreMessage', { when: formatDateTime(entry.createdAtUtc) }),
    implication: safetyRestoreImplication(entry.side, entry.items),
    confirmLabel: t('common.yesRestore'),
    danger: true,
  });
  if (!ok) return;
  await withBusy(anchorId, t('busy.restoring'), async () => {
    try {
      const res = await send<{ count: number; safety: string }>({ command: MessageCommand.RestoreSafety, fileName: entry.fileName });
      await refreshSafety();
      showResult('backup-result-3', safetyRestoreDone(res.count, res.safety));
      void refreshStatus();
    } catch (err) {
      showError('backup-error-3', (err as Error).message);
    }
  });
}

async function deleteSafety(entry: SafetyEntry, anchorId: string): Promise<void> {
  clearMessages();
  const ok = await confirmInline(anchorId, {
    message: t('mgr.safety.deleteMessage', { when: formatDateTime(entry.createdAtUtc) }),
    implication: SafetyDeleteImplication(),
    confirmLabel: t('common.yesDelete'),
    danger: true,
  });
  if (!ok) return;
  await withBusy(anchorId, t('busy.deleting'), async () => {
    try {
      await send({ command: MessageCommand.DeleteSafety, fileName: entry.fileName });
      await refreshSafety();
      showResult('backup-result-3', t('mgr.safety.deleted'));
    } catch (err) {
      showError('backup-error-3', (err as Error).message);
    }
  });
}

let dupSeq = 0;
/** Groups from the last scan (drives Delete-all). */
let lastDupGroups: DuplicateGroup[] = [];

/** Copies marked for deletion in the current scan (default: all but newest). */
let dupMarked: Set<number> = new Set();

/** Per-group delete buttons of the current render (their confirms close on re-render). */
let dupDeleteIds: string[] = [];

async function scanDuplicates(): Promise<void> {
  const my = ++dupSeq;
  const box = $('m-dup-list');
  box.textContent = '';
  $('nav-dup-count').textContent = '';
  ($('m-btn-duplicates-delete-all') as HTMLButtonElement).disabled = true;
  ($('dup-result') as HTMLElement).hidden = true;
  let groups: DuplicateGroup[] = [];
  try {
    groups = await send<DuplicateGroup[]>({ command: MessageCommand.GetDuplicates });
  } catch (err) {
    if (my !== dupSeq) return;
    lastDupGroups = [];
    dupMarked = new Set();
    updateDupBar();
    showError('dup-error', (err as Error).message);
    return;
  }
  if (my !== dupSeq) return;
  lastDupGroups = groups;
  dupMarked = defaultMarkedIds(groups);
  if (groups.length === 0) {
    const clean = document.createElement('p');
    clean.className = 'clean';
    clean.textContent = t('mgr.dup.clean');
    box.replaceChildren(clean);
    updateDupBar();
    return;
  }
  $('nav-dup-count').textContent = `(${groups.length})`;
  renderDuplicates();
  updateDupBar();
}

/** "N marked" counter + Delete-marked button state. */
function updateDupBar(): void {
  const btn = $('m-btn-duplicates-delete-all') as HTMLButtonElement;
  // Nothing to delete without duplicate groups: hide instead of a dead button.
  btn.hidden = lastDupGroups.length === 0;
  btn.disabled = dupMarked.size === 0;
  btn.textContent = dupMarked.size > 0 ? t('mgr.dup.deleteMarkedCount', { count: dupMarked.size }) : t('manager.dup.deleteMarked');
}

function renderDuplicates(): void {
  const box = $('m-dup-list');
  // A re-render replaces the per-group buttons: close their open confirms first.
  for (const id of dupDeleteIds) cancelConfirm(id);
  // Marks changed: a pending Delete-all confirm names a stale count.
  cancelConfirm('m-btn-duplicates-delete-all');
  dupDeleteIds = [];
  box.textContent = '';
  for (const [gi, group] of lastDupGroups.entries()) {
    const div = document.createElement('div');
    div.className = 'dup-group';
    const head = document.createElement('div');
    // Show an original URL when normalization merged variants (tracking
    // params, case): the grouped key alone confuses ("which one is it?").
    const sample = group.entries[0]?.url;
    head.textContent =
      sample && sample !== group.url
        ? t('mgr.dup.variants', { sample, url: group.url })
        : group.url;
    const count = document.createElement('span');
    count.className = 'badge';
    count.textContent = `${group.entries.length}`;
    head.append(' ', count);
    div.append(head);
    const markedHere = group.entries.filter((e) => dupMarked.has(e.id));
    for (const entry of group.entries) {
      const marked = dupMarked.has(entry.id);
      const locked = isSelectionLocked(lastDupGroups, dupMarked, entry.id);
      const row = document.createElement('div');
      row.className = 'dup-row';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `dup-toggle${marked ? ' on' : ''}`;
      toggle.disabled = locked;
      toggle.setAttribute('aria-pressed', String(marked));
      toggle.setAttribute(
        'aria-label',
        marked
          ? t('mgr.dup.unmarkAria', { title: entry.title ?? group.url })
          : locked
            ? t('mgr.dup.lockedAria')
            : t('mgr.dup.markAria', { title: entry.title ?? group.url }),
      );
      toggle.title = locked ? t('mgr.dup.lockedTitle') : toggle.getAttribute('aria-label')!;
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = marked ? '✕' : locked ? '🔒' : '';
      toggle.append(glyph);
      toggle.addEventListener('click', () => {
        clearMessages();
        if (dupMarked.has(entry.id)) dupMarked.delete(entry.id);
        else if (!isSelectionLocked(lastDupGroups, dupMarked, entry.id)) dupMarked.add(entry.id);
        renderDuplicates();
        updateDupBar();
      });
      const text = document.createElement('div');
      text.className = 'dup-text';
      if (entry.url) {
        const link = document.createElement('a');
        link.href = entry.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = entry.title ?? entry.url;
        text.append(link);
      } else {
        text.textContent = entry.title ?? '';
      }
      const path = document.createElement('div');
      path.className = 'dup-sub';
      path.textContent = displayPath(entry.path);
      text.append(path);
      row.append(toggle, text);
      div.append(row);
    }
    // Per-group delete with inline confirm (like the Android client).
    const footer = document.createElement('div');
    footer.className = 'row';
    const del = document.createElement('button');
    del.id = `dup-del-${gi}`;
    dupDeleteIds.push(del.id);
    del.className = 'mini danger';
    del.textContent = markedHere.length > 0 ? t('mgr.dup.deleteGroup', { count: markedHere.length }) : t('manager.dup.deleteMarked');
    del.disabled = markedHere.length === 0;
    del.addEventListener('click', async () => {
      clearMessages();
      if (!(await confirmInline(del.id, { ...dupDeleteConfirm(markedHere.length), danger: true }))) return;
      del.disabled = true;
      send<{ deleted: number; safety: string }>({
        command: MessageCommand.RemoveDuplicates,
        ids: markedHere.map((e) => e.id),
      })
        .then((res) => {
          showResult('dup-result', dupDeleteDone(res.deleted));
          void scanDuplicates();
        })
        .catch((err: Error) => {
          showError('dup-error-2', err.message);
          del.disabled = false;
        });
    });
    footer.append(del);
    div.append(footer);
    box.append(div);
  }
}

function initDuplicatesSection(): void {
  $('m-btn-duplicates').addEventListener('click', () =>
    withBusy('m-btn-duplicates', t('busy.scanning'), () => scanDuplicates()),
  );
  $('m-btn-duplicates-delete-all').addEventListener('click', async () => {
    clearMessages();
    const ids = [...dupMarked];
    if (ids.length === 0) return;
    // Confirm before withBusy (it disables the anchor while running).
    if (!(await confirmInline('m-btn-duplicates-delete-all', { ...dupDeleteConfirm(ids.length), danger: true }))) return;
    await withBusy('m-btn-duplicates-delete-all', t('busy.deleting'), async () => {
      try {
        const res = await send<{ deleted: number; safety: string }>({
          command: MessageCommand.RemoveDuplicates,
          ids,
        });
        showResult('dup-result', dupDeleteDone(res.deleted));
        await scanDuplicates();
      } catch (err) {
        showError('dup-error', (err as Error).message);
      }
    });
    // withBusy restores the pre-click label + enabled state last: re-assert
    // the bar after it, or the rescan's empty selection is overwritten by a
    // stale "Delete N marked" that still accepts clicks.
    updateDupBar();
  });
}

function switchMode(): 'new' | 'existing' {
  return (document.querySelector('input[name="m-switch-mode"]:checked') as HTMLInputElement).value as
    | 'new'
    | 'existing';
}

function switchDirection(): 'push' | 'pull' | 'merge' {
  return (document.querySelector('input[name="m-switch-direction"]:checked') as HTMLInputElement).value as
    | 'push'
    | 'pull'
    | 'merge';
}

function updateMoveForm(): void {
  const mode = switchMode();
  ($('m-switch-id-row') as HTMLElement).hidden = mode !== 'existing';
  ($('m-switch-direction-row') as HTMLElement).hidden = mode !== 'existing';
  // Prepopulate once with the current link: most moves stay on the same
  // service (new sync id, same host). Never clobbers user input afterwards.
  prefillMoveUrl();
  // Password labels follow the mode: in existing mode it is the target
  // sync's CURRENT password, not a new one. The confirmation stays in both
  // modes — a typo in existing mode locks you out with no recovery.
  $('m-switch-password-label').textContent = mode === 'new' ? t('manager.move.newPassword') : t('mgr.move.syncPassword');
  $('m-switch-confirm-label').textContent = mode === 'new' ? t('common.confirmPassword') : t('mgr.move.confirmTargetPassword');
  // Confirm row only when inventing a password (new mode). In existing
  // mode the password is verify-before-mutate: a typo fails safely as
  // InvalidCredentials, so no confirmation is asked.
  ($('m-switch-confirm-row') as HTMLElement).hidden = mode !== 'new';
  ($('m-switch-pw-hint') as HTMLElement).hidden = mode !== 'new';
  // Existing sync: its password is part of the target (the check needs it
  // for the merge counts), so the field sits in step 1; a new sync invents
  // its password at confirm time, in step 2.
  const pwRow = $('m-switch-password-row');
  if (mode === 'existing') $('m-switch-existing-pw-slot').append(pwRow);
  else $('m-switch-confirm-row').before(pwRow);
  preview = undefined;
  previewFor = undefined;
  mergeStats = undefined;
  cancelConfirm('m-btn-switch');
  setMoveGate(false);
  $('move-error').hidden = true;
  $('move-error-2').hidden = true;
  $('move-preview').hidden = true;
  const result = $('move-result') as HTMLElement;
  result.hidden = true;
  result.textContent = '';
  const url = input('m-switch-url').value.trim() || '…';
  const n = status?.bookmarkCount;
  const direction = switchDirection();
  $('move-summary').textContent =
    mode === 'new'
      ? n === undefined
        ? t('mgr.move.summaryNewNoCount', { url })
        : tn('mgr.move.summaryNew', n, { url })
      : direction === 'push'
        ? n === undefined
          ? t('mgr.move.summaryPushNoCount', { url })
          : tn('mgr.move.summaryPush', n, { url })
        : direction === 'merge'
          ? t('mgr.move.summaryMerge', { url })
          : t('mgr.move.summaryPull', { url });
}

async function previewTarget(): Promise<void> {
  clearMessages();
  const newServiceUrl = input('m-switch-url').value.trim();
  if (!newServiceUrl) {
    showError('move-error', t('mgr.move.urlRequired'));
    return;
  }
  const mode = switchMode();
  const syncId = input('m-switch-id').value.trim() || undefined;
  if (mode === 'existing' && !syncId) {
    showError('move-error', t('val.syncId.required'));
    return;
  }
  const urlErr = validateServiceUrl(newServiceUrl);
  if (urlErr) {
    showError('move-error', urlErr);
    return;
  }
  await withBusy('m-btn-preview', t('busy.checking'), async () => {
    try {
      preview = await send<SwitchPreviewResult>({
        command: MessageCommand.SwitchPreview,
        newServiceUrl,
        mode,
        syncId,
      });
      // Pin what the preview was made for; submitMove() refuses stale previews.
      previewFor = { newServiceUrl, mode, syncId, direction: switchDirection() };
    } catch (err) {
      showError('move-error', (err as Error).message);
      return;
    }
    const box = $('move-preview');
    if (!preview.reachable) {
      box.textContent = t('mgr.move.unreachable');
    } else {
      const lines = [
        t('mgr.move.previewVersion', {
          version: preview.serviceVersion ?? '?',
          state: preview.versionCompatible ? t('mgr.move.versionOk') : t('mgr.move.versionOld'),
        }),
        t('mgr.move.previewSync', {
          state:
            mode === 'new'
              ? t('mgr.move.syncNew')
              : preview.remoteExists
                ? t('mgr.move.syncFound', { when: preview.remoteLastUpdated ?? '?' })
                : t('mgr.move.syncNotFound'),
        }),
        t('mgr.move.previewLocal', { count: preview.localCount ?? '?' }),
      ];
      if (preview.syncExpiryDays !== undefined) {
        lines.push(t('mgr.move.previewExpiry', { state: describeSyncExpiry(preview.syncExpiryDays) }));
      }
      // Merge direction: dry-run the union so the user sees exactly what
      // will upload/download before the Move button unlocks. Needs the
      // target password (already in the form for the submit step).
      mergeStats = undefined;
      if (mode === 'existing' && switchDirection() === 'merge' && preview.remoteExists) {
        const mergePassword = input('m-switch-password').value;
        if (!mergePassword) {
          box.textContent = lines.join('\n') + '\n' + t('mgr.move.enterPwForMerge');
          box.hidden = false;
          setMoveGate(false);
          return;
        }
        try {
          mergeStats = await send<MergePreview>({
            command: MessageCommand.PreviewMerge,
            serviceUrl: newServiceUrl,
            syncId: syncId!,
            password: mergePassword,
          });
          lines.push(
            t('mgr.move.mergePreview', {
              local: mergeStats.localOnly,
              localTotal: mergeStats.localCount,
              remote: mergeStats.remoteOnly,
              remoteTotal: mergeStats.remoteCount,
              titles: mergeStats.titleConflicts,
              folders: mergeStats.foldersCreated,
              separators: mergeStats.separatorsAdopted,
            }),
          );
        } catch (err) {
          showError('move-error', (err as Error).message);
          return;
        }
      }
      box.textContent = lines.join('\n');
    }
    box.hidden = false;
    const ok =
      preview.reachable &&
      preview.versionCompatible !== false &&
      (mode === 'new' || preview.remoteExists === true);
    setMoveGate(ok);
  });
}

/** The Move button exists only after a passing check: shown + enabled
 *  together, with the gate hint standing in for it while locked. */
function setMoveGate(ok: boolean): void {
  ($('m-btn-switch') as HTMLButtonElement).disabled = !ok;
  ($('move-step2') as HTMLElement).hidden = !ok;
  // One primary action at a time: once step 2 is open, Move is the main one.
  $('m-btn-preview').classList.toggle('primary', !ok);
  ($('move-gate-hint') as HTMLElement).hidden = ok;
}

async function submitMove(): Promise<void> {
  clearMessages();
  const newServiceUrl = input('m-switch-url').value.trim();
  const mode = switchMode();
  const direction = switchDirection();
  const syncId = input('m-switch-id').value.trim() || undefined;
  const newPassword = input('m-switch-password').value;
  const confirm = input('m-switch-confirm').value;
  const invalid = validateSwitch({ mode, newServiceUrl, syncId, newPassword, confirm });
  if (invalid) {
    showError('move-error-2', invalid);
    return;
  }
  if (
    !preview ||
    !previewFor ||
    previewFor.newServiceUrl !== newServiceUrl ||
    previewFor.mode !== mode ||
    previewFor.syncId !== syncId ||
    previewFor.direction !== direction
  ) {
    showError('move-error-2', t('mgr.move.inputsChanged'));
    return;
  }
  // Merge executes on explicit per-counts confirmation: the union never
  // deletes, but resurrects items deleted while offline — say so first.
  const s = mergeStats;
  if (mode === 'existing' && direction === 'merge' && !s) {
    showError('move-error-2', t('mgr.move.mergeUnavailable'));
    return;
  }
  // Every move replaces or creates something: always confirm inline, with
  // the direction's loss line plus what happens to the old sync. Asked
  // BEFORE withBusy (confirmInline owns the button while open).
  const counts = s
    ? t('popup.merge.counts', { local: s.localOnly, remote: s.remoteOnly, titles: s.titleConflicts })
    : '';
  const ok = await confirmInline(
    'm-btn-switch',
    mode === 'new'
      ? {
          message: moveNewConfirm(newServiceUrl, status?.bookmarkCount),
          implication: MoveImplication(),
          confirmLabel: t('common.yesMove'),
        }
      : {
          message: directionConfirm(direction).message,
          implication: `${direction === 'merge' ? counts : ''}${directionConfirm(direction).implication} ${MoveImplication()}`,
          confirmLabel: directionConfirm(direction).confirmLabel,
          danger: direction !== 'merge',
        },
  );
  // Inputs edited while the confirm was open re-run updateMoveForm(), which
  // drops the preview: never move with what was not checked.
  if (!ok || !preview) return;
  // Set on success so the post-busy gate below knows the preview was spent.
  let movedId: string | undefined;
  // Local count for the success line (new/push upload exactly these; capture
  // before the move — merge/pull rewrite the local tree).
  const localCount = status?.bookmarkCount;
  await withBusy('m-btn-switch', t('busy.moving'), async () => {
    ($('move-result') as HTMLElement).hidden = true;
    try {
      const res = await send<{ id: string }>({
        command: MessageCommand.SwitchService,
        switch: { newServiceUrl, mode, syncId, newPassword, direction },
      });
      input('m-switch-password').value = '';
      input('m-switch-confirm').value = '';
      movedId = res.id;
    } catch (err) {
      input('m-switch-confirm').value = '';
      showError('move-error-2', (err as Error).message);
    }
  });
  if (movedId) {
    // Consume the preview AFTER withBusy (it restores the pre-click state
    // last): the unlocked button must never re-fire with stale inputs.
    updateMoveForm();
    // Contextual success: restate WHAT ran (mode + direction + target), not
    // just the new id — the wizard offers four different outcomes.
    const done = describeMoveResult({ mode, direction, newServiceUrl, syncId, bookmarkCount: localCount });
    showResult('move-result', t('mgr.move.resultLine', { done, next: MoveDoneNext(), id: movedId }));
    const copy = document.createElement('button');
    copy.textContent = t('mgr.move.copyId');
    copy.className = 'mini';
    copy.setAttribute('aria-label', t('mgr.move.copyIdAria'));
    copy.addEventListener('click', () => void copyText(movedId!, t('popup.copyIdPrompt')));
    $('move-result').append(' ', copy);
    // updateMoveForm() above re-locked the button and reshown the gate hint:
    // the hint contradicts the result, so hide it, then bring the result
    // into view (it sits below the fold on small windows).
    ($('move-gate-hint') as HTMLElement).hidden = true;
    const box = $('move-result') as HTMLElement;
    box.scrollIntoView({ block: 'nearest' });
    box.focus({ preventScroll: true });
    await refreshStatus();
  } else {
    // Failed: the still-valid preview keeps the button unlocked, so keep
    // the gate hint in sync with the button (hint shown only while locked).
    ($('move-gate-hint') as HTMLElement).hidden = !($('m-btn-switch') as HTMLButtonElement).disabled;
  }
}

function initMoveSection(): void {
  document.querySelectorAll('input[name="m-switch-mode"], input[name="m-switch-direction"]').forEach((el) => {
    el.addEventListener('change', updateMoveForm);
  });
  input('m-switch-url').addEventListener('input', updateMoveForm);
  input('m-switch-id').addEventListener('input', updateMoveForm);
  $('m-btn-preview').addEventListener('click', () => void previewTarget());
  $('m-btn-switch').addEventListener('click', () => void submitMove());
  updateMoveForm();
}

async function refreshLogs(): Promise<void> {
  clearMessages();
  try {
    const entries = await send<{ timestamp: string; level: number; tag: string; message: string }[]>({
      command: MessageCommand.GetLogs,
    });
    const names = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
    $('m-log-list').textContent = entries
      .map((e) => `${e.timestamp} [${names[e.level] ?? e.level}] ${e.tag}: ${e.message}`)
      .join('\n');
  } catch (err) {
    showError('logs-error', (err as Error).message);
  }
}

function initLogsSection(): void {
  $('m-btn-logs').addEventListener('click', () =>
    withBusy('m-btn-logs', t('busy.loading'), () => refreshLogs()),
  );
}

async function renderSettings(): Promise<void> {
  clearMessages();
  const info = $('m-service-info');
  info.textContent = '';
  let st: StatusResponse | undefined;
  try {
    st = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    showError('settings-error', (err as Error).message);
    return;
  }
  let pg: PingResponse | undefined;
  try {
    pg = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    pg = undefined;
  }
  const rows: [string, string][] = [
    [t('mgr.settings.reachability'), pg?.reachable ? t('mgr.settings.online') : t('mgr.settings.unreachable')],
    [t('common.service'), st?.serviceUrl ?? '—'],
    [t('mgr.settings.apiVersion'), pg?.version ?? '—'],
    [t('mgr.settings.apiContract'), pg?.supportsV12 ?? st?.supportsV12 ? t('mgr.settings.contractV12') : 'v1.1'],
    [t('mgr.settings.syncExpiry'), describeSyncExpiry(pg?.syncExpiryDays)],
    [t('common.syncId'), st?.syncId ?? '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    info.append(dt, dd);
  }
  const toolbar = await send<{ enabled: boolean }>({ command: MessageCommand.GetToolbarSync }).catch(() => ({
    enabled: true,
  }));
  (input('m-opt-toolbar') as HTMLInputElement).checked = toolbar.enabled;
  const level = st?.logLevel ?? 2;
  ($('m-opt-verbosity') as HTMLSelectElement).value = String(level);
  const lang = await send<{ language: string }>({ command: MessageCommand.GetUiLanguage }).catch(() => ({
    language: 'system',
  }));
  ($('m-opt-language') as HTMLSelectElement).value = lang.language;
}

function initSettingsSection(): void {
  ($('m-opt-language') as HTMLSelectElement).addEventListener('change', async (e) => {
    clearMessages();
    const language = (e.target as HTMLSelectElement).value as LangSetting;
    try {
      await send({ command: MessageCommand.SetUiLanguage, language });
      location.reload();
    } catch (err) {
      showError('settings-error', (err as Error).message);
    }
  });
  (input('m-opt-toolbar') as HTMLInputElement).addEventListener('change', (e) => {
    void send({ command: MessageCommand.SetToolbarSync, enabled: (e.target as HTMLInputElement).checked }).catch(
      (err: Error) => showError('settings-error', err.message),
    );
  });
  ($('m-opt-verbosity') as HTMLSelectElement).addEventListener('change', async (e) => {
    clearMessages();
    const level = Number((e.target as HTMLSelectElement).value);
    try {
      await send({ command: MessageCommand.SetVerbosity, level });
      const levelNames = [
        t('manager.settings.verbError'),
        t('manager.settings.verbWarning'),
        t('manager.settings.verbInfo'),
        t('manager.settings.verbDebug'),
        t('manager.settings.verbVerbose'),
      ];
      showResult('settings-result', t('mgr.settings.verbositySet', { level: levelNames[level] }));
    } catch (err) {
      showError('settings-error', (err as Error).message);
    }
  });
  $('m-btn-password').addEventListener('click', () => void changePassword());
}

function readPasswordChange(): { current: string; next: string; confirm: string } {
  return {
    current: input('m-current-password').value,
    next: input('m-new-password').value,
    confirm: input('m-new-password-confirm').value,
  };
}

/** Change password: validate → inline confirm with the implications → run. */
async function changePassword(): Promise<void> {
  clearMessages();
  ($('pw-result') as HTMLElement).hidden = true;
  const invalid = validatePasswordChange(readPasswordChange());
  if (invalid) {
    showError('pw-error', invalid);
    return;
  }
  const ok = await confirmInline('m-btn-password', {
    message: t('mgr.settings.changePwMessage'),
    implication: ChangePasswordImplication(),
    confirmLabel: t('common.yesChangePw'),
    danger: true,
  });
  if (!ok) return;
  // Fields stay editable while the confirmation is open: validate what is
  // there now, not what was there when the button was pressed.
  const fields = readPasswordChange();
  const stillInvalid = validatePasswordChange(fields);
  if (stillInvalid) {
    showError('pw-error', stillInvalid);
    return;
  }
  await withBusy('m-btn-password', t('busy.changing'), async () => {
    try {
      await send({ command: MessageCommand.ChangePassword, currentPassword: fields.current, newPassword: fields.next });
      input('m-current-password').value = '';
      input('m-new-password').value = '';
      input('m-new-password-confirm').value = '';
      showResult('pw-result', ChangePasswordDone());
      await refreshStatus();
    } catch (err) {
      // Never leave the current password or its confirmation in the DOM;
      // the new password stays so only the proof has to be retyped.
      input('m-current-password').value = '';
      input('m-new-password-confirm').value = '';
      showError('pw-error', (err as Error).message);
    }
  });
}

function renderAbout(): void {
  $('about-version').textContent = `v${browser.runtime.getManifest().version}`;
  $('about-api').textContent = `v${ApiVersion}`;
  $('about-api12').textContent = `v${ApiVersion12}`;
  $('about-minapi').textContent = `v${MinApiVersion}`;
  $('about-syncver').textContent = `v${SyncClientVersion}`;
  // Registered on every section visit: guard so N visits stack a single handler.
  const bug = $('about-bug');
  if (!bug.dataset.bound) {
    bug.dataset.bound = '1';
    bug.addEventListener('click', () => {
      const version = browser.runtime.getManifest().version;
      const details = `App version: ${version}\nAPI version: ${ApiVersion} / ${ApiVersion12}\nSync format: ${SyncClientVersion}\nBrowser: ${navigator.userAgent}\n`;
      // Clipboard may be denied; the issue page opens regardless.
      void navigator.clipboard?.writeText(details).catch(() => undefined);
      window.open('https://github.com/Keepmark', '_blank', 'noreferrer');
    });
  }
}

async function init(): Promise<void> {
  await initI18n();
  initSidebar();
  initStatusSection();
  initUndoBanner();
  initConflictSection();
  initBackupSection();
  initDuplicatesSection();
  initMoveSection();
  initLogsSection();
  initSettingsSection();
  // Follow link changes made elsewhere (e.g. connecting from the popup):
  // the status card, actions and danger zone re-gate themselves without a
  // manual refresh. refreshStatus() is race-guarded (statusSeq), so bursts
  // of storage events collapse onto the newest read.
  browser.storage.onChanged.addListener((changes) => {
    if (StoreKey.UiLanguage in changes) location.reload();
    if ('syncEnabled' in changes || 'syncInfo' in changes) void refreshStatus();
  });
  void refreshStatus();
}
void init();
