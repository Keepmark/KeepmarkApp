// Typed failures mapped from HTTP status codes.
// Port of Keepmark.Core/Errors/XbsErrors.cs — mapping mirrors
// getErrorFromHttpResponse in app/api-xbrowsersync.service.ts.

export class XbsException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** 401 — sync ID not found on the service. */
export class SyncNotFoundException extends XbsException {}

/** 404 — not a valid xBrowserSync service. */
export class InvalidServiceException extends XbsException {}

/** 405 — service is not accepting new syncs. */
export class NotAcceptingNewSyncsException extends XbsException {}

/** 406 — daily new-sync limit reached. */
export class DailyNewSyncLimitException extends XbsException {}

/** 409 — remote changed since our lastUpdated; re-pull before pushing. */
export class DataOutOfSyncException extends XbsException {}

/** 412 — the server does not speak the requested API contract (v1.2-only
 * endpoint or Accept-Version on a legacy service). */
export class UnsupportedVersionException extends XbsException {}

/** 413 — encrypted blob exceeds the service maxSyncSize. */
export class SyncTooLargeException extends XbsException {}

/** 429 — throttled by the service. */
export class ThrottledException extends XbsException {}

/** 5xx or unreachable — service considered offline. */
export class ServiceOfflineException extends XbsException {}

/** Decryption failed — almost always a wrong password for the sync ID. */
export class InvalidCredentialsException extends XbsException {}

/** Remote sync format is newer than SyncClientVersion. */
export class UnsupportedSyncVersionException extends XbsException {}

/** Service version is older than MinApiVersion. */
export class UnsupportedApiVersionException extends XbsException {}

/** Sync ID or derived key missing from local storage. */
export class IncompleteSyncInfoException extends XbsException {}

/** Response shape is not what the API contract promises. */
export class UnexpectedResponseException extends XbsException {}

/** Map an HTTP status to the matching typed error (shared by api client + tests). */
export function errorForStatus(status: number, serverMessage: string, local: (key: string) => string): XbsException {
  const withServer = (msg: string): string => {
    const suffix = serverMessage.trim() ? ` (server: ${serverMessage.trim()})` : ` (HTTP ${status})`;
    return `${msg}${suffix}`;
  };
  switch (status) {
    case 401:
      return new SyncNotFoundException(withServer(local('ErrSyncNotFound')));
    case 404:
      return new InvalidServiceException(withServer(local('ErrInvalidService')));
    case 405:
      return new NotAcceptingNewSyncsException(withServer(local('ErrNotAcceptingNewSyncs')));
    case 406:
      return new DailyNewSyncLimitException(withServer(local('ErrDailyNewSyncLimit')));
    case 409:
      return new DataOutOfSyncException(withServer(local('ErrDataOutOfSync')));
    case 412:
      return new UnsupportedVersionException(withServer(local('ErrUnsupportedVersion')));
    case 413:
      return new SyncTooLargeException(withServer(local('ErrSyncTooLarge')));
    case 429:
      return new ThrottledException(withServer(local('ErrThrottled')));
    default:
      return new ServiceOfflineException(withServer(local('ErrServiceOffline')));
  }
}
