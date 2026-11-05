// Full-tab manager: sidebar sections, each with its own contextual
// busy/error/result evidence. Shares the status renderer + helpers with the
// popup via ../popup/ui.js. Display only; mutations go through background.

import browser from 'webextension-polyfill';
import { ServicePicker } from '../popup/service-picker.js';
import { ConnectQrController } from './connect-qr.js';
import type { ConnectQrPayload, ConnectQrTarget } from '../shared/connect-qr.js';
import { ApiVersion, ApiVersion12, MinApiVersion, PasswordTooShort, SyncClientVersion } from '../shared/constants.js';
import {
  $,
  contractGate,
  copyText,
  describeLinkResult,
  describeSyncExpiry,
  describeUndo,
  formatBytes,
  validatePasswordChange,
  validateServiceUrl,
  validateSwitch,
  input,
  focusFirstVisible,
  renderStatusCard,
  send,
  withBusy,
  type StatusView,
  initI18n,
} from '../popup/ui.js';
import { StoreKey } from '../shared/store.js';
import { displayPath, formatDateTime, t, tn, type MessageKey } from '../shared/i18n.js';
import type { LangSetting } from '../shared/i18n.js';
import { cancelAllConfirms, cancelConfirm, clearMessages, confirmInline, showError } from '../popup/flow.js';
import { TaskDialog } from '../popup/modal.js';
import {
  ChangePasswordDone,
  DeleteRemoteDone,
  DeleteRemoteImplication,
  LinkDoneNext,
  LinkImplication,
  DirectionOrder,
  directionConfirm,
  dupDeleteConfirm,
  dupDeleteDone,
  ImportImplication,
  RemovedSyncDismissImplication,
  SafetyDeleteImplication,
  exportDone,
  importChecked,
  importDone,
  removedSyncText,
  safetyRestoreDone,
  safetyRestoreImplication,
} from '../popup/texts.js';
import {
  MessageCommand,
  type DuplicateGroup,
  type MergePreview,
  type PingResponse,
  type RemovedSyncSnapshot,
  type SafetyEntry,
  type SavedSyncsResponse,
  type StatusResponse,
  type SwitchLockState,
  type SyncTargetPreview,
  // Conflict resolution types
  type ConflictPreviewResponse,
  type ConflictResolutionDirection,
  type ConflictStateResponse,
} from '../shared/messages.js';
import { backupFileName, MaxBackupBytes, MinBackupPasswordLength } from '../shared/backup.js';
import {
  MaxSavedSyncLabelLength,
  isActiveSavedSync,
  normalizeSavedSyncLabel,
  sameSavedSync,
  savedSyncLabelTaken,
  savedSyncName,
  serviceHost,
  shortSyncId,
  suggestSavedSyncName,
  type SavedSync,
  type SavedSyncActive,
} from '../shared/saved-syncs.js';
import { defaultMarkedIds, isSelectionLocked } from '../shared/duplicates.js';
import type { BookmarkNode } from '../shared/models.js';

let connectQr: ConnectQrController | undefined;
let status: StatusResponse | undefined;
let ping: PingResponse | undefined;
let preview: SyncTargetPreview | undefined;
let linkGeneration = 0;
/** Proved once at the gate, then reused by every send of this wizard: the
 *  sync lock password is asked before the form opens, never inside it. */
let linkSwitchPassword = '';
/** Merge dry-run from the last Check target (merge direction only). */
let mergeStats: MergePreview | undefined;
/** Move URL prefilled once from the current link (never clobbers typing). */
let linkUrlPrefilled = false;
let linkService: ServicePicker;
let checkingTarget = false;
let linking = false;
/** Current conflict preview (fetched when status.conflict === true). */
let conflictPreview: ConflictPreviewResponse | undefined;
/** Manager-owned switch password: optional protection for dormant keys. */
let switchLockSet = false;
/** Registry snapshot behind the Sync section (list + protection card). */
let syncsView: SavedSyncsResponse = { syncs: [], switchLockSet: false };
/** Dormant row waiting for the activation confirmation. */
let pendingActivation: SavedSync | undefined;
/** Name typed by the user (stop overwriting it with the host suggestion). */
let nameTouched = false;
/** One task at a time: each Sync operation owns a modal dialog (see
 *  ../popup/modal.ts), so the list and the other actions are inert while it
 *  runs and a second operation can never start halfway through the first. */
let linkDialog: TaskDialog;
let activateDialog: TaskDialog;
let lockDialog: TaskDialog;
let rowDialog: TaskDialog;
let pwDialog: TaskDialog;

/** Fill an empty move URL with the current link (same host is the common
 * case). Runs on section visits and status refreshes until it sticks. */
function prefillLinkUrl(): void {
  if (linkUrlPrefilled || !linkService || $('sec-syncs').hidden) return;
  linkUrlPrefilled = true;
  void linkService.load(status?.serviceUrl).then(updateLinkServiceGate);
}
function updateLinkServiceGate(): void {
  if (!linkService || checkingTarget || linking) return;
  const ready = linkService.ready && !linkLabelTaken(input('m-link-name').value);
  const wizard = linkMode() === 'existing' && !!status?.syncEnabled;
  ($('m-btn-link-check') as HTMLButtonElement).disabled = !ready || !wizard;
  ($('m-btn-link-direct') as HTMLButtonElement).disabled = !ready;
}
/** Generation token: stale refresh responses never overwrite newer state. */
let statusSeq = 0;
/** Inputs the current preview was made for — submit requires an exact match. */
let previewFor: { newServiceUrl: string; mode: string; syncId?: string; direction: 'push' | 'pull' | 'merge' } | undefined;

