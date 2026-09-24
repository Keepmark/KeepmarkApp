// Serialized sync job queue. Ports the queue mechanics of app/sync.service.ts
// (which must live only in the background context) with the failure policy of
// handleFailedSync, minus Angular:
//
// - jobs run FIFO, one at a time (gate); popup never touches the queue.
// - network failure on a non-local job → job goes back to the front, error rethrown.
// - DataOutOfSync → a local job is queued at the front, error rethrown.
// - SyncNotFound / IncompleteSyncInfo → onSyncLost callback (caller disables sync).

import { DataOutOfSyncException, IncompleteSyncInfoException, ServiceOfflineException, SyncNotFoundException } from './errors.js';
import type { IXbsLogger } from './logging.js';
import { XbsLogLevel } from './logging.js';
import type { SyncJobType } from './messages.js';

export interface SyncJob {
  id: number;
  type: SyncJobType;
  run?: boolean;
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

  /** Enqueue a job; cancel-type clears the queue first (mirrors SyncType.Cancel). */
  enqueue(type: SyncJobType, run = true): number {
    const job: SyncJob = { id: this.nextId++, type, run };
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
      this.log.log(XbsLogLevel.Info, 'sync', 'Remote out of sync, queueing local resync');
      this.enqueueFront('local');
      return;
    }
    if (err instanceof SyncNotFoundException || err instanceof IncompleteSyncInfoException) {
      this.clear();
      await this.onSyncLost?.(err);
    }
  }
}
