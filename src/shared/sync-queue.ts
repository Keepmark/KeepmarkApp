// Serialized sync job queue. Ports the queue mechanics of app/sync.service.ts
// (which must live only in the background context) with the failure policy of
// handleFailedSync, minus Angular:
//
// - jobs run FIFO, one at a time (gate); popup never touches the queue.
// - network failure on a non-local job → job goes back to the front, error rethrown.
// - DataOutOfSync → queue cleared, a local job is queued at the front, error rethrown.
// - SyncNotFound / IncompleteSyncInfo / Throttled / UnsupportedSyncVersion →
//   queue cleared, onSyncLost callback (caller disables sync).
// (No Cancel job type: callers use clear() directly, e.g. disableSync.)

import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  ServiceOfflineException,
  SyncNotFoundException,
  ThrottledException,
  UnsupportedSyncVersionException,
} from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import type { BookmarkNode } from './models.js';
import type { SyncJobType } from './messages.js';

export interface SyncJob {
  id: number;
  type: SyncJobType;
  run?: boolean;
  /** Full tree for localAndRemote (restore) jobs. */
  bookmarks?: BookmarkNode[];
}

export class SyncQueue {
  private jobs: SyncJob[] = [];
  private running = false;
  private current?: SyncJob;
  private nextId = 1;

  constructor(
    private runner: (job: SyncJob) => Promise<void>,
    private log: IXbsLogger,
    private onSyncLost?: (err: Error) => Promise<void> | void,
  ) {}

  get length(): number {
    return this.jobs.length;
  }

  get syncing(): boolean {
    return this.running;
  }

  get currentJob(): SyncJob | undefined {
    return this.current;
  }

  /** Enqueue a job (appended at the back). */
  enqueue(type: SyncJobType, run = true, bookmarks?: SyncJob['bookmarks']): number {
    const job: SyncJob = { id: this.nextId++, type, run, bookmarks };
    this.jobs.push(job);
    if (run) void this.execute();
    return job.id;
  }

  enqueueFront(type: SyncJobType): number {
    const job: SyncJob = { id: this.nextId++, type, run: true };
    this.jobs.unshift(job);
    return job.id;
  }

  clear(): void {
    this.jobs = [];
  }

  async execute(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        this.current = job;
        try {
          await this.runner(job);
        } catch (err) {
          await this.handleFailedJob(job, err as Error);
          throw err;
        } finally {
          this.current = undefined;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async handleFailedJob(job: SyncJob, err: Error): Promise<void> {
    if ((err instanceof ServiceOfflineException) && job.type !== 'local') {
      this.log.log(XbsLogLevel.Warning, 'sync', `Job ${job.id} failed offline, requeued at front`);
      this.jobs.unshift(job);
      return;
    }
    if (err instanceof DataOutOfSyncException) {
      // Drop anything queued behind: a stale remote job pushing after the
      // fresh pull would immediately re-conflict.
      this.log.log(XbsLogLevel.Info, 'sync', 'Remote out of sync, clearing queue and resyncing local');
      this.clear();
      this.enqueueFront('local');
      return;
    }
    if (
      err instanceof SyncNotFoundException ||
      err instanceof IncompleteSyncInfoException ||
      err instanceof ThrottledException ||
      err instanceof UnsupportedSyncVersionException
    ) {
      this.clear();
      await this.onSyncLost?.(err);
    }
  }
}
