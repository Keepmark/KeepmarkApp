// Storage keys + backend abstraction. Port of app/store.enum.ts and the
// webext-store idea, but on browser.storage.local (MV2 and MV3 compatible).
// All storage keys belong here — never scatter string literals.

export enum StoreKey {
  AlternateSearchBarPosition = 'alternateSearchBarPosition',
  AutoFetchMetadata = 'autoFetchMetadata',
  AutoBackUpSchedule = 'autoBackUpSchedule',
  BookmarkIdMappings = 'bookmarkIdMappings',
  Bookmarks = 'bookmarks',
  CheckForAppUpdates = 'checkForAppUpdates',
  DarkModeEnabled = 'darkModeEnabled',
  DisplayHelp = 'displayHelp',
  DisplayOtherSyncsWarning = 'displayOtherSyncsWarning',
  DisplayPermissions = 'displayPermissions',
  DisplayTelemetryCheck = 'displayTelemetryCheck',
  DisplayUpdated = 'displayUpdated',
  DefaultToFolderView = 'defaultToFolderView',
  InstallBackup = 'installBackup',
  InstallationId = 'installationId',
  LastUpdated = 'lastUpdated',
  LastUpgradeVersion = 'lastUpgradeVersion',
  RemovedSync = 'removedSync',
  SyncBookmarksToolbar = 'syncBookmarksToolbar',
  SyncEnabled = 'syncEnabled',
  SyncInfo = 'syncInfo',
  TelemetryEnabled = 'telemetryEnabled',
  TraceLog = 'traceLog',
}

/** Persisted sync credentials. password holds the derived key, never the raw password. */
export interface SyncInfo {
  id?: string;
  password?: string;
  serviceUrl?: string;
  version?: string;
}

/** Minimal async key/value backend. */
export interface KeyValueBackend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const defaults = new Map<StoreKey, unknown>([
  [StoreKey.SyncEnabled, false],
  [StoreKey.SyncBookmarksToolbar, true],
  [StoreKey.DarkModeEnabled, false],
  [StoreKey.BookmarkIdMappings, []],
]);

export class Store {
  constructor(private backend: KeyValueBackend) {}

  async get<T>(key: StoreKey): Promise<T | undefined> {
    const value = await this.backend.get<T>(key);
    if (value !== undefined) return value;
    return defaults.get(key) as T | undefined;
  }

  set(key: StoreKey, value: unknown): Promise<void> {
    return this.backend.set(key, value);
  }

  remove(key: StoreKey): Promise<void> {
    return this.backend.remove(key);
  }
}

/** In-memory backend for tests and non-extension contexts. */
export class MemoryBackend implements KeyValueBackend {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/**
 * browser.storage.local backend. The storage area is injected so the module
 * never imports webextension-polyfill directly (keeps unit tests DOM-free).
 */
export class BrowserLocalBackend implements KeyValueBackend {
  constructor(
    private area: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    },
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.area.get(key);
    return result[key] as T | undefined;
  }

  set(key: string, value: unknown): Promise<void> {
    return this.area.set({ [key]: value }).then(() => undefined);
  }

  remove(key: string): Promise<void> {
    return this.area.remove(key).then(() => undefined);
  }
}
