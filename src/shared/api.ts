// HTTP client for the xBrowserSync API v1.1.13. Port of
// Keepmark.Core/Api/XSyncApiClient.cs (itself a mirror of
// app/api-xbrowsersync.service.ts). One instance per service URL,
// Accept-Version header pinned, bodies never logged.

import { ApiVersion, DefaultHttpTimeoutMs, SyncClientVersion } from './constants.js';
import { errorForStatus, ServiceOfflineException, UnexpectedResponseException, XbsException } from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import { sanitizePath } from './logging.js';
import { ServiceStatus } from './models.js';
import type { ServiceInfo } from './models.js';

export interface CreateSyncResponse {
  id?: string;
  lastUpdated?: string;
  version?: string;
}

export interface GetBookmarksResponse {
  bookmarks?: string;
  version?: string;
  lastUpdated?: string;
}

export interface LastUpdatedResponse {
  lastUpdated?: string;
}

export interface VersionResponse {
  version?: string;
}

export interface UpdateBookmarksResponse {
  lastUpdated?: string;
}

export interface ServiceInfoResponse {
  location?: string;
  maxSyncSize: number;
  message?: string;
  status: ServiceStatus;
  version?: string;
}

const STRINGS: Record<string, string> = {
  ErrSyncNotFound: 'Sync not found on this service.',
  ErrInvalidService: 'Not a valid xBrowserSync service.',
  ErrNotAcceptingNewSyncs: 'Service is not accepting new syncs.',
  ErrDailyNewSyncLimit: 'Daily new-sync limit reached.',
  ErrDataOutOfSync: 'Remote changed since last sync; pull before pushing.',
  ErrSyncTooLarge: 'Sync data exceeds the service limit.',
  ErrThrottled: 'Throttled by the service, retry later.',
  ErrServiceOffline: 'Service offline or unreachable.',
  ErrUnexpectedResponse: 'Unexpected response from the service.',
};

const tr = (key: string): string => STRINGS[key] ?? key;

export type FetchFn = typeof fetch;

export class XSyncApiClient {
  private baseUrl: string;

  constructor(
    serviceUrl: string,
    private log: IXbsLogger,
    private fetchFn: FetchFn = fetch,
    private timeoutMs: number = DefaultHttpTimeoutMs,
  ) {
    this.baseUrl = `${serviceUrl.replace(/\/+$/, '')}/`;
  }

  getInfo(): Promise<ServiceInfoResponse> {
    return this.send<ServiceInfoResponse>('GET', 'info', undefined, (r) => r.status !== undefined && !!r.version);
  }

  async createSync(): Promise<CreateSyncResponse> {
    return this.send<CreateSyncResponse>(
      'POST',
      'bookmarks',
      { version: SyncClientVersion },
      (r) => !!r.id && !!r.lastUpdated && !!r.version,
    );
  }

  getBookmarks(syncId: string): Promise<GetBookmarksResponse> {
    return this.send<GetBookmarksResponse>(
      'GET',
      `bookmarks/${syncId}`,
      undefined,
      (r) => !!r.lastUpdated,
      syncId,
    );
  }

  getLastUpdated(syncId: string): Promise<LastUpdatedResponse> {
    return this.send<LastUpdatedResponse>(
      'GET',
      `bookmarks/${syncId}/lastUpdated`,
      undefined,
      (r) => !!r.lastUpdated,
      syncId,
    );
  }

  getVersion(syncId: string): Promise<VersionResponse> {
    return this.send<VersionResponse>(
      'GET',
      `bookmarks/${syncId}/version`,
      undefined,
      (r) => !!r.version,
      syncId,
    );
  }

  updateBookmarks(
    syncId: string,
    encryptedBookmarks: string,
    lastUpdated: string,
    updateVersion = false,
  ): Promise<UpdateBookmarksResponse> {
    const body = updateVersion
      ? { bookmarks: encryptedBookmarks, lastUpdated, version: SyncClientVersion }
      : { bookmarks: encryptedBookmarks, lastUpdated };
    return this.send<UpdateBookmarksResponse>(
      'PUT',
      `bookmarks/${syncId}`,
      body,
      (r) => !!r.lastUpdated,
      syncId,
    );
  }

  /** Probe used at connect time: status + version check is done by the caller. */
  async checkService(url = this.baseUrl): Promise<ServiceInfo> {
    const probe = new XSyncApiClient(url, this.log, this.fetchFn, this.timeoutMs);
    const res = await probe.getInfo();
    return {
      location: res.location,
      maxSyncSize: res.maxSyncSize,
      message: res.message,
      status: res.status,
      version: res.version,
      url,
    };
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    valid: (r: T) => boolean,
    syncId?: string,
  ): Promise<T> {
    const label = sanitizePath(`${method} ${path}`, syncId);
    const started = Date.now();
    this.log.log(XbsLogLevel.Info, 'net', `→ START ${label}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: {
          'Accept-Version': ApiVersion,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      this.log.log(
        XbsLogLevel.Info,
        'net',
        `← END ${label} ${res.status} in ${Date.now() - started}ms`,
      );
      if (!res.ok) {
        throw errorForStatus(res.status, await readMessage(res), tr);
      }
      const dto = (await res.json()) as T;
      if (!dto || !valid(dto)) throw new UnexpectedResponseException(tr('ErrUnexpectedResponse'));
      return dto;
    } catch (err) {
      if (err instanceof XbsException) throw err;
      const aborted =
        err instanceof DOMException && err.name === 'AbortError'
          ? true
          : err instanceof Error && err.name === 'AbortError';
      this.log.log(
        XbsLogLevel.Warning,
        'net',
        aborted ? `← TIMEOUT ${label}` : `← FAIL ${label}: ${(err as Error)?.name ?? 'fetch'}`,
      );
      throw new ServiceOfflineException(tr('ErrServiceOffline'), { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown };
    return typeof data?.message === 'string' ? data.message : '';
  } catch {
    return '';
  }
}
