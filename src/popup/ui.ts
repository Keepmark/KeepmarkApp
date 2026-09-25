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

/** Disable a button with a busy label while an async action runs. */
export async function withBusy(buttonId: string, busyLabel: string, fn: () => Promise<void>): Promise<void> {
  const btn = $(buttonId) as HTMLButtonElement;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.disabled = false;
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

/** Render the status card into elements with the given id prefix. */
export function renderStatusCard(prefix: string, view: StatusView): void {
  const { status, ping } = view;
  const pill = $(`${prefix}-pill`);
  const badge = $(`${prefix}-service-badge`);
  if (!status?.syncEnabled) {
    setPill(pill, 'Not connected', 'bad');
    return;
  }
  const serviceUrl = status.serviceUrl ?? DefaultServiceUrl;
  $(`${prefix}-server`).textContent = serviceUrl;
  const official = serviceUrl.replace(/\/+$/, '') === DefaultServiceUrl;
  badge.textContent = official ? 'Official service' : 'Custom service';
  badge.className = `badge ${official ? 'official' : 'custom'}`;
  $(`${prefix}-syncid`).textContent = status.syncId ?? '—';
  $(`${prefix}-last`).textContent = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : '—';

  const used = status.usedBytes ?? 0;
  const max = ping?.maxSyncSize;
  $(`${prefix}-space`).textContent = max ? `${formatBytes(used)} of ${formatBytes(max)}` : formatBytes(used);
  ($(`${prefix}-space-fill`) as HTMLElement).style.width = max
    ? `${Math.min(100, (used / max) * 100).toFixed(1)}%`
    : '0%';
  if (status.bookmarkCount !== undefined) {
    const countEl = document.getElementById(`${prefix}-count`);
    if (countEl) countEl.textContent = `${status.bookmarkCount} bookmarks`;
  }

  if (status.syncing || status.queueLength > 0) {
    setPill(pill, 'Syncing…', 'busy');
  } else if (!ping) {
    setPill(pill, 'Checking…', 'busy');
  } else if (!ping.reachable) {
    setPill(pill, 'Offline', 'bad');
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
