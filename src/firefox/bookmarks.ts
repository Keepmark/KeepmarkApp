// Firefox native bookmark service. Port of app/firefox-bookmark.service.ts
// (which extends webext-bookmark.service.ts), framework-free.
//
// The browser.bookmarks API surface is injected via BookmarkApi so the logic
// is unit-testable; the real background script passes browser.bookmarks.
// Event listeners (onCreated/onChanged/...) come in Fase 3 with the background queue.

import {
  BookmarkContainer,
  eachBookmark,
  ensureContainersExist,
  getContainer,
  getNewBookmarkId,
  nativeToSynced,
  type NativeNode,
} from '../shared/bookmarks.js';
import type { BookmarkNode } from '../shared/models.js';
import { getNewTabUrl, getSupportedUrl } from './platform.js';
import type { BookmarkIdMapping } from '../shared/id-mapper.js';

/** Narrow view of the browser.bookmarks API used here. */
export interface BookmarkApi {
  getTree(): Promise<NativeNode[]>;
  getSubTree(id: string): Promise<NativeNode[]>;
  getChildren(id: string): Promise<NativeNode[]>;
  create(details: { parentId?: string; title?: string; url?: string; type?: 'separator' }): Promise<NativeNode>;
  removeTree(id: string): Promise<void>;
}

export class ContainerNotFoundError extends Error {
  constructor(message = 'Native bookmark container not found.') {
    super(message);
    this.name = 'ContainerNotFoundError';
  }
}

export interface ContainerIds {
  menu: string;
  other: string;
  toolbar: string;
}

export async function getContainerIds(api: BookmarkApi): Promise<ContainerIds> {
  const [root] = await api.getTree();
  const menu = root.children?.find((x) => x.id === 'menu________');
  const other = root.children?.find((x) => x.id === 'unfiled_____');
  const toolbar = root.children?.find((x) => x.id === 'toolbar_____');
  if (!menu || !other || !toolbar) throw new ContainerNotFoundError();
  return { menu: menu.id, other: other.id, toolbar: toolbar.id };
}

/**
 * Read native bookmarks as synced bookmarks. Mirrors
 * getNativeBookmarksAsBookmarks: per-container subtrees, then ids assigned in
 * dateAdded order by matching title/url.
 */
export async function getNativeBookmarksAsBookmarks(
  api: BookmarkApi,
  syncToolbar: boolean,
): Promise<BookmarkNode[]> {
  const ids = await getContainerIds(api);
  const [menuTree] = await api.getSubTree(ids.menu);
  const [otherTree] = await api.getSubTree(ids.other);
  const newTabUrl = getNewTabUrl();

  const flat: NativeNode[] = [];
  const collect = (nodes: NativeNode[] | undefined): void => {
    if (!nodes) return;
    for (const n of nodes) {
      flat.push(n);
      if (n.children?.length) collect(n.children);
    }
  };

  const menu = nativeToSynced(menuTree.children ?? [], newTabUrl);
  collect(menuTree.children);
  const other = nativeToSynced(otherTree.children ?? [], newTabUrl);
  collect(otherTree.children);

  let toolbar: BookmarkNode[] = [];
  if (syncToolbar) {
    const [toolbarTree] = await api.getSubTree(ids.toolbar);
    toolbar = nativeToSynced(toolbarTree.children ?? [], newTabUrl);
    collect(toolbarTree.children);
  }

  const bookmarks: BookmarkNode[] = [];
  const otherContainer = getContainer(BookmarkContainer.Other, bookmarks, true)!;
  if (other.length > 0) otherContainer.children = other;
  const toolbarContainer = getContainer(BookmarkContainer.Toolbar, bookmarks, true)!;
  if (toolbar.length > 0) toolbarContainer.children = toolbar;
  const menuContainer = getContainer(BookmarkContainer.Menu, bookmarks, true)!;
  if (menu.length > 0) menuContainer.children = menu;

  // Assign ids in dateAdded order, matching converted nodes to natives.
  const sorted = [...flat].sort((x, y) => (x.dateAdded ?? 0) - (y.dateAdded ?? 0));
  for (const native of sorted) {
    eachBookmark((b: BookmarkNode) => {
      if (b.id !== undefined) return;
      const match = !native.url ? b.title === native.title : b.url === native.url;
      if (match) b.id = getNewBookmarkId(bookmarks);
    }, bookmarks);
  }
  // Fix any still missing.
  eachBookmark((b: BookmarkNode) => {
    if (b.id === undefined) b.id = getNewBookmarkId(bookmarks);
  }, bookmarks);

  return bookmarks;
}

