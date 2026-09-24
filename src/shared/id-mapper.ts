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

  async add(mappings: BookmarkIdMapping | BookmarkIdMapping[]): Promise<void> {
    const arr = Array.isArray(mappings) ? mappings : [mappings];
    const existing = (await this.store.get<BookmarkIdMapping[]>(StoreKey.BookmarkIdMappings)) ?? [];
    await this.set([...existing, ...arr]);
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
    const syncedArr =
      syncedIds == null ? null : Array.isArray(syncedIds) ? syncedIds : [syncedIds];
    const nativeArr =
      nativeIds == null ? null : Array.isArray(nativeIds) ? nativeIds : [nativeIds];
    let mappings = await this.all();
    if (syncedArr != null) {
      for (const id of syncedArr) {
        const index = mappings.findIndex((x) => x.syncedId === id);
        if (index < 0) throw new Error(`Bookmark ID mapping to remove could not be determined (${id})`);
        mappings = mappings.filter((_, i) => i !== index);
      }
    }
    if (nativeArr != null) {
      for (const id of nativeArr) {
        const index = mappings.findIndex((x) => x.nativeId === id);
        if (index < 0) throw new Error(`Bookmark ID mapping to remove could not be determined (${id})`);
        mappings = mappings.filter((_, i) => i !== index);
      }
    }
    await this.set(mappings);
  }

  async set(mappings: BookmarkIdMapping[]): Promise<void> {
    const sorted = [...mappings].sort((x, y) => x.syncedId - y.syncedId);
    await this.store.set(StoreKey.BookmarkIdMappings, sorted);
  }
}
