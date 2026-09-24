// Native -> synced reconciliation. Replaces the incremental
// processNativeChangeOnBookmarks machinery of app/webext-bookmark.service.ts
// (Add/Modify/Remove/Move/ChildrenReordered cases) with one equivalent
// whole-tree pass:
//
// - native nodes with a stored nativeId->syncedId mapping keep their synced id
//   and take title/url from the native side (covers modify + move);
// - native nodes without a mapping get fresh ids (covers add);
// - synced nodes with no live native counterpart disappear (covers remove);
// - children order follows the native order (covers reorder).
//
// Containers are re-ensured by the caller after reconciling each container.

import {
  BookmarkContainer,
  eachBookmark,
  getNewBookmarkId,
  nativeIsSeparator,
  newBookmark,
  type NativeNode,
} from './bookmarks.js';
import { SeparatorUrl } from './constants.js';
import type { BookmarkIdMapping } from './id-mapper.js';
import type { BookmarkNode } from './models.js';

export interface ReconcileResult {
  bookmarks: BookmarkNode[];
  mappings: BookmarkIdMapping[];
  changed: boolean;
}

/**
 * Reconcile one native container subtree into its synced container.
 * nativeChildren come from getSubTree(containerId).children.
 */
export function reconcileContainer(
  nativeChildren: NativeNode[],
  container: BookmarkContainer,
  bookmarks: BookmarkNode[],
  mappings: BookmarkIdMapping[],
  newTabUrl: string,
): ReconcileResult {
  const byNative = new Map(mappings.map((m) => [m.nativeId, m.syncedId]));
  const taken: number[] = [];
  eachBookmark((b) => {
    if (b.id !== undefined) taken.push(b.id);
  }, bookmarks);
  const freshId = (): number => {
    const id = taken.reduce((x, y) => (x > y ? x : y), 0) + 1;
    taken.push(id);
    return id;
  };

  let changed = false;
  const liveSynced = new Set<number>();
  const outMappings: BookmarkIdMapping[] = mappings.filter((m) => {
    // Keep mappings of other containers; container mappings are rebuilt below.
    const node = findSynced(m.syncedId, bookmarks);
    if (!node) return false;
    return !isInContainer(node, container, bookmarks);
  });

  const convert = (native: NativeNode): BookmarkNode => {
    const knownId = byNative.get(native.id);
    const url = nativeIsSeparator(native, newTabUrl) ? SeparatorUrl : native.url?.trim();
    if (knownId !== undefined) {
      const current = findSynced(knownId, bookmarks);
      const meta = newBookmark(native.title, url);
      if (!current || current.title !== meta.title || current.url !== meta.url) changed = true;
      const node: BookmarkNode = { ...meta, id: knownId };
      liveSynced.add(knownId);
      if (!url) {
        // Folder: children follow the native side exactly (empty stays empty).
        const before = current?.children?.length ?? -1;
        node.children = (native.children ?? []).map(convert);
        if (before !== node.children.length) changed = true;
      } else if (native.children?.length) {
        node.children = native.children.map(convert);
      }
      outMappings.push({ nativeId: native.id, syncedId: knownId });
      return node;
    }
    changed = true;
    const id = freshId();
    const node = newBookmark(native.title, url);
    node.id = id;
    liveSynced.add(id);
    if (native.children?.length) node.children = native.children.map(convert);
    else if (!url && !Array.isArray(node.children)) node.children = [];
    outMappings.push({ nativeId: native.id, syncedId: id });
    return node;
  };

  const children = nativeChildren.map(convert);

  // Detect removals: previous container children whose ids are not live.
  const prev = bookmarks.find((b) => b.title === container);
  if (prev?.children) {
    const prevIds = new Set<number>();
    eachBookmark((b) => {
      if (b.id !== undefined) prevIds.add(b.id);
    }, prev.children);
    for (const id of prevIds) {
      if (!liveSynced.has(id)) {
        changed = true;
        break;
      }
    }
  }

  const next = bookmarks.map((b) => (b.title === container ? { ...b, children } : b));
  outMappings.sort((x, y) => x.syncedId - y.syncedId);
  return { bookmarks: next, mappings: outMappings, changed };
}

function findSynced(id: number, bookmarks: BookmarkNode[]): BookmarkNode | undefined {
  let found: BookmarkNode | undefined;
  eachBookmark(
    (b) => {
      if (b.id === id) found = b;
    },
    bookmarks,
    () => found !== undefined,
  );
  return found;
}

function isInContainer(node: BookmarkNode, container: BookmarkContainer, bookmarks: BookmarkNode[]): boolean {
  const root = bookmarks.find((b) => b.title === container);
  if (!root || !root.children) return false;
  let inside = false;
  eachBookmark(
    (b) => {
      if (b === node) inside = true;
    },
    root.children,
    () => inside,
  );
  return inside;
}

export { getNewBookmarkId };