/** Remove every bookmark inside the native containers (toolbar only if synced). */
export async function clearNativeBookmarks(api: BookmarkApi, syncToolbar: boolean): Promise<void> {
  const ids = await getContainerIds(api);
  const targets = [ids.menu, ids.other, ...(syncToolbar ? [ids.toolbar] : [])];
  for (const id of targets) {
    const children = await api.getChildren(id);
    for (const child of children) await api.removeTree(child.id);
  }
}

async function createTree(
  api: BookmarkApi,
  parentId: string,
  bookmarks: BookmarkNode[],
): Promise<number> {
  let total = 0;
  for (const b of bookmarks) {
    if (b.url === 'xbs:separator') {
      await api.create({ parentId, type: 'separator' });
    } else {
      const created = await api.create({
        parentId,
        title: b.title,
        url: b.url ? getSupportedUrl(b.url) : undefined,
      });
      if (b.children?.length) await createTree(api, created.id, b.children);
    }
    total += 1;
  }
  return total;
}

/** Populate native containers from synced bookmarks. Returns nodes created. */
export async function createNativeBookmarksFromBookmarks(
  api: BookmarkApi,
  bookmarks: BookmarkNode[],
  syncToolbar: boolean,
): Promise<number> {
  const ids = await getContainerIds(api);
  let total = 0;
  const menu = getContainer(BookmarkContainer.Menu, bookmarks);
  if (menu?.children?.length) total += await createTree(api, ids.menu, menu.children);
  const other = getContainer(BookmarkContainer.Other, bookmarks);
  if (other?.children?.length) total += await createTree(api, ids.other, other.children);
  const toolbar = getContainer(BookmarkContainer.Toolbar, bookmarks);
  if (toolbar?.children?.length && syncToolbar) {
    total += await createTree(api, ids.toolbar, toolbar.children);
  }
  return total;
}

/**
 * Rebuild positional id mappings after a populate. Mirrors buildIdMappings:
 * native children ↔ synced container children by index, recursively.
 */
export async function buildIdMappings(
  api: BookmarkApi,
  bookmarks: BookmarkNode[],
  syncToolbar: boolean,
): Promise<BookmarkIdMapping[]> {
  const ids = await getContainerIds(api);
  const mapIds = (natives: NativeNode[], synced: BookmarkNode[]): BookmarkIdMapping[] => {
    const out: BookmarkIdMapping[] = [];
    natives.forEach((native, i) => {
      const s = synced[i];
      if (!s) return;
      out.push({ nativeId: native.id, syncedId: s.id! });
      if (native.children?.length && s.children?.length) out.push(...mapIds(native.children, s.children));
    });
    return out;
  };

  const out: BookmarkIdMapping[] = [];
  const menu = getContainer(BookmarkContainer.Menu, bookmarks);
  if (menu?.children?.length) {
    const [tree] = await api.getSubTree(ids.menu);
    out.push(...mapIds(tree.children ?? [], menu.children));
  }
  const other = getContainer(BookmarkContainer.Other, bookmarks);
  if (other?.children?.length) {
    const [tree] = await api.getSubTree(ids.other);
    out.push(...mapIds(tree.children ?? [], other.children));
  }
  const toolbar = getContainer(BookmarkContainer.Toolbar, bookmarks);
  if (toolbar?.children?.length && syncToolbar) {
    const [tree] = await api.getSubTree(ids.toolbar);
    out.push(...mapIds(tree.children ?? [], toolbar.children));
  }
  return out.sort((x, y) => x.syncedId - y.syncedId);
}

export { ensureContainersExist };
