// Serialized sync job queue. Ports the queue mechanics of app/sync.service.ts
// (which must live only in the background context) with the failure policy of
// handleFailedSync, minus Angular:
//
// - jobs run FIFO, one at a time (gate); popup never touches the queue.
// - network failure (offline) or throttle → job goes back to the front,
//   error rethrown. The caller (drain) must NOT tight-loop on these.
// - DataOutOfSync → queue cleared, a local job is queued at the front, error rethrown.
// - InvalidCredentials (wrong password) → queue cleared (retrying the same
//   key is pointless), error rethrown; credentials are kept for the user to fix.
// - SyncNotFound / IncompleteSyncInfo / UnsupportedSyncVersion →
//   queue cleared, onSyncLost callback (caller disables sync).
// (No Cancel job type: callers use clear() directly, e.g. disableSync.)

import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  InvalidCredentialsException,
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
    // Fire-and-forget: the rejection is a duplicate of what the next
    // explicit execute()/drain() reports, so swallow it here to avoid
    // unhandled-rejection noise (the job itself was already requeued/handled).
    if (run) void this.execute().catch(() => undefined);
    return job.id;
  }

  enqueueFront(type: SyncJobType): number {
    // NOTE: does not start execution — the caller must drain() (the queue's
    // recovery paths enqueueFront from inside a failing execute()).
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
    if (err instanceof ServiceOfflineException || err instanceof ThrottledException) {
      // Transient: backoff by retrying later (drain breaks instead of
      // tight-looping). A 429 never wipes credentials — it is not sync loss.
      this.log.log(XbsLogLevel.Warning, 'sync', `Job ${job.id} failed transiently, requeued at front`);
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
    if (err instanceof InvalidCredentialsException) {
      // Wrong password for the stored key: retrying the queued jobs with the
      // same key is pointless. Keep credentials (user fixes via relink) but
      // drop the queue so nothing retries in a loop.
      this.log.log(XbsLogLevel.Warning, 'sync', 'Job failed on credentials, clearing queue');
      this.clear();
      return;
    }
    if (
      err instanceof SyncNotFoundException ||
      err instanceof IncompleteSyncInfoException ||
      err instanceof UnsupportedSyncVersionException
    ) {
      this.clear();
      try {
        await this.onSyncLost?.(err);
      } catch (cbErr) {
        // Never mask the original failure with a callback failure.
        this.log.log(
          XbsLogLevel.Warning,
          'sync',
          `onSyncLost failed (${(cbErr as Error)?.message}); original error: ${err.message}`,
        );
      }
    }
  }
}
