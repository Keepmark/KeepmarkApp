// xbsId <-> nativeId mapping. Port of app/bookmark-id-mapper.service.ts.
// Mappings are rebuilt on every Local populate and incrementally on Remote changes.

import { Store, StoreKey } from './store.js';

export interface BookmarkIdMapping {
  syncedId: number;
  nativeId: string;
}

export function createMapping(syncedId: number, nativeId: string): BookmarkIdMapping {
  return { nativeId, syncedId };
}

export class BookmarkIdMapper {
  constructor(private store: Store) {}
  /** Runs after every full set() (not add/remove): the owner records which
   * native roots the mappings belong to. */
  onFullSet?: () => Promise<void>;
  /** Serializes read-modify-write cycles: concurrent add/set/remove calls
   * otherwise interleave on the same `existing` snapshot and lose batches. */
  private tail: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async add(mappings: BookmarkIdMapping | BookmarkIdMapping[]): Promise<void> {
    const arr = Array.isArray(mappings) ? mappings : [mappings];
    return this.serialized(async () => {
      const existing = (await this.store.get<BookmarkIdMapping[]>(StoreKey.BookmarkIdMappings)) ?? [];
      await this.write([...existing, ...arr]);
    });
  }

  async clear(): Promise<void> {
    await this.store.remove(StoreKey.BookmarkIdMappings);
  }

  async get(nativeId?: string, syncedId?: number): Promise<BookmarkIdMapping | undefined> {
    const mappings = (await this.store.get<BookmarkIdMapping[]>(StoreKey.BookmarkIdMappings)) ?? [];
    if (nativeId != null) return mappings.find((x) => x.nativeId === nativeId);
    if (syncedId != null) return mappings.find((x) => x.syncedId === syncedId);
    return undefined;
  }

  async all(): Promise<BookmarkIdMapping[]> {
    return (await this.store.get<BookmarkIdMapping[]>(StoreKey.BookmarkIdMappings)) ?? [];
  }

  async remove(syncedIds?: number | number[], nativeIds?: string | string[]): Promise<void> {
    return this.serialized(async () => {
      const syncedArr =
        syncedIds == null ? null : Array.isArray(syncedIds) ? syncedIds : [syncedIds];
      const nativeArr =
        nativeIds == null ? null : Array.isArray(nativeIds) ? nativeIds : [nativeIds];
      let mappings = await this.all();
      if (syncedArr != null) {
        for (const id of syncedArr) {
          // Idempotent: already-removed ids are skipped so retries after a
          // half-applied batch cannot fail the whole sync.
          mappings = mappings.filter((x) => x.syncedId !== id);
        }
      }
      if (nativeArr != null) {
        for (const id of nativeArr) {
          mappings = mappings.filter((x) => x.nativeId !== id);
        }
      }
      await this.write(mappings);
    });
  }

  /** Replace all mappings (a full rebuild: also re-anchors the native roots). */
  async set(mappings: BookmarkIdMapping[]): Promise<void> {
    await this.write(mappings);
    await this.onFullSet?.();
  }

  /** Incremental writes keep the recorded roots: they never prove the roots are current. */
  private async write(mappings: BookmarkIdMapping[]): Promise<void> {
    const sorted = [...mappings].sort((x, y) => x.syncedId - y.syncedId);
    await this.store.set(StoreKey.BookmarkIdMappings, sorted);
  }
}
