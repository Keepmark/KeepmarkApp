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

export class InMemoryLogger implements IXbsLogger {
  minLevel: XbsLogLevel = XbsLogLevel.Info;
  private queue: LogEntry[] = [];

  constructor(private capacity = 1000) {}

  log(level: XbsLogLevel, tag: string, message: string): void {
    if (level > this.minLevel) return;
    this.queue.push({ timestamp: new Date().toISOString(), level, tag, message });
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
  entries: [],
  clear() {},
  log() {},
};
