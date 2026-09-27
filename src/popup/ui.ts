// Shared popup/manager UI helpers: messaging, DOM, busy buttons, formatting,
// and the status-card renderer (single source of truth for both surfaces).

import browser from 'webextension-polyfill';
import { DefaultServiceUrl } from '../shared/constants.js';
import {
  fromWireError,
  type MessagePayload,
  type MessageResponse,
  type PingResponse,
  type StatusResponse,
} from '../shared/messages.js';

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

export async function send<T>(msg: MessagePayload): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as MessageResponse;
  if (!res || typeof res !== 'object' || !('ok' in res)) {
    throw new Error('Background did not respond.');
  }
  if (!res.ok) throw fromWireError({ errorName: (res as { errorName: string }).errorName, message: (res as { message: string }).message });
  return (res as { data?: T }).data as T;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Disable a button with a busy label while an async action runs. The
 * previous disabled state is restored (never force-enabled): gating such as
 * the v1.2-only delete or the move-wizard preview lock must survive. */
export async function withBusy(buttonId: string, busyLabel: string, fn: () => Promise<void>): Promise<void> {
  const btn = $(buttonId) as HTMLButtonElement;
  const original = btn.textContent;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.disabled = wasDisabled;
    btn.textContent = original;
  }
}

export interface StatusView {
  status: StatusResponse | undefined;
  ping: PingResponse | undefined;
}

function setPill(pill: HTMLElement, text: string, kind: 'ok' | 'warn' | 'bad' | 'busy'): void {
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

/** Meter fill + progressbar value stay in sync (screen readers read the value). */
function setMeter(prefix: string, used: number, max: number | undefined): void {
  const fill = document.getElementById(`${prefix}-space-fill`);
  if (!fill) return;
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  // Exact legacy format: bare '0%' without a quota, one decimal with one.
  (fill as HTMLElement).style.width = max ? `${pct.toFixed(1)}%` : '0%';
  fill.parentElement?.setAttribute('aria-valuenow', String(Math.round(pct)));
}

/** Render the status card into elements with the given id prefix. */
export function renderStatusCard(prefix: string, view: StatusView): void {
  const { status, ping } = view;
  const pill = $(`${prefix}-pill`);
  const badge = $(`${prefix}-service-badge`);
  // Service version row is optional (older test mounts lack it).
  const swversion = document.getElementById(`${prefix}-swversion`);
  if (!status?.syncEnabled) {
    setPill(pill, 'Not connected', 'bad');
    badge.textContent = '—';
    badge.className = 'badge';
    $(`${prefix}-server`).textContent = '—';
    $(`${prefix}-syncid`).textContent = '—';
    $(`${prefix}-last`).textContent = '—';
    $(`${prefix}-space`).textContent = '—';
    setMeter(prefix, 0, undefined);
    if (swversion) swversion.textContent = '—';
    const countEl = document.getElementById(`${prefix}-count`);
    if (countEl) countEl.textContent = '—';
    return;
  }
  const serviceUrl = status.serviceUrl ?? DefaultServiceUrl;
  $(`${prefix}-server`).textContent = serviceUrl;
  if (swversion) swversion.textContent = status.serviceVersion ?? ping?.version ?? '—';
  const official = serviceUrl.replace(/\/+$/, '') === DefaultServiceUrl;
  // Stored flag is the offline fallback: without it an unreachable service
  // would flicker the contract suffix on every failed probe.
  const v12 = ping?.supportsV12 ?? status?.supportsV12 ?? false;
  const contract = v12 ? ' · API v1.2' : '';
  badge.textContent = `${official ? 'Official service' : 'Custom service'}${contract}`;
  badge.className = `badge ${official ? 'official' : 'custom'}`;
  $(`${prefix}-syncid`).textContent = status.syncId ?? '—';
  $(`${prefix}-last`).textContent = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : '—';

  const used = status.usedBytes ?? 0;
  const max = ping?.maxSyncSize;
  $(`${prefix}-space`).textContent = max ? `${formatBytes(used)} of ${formatBytes(max)}` : formatBytes(used);
  setMeter(prefix, used, max);
  if (status.bookmarkCount !== undefined) {
    const countEl = document.getElementById(`${prefix}-count`);
    if (countEl) countEl.textContent = `${status.bookmarkCount} bookmarks`;
  }

  // Reachability first: a queued-but-offline client is Offline, not Syncing.
  if (ping && !ping.reachable) {
    setPill(pill, 'Offline', 'bad');
  } else if (status.syncing || status.queueLength > 0) {
    setPill(pill, 'Syncing…', 'busy');
  } else if (!ping) {
    setPill(pill, 'Checking…', 'busy');
  } else if (ping.remoteLastUpdated && status.lastUpdated && ping.remoteLastUpdated !== status.lastUpdated) {
    setPill(pill, 'Behind', 'warn');
  } else {
    setPill(pill, 'Synced', 'ok');
  }
}

export async function copyText(text: string, fallbackLabel: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt(fallbackLabel, text);
  }
}

