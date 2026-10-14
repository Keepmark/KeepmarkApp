// Storage keys + backend abstraction. Port of app/store.enum.ts and the
// webext-store idea, but on browser.storage.local (MV2 and MV3 compatible).
// All storage keys belong here — never scatter string literals.

export enum StoreKey {
  AlternateSearchBarPosition = 'alternateSearchBarPosition',
  AutoFetchMetadata = 'autoFetchMetadata',
  AutoBackUpSchedule = 'autoBackUpSchedule',
  BookmarkIdMappings = 'bookmarkIdMappings',
  /** Pending sync conflict (encrypted local tree + remote base seen), persisted
   *  so MV3 worker sleeps / browser restarts never lose it. */
  ConflictState = 'conflictState',
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
  LogVerbosity = 'logVerbosity',
  /** Native root folder ids the id mappings were built against (Chromium
   *  roots move when the browser switches local/account bookmark storage). */
  NativeRootKey = 'nativeRootKey',
  RemovedSync = 'removedSync',
  SyncBookmarksToolbar = 'syncBookmarksToolbar',
  SyncEnabled = 'syncEnabled',
  SyncHash = 'syncHash',
  SyncInfo = 'syncInfo',
  SyncRevision = 'syncRevision',
  /** Safety-backup manifest (index rows; payloads live under safetyFileKey). */
  SafetyIndex = 'safetyIndex',
  TelemetryEnabled = 'telemetryEnabled',
  TraceLog = 'traceLog',
  UndoSlot = 'undoSlot',
  /** UI language: 'system' (browser UI language) or a Lang code. */
  UiLanguage = 'uiLanguage',
}

/** Persisted sync credentials. password holds the derived key, never the raw password. */
export interface SyncInfo {
  id?: string;
  password?: string;
  serviceUrl?: string;
  version?: string;
  /** Last-known service API version (link-time probe, refreshed by ping). */
  serviceVersion?: string;
  /**
   * Whether the linked service speaks the v1.2 extended contract (probed at
   * link time, refreshed by ping/preview). Gates every v1.2-only feature in
   * the UI — undefined means "not probed yet", treated as legacy.
   */
  supportsV12?: boolean;
}

/** Minimal async key/value backend. */
export interface KeyValueBackend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Keys starting with prefix (for indexed payloads like safety files). */
  list(prefix: string): Promise<string[]>;
}

const defaults = new Map<StoreKey, unknown>([
  [StoreKey.SyncEnabled, false],
  [StoreKey.SyncBookmarksToolbar, true],
  [StoreKey.DarkModeEnabled, false],
  [StoreKey.BookmarkIdMappings, []],
  [StoreKey.UiLanguage, 'system'],
]);

export class Store {
  constructor(private backend: KeyValueBackend) {}

  // Fixed keys come from the StoreKey enum; dynamic payload keys (safety
  // files) go through the safetyFileKey helper — same backend, no literals.
  async get<T>(key: StoreKey | string): Promise<T | undefined> {
    const value = await this.backend.get<T>(key);
    // storage.local may resolve null for removed keys: fall back to defaults.
    if (value !== undefined && value !== null) return value;
    return defaults.get(key as StoreKey) as T | undefined;
  }

  set(key: StoreKey | string, value: unknown): Promise<void> {
    return this.backend.set(key, value);
  }

  remove(key: StoreKey | string): Promise<void> {
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

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** Payload key for one safety file. Single helper (not enum members):
 * per-file keys are dynamic by nature; the prefix is the fixed contract. */
export const safetyFilePrefix = 'safetyFile:';

export function safetyFileKey(fileName: string): string {
  return `${safetyFilePrefix}${fileName}`;
}

/**
 * browser.storage.local backend. The storage area is injected so the module
 * never imports webextension-polyfill directly (keeps unit tests DOM-free).
 */
export class BrowserLocalBackend implements KeyValueBackend {
  constructor(
    private area: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    },
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.area.get(key);
    return result[key] as T | undefined;
  }

  async list(prefix: string): Promise<string[]> {
    // get(null) returns the whole area; filtered client-side.
    const all = await this.area.get(null);
    return Object.keys(all).filter((k) => k.startsWith(prefix));
  }

  set(key: string, value: unknown): Promise<void> {
    return this.area.set({ [key]: value }).then(() => undefined);
  }

  remove(key: string): Promise<void> {
    return this.area.remove(key).then(() => undefined);
  }
}
