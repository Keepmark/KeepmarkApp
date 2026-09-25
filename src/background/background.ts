// Background entry shared by Firefox (MV2 page) and Chromium (MV3 worker).
// The platform adapter resolves through the '@platform' vite alias, set per
// build config. No DOM access here — this also runs as a service worker.

import browser from 'webextension-polyfill';
import { makeAdapter } from '@platform/adapter';
import type { BookmarkApi } from '../shared/native.js';
import { toWireError } from '../shared/messages.js';
import type { MessagePayload } from '../shared/messages.js';
import { BookmarkIdMapper } from '../shared/id-mapper.js';
import { InMemoryLogger } from '../shared/logging.js';
import { BrowserLocalBackend, Store } from '../shared/store.js';
import { BackgroundCore, type CorePorts } from './core.js';

const bookmarksApi = browser.bookmarks as unknown as BookmarkApi;

function addRemove<T>(add: (h: (arg: T) => void) => void, remove: (h: (arg: T) => void) => void) {
  return {
    add: (handler: () => void) => add(() => handler()),
    remove: (handler: () => void) => remove(() => handler()),
  };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function main(): Promise<void> {
  type StorageArea = ConstructorParameters<typeof BrowserLocalBackend>[0];
  const store = new Store(new BrowserLocalBackend(browser.storage.local as unknown as StorageArea));
  const log = new InMemoryLogger();
  const core = new BackgroundCore(
    store,
    new BookmarkIdMapper(store),
    log,
    makeAdapter(bookmarksApi),
    ports(),
  );

  browser.runtime.onMessage.addListener((msg: unknown) => {
    return core
      .handleMessage(msg as MessagePayload)
      .then((data) => ({ ok: true as const, data }))
      .catch((err: unknown) => ({ ok: false as const, ...toWireError(err) }));
  });

  browser.runtime.onInstalled.addListener(() => void core.startup());
  browser.runtime.onStartup?.addListener(() => void core.startup());
  await core.startup();
}

function ports(): CorePorts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = ((browser as any).action ?? (browser as any).browserAction) as
    | {
        setBadgeText(details: { text: string }): Promise<void>;
        setTitle(details: { title: string }): Promise<void>;
        setIcon(details: { path: string }): Promise<void>;
      }
    | undefined;
  return {
    alarms: {
      schedule: (name, periodMinutes) => browser.alarms.create(name, { periodInMinutes: periodMinutes }).then(() => undefined),
      clear: (name) => browser.alarms.clear(name).then(() => undefined),
      once: (name, whenMs) => browser.alarms.create(name, { when: whenMs }).then(() => undefined),
      onAlarm: (cb) => browser.alarms.onAlarm.addListener((alarm) => cb(alarm.name)),
    },
    listeners: {
      created: addRemove(
        (h) => browser.bookmarks.onCreated.addListener(h),
        (h) => browser.bookmarks.onCreated.removeListener(h),
      ),
      changed: addRemove(
        (h) => browser.bookmarks.onChanged.addListener(h),
        (h) => browser.bookmarks.onChanged.removeListener(h),
      ),
      removed: addRemove(
        (h) => browser.bookmarks.onRemoved.addListener(h),
        (h) => browser.bookmarks.onRemoved.removeListener(h),
      ),
      moved: addRemove(
        (h) => browser.bookmarks.onMoved.addListener(h),
        (h) => browser.bookmarks.onMoved.removeListener(h),
      ),
    },
    chrome: {
      setBadge: async (text, title) => {
        if (!action) return;
        const icon = text === '!' ? 'assets/notsynced32.png' : 'assets/synced32.png';
        await action.setIcon({ path: icon }).catch(() => undefined);
        await action.setBadgeText({ text }).catch(() => undefined);
        await action.setTitle({ title }).catch(() => undefined);
      },
      notify: async (title, message) => {
        await browser.notifications
          .create({ type: 'basic', title, message, iconUrl: 'assets/icon48.png' })
          .then(() => undefined)
          .catch(() => undefined);
      },
      download: async (filename, text) => {
        const url = `data:application/json;base64,${toBase64(text)}`;
        await browser.downloads.download({ filename, url, saveAs: false });
      },
    },
  };
}

void main();