/** v1.2 gating for v1.2-only UI (e.g. server delete). Pure for testability.
 * Live probe wins; the stored link flag is the offline fallback. Legacy (or
 * unknown) services get the button disabled plus the reason. */
export interface ContractGate {
  /** Whether the v1.2-only action may run. */
  enabled: boolean;
  /** Button tooltip when disabled. */
  title: string;
  /** Whether to hide the "requires v1.2" hint. */
  hintHidden: boolean;
  /** Contract badge text (empty when unlinked). */
  badge: string;
}

export function contractGate(input: {
  liveV12?: boolean;
  storedV12?: boolean;
  syncEnabled: boolean;
}): ContractGate {
  const v12 = input.liveV12 ?? input.storedV12 ?? false;
  return {
    enabled: v12,
    title: v12 ? '' : 'Not supported (requires service v1.2)',
    hintHidden: v12 || !input.syncEnabled,
    badge: !input.syncEnabled ? '' : v12 ? 'API v1.2' : 'API v1.1',
  };
}

/** Contextual wizard success (pure helper lives in shared/sync.ts so the
 * background completion notice uses the same words; re-exported here for
 * the popup/manager surfaces). */
export { describeMoveResult } from '../shared/sync.js';

/** Human-readable undo slot description for banners. */
export function describeUndo(kind: string, count: number | undefined, when: number): string {
  const what =
    kind === 'connect-new'
      ? 'created a new sync'
      : kind === 'connect-pull'
        ? 'downloaded the server copy'
        : kind === 'connect-push'
          ? 'uploaded over the server copy'
          : kind === 'connect-merge'
            ? 'merged local and server bookmarks'
            : kind === 'switch-new'
              ? 'moved to a new sync'
            : kind === 'switch-pull'
              ? 'moved and downloaded the server copy'
              : kind === 'switch-push'
                ? 'moved and uploaded over the server copy'
                : kind === 'switch-merge'
                  ? 'moved and merged with the server copy'
                  : kind === 'change-password'
                  ? 'changed the sync password'
                  : kind === 'restore'
                    ? 'restored bookmarks'
                    : kind === 'duplicates'
                      ? 'deleted duplicates'
                      : 'imported a backup';
  const n = count !== undefined ? ` (${count} bookmarks)` : '';
  return `Last action: ${what}${n} at ${new Date(when).toLocaleString()}. Undo restores the previous state.`;
}

/** Service URL check: https always; http only for loopback (local dev/E2E). */
export function validateServiceUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return 'Service URL is required.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Service URL is not a valid URL.';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return null;
  return 'Service URL must use https (http is allowed only for localhost).';
}

/** Pure connect-form validation (foolproof rules). Null = valid. */
export function validateConnect(input: {
  mode: 'new' | 'existing';
  direction: 'pull' | 'push' | 'merge';
  serviceUrl: string;
  syncId: string;
  password: string;
  confirm: string;
  pushConfirmed: boolean;
}): string | null {
  const urlErr = validateServiceUrl(input.serviceUrl);
  if (urlErr) return urlErr;
  if (!input.password) return 'Password is required.';
  if (input.mode === 'new') {
    if (input.password !== input.confirm) return 'Passwords do not match.';
    return null;
  }
  if (!input.syncId.trim()) return 'Sync ID is required for an existing sync.';
  if (input.direction === 'push' && !input.pushConfirmed) {
    return 'Tick the confirmation to overwrite the server copy.';
  }
  return null;
}

/** Pure password-change validation. Null = valid. */
export function validatePasswordChange(input: { current: string; next: string; confirm: string }): string | null {
  if (!input.current) return 'Current password is required.';
  if (!input.next) return 'A new password is required.';
  if (input.next === input.current) return 'The new password must be different from the current one.';
  if (input.next !== input.confirm) return 'New passwords do not match.';
  return null;
}

/** Pure move-wizard validation. Null = valid. */
export function validateSwitch(input: {
  mode: 'new' | 'existing';
  newServiceUrl: string;
  syncId?: string;
  newPassword: string;
  confirm: string;
}): string | null {
  const urlErr = validateServiceUrl(input.newServiceUrl);
  if (urlErr) return urlErr;
  if (!input.newPassword) {
    return input.mode === 'new' ? 'A new password is required.' : 'The target sync password is required.';
  }
  // Confirm only when inventing a password (new mode): a typo there locks
  // you out of the fresh sync. In existing mode the password is verified by
  // decrypting the target BEFORE anything mutates — a typo fails safely as
  // InvalidCredentials with zero side effects, so no confirmation needed.
  if (input.mode === 'new' && input.newPassword !== input.confirm) return 'Passwords do not match.';
  if (input.mode === 'existing' && !input.syncId?.trim()) {
    return 'Sync ID is required for an existing sync.';
  }
  return null;
}
