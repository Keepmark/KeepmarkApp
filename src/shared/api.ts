// HTTP client for the xBrowserSync API (v1.1 + v1.2 dual-stack). Port of
// Keepmark.Core/Api/XSyncApiClient.cs (itself a mirror of
// app/api-xbrowsersync.service.ts). One instance per service URL,
// Accept-Version header per request, bodies never logged.
//
// Contract rules (see KeepmarkApi README):
// - v1.1.x (Accept-Version: 1.1.13): frozen legacy shapes, no meta/capabilities.
// - v1.2 (Accept-Version: 1.2.0, opt-in): same endpoints plus
//   meta {revision, hash, size, createdAt}, PUT baseRevision CAS,
//   conditional GET via If-None-Match -> 304, DELETE /bookmarks/:id,
//   capabilities in /info. Legacy servers answer 412 to v1.2-only calls.

import { ApiVersion, ApiVersion12, DefaultHttpTimeoutMs, SyncClientVersion } from './constants.js';
import {
  errorForStatus,
  ServiceOfflineException,
  UnexpectedResponseException,
  UnsupportedVersionException,
  XbsException,
} from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import { sanitizePath } from './logging.js';
import { ServiceStatus } from './models.js';
import type { ApiCapabilities, ServiceInfo } from './models.js';
import { t, type MessageKey } from './i18n.js';

/** v1.2 sync metadata envelope (absent on legacy servers). */
export interface SyncMeta {
  revision?: number;
  hash?: string;
  size?: number;
  createdAt?: string;
}

export interface CreateSyncResponse {
  id?: string;
  lastUpdated?: string;
  version?: string;
  meta?: SyncMeta;
}

export interface GetBookmarksResponse {
  bookmarks?: string;
  version?: string;
  lastUpdated?: string;
  meta?: SyncMeta;
}

export interface LastUpdatedResponse {
  lastUpdated?: string;
}

export interface VersionResponse {
  version?: string;
}

export interface UpdateBookmarksResponse {
  lastUpdated?: string;
  meta?: SyncMeta;
}

export interface ServiceInfoResponse {
  location?: string;
  maxSyncSize: number;
  message?: string;
  status: ServiceStatus;
  version?: string;
  capabilities?: ApiCapabilities;
}

const tr = (key: string): string => t(`api.${key}` as MessageKey);

export type FetchFn = typeof fetch;

export class XSyncApiClient {
  private baseUrl: string;

  constructor(
    serviceUrl: string,
    private log: IXbsLogger,
    // NOTE: never default to the bare `fetch` reference — called detached it
    // loses its Window receiver and Firefox throws "'fetch' called on an
    // object that does not implement interface Window". The wrapper keeps it bound.
    private fetchFn: FetchFn = (...args: Parameters<FetchFn>) => fetch(...args),
    private timeoutMs: number = DefaultHttpTimeoutMs,
  ) {
    this.baseUrl = `${serviceUrl.replace(/\/+$/, '')}/`;
  }

  getInfo(): Promise<ServiceInfoResponse> {
    return this.send<ServiceInfoResponse>('GET', 'info', undefined, (r) => r.status !== undefined && !!r.version);
  }

  /** v1.2 info: capabilities present only on v1.2 services. Never throws
   * UnsupportedVersion — a legacy service answers the legacy shape instead. */
  getInfoV12(): Promise<ServiceInfoResponse> {
    return this.send<ServiceInfoResponse>(
      'GET',
      'info',
      undefined,
      (r) => r.status !== undefined && !!r.version,
      undefined,
      ApiVersion12,
    );
  }

  /**
   * Capability probe: true only when the server advertises the v1.2 revision
   * contract. Any failure (legacy shape without capabilities, 412, offline)
   * means legacy — the caller stays on the v1.1 timestamp path.
   */
  async supportsV12(): Promise<boolean> {
    try {
      const res = await this.getInfoV12();
      return res.capabilities?.revision === true;
    } catch {
      return false;
    }
  }

  async createSync(): Promise<CreateSyncResponse> {
    return this.send<CreateSyncResponse>(
      'POST',
      'bookmarks',
      { version: SyncClientVersion },
      (r) => !!r.id && !!r.lastUpdated && !!r.version,
    );
  }

