// Popup -> full-tab handover of the in-progress connect form. The popup closes
// when the tab opens, so the draft goes through extension storage under one
// short-lived key, read once and cleared on read. It carries the choices and
// typed identifiers only: passwords never leave the page (the tab asks them
// again). The sync ID is a bearer token: it is never logged.

import { StoreKey } from '../shared/store.js';

/** How long a written draft stays valid: the tab opens immediately. */
export const ConnectDraftTtlMs = 60_000;

export interface ConnectDraft {
  mode: 'new' | 'existing';
  direction: 'pull' | 'merge' | 'push';
  serviceUrl: string;
  syncId: string;
  name: string;
  /** The name was typed by the user (never replace it with a suggestion). */
  nameTouched: boolean;
  savedAt: number;
}

/** Subset of a storage area (storage.session preferred, storage.local fallback). */
export interface DraftArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const modes = ['new', 'existing'] as const;
const directions = ['pull', 'merge', 'push'] as const;

function checked(root: ParentNode, name: string): string | undefined {
  return root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
}

function field(root: ParentNode, id: string): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(`#${id}`);
}

/** Read the connect form. Password fields are deliberately not read. */
export function captureConnectDraft(root: ParentNode, nameTouched: boolean, now = Date.now()): ConnectDraft {
  const mode = checked(root, 'conn-mode');
  const direction = checked(root, 'conn-direction');
  return {
    mode: mode === 'existing' ? 'existing' : 'new',
    direction: direction === 'merge' || direction === 'push' ? direction : 'pull',
    serviceUrl: field(root, 'service-url')?.value.trim() ?? '',
    syncId: field(root, 'sync-id')?.value.trim() ?? '',
    name: field(root, 'sync-name')?.value ?? '',
    nameTouched,
    savedAt: now,
  };
}

/** Validate an untrusted stored value; undefined when absent, malformed or expired. */
export function parseConnectDraft(value: unknown, now = Date.now()): ConnectDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!modes.includes(v.mode as ConnectDraft['mode'])) return undefined;
  if (!directions.includes(v.direction as ConnectDraft['direction'])) return undefined;
  if (typeof v.savedAt !== 'number' || now - v.savedAt > ConnectDraftTtlMs || v.savedAt - now > ConnectDraftTtlMs) {
    return undefined;
  }
  const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');
  return {
    mode: v.mode as ConnectDraft['mode'],
    direction: v.direction as ConnectDraft['direction'],
    serviceUrl: text(v.serviceUrl, 2048),
    syncId: text(v.syncId, 256),
    name: text(v.name, 40),
    nameTouched: v.nameTouched === true,
    savedAt: v.savedAt,
  };
}

/** Put the draft into the form (radios + text fields). The caller re-runs its
 *  own mode/direction rendering and service selection afterwards. */
export function applyConnectDraft(root: ParentNode, draft: ConnectDraft): void {
  const radio = (name: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  radio('conn-mode', draft.mode);
  radio('conn-direction', draft.direction);
  const set = (id: string, value: string): void => {
    const el = field(root, id);
    if (el && value) el.value = value;
  };
  set('service-url', draft.serviceUrl);
  set('sync-id', draft.syncId);
  set('sync-name', draft.name);
}

export async function saveConnectDraft(area: DraftArea, draft: ConnectDraft): Promise<void> {
  await area.set({ [StoreKey.ConnectDraft]: draft });
}

/** Read once and clear: a reload or a second tab never sees the draft again.
 *  The key is removed even when the value is stale or malformed. */
export async function takeConnectDraft(area: DraftArea, now = Date.now()): Promise<ConnectDraft | undefined> {
  let raw: unknown;
  try {
    raw = (await area.get(StoreKey.ConnectDraft))[StoreKey.ConnectDraft];
  } catch {
    return undefined;
  }
  try {
    await area.remove(StoreKey.ConnectDraft);
  } catch {
    // best effort: the TTL still expires it
  }
  return parseConnectDraft(raw, now);
}
