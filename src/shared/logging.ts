// Logging levels + redaction gate. Port of Keepmark.Core/Logging/Logging.cs.
// Passwords/keys/blobs are never logged; sync IDs are truncated.

export enum XbsLogLevel {
  Error = 0,
  Warning = 1,
  Info = 2,
  Debug = 3,
  Verbose = 4,
}

export interface LogEntry {
  timestamp: string;
  level: XbsLogLevel;
  tag: string;
  message: string;
}

export interface IXbsLogger {
  log(level: XbsLogLevel, tag: string, message: string): void;
  readonly entries: LogEntry[];
  clear(): void;
  minLevel: XbsLogLevel;
}

export function sanitizeSyncId(syncId?: string): string {
  if (!syncId || syncId.length <= 8) return '…';
  return `${syncId.slice(0, 4)}…${syncId.slice(-2)}`;
}

export function sanitizePath(template: string, syncId?: string): string {
  if (!syncId) return template;
  return template.split(syncId).join(sanitizeSyncId(syncId)).replaceAll('{id}', sanitizeSyncId(syncId));
}

/**
 * Central redaction gate. Key=value secrets and bearer-like IDs never reach
 * stored log entries, no matter the call site: every message is sanitized
 * inside InMemoryLogger.log, so redaction is a mechanism, not discipline.
 */
export const LogSanitizer = {
  sanitize(message: string): string {
    return message
      .replace(
        /\b(password|passwd|pwd|secret|derivedKey|privateKey|bearer|blob|encryptedBookmarks)\s*[:=]\s*\S+/gi,
        '$1=[redacted]',
      )
      // Quoted JSON shapes: {"password":"hunter2"} — the char after the key
      // is a quote, so the gate above never matches. Redact the value.
      .replace(
        /"(password|passwd|pwd|secret|derivedKey|privateKey|bearer|blob|encryptedBookmarks)"\s*:\s*"[^"]*"/gi,
        '"$1":"[redacted]"',
      )
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        (id) => sanitizeSyncId(id),
      );
  },
};

export class InMemoryLogger implements IXbsLogger {
  minLevel: XbsLogLevel = XbsLogLevel.Info;
  private queue: LogEntry[] = [];

  constructor(private capacity = 1000) {}

  log(level: XbsLogLevel, tag: string, message: string): void {
    if (level > this.minLevel) return;
    this.queue.push({ timestamp: new Date().toISOString(), level, tag, message: LogSanitizer.sanitize(message) });
    while (this.queue.length > this.capacity) this.queue.shift();
  }

  get entries(): LogEntry[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }
}

export const nullLogger: IXbsLogger = {
  minLevel: XbsLogLevel.Error,
  // Fresh array per access: entries is readonly, nothing may mutate (or leak
  // into) the shared singleton.
  get entries(): LogEntry[] {
    return [];
  },
  clear() {},
  log() {},
};
