// Activation confirm, short after the first time ("Variante 1"). The first
// confirmations show the full explanation plus "Got it, don't repeat this";
// once that box was ticked on a confirmed Activate, later confirmations show
// only "Activate {name}?" with a small info button that expands the same
// text inline. The sync lock password field is never affected: only the
// explanation collapses. The flag is a local preference of this browser
// (StoreKey.ActivateHintSeen, storage.local, never synced).

import browser from 'webextension-polyfill';
import { StoreKey } from '../shared/store.js';

/** Minimal storage.local surface (injected in tests). */
export interface HintStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function defaultStorage(): HintStorage | undefined {
  try {
    return browser.storage?.local as unknown as HintStorage | undefined;
  } catch {
    return undefined;
  }
}

/** Cached flag: confirmations open synchronously, so the value is read at
 *  page start and kept here. Unknown = show the full text. */
let seen = false;

export function activateHintSeen(): boolean {
  return seen;
}

/** Read the flag once per page (call at init). Failures keep the full text. */
export async function loadActivateHintSeen(storage = defaultStorage()): Promise<boolean> {
  try {
    const got = await storage?.get(StoreKey.ActivateHintSeen);
    seen = got?.[StoreKey.ActivateHintSeen] === true;
  } catch {
    seen = false;
  }
  return seen;
}

/** Remember the choice (best effort: a failure only means the full text again). */
export async function markActivateHintSeen(storage = defaultStorage()): Promise<void> {
  seen = true;
  try {
    await storage?.set({ [StoreKey.ActivateHintSeen]: true });
  } catch {
    // keep the in-page value; the next page load shows the full text again
  }
}

/** The dialog's explanation parts, by element id. Missing elements are skipped. */
export interface HintIds {
  hint: string;
  ack: string;
  ackRow: string;
  more: string;
}

const byId = (id: string): HTMLElement | null => document.getElementById(id);

/** Show the full text + checkbox (first times) or the collapsed form. */
export function renderActivateHint(ids: HintIds, collapsed = seen): void {
  const hint = byId(ids.hint);
  const ack = byId(ids.ack) as HTMLInputElement | null;
  const ackRow = byId(ids.ackRow);
  const more = byId(ids.more);
  if (hint) hint.hidden = collapsed;
  if (ack) ack.checked = false;
  if (ackRow) ackRow.hidden = collapsed;
  if (more) {
    more.hidden = !collapsed;
    more.setAttribute('aria-expanded', 'false');
    if (hint) more.setAttribute('aria-controls', ids.hint);
  }
}

/** Info button next to the question: shows / hides the explanation inline. */
export function bindActivateHintToggle(ids: HintIds): void {
  byId(ids.more)?.addEventListener('click', () => {
    const hint = byId(ids.hint);
    const more = byId(ids.more);
    if (!hint || !more) return;
    hint.hidden = !hint.hidden;
    more.setAttribute('aria-expanded', String(!hint.hidden));
  });
}

/** On a confirmed Activate: store the flag when the box is ticked. */
export async function commitActivateHintAck(ids: HintIds, storage = defaultStorage()): Promise<void> {
  const ack = byId(ids.ack) as HTMLInputElement | null;
  const row = byId(ids.ackRow);
  if (ack?.checked && !row?.hidden) await markActivateHintSeen(storage);
}
