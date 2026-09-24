import { describe, expect, it, vi } from 'vitest';
import {
  DataOutOfSyncException,
  IncompleteSyncInfoException,
  ServiceOfflineException,
  SyncNotFoundException,
  XbsException,
} from '../src/shared/errors';
import { InMemoryLogger } from '../src/shared/logging';
import { fromWireError, MessageCommand, toWireError } from '../src/shared/messages';
import { SyncQueue } from '../src/shared/sync-queue';

describe('message error wire format', () => {
  it('round-trips typed errors by name', () => {
    const wire = toWireError(new SyncNotFoundException('gone'));
    expect(wire).toEqual({ errorName: 'SyncNotFoundException', message: 'gone' });
    const rebuilt = fromWireError(wire);
    expect(rebuilt).toBeInstanceOf(SyncNotFoundException);
    expect(rebuilt.message).toBe('gone');
  });

  it('falls back to XbsException for unknown names', () => {
    expect(fromWireError({ errorName: 'Nope', message: 'x' })).toBeInstanceOf(XbsException);
    expect(toWireError(new Error('plain'))).toEqual({ errorName: 'XbsException', message: 'plain' });
  });

  it('commands are stable strings', () => {
    expect(MessageCommand.SyncBookmarks).toBe('sync-bookmarks');
  });
});

describe('sync queue', () => {
  it('runs jobs FIFO one at a time', async () => {
    const order: string[] = [];
    const q = new SyncQueue(async (job) => {
      order.push(job.type);
    }, new InMemoryLogger());
    q.enqueue('remote', false);
    q.enqueue('local', false);
    await q.execute();
    expect(order).toEqual(['remote', 'local']);
    expect(q.syncing).toBe(false);
  });

  it('auto-executes on enqueue by default and gates concurrent execute', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new SyncQueue(async () => {
      calls += 1;
      await gate;
    }, new InMemoryLogger());
    q.enqueue('local');
    q.enqueue('local');
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it('requeues offline failures at the front and rethrows', async () => {
    let attempts = 0;
    const q = new SyncQueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new ServiceOfflineException('down');
    }, new InMemoryLogger());
    q.enqueue('remote', false);
    await expect(q.execute()).rejects.toBeInstanceOf(ServiceOfflineException);
    expect(q.length).toBe(1); // job back at front
    await q.execute();
    expect(attempts).toBe(2);
    expect(q.length).toBe(0);
  });

  it('queues a local resync on DataOutOfSync', async () => {
    const seen: string[] = [];
    const q = new SyncQueue(async (job) => {
      seen.push(job.type);
      if (job.type === 'remote') throw new DataOutOfSyncException('conflict');
    }, new InMemoryLogger());
    q.enqueue('remote', false);
    await expect(q.execute()).rejects.toBeInstanceOf(DataOutOfSyncException);
    expect(seen).toEqual(['remote']);
    expect(q.length).toBe(1); // local resync queued at front
    await q.execute();
    expect(seen).toEqual(['remote', 'local']);
  });

  it('clears and notifies on sync loss', async () => {
    const lost: Error[] = [];
    const q = new SyncQueue(async () => {
      throw new SyncNotFoundException('gone');
    }, new InMemoryLogger(), (err) => {
      lost.push(err);
    });
    q.enqueue('remote', false);
    q.enqueue('local', false);
    await expect(q.execute()).rejects.toBeInstanceOf(SyncNotFoundException);
    expect(q.length).toBe(0);
    expect(lost).toHaveLength(1);
  });

  it('does not requeue offline failures for local jobs', async () => {
    const q = new SyncQueue(async () => {
      throw new ServiceOfflineException('down');
    }, new InMemoryLogger());
    q.enqueue('local', false);
    await expect(q.execute()).rejects.toBeInstanceOf(ServiceOfflineException);
    expect(q.length).toBe(0);
  });

  it('treats incomplete sync info as sync loss', async () => {
    let notified = false;
    const q = new SyncQueue(async () => {
      throw new IncompleteSyncInfoException('no creds');
    }, new InMemoryLogger(), () => {
      notified = true;
    });
    q.enqueue('remote', false);
    await expect(q.execute()).rejects.toBeInstanceOf(IncompleteSyncInfoException);
    expect(notified).toBe(true);
  });
});