function showSection(name: string, moveFocus = false): void {
  connectQr?.close();
  // A confirmation armed in the section being left must not survive hidden
  // and reappear later: every section starts from a clean state.
  cancelAllConfirms();
  document.querySelectorAll('#sidebar button').forEach((b) => {
    const active = (b as HTMLElement).dataset.section === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  for (const sec of ['status', 'backup', 'duplicates', 'syncs', 'settings', 'about']) {
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
  if (name === 'syncs') {
    updateLinkForm();
    prefillLinkUrl();
    void refreshSyncs();
  }
  if (name === 'duplicates') void scanDuplicates();
  if (name === 'settings') void renderSettings();
  if (name === 'about') renderAbout();
}

/** Status refresh clears stale ERROR boxes only: it runs right after every
 *  successful action (and on storage changes), so hiding result boxes here
 *  would erase the success evidence the action just showed. */
function hideStatusErrors(): void {
  for (const id of ['status-error', 'conflict-error']) {
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
    connectQr?.updateStatus();
    ping = undefined;
    conflictPreview = undefined;
    renderStatusCard('m', { status, ping });
    updateStatusActions();
    updateSyncsDanger();
    updateLinkGates();
    renderConflictSection();
    ($('m-notlinked-hint') as HTMLElement).hidden = true;
    showError('status-error', (err as Error).message);
    return;
  }
  if (my !== statusSeq) return;
  connectQr?.updateStatus(status);
  const view: StatusView = { status, ping: undefined };
  renderStatusCard('m', view);
  prefillLinkUrl();
  try {
    ping = await send<PingResponse>({ command: MessageCommand.Ping });
  } catch {
    ping = undefined;
  }
  if (my !== statusSeq) return;
  renderStatusCard('m', { status, ping });
  updateStatusActions();
  updateSyncsDanger();
  updateLinkGates();
  ($('m-notlinked-hint') as HTMLElement).hidden = !!status?.syncEnabled;
  if (!$('sec-syncs').hidden) void refreshSyncs();

  // If there's a conflict, fetch the preview and render resolution UI.
  if (status?.conflict) {
    await loadConflictPreview();
  } else {
    conflictPreview = undefined;
    renderConflictSection();
  }
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
        showError('status-error', (err as Error).message);
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
 * Delete gating on the active row: it acts on the current link, so it stays
 * disabled while unlinked and until the service speaks v1.2 (live probe
 * wins, stored flag as fallback when offline). Legacy services see the
 * button disabled plus the reason.
 */
function updateSyncsDanger(): void {
  // The API-version badge lives in the active row; this only drives the
  // active row's "Delete from server" button and its explanation.
  const btn = document.querySelector<HTMLButtonElement>('#m-syncs-list button[data-action="delete"]');
  const hint = $('m-delete-v12-hint');
  const gate = contractGate({
    liveV12: ping?.supportsV12,
    storedV12: status?.supportsV12,
    syncEnabled: !!status?.syncEnabled,
  });
  if (btn) {
    btn.disabled = !gate.enabled;
    btn.title = gate.title;
  }
  hint.hidden = gate.hintHidden || !syncsView.active;
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
  updateLinkServiceGate();
}

function showResult(id: string, text: string): void {
  const el = $(id);
  el.textContent = text;
  el.hidden = false;
}

function initBackupSection(): void {
  $('m-btn-export').addEventListener('click', () => void exportBackup());
  // Choose file and verify its password, then apply directly from the review.
  // Choosing another file always invalidates the review.
  $('m-btn-import').addEventListener('click', () => {
    resetImport();
    clearMessages();
    ($('m-import-file') as HTMLInputElement).click();
  });
  ($('m-import-file') as HTMLInputElement).addEventListener('change', (e) => {
    clearMessages();
    const file = (e.target as HTMLInputElement).files?.[0];
    backToPasswordStep();
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
  $('m-btn-removed-download').addEventListener('click', () =>
    void downloadRemovedCopy('m-btn-removed-download'),
  );
  $('m-btn-removed-dismiss').addEventListener('click', () =>
    void dismissRemovedCopy('m-btn-removed-dismiss'),
  );
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
      // The file name carries the sync it belongs to (slugged: it is a human
      // label), so two exports of different syncs never look identical.
      const registry = await send<SavedSyncsResponse>({ command: MessageCommand.GetSavedSyncs }).catch(
        () => null,
      );
      const activeRow = registry?.syncs.find((row) => isActiveSavedSync(row, registry.active));
      const filename = backupFileName(activeRow ? savedSyncName(activeRow) : undefined, new Date());
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
  const generation = importGeneration;
  await withBusy('m-btn-import-check', t('busy.checking'), async () => {
    try {
      const preview = await send<{ count: number }>({
        command: MessageCommand.PreviewBackup,
        json: await file.text(),
        password,
      });
      if (generation !== importGeneration || input('m-import-password').value !== password) return;
      importPreview = { name: file.name, size: file.size, lastModified: file.lastModified, password, count: preview.count };
      input('m-import-password').disabled = true;
      ($('m-btn-import-check') as HTMLElement).hidden = true;
      const box = $('m-import-preview');
      box.textContent = `${importChecked(file.name, preview.count)} ${ImportImplication()}`;
      box.hidden = false;
      ($('m-import-confirm-row') as HTMLElement).hidden = false;
    } catch (err) {
      if (generation !== importGeneration) return;
      input('m-import-password').value = '';
      showError('backup-error-2', (err as Error).message);
    }
  });
}

/** The checked summary is the confirmation: its final button applies directly. */
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
  importGeneration++;
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
let importGeneration = 0;
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
  'sync-pull': 'mgr.safety.op.syncPull',
  'sync-push': 'mgr.safety.op.syncPush',
};

/** Items in a whole tree (folders included), for the kept-copy count. */
function countTree(nodes: BookmarkNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countTree(node.children ?? []), 0);
}

/** Plaintext copy of a sync the server no longer has. It lives here because
 *  the popup card is informational: download and dismissal are backup actions. */
async function refreshRemovedCard(): Promise<void> {
  const card = $('m-removed-card');
  const errorBox = $('removed-error');
  errorBox.hidden = true;
  errorBox.textContent = '';
  let removed: RemovedSyncSnapshot | null = null;
  try {
    removed = await send<RemovedSyncSnapshot | null>({ command: MessageCommand.GetRemovedSync });
  } catch (err) {
    card.hidden = true;
    showError('removed-error', (err as Error).message);
    return;
  }
  if (!removed) {
    card.hidden = true;
    return;
  }
  $('m-removed-text').textContent = removedSyncText(
    removed.bookmarks.reduce((n, root) => n + countTree(root.children ?? []), 0),
    removed.lastUpdated,
  );
  card.hidden = false;
}

async function downloadRemovedCopy(anchorId: string): Promise<void> {
  clearMessages();
  await withBusy(anchorId, t('busy.downloading'), async () => {
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
      showError('removed-error', (err as Error).message);
    }
  });
}

/** Dismissal is final: the kept copy is the only copy of the removed sync. */
async function dismissRemovedCopy(anchorId: string): Promise<void> {
  clearMessages();
  const ok = await confirmInline(anchorId, {
    message: t('removed.deleteConfirm'),
    implication: RemovedSyncDismissImplication(),
    confirmLabel: t('common.yesDelete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await send({ command: MessageCommand.ClearRemovedSync });
    ($('m-removed-card') as HTMLElement).hidden = true;
    void refreshStatus();
  } catch (err) {
    showError('removed-error', (err as Error).message);
  }
}

async function refreshSafety(): Promise<void> {
  await refreshRemovedCard();
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
let dupTarget: SavedSyncActive | undefined;

function invalidateSyncTasks(): void {
  ++dupSeq;
  dupTarget = undefined;
  lastDupGroups = [];
  dupMarked.clear();
  cancelAllConfirms();
  dupDeleteIds = [];
  $('m-dup-list').textContent = '';
  $('nav-dup-count').textContent = '';
  updateDupBar();
  rowDialog.close();
  pwDialog.close();
}

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
    const current = await send<StatusResponse>({ command: MessageCommand.GetStatus });
    if (my !== dupSeq) return;
    if (!current.syncEnabled || !current.syncId || !current.serviceUrl) return;
    const target = { serviceUrl: current.serviceUrl, syncId: current.syncId };
    groups = await send<DuplicateGroup[]>({ command: MessageCommand.GetDuplicates, target });
    if (my !== dupSeq) return;
    dupTarget = target;
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
      const target = dupTarget;
      if (!target) return;
      if (!(await confirmInline(del.id, { ...dupDeleteConfirm(markedHere.length), danger: true }))) return;
      del.disabled = true;
      send<{ deleted: number; safety: string }>({
        command: MessageCommand.RemoveDuplicates,
        target,
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
    const target = dupTarget;
    if (!target) return;
    const ids = [...dupMarked];
    if (ids.length === 0) return;
    // Confirm before withBusy (it disables the anchor while running).
    if (!(await confirmInline('m-btn-duplicates-delete-all', { ...dupDeleteConfirm(ids.length), danger: true }))) return;
    await withBusy('m-btn-duplicates-delete-all', t('busy.deleting'), async () => {
      try {
        const res = await send<{ deleted: number; safety: string }>({
          command: MessageCommand.RemoveDuplicates,
          target,
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

function linkMode(): 'new' | 'existing' {
  return (document.querySelector('input[name="m-link-mode"]:checked') as HTMLInputElement).value as
    | 'new'
    | 'existing';
}

function linkDirection(): 'push' | 'pull' | 'merge' {
  return (document.querySelector('input[name="m-link-direction"]:checked') as HTMLInputElement).value as
    | 'push'
    | 'pull'
    | 'merge';
}

function updateLinkForm(): void {
  linkGeneration++;
  const mode = linkMode();
  const linked = !!status?.syncEnabled;
  // A new sync is always additive (the current one stays in the list), so it
  // is created directly from the live bookmarks. Only an existing sync, with
  // an active one to compare against, goes through the check/review wizard.
  const wizard = mode === 'existing' && linked;
  linkService?.updateMode();
  ($('m-link-id-row') as HTMLElement).hidden = mode !== 'existing';
  ($('m-link-direction-row') as HTMLElement).hidden = mode !== 'existing';
  ($('m-link-check-row') as HTMLElement).hidden = !wizard;
  ($('m-link-direct') as HTMLElement).hidden = wizard;
  ($('link-gate-hint') as HTMLElement).hidden = !wizard;
  $('m-btn-link-direct').textContent = mode === 'new'
    ? t('manager.syncs.createUpload')
    : t('manager.syncs.connect');
  ($('m-link-new-note') as HTMLElement).hidden = mode !== 'new';
  updateLinkConflictNote();
  // Prepopulate once with the current link: most moves stay on the same
  // service (new sync id, same host). Never clobbers user input afterwards.
  prefillLinkUrl();
  // Existing targets use their current password, verified before the review.
  $('m-link-password-label').textContent = mode === 'new' ? t('manager.syncs.newPassword') : t('mgr.syncs.syncPassword');
  $('m-link-confirm-label').textContent = mode === 'new' ? t('common.confirmPassword') : t('mgr.syncs.confirmTargetPassword');
  // Confirm row only when inventing a password (new mode). In existing
  // mode the password is verify-before-mutate: a typo fails safely as
  // InvalidCredentials, so no confirmation is asked.
  ($('m-link-confirm-row') as HTMLElement).hidden = mode !== 'new';
  ($('m-link-pw-hint') as HTMLElement).hidden = mode !== 'new';
  preview = undefined;
  previewFor = undefined;
  mergeStats = undefined;
  cancelConfirm('m-btn-link');
  setLinkGate(false);
  $('link-error').hidden = true;
  $('link-error-2').hidden = true;
  $('link-preview').hidden = true;
  const result = $('link-result') as HTMLElement;
  result.hidden = true;
  result.textContent = '';
  suggestLinkName();
  updateLinkNameHint();
  renderLinkReview();
  updateLinkServiceGate();
}

/** Informational only: a pending conflict is not a reason to block a new
 *  sync. The new sync starts from the live tree; the conflicted one keeps
 *  its server copy (the conflict record is dropped on the sync change). */
function updateLinkConflictNote(): void {
  const note = document.getElementById('m-link-conflict') as HTMLElement | null;
  if (!note) return;
  note.hidden = !(linkMode() === 'new' && !!status?.conflict);
}

function renderLinkReview(): void {
  const mode = linkMode();
  const url = input('m-link-url').value.trim() || '…';
  const n = status?.bookmarkCount;
  const direction = linkDirection();
  $('link-summary').textContent =
    mode === 'new'
      ? n === undefined
        ? t('mgr.syncs.summaryNewNoCount', { url })
        : tn('mgr.syncs.summaryNew', n, { url })
      : direction === 'push'
        ? n === undefined
          ? t('mgr.syncs.summaryPushNoCount', { url })
          : tn('mgr.syncs.summaryPush', n, { url })
        : direction === 'merge'
          ? t('mgr.syncs.summaryMerge', { url })
          : t('mgr.syncs.summaryPull', { url });
  $('link-implication').textContent = `${mode === 'existing' ? directionConfirm(direction).implication + ' ' : ''}${LinkImplication()}`;
  const stats = mergeStats;
  $('link-merge-counts').textContent = mode === 'existing' && direction === 'merge' && stats
    ? t('popup.merge.counts', { local: stats.localOnly, remote: stats.remoteOnly, titles: stats.titleConflicts }) : '';
}

async function previewTarget(): Promise<void> {
  if (!linkService.ready) return;
  clearMessages();
  const newServiceUrl = input('m-link-url').value.trim();
  if (!newServiceUrl) {
    showError('link-error', t('mgr.syncs.urlRequired'));
    return;
  }
  const mode = linkMode();
  const syncId = input('m-link-id').value.trim() || undefined;
  if (mode === 'existing' && !syncId) {
    showError('link-error', t('val.syncId.required'));
    return;
  }
  const invalid = validateSwitch({ mode, newServiceUrl, syncId,
    newPassword: input('m-link-password').value, confirm: input('m-link-confirm').value });
  if (invalid) return showError('link-error', invalid);
  const generation = linkGeneration;
  const urlErr = validateServiceUrl(newServiceUrl);
  if (urlErr) {
    showError('link-error', urlErr);
    return;
  }
  checkingTarget = true;
  await withBusy('m-btn-link-check', t('busy.checking'), async () => {
    try {
      const checked = await send<SyncTargetPreview>({
        command: MessageCommand.CheckSyncTarget,
        newServiceUrl,
        mode,
        syncId,
      });
      if (generation !== linkGeneration) return;
      preview = checked;
      // Pin what the preview was made for; submitLink() refuses stale previews.
      previewFor = { newServiceUrl, mode, syncId, direction: linkDirection() };
    } catch (err) {
      if (generation !== linkGeneration) return;
      showError('link-error', (err as Error).message);
      return;
    }
    const box = $('link-preview');
    if (!preview.reachable) {
      box.textContent = t('mgr.syncs.unreachable');
    } else {
      const lines = [
        t('mgr.syncs.previewVersion', {
          version: preview.serviceVersion ?? '?',
          state: preview.versionCompatible ? t('mgr.syncs.versionOk') : t('mgr.syncs.versionOld'),
        }),
        t('mgr.syncs.previewSync', {
          state:
            mode === 'new'
              ? t('mgr.syncs.syncNew')
              : preview.remoteExists
                ? t('mgr.syncs.syncFound', { when: preview.remoteLastUpdated ?? '?' })
                : t('mgr.syncs.syncNotFound'),
        }),
        t('mgr.syncs.previewLocal', { count: preview.localCount ?? '?' }),
      ];
      if (preview.syncExpiryDays !== undefined) {
        lines.push(t('mgr.syncs.previewExpiry', { state: describeSyncExpiry(preview.syncExpiryDays) }));
      }
      // Read-only decryption verifies existing credentials for every direction.
      // Keep union statistics so changing direction needs no further check.
      mergeStats = undefined;
      if (mode === 'existing' && preview.remoteExists) {
        const mergePassword = input('m-link-password').value;
        if (!mergePassword) {
          box.textContent = lines.join('\n') + '\n' + t('mgr.syncs.enterPwForMerge');
          box.hidden = false;
          setLinkGate(false);
          return;
        }
        try {
          const checkedMerge = await send<MergePreview>({
            command: MessageCommand.PreviewMerge,
            serviceUrl: newServiceUrl,
            syncId: syncId!,
            password: mergePassword,
          });
          if (generation !== linkGeneration) return;
          mergeStats = checkedMerge;
          if (linkDirection() === 'merge')
          lines.push(
            t('mgr.syncs.mergePreview', {
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
          if (generation !== linkGeneration) return;
          showError('link-error', (err as Error).message);
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
    if (generation !== linkGeneration) return;
    renderLinkReview();
    setLinkGate(ok);
    if (!ok) showError('link-error', !preview.reachable ? t('mgr.syncs.unreachable') : preview.versionCompatible === false ? t('mgr.syncs.versionOld') : t('mgr.syncs.syncNotFound'));
    if (ok) $('link-step2').scrollIntoView({ block: 'nearest' });
  });
  checkingTarget = false;
  updateLinkServiceGate();
}

/** The Move button exists only after a passing check: shown + enabled
 *  together, with the gate hint standing in for it while locked. */
function setLinkGate(ok: boolean): void {
  ($('m-btn-link') as HTMLButtonElement).disabled = !ok;
  ($('link-step2') as HTMLElement).hidden = !ok;
  // One primary action at a time: once step 2 is open, Move is the main one.
  $('m-btn-link-check').classList.toggle('primary', !ok);
  ($('link-gate-hint') as HTMLElement).hidden = ok;
}

async function submitLink(): Promise<void> {
  // Only the existing-sync wizard has a review step; everything else acts
  // through the direct button.
  if (linkMode() !== 'existing' || !status?.syncEnabled) return;
  connectQr?.close();
  clearMessages();
  const newServiceUrl = input('m-link-url').value.trim();
  const mode = linkMode();
  const direction = linkDirection();
  const syncId = input('m-link-id').value.trim() || undefined;
  const newPassword = input('m-link-password').value;
  const confirm = input('m-link-confirm').value;
  const invalid = validateSwitch({ mode, newServiceUrl, syncId, newPassword, confirm });
  if (invalid) {
    showError('link-error-2', invalid);
    return;
  }
  // A move leaves the previous sync in the list: prove the switch lock first,
  // so the background can wrap the new active key.
  const label = input('m-link-name').value.trim() || undefined;
  const switchPassword = linkSwitchPassword;
  if (switchLockSet && !switchPassword) {
    showError('link-error-2', t('core.switchPasswordRequired'));
    return;
  }
  if (
    !linkService.ready ||
    !preview ||
    !previewFor ||
    previewFor.newServiceUrl !== newServiceUrl ||
    previewFor.mode !== mode ||
    previewFor.syncId !== syncId ||
    previewFor.direction !== direction
  ) {
    showError('link-error-2', t('mgr.syncs.inputsChanged'));
    return;
  }
  // Merge executes on explicit per-counts confirmation: the union never
  // deletes, but resurrects items deleted while offline — say so first.
  const s = mergeStats;
  if (mode === 'existing' && direction === 'merge' && !s) {
    showError('link-error-2', t('mgr.syncs.mergeUnavailable'));
    return;
  }
  // The visible checked summary and implication are the sole confirmation.
  // Set on success so the post-busy gate below knows the preview was spent.
  let movedId: string | undefined;
  // Local count for the success line (new/push upload exactly these; capture
  // before the move — merge/pull rewrite the local tree).
  const localCount = status?.bookmarkCount;
  linking = true;
  linkService.setBusy(true);
  await withBusy('m-btn-link', t('busy.moving'), async () => {
    ($('link-result') as HTMLElement).hidden = true;
    try {
      const res = await send<{ id: string }>({
        command: MessageCommand.LinkSync,
        link: { newServiceUrl, mode, syncId, newPassword, direction, switchPassword, label },
      });
      input('m-link-password').value = '';
      input('m-link-confirm').value = '';
      input('m-link-name').value = '';
      nameTouched = false;
      movedId = res.id;
    } catch (err) {
      input('m-link-confirm').value = '';
      showError('link-error-2', (err as Error).message);
    }
  });
  linking = false;
  linkService.setBusy(false);
  updateLinkServiceGate();
  if (movedId) {
    // The add form is one-shot: close it (consuming the stale preview) and
    // keep the evidence in the section-level result box outside the form.
    closeAddSync();
    await linkService.refreshCatalog().catch(err => showError('m-syncs-error', (err as Error).message));
    // Contextual success: restate WHAT ran (mode + direction + target), not
    // just the new id — the wizard offers four different outcomes.
    const done = describeLinkResult({ mode, direction, newServiceUrl, syncId, bookmarkCount: localCount });
    const box = $('m-syncs-result') as HTMLElement;
    box.textContent = t('mgr.syncs.resultLine', { done, next: LinkDoneNext(), id: movedId });
    const copy = document.createElement('button');
    copy.textContent = t('mgr.syncs.copyId');
    copy.className = 'mini';
    copy.setAttribute('aria-label', t('mgr.syncs.copyIdAria'));
    copy.addEventListener('click', () => void copyText(movedId!, t('popup.copyIdPrompt')));
    box.append(' ', copy);
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    box.focus({ preventScroll: true });
    await refreshStatus();
  } else {
    // Failed: the still-valid preview keeps the button unlocked, so keep
    // the gate hint in sync with the button (hint shown only while locked).
    ($('link-gate-hint') as HTMLElement).hidden = !($('m-btn-link') as HTMLButtonElement).disabled;
  }
}

/** Direct action: creating a new sync (always additive) or, with no active
 *  side, opening an existing one. Nothing is reviewed because nothing is
 *  replaced: a new sync uploads the live tree and the current sync stays in
 *  the list. */
async function directConnect(): Promise<void> {
  connectQr?.close();
  clearMessages();
  const serviceUrl = input('m-link-url').value.trim();
  const mode = linkMode();
  const direction = linkDirection();
  const syncId = input('m-link-id').value.trim() || undefined;
  const password = input('m-link-password').value;
  const invalid = validateSwitch({ mode, newServiceUrl: serviceUrl, syncId,
    newPassword: password, confirm: input('m-link-confirm').value });
  if (invalid) return showError('link-error', invalid);
  const urlErr = validateServiceUrl(serviceUrl);
  if (urlErr) return showError('link-error', urlErr);
  if (!linkService.ready) return;
  const label = input('m-link-name').value.trim() || undefined;
  if (linkLabelTaken(input('m-link-name').value)) {
    return showError('link-error', t('core.labelDuplicate'));
  }
  // Existing target while unlinked: still confirm the direction (pull/push
  // replace a side, merge resurrects deleted items). A new sync replaces
  // nothing, so its note in the form is the whole explanation.
  if (mode === 'existing') {
    let counts = '';
    if (direction === 'merge') {
      let preview: MergePreview | undefined;
      await withBusy('m-btn-link-direct', t('busy.checking'), async () => {
        try {
          preview = await send<MergePreview>({
            command: MessageCommand.PreviewMerge,
            serviceUrl,
            syncId: syncId!,
            password,
          });
        } catch (err) {
          showError('link-error', (err as Error).message);
        }
      });
      if (!preview) return;
      counts = t('popup.merge.counts', {
        local: preview.localOnly,
        remote: preview.remoteOnly,
        titles: preview.titleConflicts,
      });
    }
    const ok = await confirmInline('m-btn-link-direct', {
      message: directionConfirm(direction).message,
      implication: `${counts}${directionConfirm(direction).implication}`,
      confirmLabel: directionConfirm(direction).confirmLabel,
      danger: direction !== 'merge',
    });
    if (!ok) return;
  }
  const switchPassword = linkSwitchPassword;
  if (switchLockSet && !switchPassword) {
    return showError('link-error', t('core.switchPasswordRequired'));
  }
  const shownName = label ?? serviceHost(serviceUrl);
  let createdCount: number | undefined;
  await withBusy('m-btn-link-direct', t('busy.connecting'), async () => {
    try {
      if (mode === 'new') {
        const res = await send<{ id: string; bookmarkCount: number }>({
          command: MessageCommand.ConnectNew,
          serviceUrl,
          password,
          switchPassword,
          label,
        });
        createdCount = res.bookmarkCount;
      } else {
        await send({
          command: MessageCommand.ConnectExisting,
          serviceUrl,
          syncId: syncId!,
          password,
          direction,
          switchPassword,
          label,
        });
      }
      closeAddSync();
      await linkService.refreshCatalog().catch((err) => showError('m-syncs-error', (err as Error).message));
      showResult(
        'm-syncs-result',
        createdCount === undefined
          ? t('manager.syncs.connected', { name: shownName })
          : t('manager.syncs.created', { name: shownName, count: createdCount }),
      );
      await refreshSyncs();
      await refreshStatus();
    } catch (err) {
      input('m-link-confirm').value = '';
      showError('link-error', (err as Error).message);
    }
  });
  updateLinkForm();
}

/** The add task is one modal dialog: with a sync lock its first step is the
 *  proof, then the wizard replaces it in place. The Sync list behind is inert
 *  for the whole task, so no row can be activated, renamed or removed
 *  halfway through, and there is exactly one Cancel on screen. */
function openAddSync(): void {
  clearMessages();
  nameTouched = false;
  linkSwitchPassword = '';
  const dialog = $('m-link-dialog') as HTMLDialogElement;
  if (switchLockSet) {
    input('m-link-gate-pw').value = '';
    const gateError = $('link-gate-error') as HTMLElement;
    gateError.textContent = '';
    gateError.hidden = true;
    ($('m-link-form') as HTMLElement).hidden = true;
    ($('m-link-gate') as HTMLElement).hidden = false;
    dialog.classList.add('gate');
    dialog.setAttribute('aria-labelledby', 'm-link-gate-title');
    dialog.setAttribute('aria-describedby', 'm-link-gate-intro');
    linkDialog.open($('m-btn-add-sync'), input('m-link-gate-pw'));
    return;
  }
  openAddWizard($('m-btn-add-sync'));
}

/** Second step of the same task: the gate (when set) passed, so the wizard
 *  takes the dialog. Nothing is closed and reopened: the task never flickers
 *  and the opener keeps its focus target for when the task ends. */
function openAddWizard(opener?: HTMLElement): void {
  // Every open starts on "a new sync": that is what the button promises.
  (document.querySelector('input[name="m-link-mode"][value="new"]') as HTMLInputElement).checked = true;
  (document.querySelector('input[name="m-link-direction"][value="pull"]') as HTMLInputElement).checked = true;
  ($('m-link-gate') as HTMLElement).hidden = true;
  ($('m-link-form') as HTMLElement).hidden = false;
  const dialog = $('m-link-dialog') as HTMLDialogElement;
  dialog.classList.remove('gate');
  dialog.setAttribute('aria-labelledby', 'm-link-add-title');
  dialog.removeAttribute('aria-describedby');
  if (!linkDialog.isOpen) linkDialog.open(opener);
  updateLinkForm();
  prefillLinkUrl();
  suggestLinkName();
  // A remembered service hides the URL input (its label is hidden): focusing
  // it would leave the caret on the page body, so a name typed right after
  // opening the form would silently go nowhere and the host default would be
  // saved. Focus the first field the user can see and select it, so typing
  // replaces the suggestion instead of appending to it.
  focusFirstVisible([input('m-link-url'), input('m-link-name')], true);
}

/** Gate submit: prove the sync lock password (read-only, nothing changes) and
 *  only then reveal the wizard. A wrong password clears the field. */
async function verifyAddSyncGate(): Promise<void> {
  // Enter can submit the form while the button is disabled by withBusy.
  if (($('m-btn-link-gate-go') as HTMLButtonElement).disabled) return;
  const password = input('m-link-gate-pw').value;
  const gateError = $('link-gate-error') as HTMLElement;
  gateError.textContent = '';
  gateError.hidden = true;
  if (!password) {
    gateError.textContent = t('core.switchPasswordRequired');
    gateError.hidden = false;
    return;
  }
  const token = linkDialog.token;
  await withBusy('m-btn-link-gate-go', t('busy.checking'), async () => {
    try {
      await send({ command: MessageCommand.VerifySwitchPassword, password });
      // Cancelled (or replaced) while the answer was in flight: the wizard
      // must not open over a task the user already closed.
      if (!linkDialog.isOpen || linkDialog.token !== token) return;
      linkSwitchPassword = password;
      input('m-link-gate-pw').value = '';
      openAddWizard();
    } catch (err) {
      if (!linkDialog.isOpen || linkDialog.token !== token) return;
      input('m-link-gate-pw').value = '';
      gateError.textContent = (err as Error).message;
      gateError.hidden = false;
      input('m-link-gate-pw').focus();
    }
  });
}

/** Ends the add task (button, Escape, backdrop or a successful submit). The
 *  dialog's onClose resets every field, so the next open starts clean. */
function closeAddSync(): void {
  linkDialog.close();
}

function resetAddSync(): void {
  ($('m-link-form') as HTMLElement).hidden = true;
  ($('m-link-gate') as HTMLElement).hidden = true;
  ($('m-link-dialog') as HTMLDialogElement).classList.add('gate');
  linkSwitchPassword = '';
  input('m-link-gate-pw').value = '';
  const gateError = $('link-gate-error') as HTMLElement;
  gateError.textContent = '';
  gateError.hidden = true;
  input('m-link-password').value = '';
  input('m-link-confirm').value = '';
  input('m-link-id').value = '';
  input('m-link-name').value = '';
  nameTouched = false;
  preview = undefined;
  previewFor = undefined;
  mergeStats = undefined;
  for (const id of ['link-error', 'link-error-2', 'link-preview', 'link-result', 'link-step2']) {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) continue;
    el.hidden = true;
    if (el.hasAttribute('role') && (el.classList.contains('error') || el.classList.contains('result'))) el.textContent = '';
  }
}

function initMoveSection(): void {
  linkService = new ServicePicker({
    input: input('m-link-url'), mode: linkMode,
    onChange: () => updateLinkForm(),
    onState: () => updateLinkServiceGate(),
  });
  document.querySelectorAll('input[name="m-link-mode"]').forEach((el) => {
    el.addEventListener('change', updateLinkForm);
  });
  document.querySelectorAll('input[name="m-link-direction"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (previewFor) previewFor.direction = linkDirection();
      renderLinkReview();
    });
  });
  input('m-link-url').addEventListener('input', updateLinkForm);
  input('m-link-id').addEventListener('input', updateLinkForm);
  input('m-link-password').addEventListener('input', updateLinkForm);
  input('m-link-confirm').addEventListener('input', updateLinkForm);
  input('m-link-name').addEventListener('input', () => {
    nameTouched = true;
    updateLinkNameHint();
    updateLinkServiceGate();
  });
  $('m-btn-link-check').addEventListener('click', () => void previewTarget());
  $('m-btn-link').addEventListener('click', () => void submitLink());
  $('m-btn-link-direct').addEventListener('click', () => void directConnect());
  $('m-btn-add-sync').addEventListener('click', () => openAddSync());
  $('m-btn-add-cancel').addEventListener('click', () => closeAddSync());
  // Enter submits the proof; Escape and a backdrop click cancel through the
  // dialog itself (TaskDialog), exactly like the Cancel button.
  $('m-link-gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void verifyAddSyncGate();
  });
  $('m-btn-link-gate-cancel').addEventListener('click', () => closeAddSync());
  updateLinkForm();
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
  // The log is troubleshooting material, not a feature: Settings keeps it
  // folded behind one button (verbosity included) instead of a sidebar entry.
  $('m-btn-logs-toggle').addEventListener('click', () => {
    const panel = $('m-logs-panel') as HTMLElement;
    const button = $('m-btn-logs-toggle') as HTMLButtonElement;
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = t(open ? 'manager.logs.hide' : 'manager.logs.show');
    if (open) void refreshLogs();
  });
}

async function renderSettings(): Promise<void> {
  clearMessages();
  // The lock state decides whether the password task asks for its proof.
  await refreshSyncs().catch(() => undefined);
  // Settings holds preferences only: service, API version, sync ID and the
  // saved syncs are reported by Status and Sync, never repeated here.
  let level = 2;
  try {
    const st = await send<StatusResponse>({ command: MessageCommand.GetStatus });
    level = st.logLevel ?? 2;
  } catch (err) {
    showError('settings-error', (err as Error).message);
  }
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
  ($('m-pw-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    void submitPasswordChange();
  });
  ($('m-btn-password-cancel') as HTMLButtonElement).addEventListener('click', () => pwDialog.close());
}

/** Sync section: registry rows, activation, rename and row actions. Reads the
 *  background (the only writer) then renders; every mutation re-reads. */
async function refreshSyncs(): Promise<void> {
  let data: SavedSyncsResponse | null = null;
  try {
    data = await send<SavedSyncsResponse>({ command: MessageCommand.GetSavedSyncs });
  } catch {
    data = null;
  }
  // Defensive: a background from an older version (or a failed read) must
  // leave the section empty, not crash the whole manager.
  syncsView = {
    syncs: Array.isArray(data?.syncs) ? data.syncs : [],
    ...(data?.active ? { active: data.active } : {}),
    switchLockSet: !!data?.switchLockSet,
  };
  switchLockSet = syncsView.switchLockSet;
  renderSyncsList();
  refreshSwitchLockUi();
  suggestLinkName();
}

function renderSyncsList(): void {
  const list = $('m-syncs-list') as HTMLElement;
  list.replaceChildren();
  const rows = syncsView.syncs;
  ($('m-syncs-empty') as HTMLElement).hidden = rows.length > 0;
  rows.forEach((sync, index) => list.append(syncRow(sync, index)));
  const activeRow = rows.find((row) => isActiveSavedSync(row, syncsView.active));
  ($('m-sync-name') as HTMLElement).textContent = activeRow ? savedSyncName(activeRow) : '—';
  updateLinkConflictNote();
  updateSyncsDanger();
  renderActivation();
}

/** One registry row: identity, then a primary activation and secondary menu. Every row
 *  has one local action: on the active row it unlinks this device (the row is
 *  the link), on an inactive one it forgets the row. Both leave the server and
 *  the local bookmarks alone. */
function syncRow(sync: SavedSync, index: number): HTMLElement {
  const isActive = isActiveSavedSync(sync, syncsView.active);
  const li = document.createElement('li');
  li.className = isActive ? 'saved-row saved-active' : 'saved-row';

  const head = document.createElement('div');
  head.className = 'saved-head';
  const name = document.createElement('strong');
  name.textContent = savedSyncName(sync);
  const statusWrap = document.createElement('span');
  statusWrap.className = 'saved-status';
  const tag = document.createElement('span');
  tag.className = isActive ? 'tag ok' : 'tag';
  tag.textContent = isActive ? t('popup.saved.active') : t('manager.syncs.dormant');
  statusWrap.append(tag);
  if (isActive) {
    const gate = contractGate({
      liveV12: ping?.supportsV12,
      storedV12: status?.supportsV12,
      syncEnabled: true,
    });
    if (gate.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = gate.badge;
      statusWrap.append(badge);
    }
  }
  head.append(name, statusWrap);

  // The sync ID is a bearer token: a prefix only (the full one stays in the
  // status card, copyable).
  const lastUsed = sync.lastUsedAt ? ` · ${t('manager.syncs.lastUsed', { when: formatDateTime(sync.lastUsedAt) })}` : '';
  const sub = document.createElement('small');
  sub.className = 'saved-sub';
  sub.textContent = `${serviceHost(sync.serviceUrl)} · ${shortSyncId(sync.syncId)}${lastUsed}`;

  const actions = document.createElement('div');
  actions.className = 'saved-actions';

  const activate = document.createElement('button');
  activate.type = 'button';
  activate.className = 'mini primary';
  activate.id = `m-syncs-act-${index}`;
  activate.textContent = t('popup.saved.activate');
  activate.disabled = isActive;
  activate.addEventListener('click', () => openActivation(sync, activate));
  actions.append(activate);

  const menu = document.createElement('details');
  menu.className = 'saved-menu';
  const more = document.createElement('summary');
  more.className = 'saved-menu-toggle';
  more.textContent = '⋮';
  more.setAttribute('aria-label', t('manager.syncs.moreActions', { name: savedSyncName(sync) }));
  const commands = document.createElement('div');
  commands.className = 'saved-menu-commands';
  menu.append(more, commands);
  actions.append(menu);
  // Keep the opener visible for TaskDialog's focus return, even after the
  // selected command has closed this disclosure.
  commands.addEventListener('click', () => { menu.open = false; });
  menu.addEventListener('toggle', () => {
    if (menu.open) {
      listOpenSyncMenus().forEach((other) => { if (other !== menu) other.open = false; });
    }
  });

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'mini';
  rename.id = `m-syncs-rename-${index}`;
  rename.textContent = t('manager.syncs.rename');
  rename.addEventListener('click', () => openRowTask('rename', sync, more));
  commands.append(rename);

  // Every row can produce a QR: the phone may join a sync that is not the one
  // active in this browser. The code names that row's own service and ID.
  const qr = document.createElement('button');
  qr.type = 'button';
  qr.className = 'mini';
  qr.id = `m-syncs-qr-${index}`;
  qr.textContent = t('manager.syncs.showQr');
  const qrTarget: ConnectQrTarget = { serviceUrl: sync.serviceUrl, syncId: sync.syncId };
  qr.addEventListener('click', () => connectQr?.openFor(qrTarget, more));
  commands.append(qr);

  if (isActive) {
    // The long password belongs to this sync, so its change lives here, next
    // to the row it re-encrypts — not in Settings.
    const changePw = document.createElement('button');
    changePw.type = 'button';
    changePw.className = 'mini';
    changePw.id = `m-syncs-pw-${index}`;
    changePw.textContent = t('manager.syncs.changePw');
    changePw.addEventListener('click', () => openPasswordChange(more));
    commands.append(changePw);
  }

  const separator = document.createElement('hr');
  commands.append(separator);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'mini danger';
  remove.id = `m-syncs-rm-${index}`;
  remove.textContent = t(isActive ? 'manager.syncs.unlink' : 'manager.syncs.forget');
  // On the active row this unlinks this device (the row is the link) and keeps
  // the server copy: confirmed with its own wording, never disabled.
  remove.addEventListener('click', () => openRowTask(isActive ? 'unlink' : 'forget', sync, more));
  commands.append(remove);

  if (isActive) {
    const removeRemote = document.createElement('button');
    removeRemote.type = 'button';
    removeRemote.className = 'mini danger';
    removeRemote.id = `m-syncs-delete-${index}`;
    removeRemote.dataset.action = 'delete';
    removeRemote.textContent = t('manager.syncs.deleteRemote');
    removeRemote.addEventListener('click', () => {
      if (!removeRemote.disabled) openRowTask('delete', sync, more);
    });
    commands.append(removeRemote);
  }

  li.append(head, sub, actions);
  return li;
}

function listOpenSyncMenus(): HTMLDetailsElement[] {
  return [...document.querySelectorAll<HTMLDetailsElement>('.saved-menu[open]')];
}

document.addEventListener('click', (event) => {
  const target = event.target;
  listOpenSyncMenus().forEach((menu) => {
    if (!(target instanceof Node) || !menu.contains(target)) menu.open = false;
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  listOpenSyncMenus().forEach((menu) => {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
});

/** Duplicate check for the name field (case-insensitive, host fallback
 *  counts as a name too: two identical rows would be indistinguishable). */
function linkLabelTaken(label: string): boolean {
  const needle = label.trim().toLocaleLowerCase();
  if (!needle) return false;
  const mode = linkMode();
  const syncId = input('m-link-id').value.trim();
  const exclude: SavedSyncActive | undefined =
    mode === 'existing' && syncId
      ? { serviceUrl: input('m-link-url').value.trim(), syncId }
      : undefined;
  return syncsView.syncs.some(
    (row) => (!exclude || !sameSavedSync(row, exclude)) && savedSyncName(row).trim().toLocaleLowerCase() === needle,
  );
}

function suggestLinkName(): void {
  if (nameTouched) return;
  const url = input('m-link-url').value.trim();
  input('m-link-name').value = url ? suggestSavedSyncName(url, syncsView.syncs) : '';
  updateLinkNameHint();
}

function updateLinkNameHint(): void {
  const hint = $('m-link-name-hint') as HTMLElement;
  hint.hidden = !linkLabelTaken(input('m-link-name').value);
}

function openActivation(sync: SavedSync, opener: HTMLElement): void {
  clearMessages();
  pendingActivation = sync;
  const name = savedSyncName(sync);
  $('m-syncs-activate-text').textContent = t('popup.saved.activatePrompt', { name });
  $('m-syncs-activate-hint').textContent = switchLockSet
    ? t('popup.saved.passwordHint', { name })
    : t('manager.syncs.activateHint', { name });
  ($('m-syncs-pw-row') as HTMLElement).hidden = !switchLockSet;
  input('m-syncs-activate-pw').value = '';
  const error = $('m-activate-error') as HTMLElement;
  error.textContent = '';
  error.hidden = true;
  activateDialog.open(opener, switchLockSet ? input('m-syncs-activate-pw') : ($('m-syncs-activate-go') as HTMLElement));
}

/** Ends the activation task: the dialog's onClose clears the pending row and
 *  any password typed into it. */
function closeActivation(): void {
  activateDialog.close();
}

function resetActivation(): void {
  pendingActivation = undefined;
  input('m-syncs-activate-pw').value = '';
  const error = $('m-activate-error') as HTMLElement;
  error.textContent = '';
  error.hidden = true;
}

function renderActivation(): void {
  if (pendingActivation && !syncsView.syncs.some((row) => sameSavedSync(row, pendingActivation!))) {
    closeActivation();
  }
}

async function activatePending(): Promise<void> {
  // Enter can submit the form while the button is disabled by withBusy.
  if (($('m-syncs-activate-go') as HTMLButtonElement).disabled) return;
  const target = pendingActivation;
  if (!target) return;
  const password = input('m-syncs-activate-pw').value;
  if (switchLockSet && !password) {
    showError('m-activate-error', t('core.switchPasswordRequired'));
    return;
  }
  const name = savedSyncName(target);
  const token = activateDialog.token;
  await withBusy('m-syncs-activate-go', t('busy.connecting'), async () => {
    try {
      await send({
        command: MessageCommand.ActivateSavedSync,
        serviceUrl: target.serviceUrl,
        syncId: target.syncId,
        ...(switchLockSet ? { switchPassword: password } : {}),
      });
      // Closed while the switch was running: the outcome still happened, but
      // the dialog must not be reopened or its error shown elsewhere.
      if (!activateDialog.isOpen || activateDialog.token !== token) return;
      closeActivation();
      showResult('m-syncs-result', t('manager.syncs.activated', { name }));
      await refreshSyncs();
      await refreshStatus();
    } catch (err) {
      if (!activateDialog.isOpen || activateDialog.token !== token) return;
      input('m-syncs-activate-pw').value = '';
      showError('m-activate-error', (err as Error).message);
      input('m-syncs-activate-pw').focus();
    }
  });
}

/** Row tasks share one modal dialog: rename, or forget/unlink/delete with
 *  their confirmation. One task at a time, so a confirmation is never armed on
 *  a second row while the first is still open. */
type RowTaskKind = 'rename' | 'forget' | 'unlink' | 'delete';
let rowTask: { kind: RowTaskKind; sync: SavedSync } | undefined;

function openRowTask(kind: RowTaskKind, sync: SavedSync, opener: HTMLElement): void {
  // Defense in depth: the v1.2 gate disables this button on legacy services.
  if (kind === 'delete' && opener instanceof HTMLButtonElement && opener.disabled) return;
  clearMessages();
  rowTask = { kind, sync };
  const name = savedSyncName(sync);
  const title = $('m-row-title') as HTMLElement;
  const message = $('m-row-message') as HTMLElement;
  const implication = $('m-row-implication') as HTMLElement;
  const fieldRow = $('m-row-field-row') as HTMLElement;
  const field = input('m-row-field');
  const go = $('m-btn-row-go') as HTMLButtonElement;
  fieldRow.hidden = kind !== 'rename';
  message.hidden = kind === 'rename';
  implication.hidden = kind === 'rename';
  go.className = kind === 'rename' ? 'primary' : 'danger';
  switch (kind) {
    case 'rename':
      title.textContent = withoutEllipsis(t('manager.syncs.rename'));
      field.value = sync.label ?? '';
      field.maxLength = MaxSavedSyncLabelLength;
      field.placeholder = serviceHost(sync.serviceUrl);
      go.textContent = t('common.save');
      break;
    case 'forget':
      title.textContent = withoutEllipsis(t('manager.syncs.forget'));
      message.textContent = t('popup.saved.forgetPrompt', { name });
      implication.textContent = t('popup.saved.forgetImplication');
      go.textContent = t('popup.saved.forget');
      break;
    case 'unlink':
      title.textContent = withoutEllipsis(t('manager.syncs.unlink'));
      message.textContent = t('manager.syncs.unlinkMessage', { name });
      implication.textContent = t('manager.syncs.unlinkImplication');
      go.textContent = t('common.yesUnlink');
      break;
    case 'delete':
      title.textContent = withoutEllipsis(t('manager.syncs.deleteRemote'));
      message.textContent = t('mgr.status.deleteMessage');
      implication.textContent = DeleteRemoteImplication();
      go.textContent = t('common.yesDelete');
      break;
  }
  // A destructive task focuses Cancel: Enter must never remove a sync by
  // accident. Rename focuses its field with the current name selected.
  if (kind === 'rename') {
    rowDialog.open(opener, field);
    field.select();
  } else {
    rowDialog.open(opener, $('m-btn-row-cancel') as HTMLElement);
  }
}

function resetRowTask(): void {
  rowTask = undefined;
  input('m-row-field').value = '';
  const error = $('m-row-error') as HTMLElement;
  error.textContent = '';
  error.hidden = true;
}

/** One submit for the open row task. Rename is metadata only; the three
 *  removals are the destructive ones and keep their own wording. */
async function submitRowTask(): Promise<void> {
  // Enter can submit the form while the button is disabled by withBusy.
  if (($('m-btn-row-go') as HTMLButtonElement).disabled) return;
  const task = rowTask;
  if (!task) return;
  const token = rowDialog.token;
  const error = $('m-row-error') as HTMLElement;
  error.textContent = '';
  error.hidden = true;
  const name = savedSyncName(task.sync);
  if (task.kind === 'rename') {
    try {
      const res = await send<{ renamed: boolean }>({
        command: MessageCommand.RenameSavedSync,
        serviceUrl: task.sync.serviceUrl,
        syncId: task.sync.syncId,
        label: input('m-row-field').value.trim(),
      });
      if (!rowDialog.isOpen || rowDialog.token !== token) return;
      if (!res.renamed) throw new Error(t('core.savedNotFound'));
      rowDialog.close();
      await refreshSyncs();
      await refreshStatus();
    } catch (err) {
      if (!rowDialog.isOpen || rowDialog.token !== token) return;
      error.textContent = (err as Error).message;
      error.hidden = false;
      input('m-row-field').focus();
    }
    return;
  }
  await withBusy('m-btn-row-go', t('busy.deleting'), async () => {
    try {
      if (task.kind === 'delete') {
        await send({ command: MessageCommand.DeleteRemoteSync, target: { serviceUrl: task.sync.serviceUrl, syncId: task.sync.syncId } });
        if (!rowDialog.isOpen || rowDialog.token !== token) return;
        rowDialog.close();
        showResult('m-syncs-result', DeleteRemoteDone());
        status = undefined;
        ping = undefined;
        await refreshStatus();
        await refreshSyncs();
        return;
      }
      const res = await send<{ removed: boolean; unlinked: boolean; backups: number }>({
        command: MessageCommand.RemoveSavedSync,
        serviceUrl: task.sync.serviceUrl,
        syncId: task.sync.syncId,
      });
      if (!rowDialog.isOpen || rowDialog.token !== token) return;
      rowDialog.close();
      await refreshSyncs();
      if (res.unlinked) await refreshStatus();
      const done = t(res.unlinked ? 'manager.syncs.unlinked' : 'manager.syncs.forgot', { name });
      showResult(
        'm-syncs-result',
        res.backups > 0 ? `${done} ${t('manager.syncs.backupsPruned', { count: res.backups })}` : done,
      );
    } catch (err) {
      if (!rowDialog.isOpen || rowDialog.token !== token) return;
      error.textContent = (err as Error).message;
      error.hidden = false;
    }
  });
  // withBusy restores the pre-click disabled state last: re-assert the v1.2
  // gate after it, so neither success (now unlinked) nor failure (legacy
  // service) leaves a stale enabled button behind.
  updateSyncsDanger();
}

/** Protection card: offered with 2+ syncs, change/remove/reset once a lock
 *  exists (even with a single row, so it can always be removed). The card shows
 *  only the state and the actions; one action at a time opens the panel below
 *  with just the fields it needs. */
type LockAction = 'set' | 'change' | 'remove' | 'reset';
let lockAction: LockAction | undefined;

function refreshSwitchLockUi(): void {
  const rows = syncsView.syncs.length;
  const state = $('m-link-state');
  state.textContent = switchLockSet ? t('manager.switchPw.isSet') : t('manager.switchPw.notSet');
  state.classList.toggle('ok', switchLockSet);
  ($('m-protection') as HTMLElement).hidden = !switchLockSet && rows < 2;
  ($('m-btn-link-lock-set') as HTMLElement).hidden = switchLockSet;
  ($('m-btn-link-lock-change') as HTMLElement).hidden = !switchLockSet;
  ($('m-btn-link-lock-remove') as HTMLElement).hidden = !switchLockSet;
  // The action buttons stay in the section: the task itself is a modal, so
  // they are inert while it runs and nothing has to jump around.
  ($('m-lock-actions') as HTMLElement).hidden = false;
  ($('m-lock-forgot') as HTMLElement).hidden = !switchLockSet;
}

/** Trigger labels keep the ellipsis ("Remove…"); the button that runs the
 *  action drops it. Punctuation only, so it needs no translation. */
const withoutEllipsis = (s: string): string => s.replace(/\s*…$/, '');

function lockActionLabel(action: LockAction): string {
  switch (action) {
    case 'set':
      return withoutEllipsis(t('manager.switchPw.setBtn'));
    case 'change':
      return withoutEllipsis(t('manager.switchPw.changeBtn'));
    case 'remove':
      return withoutEllipsis(t('manager.switchPw.removeBtn'));
    case 'reset':
      return t('manager.switchPw.resetGo');
  }
}

function openLockPanel(action: LockAction, opener: HTMLElement): void {
  lockAction = action;
  clearMessages();
  ($('switch-pw-result') as HTMLElement).hidden = true;
  clearSwitchLockFields();
  // Remove demotes the rows with the current password alone; reset mints a new
  // vault, so it asks only for the new one (the old password is unknown by
  // definition). Change is the only flow that needs all three.
  const needsCurrent = action === 'change' || action === 'remove';
  const needsNew = action !== 'remove';
  ($('m-lock-current-row') as HTMLElement).hidden = !needsCurrent;
  ($('m-lock-new-row') as HTMLElement).hidden = !needsNew;
  ($('m-lock-confirm-row') as HTMLElement).hidden = !needsNew;
  // A task that loses data carries its consequence at the top, before the
  // fields: set/change only touch the lock, remove demotes the keys and reset
  // forgets every inactive sync, so those two warn first.
  const warning = $('m-lock-warning') as HTMLElement;
  const warningText = $('m-lock-warning-text') as HTMLElement;
  warning.hidden = action === 'set' || action === 'change';
  if (action === 'remove') warningText.textContent = t('manager.switchPw.removeImplication');
  if (action === 'reset') {
    const dormant = Math.max(syncsView.syncs.length - (syncsView.active ? 1 : 0), 0);
    warningText.textContent = t('manager.switchPw.resetWarning', { count: dormant });
  }
  const go = $('m-btn-lock-go') as HTMLButtonElement;
  go.textContent = lockActionLabel(action);
  go.className = action === 'remove' || action === 'reset' ? 'danger' : 'primary';
  ($('m-lock-title') as HTMLElement).textContent = lockActionLabel(action);
  refreshSwitchLockUi();
  lockDialog.open(opener, input(needsCurrent ? 'm-link-lock-current-pw' : 'm-link-lock-new'));
}

/** Ends the sync lock task; the dialog's onClose clears every field. */
function closeLockPanel(): void {
  lockDialog.close();
}

function resetLockPanel(): void {
  lockAction = undefined;
  clearSwitchLockFields();
  ($('m-lock-warning') as HTMLElement).hidden = true;
  ($('m-lock-warning-text') as HTMLElement).textContent = '';
  ($('switch-pw-error') as HTMLElement).hidden = true;
  refreshSwitchLockUi();
}

function switchLockFields(): { current: string; next: string; confirm: string } {
  return {
    current: input('m-link-lock-current-pw').value,
    next: input('m-link-lock-new').value,
    confirm: input('m-link-lock-confirm').value,
  };
}

function clearSwitchLockFields(): void {
  input('m-link-lock-current-pw').value = '';
  input('m-link-lock-new').value = '';
  input('m-link-lock-confirm').value = '';
}

/** Short password: only "not empty" and "the two match" are enforced. */
function validateSwitchLockFields(fields: { next: string; confirm: string }): string | undefined {
  if (!fields.next) return t('core.switchPasswordRequired');
  if (fields.next !== fields.confirm) return t('core.switchPasswordMismatch');
  return undefined;
}

function initSyncsSection(): void {
  ($('m-activate-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    void activatePending();
  });
  ($('m-syncs-activate-cancel') as HTMLButtonElement).addEventListener('click', () => closeActivation());
  ($('m-btn-link-lock-set') as HTMLButtonElement).addEventListener('click', () =>
    openLockPanel('set', $('m-btn-link-lock-set')));
  ($('m-btn-link-lock-change') as HTMLButtonElement).addEventListener('click', () =>
    openLockPanel('change', $('m-btn-link-lock-change')));
  ($('m-btn-link-lock-remove') as HTMLButtonElement).addEventListener('click', () =>
    openLockPanel('remove', $('m-btn-link-lock-remove')));
  ($('m-btn-link-lock-reset') as HTMLButtonElement).addEventListener('click', () =>
    openLockPanel('reset', $('m-btn-link-lock-reset')));
  ($('m-lock-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    void submitLockPanel();
  });
  ($('m-btn-lock-cancel') as HTMLButtonElement).addEventListener('click', () => closeLockPanel());
  ($('m-row-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    void submitRowTask();
  });
  ($('m-btn-row-cancel') as HTMLButtonElement).addEventListener('click', () => rowDialog.close());
}

/** One submit for the open panel: each action asks only for its own proof.
 *  Set and change wrap the vault; remove demotes the rows with the current
 *  password; reset mints a new vault and forgets the dormant rows. */
async function submitLockPanel(): Promise<void> {
  const action = lockAction;
  if (!action) return;
  clearMessages();
  ($('switch-pw-result') as HTMLElement).hidden = true;
  const fields = switchLockFields();
  if (action === 'change' || action === 'remove') {
    if (!fields.current) return showError('switch-pw-error', t('core.switchPasswordRequired'));
  }
  if (action !== 'remove') {
    const invalid = validateSwitchLockFields(fields);
    if (invalid) return showError('switch-pw-error', invalid);
  }
  const token = lockDialog.token;
  await withBusy('m-btn-lock-go', t('busy.changing'), async () => {
    try {
      if (action === 'set') {
        await send({ command: MessageCommand.SetSwitchPassword, password: fields.next, confirm: fields.confirm });
        if (!lockDialog.isOpen || lockDialog.token !== token) return;
        closeLockPanel();
        showResult('switch-pw-result', t('manager.switchPw.setDone'));
        await refreshSyncs();
        await refreshStatus();
        return;
      }
      if (action === 'change') {
        await send({
          command: MessageCommand.ChangeSwitchPassword,
          current: fields.current,
          next: fields.next,
          confirm: fields.confirm,
        });
        if (!lockDialog.isOpen || lockDialog.token !== token) return;
        closeLockPanel();
        showResult('switch-pw-result', t('manager.switchPw.changeDone'));
        await refreshSyncs();
        return;
      }
      if (action === 'remove') {
        const res = await send<{ rows: number }>({
          command: MessageCommand.RemoveSwitchPassword,
          current: fields.current,
        });
        if (!lockDialog.isOpen || lockDialog.token !== token) return;
        closeLockPanel();
        showResult('switch-pw-result', t('manager.switchPw.removeDone', { count: res.rows }));
        await refreshSyncs();
        await refreshStatus();
        return;
      }
      const res = await send<{ removed: number; kept: number }>({
        command: MessageCommand.ResetSwitchPassword,
        next: fields.next,
        confirm: fields.confirm,
      });
      if (!lockDialog.isOpen || lockDialog.token !== token) return;
      closeLockPanel();
      showResult('switch-pw-result', t('manager.switchPw.resetDone', { count: res.removed }));
      await refreshSyncs();
    } catch (err) {
      if (!lockDialog.isOpen || lockDialog.token !== token) return;
      // A wrong proof must not stay in the field.
      if (action === 'change' || action === 'remove') input('m-link-lock-current-pw').value = '';
      showError('switch-pw-error', (err as Error).message);
    }
  });
}

function readPasswordChange(): { current: string; next: string; confirm: string } {
  return {
    current: input('m-current-password').value,
    next: input('m-new-password').value,
    confirm: input('m-new-password-confirm').value,
  };
}

function resetPasswordFields(): void {
  input('m-current-password').value = '';
  input('m-new-password').value = '';
  input('m-new-password-confirm').value = '';
}

/** Ends the password task; the dialog's onClose drops every field. */
function resetPasswordChange(): void {
  resetPasswordFields();
  ($('pw-error') as HTMLElement).hidden = true;
  ($('pw-error') as HTMLElement).textContent = '';
}

/** Change password: one modal task. Its warning above the fields states the
 *  consequence, so the final button is the only confirmation. */
function openPasswordChange(opener: HTMLElement): void {
  connectQr?.close();
  clearMessages();
  ($('m-syncs-result') as HTMLElement).hidden = true;
  resetPasswordFields();
  // Name the sync being re-encrypted: the task is about that row, not about
  // the browser or the switch.
  const activeRow = syncsView.syncs.find((row) => isActiveSavedSync(row, syncsView.active));
  $('m-pw-target').textContent = activeRow
    ? t('manager.syncs.changePwTarget', { name: savedSyncName(activeRow) })
    : '';
  pwDialog.open(opener, input('m-current-password'));
}

async function submitPasswordChange(): Promise<void> {
  clearMessages();
  const fields = readPasswordChange();
  const invalid = validatePasswordChange(fields);
  if (invalid) return showError('pw-error', invalid);
  // No switch password: the rotation belongs to the active sync and the
  // background keeps the row valid on its own (see `markActiveRowRotated`).
  const token = pwDialog.token;
  await withBusy('m-btn-password-go', t('busy.changing'), async () => {
    try {
      await send({
        command: MessageCommand.ChangePassword,
        currentPassword: fields.current,
        newPassword: fields.next,
      });
      if (!pwDialog.isOpen || pwDialog.token !== token) return;
      pwDialog.close();
      showResult('m-syncs-result', ChangePasswordDone());
      await refreshStatus();
    } catch (err) {
      if (!pwDialog.isOpen || pwDialog.token !== token) return;
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
  // The four Sync tasks are modals: creating them first means every handler
  // registered below already has its dialog.
  linkDialog = new TaskDialog($('m-link-dialog') as HTMLDialogElement, { onClose: resetAddSync });
  activateDialog = new TaskDialog($('m-activate-dialog') as HTMLDialogElement, { onClose: resetActivation });
  lockDialog = new TaskDialog($('m-lock-dialog') as HTMLDialogElement, { onClose: resetLockPanel });
  rowDialog = new TaskDialog($('m-row-dialog') as HTMLDialogElement, { onClose: resetRowTask });
  pwDialog = new TaskDialog($('m-pw-dialog') as HTMLDialogElement, { onClose: resetPasswordChange });
  connectQr = new ConnectQrController(
    $('connect-qr'),
    (password, target) => send<ConnectQrPayload>({
      command: MessageCommand.PrepareConnectQr,
      currentPassword: password,
      ...(target ? { target } : {}),
    }),
    {},
    $('qr-dialog-host'),
  );
  initSidebar();
  initStatusSection();
  initConflictSection();
  initBackupSection();
  initDuplicatesSection();
  initSyncsSection();
  initMoveSection();
  initLogsSection();
  initSettingsSection();
  void refreshSyncs().catch(() => undefined);
  // Follow link changes made elsewhere (e.g. connecting from the popup):
  // the status card, actions and danger zone re-gate themselves without a
  // manual refresh. refreshStatus() is race-guarded (statusSeq), so bursts
  // of storage events collapse onto the newest read.
  browser.storage.onChanged.addListener((changes) => {
    if (StoreKey.UiLanguage in changes) location.reload();
    if ('syncEnabled' in changes || 'syncInfo' in changes) {
      const change = changes[StoreKey.SyncInfo];
      const oldInfo = change?.oldValue as { id?: string; serviceUrl?: string } | undefined;
      const newInfo = change?.newValue as { id?: string; serviceUrl?: string } | undefined;
      if (oldInfo?.id !== newInfo?.id || oldInfo?.serviceUrl !== newInfo?.serviceUrl ||
          (StoreKey.SyncEnabled in changes && changes[StoreKey.SyncEnabled].newValue !== true)) invalidateSyncTasks();
      connectQr?.close();
      void refreshStatus();
    }
  });
  void refreshStatus();
}
void init();