  /** v1.2 create: the extended shape carries meta (revision starts at 1). */
  async createSyncV12(): Promise<CreateSyncResponse> {
    return this.send<CreateSyncResponse>(
      'POST',
      'bookmarks',
      { version: SyncClientVersion },
      (r) => !!r.id && !!r.lastUpdated && !!r.version,
      undefined,
      ApiVersion12,
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

  /** v1.2 GET: the extended shape carries meta (absent/zeroed for pre-v1.2 syncs). */
  getBookmarksV12(syncId: string): Promise<GetBookmarksResponse> {
    return this.send<GetBookmarksResponse>(
      'GET',
      `bookmarks/${syncId}`,
      undefined,
      (r) => !!r.lastUpdated,
      syncId,
      ApiVersion12,
    );
  }

  /**
   * v1.2 conditional GET: null when the server answers 304 (content hash
   * unchanged). Throws UnsupportedVersionException on legacy services so the
   * caller can fall back to a full GET.
   */
  async getBookmarksIfChanged(syncId: string, knownHash: string): Promise<GetBookmarksResponse | null> {
    const label = sanitizePath('GET bookmarks/{id}', syncId);
    // Quote defensively: a stored hash with pre-existing quotes would never
    // match, silently losing the 304 path (bandwidth only, not correctness).
    const tag = `"${knownHash.replace(/"/g, '')}"`;
    const started = Date.now();
    this.log.log(XbsLogLevel.Info, 'net', `→ START ${label} (If-None-Match)`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.baseUrl + `bookmarks/${syncId}`, {
        method: 'GET',
        headers: {
          'Accept-Version': ApiVersion12,
          'If-None-Match': tag,
        },
        signal: ctrl.signal,
      });
      this.log.log(XbsLogLevel.Info, 'net', `← END ${label} ${res.status} in ${Date.now() - started}ms`);
      if (res.status === 304) return null;
      if (!res.ok) {
        throw errorForStatus(res.status, await readMessage(res), tr);
      }
      const dto = (await res.json()) as GetBookmarksResponse;
      if (!dto || !dto.lastUpdated) throw new UnexpectedResponseException(tr('ErrUnexpectedResponse'));
      return dto;
    } catch (err) {
      if (err instanceof XbsException) throw err;
      throw this.toOffline(label, err);
    } finally {
      clearTimeout(timer);
    }
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

  /**
   * v1.2 revision-based update (atomic CAS on revision instead of the
   * lastUpdated timestamp). Races lose with 409 instead of overwriting.
   */
  updateBookmarksV12(
    syncId: string,
    encryptedBookmarks: string,
    baseRevision: number,
    updateVersion = false,
  ): Promise<UpdateBookmarksResponse> {
    const body = updateVersion
      ? { bookmarks: encryptedBookmarks, baseRevision, version: SyncClientVersion }
      : { bookmarks: encryptedBookmarks, baseRevision };
    return this.send<UpdateBookmarksResponse>(
      'PUT',
      `bookmarks/${syncId}`,
      body,
      (r) => !!r.lastUpdated,
      syncId,
      ApiVersion12,
    );
  }

  /**
   * v1.2-only: delete the server copy of a sync. Legacy services answer 412
   * (UnsupportedVersionException) — the caller must gate this behind
   * supportsV12() and never offer it as a silent fallback.
   */
  async deleteBookmarks(syncId: string): Promise<void> {
    await this.send<Record<string, unknown>>(
      'DELETE',
      `bookmarks/${syncId}`,
      undefined,
      () => true,
      syncId,
      ApiVersion12,
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

  /**
   * Probe used for v1.2 gating: same as checkService but on the extended
   * contract, so capabilities survive shaping. Legacy services return the
   * legacy shape (no capabilities) or 412 — both map to supportsV12=false.
   */
  async checkServiceV12(url = this.baseUrl): Promise<ServiceInfo> {
    const probe = new XSyncApiClient(url, this.log, this.fetchFn, this.timeoutMs);
    try {
      const res = await probe.getInfoV12();
      return {
        location: res.location,
        maxSyncSize: res.maxSyncSize,
        message: res.message,
        status: res.status,
        version: res.version,
        url,
        capabilities: res.capabilities,
      };
    } catch (err) {
      if (err instanceof UnsupportedVersionException) {
        return probe.checkService(url);
      }
      throw err;
    }
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    valid: (r: T) => boolean,
    syncId?: string,
    apiVersion: string = ApiVersion,
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
          'Accept-Version': apiVersion,
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
      // DELETE answers `{}` (possibly an empty body): never fail the shape check.
      const dto = ((await res.json().catch(() => ({}))) ?? {}) as T;
      if (!dto || !valid(dto)) throw new UnexpectedResponseException(tr('ErrUnexpectedResponse'));
      return dto;
    } catch (err) {
      if (err instanceof XbsException) throw err;
      throw this.toOffline(label, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private toOffline(label: string, err: unknown): ServiceOfflineException {
    const aborted =
      err instanceof DOMException && err.name === 'AbortError'
        ? true
        : err instanceof Error && err.name === 'AbortError';
    this.log.log(
      XbsLogLevel.Warning,
      'net',
      aborted ? `← TIMEOUT ${label}` : `← FAIL ${label}: ${(err as Error)?.name ?? 'fetch'}`,
    );
    return new ServiceOfflineException(
      `${tr('ErrServiceOffline')}${err instanceof Error ? ` (${err.name}: ${err.message})` : ''}`,
      { cause: err },
    );
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
