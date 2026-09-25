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
 * isSeparator detects platform-native separators (Firefox: type or legacy
 * titles; Chromium: dashes-titles) — never hardcode one platform here.
 */
export function reconcileContainer(
  nativeChildren: NativeNode[],
  container: BookmarkContainer,
  bookmarks: BookmarkNode[],
  mappings: BookmarkIdMapping[],
  newTabUrl: string,
  isSeparator: (node: NativeNode) => boolean = (n) => nativeIsSeparator(n, newTabUrl),
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
    const url = isSeparator(native) ? SeparatorUrl : native.url?.trim();
    if (knownId !== undefined) {
      const current = findSynced(knownId, bookmarks);
      // Normalize by NATIVE type: a bookmark never carries children, a folder
      // never carries a url. A folder<->bookmark flip is always a change.
      const wasFolder = current !== undefined && Array.isArray(current.children);
      const isFolder = !url;
      if (!current || wasFolder !== isFolder) changed = true;
      const meta = newBookmark(native.title, url);
      // NOTE: description/tags live only on the synced side (natives can't
      // express them), so they are preserved below but never a diff source —
      // otherwise every reconcile would push.
      if (!current || current.title !== meta.title || current.url !== meta.url) changed = true;
      // Preserve description/tags: native nodes don't carry them, the synced
      // side owns them. Dropping them here deleted metadata on every push.
      const node: BookmarkNode = {
        ...meta,
        description: current?.description,
        tags: current?.tags,
        id: knownId,
      };
      if (node.description === undefined) delete node.description;
      if (node.tags === undefined) delete node.tags;
      liveSynced.add(knownId);
      if (isFolder) {
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

  // Detect removals AND pure reorders: previous container children whose ids
  // are not live, or whose live order differs from the native order.
  const prev = bookmarks.find((b) => b.title === container);
  if (prev?.children) {
    const prevIds: number[] = [];
    eachBookmark((b) => {
      if (b.id !== undefined) prevIds.push(b.id);
    }, prev.children);
    const liveTopIds = children.map((c) => c.id).filter((id): id is number => id !== undefined);
    const prevTopIds = prev.children.map((c) => c.id).filter((id): id is number => id !== undefined);
    for (const id of prevIds) {
      if (!liveSynced.has(id)) {
        changed = true;
        break;
      }
    }
    if (
      !changed &&
      prevTopIds.length === liveTopIds.length &&
      prevTopIds.some((id, i) => id !== liveTopIds[i])
    ) {
      changed = true;
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
