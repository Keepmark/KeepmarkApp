// Platform-native adapter consumed by the background core. Implemented by
// src/firefox/adapter.ts and src/chromium/adapter.ts over the shared
// generic layer (src/shared/native.ts).

import { BookmarkContainer } from '../shared/bookmarks.js';
import type { NativeNode } from '../shared/bookmarks.js';
import type { BookmarkIdMapping } from '../shared/id-mapper.js';
import type { BookmarkNode } from '../shared/models.js';
import type { NativeOps } from '../shared/native.js';

export interface AddNativeInput {
  container: BookmarkContainer;
  parentSyncedId?: number;
  title: string;
  url?: string;
}

export interface NativeAdapter extends NativeOps {
  readonly platformName: 'firefox' | 'chromium';
  readonly newTabUrl: string;
  /** Containers reconciled on native changes (chromium skips Menu root). */
  readonly syncContainers: BookmarkContainer[];
  /** Native children of one synced container (chromium Menu = folder in Other). */
  readContainer(container: BookmarkContainer): Promise<NativeNode[]>;
  /** Remove the native node mapped to a synced id (folder = whole subtree). */
  removeBySyncedId(syncedId: number, mappings: BookmarkIdMapping[]): Promise<void>;
  /** Create a native bookmark, resolving the parent from mappings/containers. */
  addNative(input: AddNativeInput, mappings: BookmarkIdMapping[]): Promise<string>;
}

export async function overwriteAll(
  adapter: NativeAdapter,
  bookmarks: BookmarkNode[],
  syncToolbar: boolean,
): Promise<BookmarkIdMapping[]> {
  await adapter.clearAndPopulate(bookmarks, syncToolbar);
  return adapter.rebuildMappings(bookmarks, syncToolbar);
}

export { BookmarkContainer };
export type { BookmarkNode, NativeNode };
