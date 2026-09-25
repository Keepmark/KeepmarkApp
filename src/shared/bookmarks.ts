// Pure bookmark-tree helpers. Port of app/bookmark-helper.service.ts
// (framework-free: no Angular, no browser APIs — fully unit-testable).

import { DescriptionMaxLength, SeparatorUrl } from './constants.js';
import type { BookmarkNode } from './models.js';

export enum BookmarkContainer {
  Menu = '[xbs] Menu',
  Other = '[xbs] Other',
  Toolbar = '[xbs] Toolbar',
}

export enum BookmarkType {
  Bookmark = 'bookmark',
  Container = 'container',
  Folder = 'folder',
  Separator = 'separator',
}

export const HorizontalSeparatorTitle =
  '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';
export const VerticalSeparatorTitle = '|';

/** Minimal structural view of a browser.bookmarks.BookmarkTreeNode. */
export interface NativeNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  type?: 'bookmark' | 'folder' | 'separator';
  children?: NativeNode[];
  dateAdded?: number;
  index?: number;
}

export function eachBookmark<T extends { children?: T[] }>(
  iteratee: (node: T) => void,
  nodes: T[] = [],
  until?: () => boolean,
): void {
  const walk = (list: T[]): void => {
    for (const node of list) {
      if (until?.() === true) break;
      iteratee(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
}

export function findById<T extends { id?: unknown; children?: T[] }>(id: unknown, nodes: T[] = []): T | undefined {
  if (id === undefined) return undefined;
  let found: T | undefined;
  eachBookmark(
    (n) => {
      if (n.id === id) found = n;
    },
    nodes,
    () => found !== undefined,
  );
  return found;
}

export function getBookmarkType(node: BookmarkNode): BookmarkType {
  if (
    node.title === BookmarkContainer.Menu ||
    node.title === BookmarkContainer.Other ||
    node.title === BookmarkContainer.Toolbar
  ) {
    return BookmarkType.Container;
  }
  if (Array.isArray(node.children)) return BookmarkType.Folder;
  if (node.url === SeparatorUrl) return BookmarkType.Separator;
  return BookmarkType.Bookmark;
}

/** Highest numeric id in the tree (+ taken) plus one. Mirrors getNewBookmarkId. */
export function getNewBookmarkId(bookmarks: BookmarkNode[], takenIds: number[] = [0]): number {
  let highest = 0;
  eachBookmark((b) => {
    if (b.id !== undefined) {
      const n = parseInt(String(b.id), 10);
      if (!Number.isNaN(n) && n > highest) highest = n;
    }
  }, bookmarks);
  const highestTaken = takenIds.reduce((x, y) => (x > y ? x : y), 0);
  return Math.max(highest, highestTaken) + 1;
}

export function newBookmark(
  title: string,
  url?: string,
  description?: string,
  tags?: string[],
  idSource?: BookmarkNode[],
): BookmarkNode {
  const trimmedTitle = title?.trim();
  const trimmedUrl = url?.trim();
  const node: BookmarkNode = {
    title: trimmedTitle,
    description: description?.trim().slice(0, DescriptionMaxLength),
    tags,
  };
  if (trimmedUrl) {
    node.url = trimmedUrl;
  } else {
    node.children = [];
  }
  // Separators carry only the marker url.
  if (getBookmarkType({ ...node, url: trimmedUrl || undefined } as BookmarkNode) === BookmarkType.Separator) {
    return { url: SeparatorUrl };
  }
  if (idSource) node.id = getNewBookmarkId(idSource);
  return cleanBookmark(node);
}

/** Drop invalid keys, undefined, empty descriptions and empty tag lists. */
export function cleanBookmark(node: BookmarkNode): BookmarkNode {
  const validKeys = ['children', 'description', 'id', 'tags', 'title', 'url'];
  const out: BookmarkNode = {};
  for (const key of validKeys as (keyof BookmarkNode)[]) {
    const value = node[key];
    if (value === undefined) continue;
    if (key === 'description' && (value as string).trim() === '') continue;
    if (key === 'tags' && (value as string[]).length === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function cleanAllBookmarks(nodes: BookmarkNode[]): BookmarkNode[] {
  return nodes.map((n) => {
    const cleaned = cleanBookmark(n);
    if (Array.isArray(cleaned.children)) cleaned.children = cleanAllBookmarks(cleaned.children);
    return cleaned;
  });
}

export function getContainer(
  name: BookmarkContainer,
  bookmarks: BookmarkNode[],
  createIfMissing = false,
): BookmarkNode | undefined {
  let container = bookmarks.find((x) => x.title === name);
  if (!container && createIfMissing) {
    container = newBookmark(name);
    // newBookmark(name) without url yields a folder; ensure children array.
    if (!Array.isArray(container.children)) container.children = [];
    bookmarks.push(container);
  }
  return container;
}

/** Remove containers with no children (export path). */
export function removeEmptyContainers(bookmarks: BookmarkNode[]): BookmarkNode[] {
  const empties = new Set<BookmarkNode>();
  for (const name of [BookmarkContainer.Menu, BookmarkContainer.Other, BookmarkContainer.Toolbar]) {
    const c = getContainer(name, bookmarks);
    if (c && (!c.children || c.children.length === 0)) empties.add(c);
  }
  return bookmarks.filter((x) => !empties.has(x));
}

/** Ensure Menu/Other/Toolbar containers exist; return sorted copy. */
export function ensureContainersExist(bookmarks: BookmarkNode[]): BookmarkNode[] {
  const out = [...bookmarks];
  getContainer(BookmarkContainer.Menu, out, true);
  getContainer(BookmarkContainer.Other, out, true);
  getContainer(BookmarkContainer.Toolbar, out, true);
  return out.sort((x, y) => (x.title! < y.title! ? -1 : x.title! > y.title! ? 1 : 0));
}

/** True when every node has a unique numeric id. */
export function validateBookmarkIds(bookmarks: BookmarkNode[]): boolean {
  if (!bookmarks?.length) return true;
  const flat: BookmarkNode[] = [];
  eachBookmark((b) => flat.push(b), bookmarks);
  if (flat.some((b) => b.id === undefined || typeof b.id !== 'number')) return false;
  return new Set(flat.map((b) => b.id)).size === flat.length;
}

/** Reassign sequential ids 1..n in place (mutates, returns same roots). */
export function repairBookmarkIds(bookmarks: BookmarkNode[]): BookmarkNode[] {
  const flat: BookmarkNode[] = [];
  eachBookmark((b) => flat.push(b), bookmarks);
  for (const b of flat) {
    if (typeof b.id !== 'number') delete b.id;
  }
  // Sort exactly like the original client (plain `id - id`, so missing ids
  // compare as NaN and keep their relative order) — otherwise two clients
  // repair the same tree differently and chase each other on every push.
  flat.sort((x, y) => Number(x.id) - Number(y.id));
  flat.forEach((b, i) => {
    b.id = i + 1;
  });
  return bookmarks;
}

/** A native node is a separator by type, or by legacy title+newtab-url shape. */
export function nativeIsSeparator(node: NativeNode, newTabUrl: string): boolean {
  if (!node) return false;
  return (
    node.type === 'separator' ||
    ((node.title === HorizontalSeparatorTitle || node.title === VerticalSeparatorTitle) &&
      node.url === newTabUrl)
  );
}

/** Convert native nodes to synced bookmarks (no ids — assigned by dateAdded order). */
export function nativeToSynced(
  nodes: NativeNode[],
  newTabUrl: string,
  isSeparator: (node: NativeNode) => boolean = (n) => nativeIsSeparator(n, newTabUrl),
): BookmarkNode[] {
  return nodes.map((native) => {
    const url = isSeparator(native) ? SeparatorUrl : native.url?.trim();
    const node = newBookmark(native.title, url);
    if (native.children?.length) node.children = nativeToSynced(native.children, newTabUrl);
    else if (!url) node.children = [];
    return node;
  });
}
