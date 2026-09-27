// Full-tab manager: sidebar sections, each with its own contextual
// busy/error/result evidence. Shares the status renderer + helpers with the
// popup via ../popup/ui.js. Display only; mutations go through background.

import browser from 'webextension-polyfill';
import { ApiVersion, ApiVersion12, MinApiVersion, SyncClientVersion } from '../shared/constants.js';
import {
  $,
  contractGate,
  copyText,
  describeMoveResult,
  describeUndo,
  formatBytes,
  validatePasswordChange,
  validateServiceUrl,
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
  type MergePreview,
  type PingResponse,
  type SafetyEntry,
  type StatusResponse,
  type SwitchPreviewResult,
  type UndoState,
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

function sectionError(id: string, message: string): void {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function hideErrors(): void {
  for (const id of ['status-error', 'status-error-2', 'backup-error', 'backup-error-2', 'dup-error', 'dup-error-2', 'move-error', 'move-error-2', 'logs-error', 'settings-error', 'pw-error']) {
    const el = $(id);
    el.hidden = true;
    el.textContent = '';
  }
  // Stale success/result boxes must not survive next to a new error.
  for (const id of ['status-result', 'backup-result', 'move-result', 'pw-result', 'settings-result']) {
    $(id).hidden = true;
  }
}

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

async function refreshStatus(): Promise<void> {
  const my = ++statusSeq;
  hideErrors();
  try {
    status = await send<StatusResponse>({ command: MessageCommand.GetStatus });
  } catch (err) {
    if (my !== statusSeq) return;
    // Never leave a stale linked card: redraw cleared, then report.
    status = undefined;
    ping = undefined;
    renderStatusCard('m', { status, ping });
    updateDangerZone();
    ($('m-notlinked-hint') as HTMLElement).hidden = true;
    sectionError('status-error', (err as Error).message);
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
  updateDangerZone();
  ($('m-notlinked-hint') as HTMLElement).hidden = !!status?.syncEnabled;
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
  $('m-btn-undo').addEventListener('click', async () => {
    hideErrors();
    if (!window.confirm('Undo the last link operation? Changes made since will be discarded.')) return;
    await withBusy('m-btn-undo', 'Undoing…', async () => {
      try {
        const res = await send<{ undone: string }>({ command: MessageCommand.UndoLastLink });
        showResult('status-result', `Undone: ${res.undone}.`);
        await refreshStatus();
        await refreshUndoBanner();
      } catch (err) {
        sectionError('status-error-2', (err as Error).message);
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
  $('m-btn-sync-now').addEventListener('click', () =>
    withBusy('m-btn-sync-now', 'Syncing…', async () => {
      hideErrors();
      try {
        await send({ command: MessageCommand.SyncBookmarks, sync: { type: 'remote', runSync: true } });
      } catch (err) {
        sectionError('status-error-2', (err as Error).message);
      }
      await refreshStatus();
    }),
  );
  $('m-btn-refresh').addEventListener('click', () =>
    withBusy('m-btn-refresh', 'Refreshing…', () => refreshStatus()),
  );
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
        sectionError('status-error-2', (err as Error).message);
      }
    }),
  );
  $('m-btn-delete-remote').addEventListener('click', () =>
    void (async () => {
      // Defense in depth (checked BEFORE withBusy: the wrapper disables the
      // button while running, so a check inside would always self-trigger).
      // Disabled buttons don't fire clicks anyway; the background re-gates.
      if (($('m-btn-delete-remote') as HTMLButtonElement).disabled) return;
      await withBusy('m-btn-delete-remote', 'Deleting…', async () => {
        hideErrors();
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
          sectionError('status-error-2', (err as Error).message);
        }
      });
      // withBusy restores the pre-click disabled state last: re-assert the
      // v1.2 gate after it, so neither success (now unlinked) nor failure
      // (legacy service) leaves a stale enabled button behind.
      updateDangerZone();
    })(),
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
      const password = input('m-backup-password').value;
      if (password.length < MinBackupPasswordLength) {
        sectionError('backup-error', `Enter a backup password first (min ${MinBackupPasswordLength} chars).`);
        return;
      }
      try {
        const json = await send<string>({ command: MessageCommand.ExportBackup, password });
        await send({
          command: MessageCommand.DownloadFile,
          filename: `keepmark-backup-${new Date().toISOString().slice(0, 10)}.xbs.json`,
          text: json,
        });
        input('m-backup-password').value = '';
        showResult('backup-result', 'Backup exported to your downloads.');
      } catch (err) {
        sectionError('backup-error', (err as Error).message);
      }
    }),
  );
  $('m-btn-import').addEventListener('click', () => ($('m-import-file') as HTMLInputElement).click());
  ($('m-import-file') as HTMLInputElement).addEventListener('change', async (e) => {
    hideErrors();
    ($('m-import-preview') as HTMLElement).hidden = true;
    ($('m-btn-import-confirm') as HTMLButtonElement).disabled = true;
    importPreview = undefined;
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const password = input('m-backup-password').value;
    if (password.length < MinBackupPasswordLength) {
      sectionError('backup-error', `Enter the backup password first (min ${MinBackupPasswordLength} chars), then choose the file again.`);
      (e.target as HTMLInputElement).value = '';
      return;
    }
    if (file.size > MaxBackupBytes) {
      sectionError('backup-error', 'Backup file too large (over 50 MB).');
      (e.target as HTMLInputElement).value = '';
      return;
    }
    // Step 1: preview (count) — nothing mutates. Step 2 arms Confirm import.
    await withBusy('m-btn-import', 'Reading…', async () => {
      try {
        const json = await file.text();
        const preview = await send<{ count: number }>({
          command: MessageCommand.PreviewBackup,
          json,
          password,
        });
        importPreview = { name: file.name, size: file.size, lastModified: file.lastModified };
        const box = $('m-import-preview');
        box.textContent =
          `${file.name}: ${preview.count} nodes — Confirm import replaces your local ` +
          `bookmarks and pushes to the service (a safety snapshot is taken first).`;
        box.hidden = false;
        ($('m-btn-import-confirm') as HTMLButtonElement).disabled = false;
      } catch (err) {
        input('m-backup-password').value = '';
        (e.target as HTMLInputElement).value = '';
        sectionError('backup-error', (err as Error).message);
      }
    });
  });
  $('m-btn-import-confirm').addEventListener('click', () =>
    withBusy('m-btn-import-confirm', 'Importing…', async () => {
      hideErrors();
      const fileEl = $('m-import-file') as HTMLInputElement;
      const file = fileEl.files?.[0];
      const password = input('m-backup-password').value;
      if (
        !file ||
        !importPreview ||
        importPreview.name !== file.name ||
        importPreview.size !== file.size ||
        importPreview.lastModified !== file.lastModified
      ) {
        sectionError('backup-error', 'File changed since the preview — choose it again.');
        return;
      }
      if (
        !window.confirm(
          `Import replaces your local bookmarks and pushes to the service. Continue? (Undo is in Status.)`,
        )
      ) {
        return;
      }
      try {
        const json = await file.text();
        const res = await send<{ count: number; safety: string }>({
          command: MessageCommand.ImportBackup,
          json,
          password,
        });
        input('m-backup-password').value = '';
        fileEl.value = '';
        importPreview = undefined;
        ($('m-import-preview') as HTMLElement).hidden = true;
        ($('m-btn-import-confirm') as HTMLButtonElement).disabled = true;
        showResult(
          'backup-result',
          `Imported ${res.count} nodes and pushed to the service (safety: ${res.safety} — see Safety backups below).`,
        );
        await refreshSafety();
      } catch (err) {
        // Never leave a failed password in the DOM.
        input('m-backup-password').value = '';
        sectionError('backup-error', (err as Error).message);
      }
    }),
  );
  $('m-btn-safety').addEventListener('click', () => withBusy('m-btn-safety', 'Loading…', () => refreshSafety()));
}

/** File the current import preview was made for — confirm requires identity. */
let importPreview: { name: string; size: number; lastModified: number } | undefined;

const SafetyOperations: Record<string, string> = {
  'take-remote': 'link: took remote',
  'upload-local': 'link: uploaded local',
  'create-empty': 'link: created empty',
  'import-backup': 'backup import',
  'change-password': 'password change',
  'switch-take-remote': 'move: took remote',
  'switch-upload': 'move: uploaded local',
  'duplicates-cleanup': 'duplicates cleanup',
  'pre-restore': 'pre-restore snapshot',
  restore: 'restore',
  'delete-remote': 'server delete',
  'merge-local': 'merge: local side',
  'merge-remote': 'merge: server side',
};

async function refreshSafety(): Promise<void> {
  const box = $('m-safety-list');
  box.textContent = '';
  let entries: SafetyEntry[] = [];
  try {
    entries = await send<SafetyEntry[]>({ command: MessageCommand.GetSafetyList });
  } catch (err) {
    sectionError('backup-error-2', (err as Error).message);
    return;
  }
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No safety backups yet — one is taken before every destructive step.';
    box.append(p);
    return;
  }
  const ul = document.createElement('ul');
  for (const entry of entries) {
    const li = document.createElement('li');
    const when = new Date(entry.createdAtUtc).toLocaleString();
    const what = SafetyOperations[entry.operation] ?? entry.operation;
    const side = entry.side === 'local' ? 'local tree' : 'server copy';
    li.textContent =
      `${when} · ${what} · ${side} · ${entry.items} items · ${formatBytes(entry.sizeBytes)} · ` +
      `sync ${entry.syncId} · ${entry.enc ? 'encrypted' : 'not encrypted'} `;
    const restore = document.createElement('button');
    restore.textContent = 'Restore';
    restore.className = 'mini';
    restore.setAttribute('aria-label', `Restore safety backup ${entry.fileName}`);
    restore.addEventListener('click', () => {
      hideErrors();
      if (!window.confirm(`Restore ${entry.fileName}? Current state is snapshotted first.`)) return;
      restore.disabled = true;
      send<{ count: number; safety: string }>({ command: MessageCommand.RestoreSafety, fileName: entry.fileName })
        .then((res) => {
          showResult(
            'backup-result',
            `Restored ${res.count} nodes (pre-restore snapshot: ${res.safety}).`,
          );
          void refreshSafety();
          void refreshStatus();
        })
        .catch((err: Error) => sectionError('backup-error-2', err.message))
        .finally(() => {
          restore.disabled = false;
        });
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'mini danger';
    del.setAttribute('aria-label', `Delete safety backup ${entry.fileName}`);
    del.addEventListener('click', () => {
      hideErrors();
      if (!window.confirm(`Delete safety backup ${entry.fileName}? This cannot be undone.`)) return;
      del.disabled = true;
      send({ command: MessageCommand.DeleteSafety, fileName: entry.fileName })
        .then(() => {
          showResult('backup-result', `Deleted ${entry.fileName}.`);
          void refreshSafety();
        })
        .catch((err: Error) => sectionError('backup-error-2', err.message))
        .finally(() => {
          del.disabled = false;
        });
    });
    li.append(restore, ' ', del);
    ul.append(li);
  }
  box.append(ul);
}

let dupSeq = 0;
/** Groups from the last scan (drives Delete-all). */
let lastDupGroups: DuplicateGroup[] = [];

/** Copies marked for deletion in the current scan (default: all but newest). */
let dupMarked: Set<number> = new Set();

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
    sectionError('dup-error', (err as Error).message);
    return;
  }
  if (my !== dupSeq) return;
  lastDupGroups = groups;
  dupMarked = defaultMarkedIds(groups);
  if (groups.length === 0) {
    box.innerHTML = '<p class="clean">No duplicates — everything is clean ✓</p>';
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
  btn.disabled = dupMarked.size === 0;
  btn.textContent = dupMarked.size > 0 ? `Delete marked (${dupMarked.size})` : 'Delete marked';
}

function renderDuplicates(): void {
  const box = $('m-dup-list');
  box.textContent = '';
  for (const group of lastDupGroups) {
    const div = document.createElement('div');
    div.className = 'dup-group';
    const head = document.createElement('div');
    // Show an original URL when normalization merged variants (tracking
    // params, case): the grouped key alone confuses ("which one is it?").
    const sample = group.entries[0]?.url;
    head.textContent =
      sample && sample !== group.url
        ? `${sample} (+ variants, grouped as ${group.url})`
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
        marked ? `Unmark deletion of ${entry.title ?? group.url}` : locked ? 'Always kept copy' : `Mark ${entry.title ?? group.url} for deletion`,
      );
      toggle.title = locked ? 'Always kept — unmark another copy first' : toggle.getAttribute('aria-label')!;
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = marked ? '✕' : locked ? '🔒' : '';
      toggle.append(glyph);
      toggle.addEventListener('click', () => {
        hideErrors();
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
      path.textContent = entry.path;
      text.append(path);
      row.append(toggle, text);
      div.append(row);
    }
    // Per-group armed delete (two-step, like the Android client).
    const footer = document.createElement('div');
    footer.className = 'row';
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = markedHere.length > 0 ? `Delete ${markedHere.length} marked` : 'Delete marked';
    del.disabled = markedHere.length === 0;
    del.addEventListener('click', () => {
      hideErrors();
      if (
        !window.confirm(
          `Delete ${markedHere.length} marked cop${markedHere.length === 1 ? 'y' : 'ies'} from this address? One copy always stays. A safety snapshot is taken first.`,
        )
      ) {
        return;
      }
      del.disabled = true;
      send<{ deleted: number; safety: string }>({
        command: MessageCommand.RemoveDuplicates,
        ids: markedHere.map((e) => e.id),
      })
        .then((res) => {
          showResult(
            'dup-result',
            `Deleted ${res.deleted} duplicates (safety: ${res.safety} — see Backup → Safety backups).`,
          );
          void scanDuplicates();
        })
        .catch((err: Error) => {
          sectionError('dup-error-2', err.message);
          del.disabled = false;
        });
    });
    footer.append(del);
    div.append(footer);
  }
}

function initDuplicatesSection(): void {
  $('m-btn-duplicates').addEventListener('click', () =>
    withBusy('m-btn-duplicates', 'Scanning…', () => scanDuplicates()),
  );
  $('m-btn-duplicates-delete-all').addEventListener('click', () =>
    withBusy('m-btn-duplicates-delete-all', 'Deleting…', async () => {
      hideErrors();
      const ids = [...dupMarked];
      if (ids.length === 0) return;
      if (
        !window.confirm(
          `Delete ${ids.length} marked duplicates in one push? One copy of each address stays. A safety snapshot is taken first — see Backup → Safety backups.`,
        )
      ) {
        return;
      }
      try {
        const res = await send<{ deleted: number; safety: string }>({
          command: MessageCommand.RemoveDuplicates,
          ids,
        });
        showResult(
          'dup-result',
          `Deleted ${res.deleted} duplicates (safety: ${res.safety} — see Backup → Safety backups).`,
        );
        await scanDuplicates();
      } catch (err) {
        sectionError('dup-error', (err as Error).message);
      }
    }),
  );
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
  $('m-switch-password-label').textContent = mode === 'new' ? 'New password' : 'Target sync password';
  $('m-switch-confirm-label').textContent = mode === 'new' ? 'Confirm password' : 'Confirm target password';
  // Confirm row only when inventing a password (new mode). In existing
  // mode the password is verify-before-mutate: a typo fails safely as
  // InvalidCredentials, so no confirmation is asked.
  ($('m-switch-confirm-row') as HTMLElement).hidden = mode !== 'new';
  preview = undefined;
  previewFor = undefined;
  mergeStats = undefined;
  $('m-btn-switch').toggleAttribute('disabled', true);
  ($('move-gate-hint') as HTMLElement).hidden = false;
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
      ? `Will create a new sync on ${url} and upload ${n ?? 'your'} bookmarks. No sync ID needed — a new one is shown after the move.`
      : direction === 'push'
        ? `Will overwrite the remote sync on ${url} with ${n ?? 'your'} local bookmarks.`
        : direction === 'merge'
          ? `Will union local and remote bookmarks on ${url} (never deletes; preview at step 1).`
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
  const urlErr = validateServiceUrl(newServiceUrl);
  if (urlErr) {
    sectionError('move-error', urlErr);
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
      // Pin what the preview was made for; submitMove() refuses stale previews.
      previewFor = { newServiceUrl, mode, syncId, direction: switchDirection() };
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
      // Merge direction: dry-run the union so the user sees exactly what
      // will upload/download before the Move button unlocks. Needs the
      // target password (already in the form for the submit step).
      mergeStats = undefined;
      if (mode === 'existing' && switchDirection() === 'merge' && preview.remoteExists) {
        const mergePassword = input('m-switch-password').value;
        if (!mergePassword) {
          box.textContent = lines.join('\n') + '\nEnter the target password above, then Check target again for the merge preview.';
          box.hidden = false;
          ($('m-btn-switch') as HTMLButtonElement).disabled = true;
          ($('move-gate-hint') as HTMLElement).hidden = false;
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
            `Merge preview (never deletes): ${mergeStats.localOnly} local will upload (of ${mergeStats.localCount}), ` +
              `${mergeStats.remoteOnly} remote will download (of ${mergeStats.remoteCount}), ` +
              `${mergeStats.titleConflicts} title conflicts (server title kept), ` +
              `${mergeStats.foldersCreated} folders created, ${mergeStats.separatorsAdopted} separators kept from both sides. ` +
              `Items deleted on one side while offline will reappear.`,
          );
        } catch (err) {
          sectionError('move-error', (err as Error).message);
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
    ($('m-btn-switch') as HTMLButtonElement).disabled = !ok;
    // The gate hint doubles as the enable signal: hidden only when the
    // button actually unlocked.
    ($('move-gate-hint') as HTMLElement).hidden = ok;
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
    sectionError('move-error-2', invalid);
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
    sectionError('move-error-2', 'Inputs changed since the check — press “Check target” again.');
    return;
  }
  // Set on success so the post-busy gate below knows the preview was spent.
  let movedId: string | undefined;
  await withBusy('m-btn-switch', 'Moving…', async () => {
    ($('move-result') as HTMLElement).hidden = true;
    try {
      if (direction === 'merge') {
        // Merge executes on explicit per-counts confirmation: the union never
        // deletes, but resurrects items deleted while offline — say so first.
        const s = mergeStats;
        const summary = s
          ? `${s.localOnly} local will upload, ${s.remoteOnly} remote will download, ` +
            `${s.titleConflicts} title conflicts (server title kept).`
          : 'Merge preview unavailable — press “Check target” again.';
        if (!s) {
          sectionError('move-error-2', summary);
          return;
        }
        if (
          !window.confirm(
            `Merge keeps everything from both sides and never deletes.\n\n${summary}\n\n` +
              `Items deleted on one side while offline will reappear. Continue?`,
          )
        ) {
          return;
        }
      }
      const res = await send<{ id: string }>({
        command: MessageCommand.SwitchService,
        switch: { newServiceUrl, mode, syncId, newPassword, direction },
      });
      input('m-switch-password').value = '';
      input('m-switch-confirm').value = '';
      movedId = res.id;
    } catch (err) {
      input('m-switch-confirm').value = '';
      sectionError('move-error-2', (err as Error).message);
    }
  });
  if (movedId) {
    // Consume the preview AFTER withBusy (it restores the pre-click state
    // last): the unlocked button must never re-fire with stale inputs.
    updateMoveForm();
    // Contextual success: restate WHAT ran (mode + direction + target), not
    // just the new id — the wizard offers four different outcomes.
    const done = describeMoveResult({ mode, direction, newServiceUrl, syncId });
    showResult('move-result', `${done} New sync ID: ${movedId}`);
    const copy = document.createElement('button');
    copy.textContent = 'Copy ID';
    copy.className = 'mini';
    copy.setAttribute('aria-label', 'Copy the new sync ID');
    copy.addEventListener('click', () => void copyText(movedId!, 'Copy sync ID:'));
    $('move-result').append(' ', copy);
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
  $('m-btn-logs').addEventListener('click', () =>
    withBusy('m-btn-logs', 'Loading…', () => refreshLogs()),
  );
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
  const toolbar = await send<{ enabled: boolean }>({ command: MessageCommand.GetToolbarSync }).catch(() => ({
    enabled: true,
  }));
  (input('m-opt-toolbar') as HTMLInputElement).checked = toolbar.enabled;
  const level = st?.logLevel ?? 2;
  ($('m-opt-verbosity') as HTMLSelectElement).value = String(level);
}

function initSettingsSection(): void {
  (input('m-opt-toolbar') as HTMLInputElement).addEventListener('change', (e) => {
    void send({ command: MessageCommand.SetToolbarSync, enabled: (e.target as HTMLInputElement).checked }).catch(
      (err: Error) => sectionError('settings-error', err.message),
    );
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
  $('about-api12').textContent = `v${ApiVersion12}`;
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
        `App version: ${version}\nAPI version: ${ApiVersion} / ${ApiVersion12}\nSync format: ${SyncClientVersion}\n\nDescribe the issue:\n`,
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
