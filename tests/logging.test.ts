import { describe, expect, it } from 'vitest';
import { BookmarkIdMapper } from '../src/shared/id-mapper';
import { InMemoryLogger, LogSanitizer, XbsLogLevel } from '../src/shared/logging';
import { MemoryBackend, Store, StoreKey } from '../src/shared/store';
import { BackgroundCore } from '../src/background/core';
import { makeFirefoxAdapter } from '../src/firefox/adapter';
import type { XSyncApiClient } from '../src/shared/api';
import { makeMockApi } from './firefox-bookmarks.test';

describe('LogSanitizer', () => {
  it('redacts key=value secrets', () => {
    expect(LogSanitizer.sanitize('login password=hunter2 ok')).toBe('login password=[redacted] ok');
    expect(LogSanitizer.sanitize('derivedKey: QUJD ok')).toBe('derivedKey=[redacted] ok');
    expect(LogSanitizer.sanitize('blob=QUJDRA== end')).toBe('blob=[redacted] end');
  });

  it('truncates bearer-like sync ids', () => {
    const id = '432a3972-88db-410e-9f73-3e5dbda9d4af';
    expect(LogSanitizer.sanitize(`GET bookmarks/${id}`)).toBe('GET bookmarks/432a…af');
  });

  it('leaves clean messages untouched', () => {
    expect(LogSanitizer.sanitize('Password changed, blob re-encrypted')).toBe(
      'Password changed, blob re-encrypted',
    );
  });
});

describe('InMemoryLogger', () => {
  it('sanitizes every stored entry and honors levels + cap', () => {
    const log = new InMemoryLogger(2);
    log.minLevel = XbsLogLevel.Debug;
    log.log(XbsLogLevel.Info, 'net', 'token password=secret id 432a3972-88db-410e-9f73-3e5dbda9d4af');
    log.log(XbsLogLevel.Debug, 'x', 'a');
    log.log(XbsLogLevel.Debug, 'x', 'b');
    log.log(XbsLogLevel.Debug, 'x', 'c');
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].message).toBe('b');
    log.clear();
    expect(log.entries).toHaveLength(0);
  });
});

describe('verbosity persistence', () => {
  it('startup applies the stored level', async () => {
    const store = new Store(new MemoryBackend());
    await store.set(StoreKey.LogVerbosity, XbsLogLevel.Warning);
    const log = new InMemoryLogger();
    const ports = {
      alarmsFired: [] as string[],
      badges: [] as { text: string; title: string }[],
      notices: [] as { title: string; message: string }[],
      downloads: [] as { filename: string; text: string }[],
      scheduled: [] as { name: string; minutes: number }[],
      onceFired: [] as string[],
      cleared: [] as string[],
      alarms: {
        schedule: async (name: string, minutes: number) => undefined as void,
        clear: async () => undefined,
        once: async () => undefined,
        onAlarm: () => undefined,
      },
      listeners: {
        created: { add: () => undefined, remove: () => undefined },
        changed: { add: () => undefined, remove: () => undefined },
        removed: { add: () => undefined, remove: () => undefined },
        moved: { add: () => undefined, remove: () => undefined },
      },
      chrome: {
        setBadge: async () => undefined,
        notify: async () => undefined,
        download: async () => undefined,
      },
      fireAlarm: () => undefined,
      fireNative: () => undefined,
    };
    const core = new BackgroundCore(
      store,
      new BookmarkIdMapper(store),
      log,
      makeFirefoxAdapter(makeMockApi()),
      ports,
      ((_url: string) => ({}) as unknown as XSyncApiClient) as (url: string) => XSyncApiClient,
      { debounceMs: 5 },
    );
    await core.startup();
    expect(log.minLevel).toBe(XbsLogLevel.Warning);
  });
});
