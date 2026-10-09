// Generic native-bookmark operations shared by Firefox and Chromium.
// Ports the common logic of webext-bookmark.service.ts plus the two
// platform overrides (firefox-bookmark / chromium-bookmark services).
//
// Differences encoded in NativeOpts:
// - Firefox: three real root containers; separators are type:'separator'.
// - Chromium: roots Other('2') + Toolbar('1'); the synced Menu container is
//   a folder named "[xbs] Menu" inside Other; separators are plain bookmarks
//   titled with dashes (regex /^[-─]+$/) or the legacy newtab-url shape.

import {
  BookmarkContainer,
  eachBookmark,
  getContainer,
  getNewBookmarkId,
  nativeToSynced,
  type NativeNode,
} from './bookmarks.js';
import { HorizontalSeparatorTitle, VerticalSeparatorTitle } from './bookmarks.js';
import { SeparatorUrl } from './constants.js';
import type { BookmarkIdMapping } from './id-mapper.js';
import type { BookmarkNode } from './models.js';
import { t } from './i18n.js';

export interface ContainerIds {
  menu?: string;
  other: string;
  toolbar: string;
}

export interface NativeOpts {
  newTabUrl: string;
  /** Map a synced url to a creatable native url (unsupported -> new tab). */
  mapUrl: (url: string | undefined) => string;
  /** True when the platform has no native Menu root (menu = folder in Other). */
  menuFolderInOther: boolean;
  /** Create a native separator under parentId. */
  createSeparator: (api: BookmarkApi, parentId: string, parentIsToolbar: boolean) => Promise<unknown>;
  /** Detect a native separator node. */
  isSeparatorNode: (node: NativeNode) => boolean;
}

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

/** Platform-native operations injected per browser (firefox/chromium adapters). */
export interface NativeOps {
  readAll(syncToolbar: boolean): Promise<BookmarkNode[]>;
  clearAndPopulate(bookmarks: BookmarkNode[], syncToolbar: boolean): Promise<void>;
  rebuildMappings(bookmarks: BookmarkNode[], syncToolbar: boolean): Promise<BookmarkIdMapping[]>;
}

/**
 * Find the synced-Menu folder among Other's children. A user folder with the
 * same title is ambiguous by construction (same title, no url): prefer the
 * one that actually holds synced content, else the first match. Callers must
 * never assume uniqueness — duplicate "[xbs] Menu" folders are unsupported
 * and the loser stays invisible to the sync.
 */
export function findMenuFolder(children: NativeNode[] | undefined): NativeNode | undefined {
  const matches = (children ?? []).filter((c) => c.title === BookmarkContainer.Menu && !c.url);
  return matches.find((c) => (c.children?.length ?? 0) > 0) ?? matches[0];
}

export function makeNativeOps(api: BookmarkApi, ids: ContainerIds, opts: NativeOpts): NativeOps {
  return {
    readAll: (syncToolbar) => readAll(api, ids, opts, syncToolbar),
    clearAndPopulate: async (bookmarks, syncToolbar) => {
      await clearAll(api, ids, syncToolbar);
      await populate(api, ids, bookmarks, opts, syncToolbar);
    },
    rebuildMappings: (bookmarks, syncToolbar) => buildMappings(api, ids, bookmarks, opts, syncToolbar),
  };
}
/** Chromium separator rule: dashes-only title without children or url, or legacy titles + newtab url.
 * NOTE: a dashes-titled bookmark WITH a real url is never a separator (the
 * url would be destroyed); an empty dashes-titled folder is structurally
 * identical to a separator bookmark on Chromium and still matches. */
export function chromiumIsSeparator(node: NativeNode, newTabUrl: string): boolean {
  if (!node || node.title === undefined) return false;
  if (/^[-─]+$/.test(node.title) && !node.children?.length && !node.url) return true;
  return (
    (node.title.includes(HorizontalSeparatorTitle) || node.title === VerticalSeparatorTitle) &&
    node.url === newTabUrl
  );
}

function toSynced(nodes: NativeNode[], opts: NativeOpts): BookmarkNode[] {
  return nativeToSynced(nodes, opts.newTabUrl, (n) => opts.isSeparatorNode(n));
}

/** Read all native bookmarks as a synced tree, assigning ids in dateAdded order. */
export async function readAll(
  api: BookmarkApi,
  ids: ContainerIds,
  opts: NativeOpts,
  syncToolbar: boolean,
): Promise<BookmarkNode[]> {
  const flat: NativeNode[] = [];
  const collect = (nodes: NativeNode[] | undefined): void => {
    if (!nodes) return;
    for (const n of nodes) {
      flat.push(n);
      if (n.children?.length) collect(n.children);
    }
  };

  const [otherTree] = await api.getSubTree(ids.other);
  if (!otherTree) throw new ContainerNotFoundError(t('err.containerOther'));
  let otherChildren = otherTree.children ?? [];
  collect(otherTree.children);
  let menu: BookmarkNode[] = [];
  if (!opts.menuFolderInOther && ids.menu) {
    const [menuTree] = await api.getSubTree(ids.menu);
    if (!menuTree) throw new ContainerNotFoundError(t('err.containerMenu'));
    menu = toSynced(menuTree.children ?? [], opts);
    collect(menuTree.children);
  } else if (opts.menuFolderInOther) {
    // The synced Menu container is a folder inside Other (chromium model).
    const menuFolder = findMenuFolder(otherChildren);
    if (menuFolder?.children) {
      menu = toSynced(menuFolder.children, opts);
    }
    otherChildren = otherChildren.filter((c) => c.title !== BookmarkContainer.Menu || !!c.url);
  }
  const other = toSynced(otherChildren, opts);

  let toolbar: BookmarkNode[] = [];
  if (syncToolbar) {
    const [toolbarTree] = await api.getSubTree(ids.toolbar);
    if (!toolbarTree) throw new ContainerNotFoundError(t('err.containerToolbar'));
    toolbar = toSynced(toolbarTree.children ?? [], opts);
    collect(toolbarTree.children);
  }

  const bookmarks: BookmarkNode[] = [];
  const otherContainer = getContainer(BookmarkContainer.Other, bookmarks, true)!;
  if (other.length > 0) otherContainer.children = other;
  const toolbarContainer = getContainer(BookmarkContainer.Toolbar, bookmarks, true)!;
  if (toolbar.length > 0) toolbarContainer.children = toolbar;
  // Firefox always has a Menu root; Chromium only when the folder exists.
  if (!opts.menuFolderInOther || menu.length > 0) {
    const menuContainer = getContainer(BookmarkContainer.Menu, bookmarks, true)!;
    if (menu.length > 0) menuContainer.children = menu;
  }

  const sorted = [...flat].sort((x, y) => (x.dateAdded ?? 0) - (y.dateAdded ?? 0));
  // Index id-less synced nodes ONCE (traversal order preserved in the queues):
  // the loop below used to rescan the whole tree per native (O(N·M)) with
  // getNewBookmarkId rescanning again per hit. Queues + a running id keep the
  // exact first-match semantics at O(N+M).
  const untaken = new Set<BookmarkNode>();
  eachBookmark((b: BookmarkNode) => {
    if (b.id === undefined) untaken.add(b);
  }, bookmarks);
  const byUrl = new Map<string, BookmarkNode[]>();
  const byTitle = new Map<string, BookmarkNode[]>();
  for (const b of untaken) {
    if (b.url !== undefined) {
      const list = byUrl.get(b.url) ?? [];
      list.push(b);
      byUrl.set(b.url, list);
    }
    // Exact title equality (undefined matches only undefined, like `===`).
    const t = b.title === undefined ? '\u0000' : b.title;
    const tlist = byTitle.get(t) ?? [];
    tlist.push(b);
    byTitle.set(t, tlist);
  }
  let nextId = getNewBookmarkId(bookmarks);
  const take = (pool: BookmarkNode[] | undefined): BookmarkNode | undefined => {
    while (pool?.length) {
      const cand = pool.shift()!;
      if (untaken.has(cand)) {
        untaken.delete(cand);
        return cand;
      }
    }
    return undefined;
  };
  for (const native of sorted) {
    // Same predicate as before: url-less natives match by title (any node),
    // natives with a url match by url.
    const target = !native.url
      ? take(byTitle.get(native.title === undefined ? '\u0000' : native.title))
      : take(byUrl.get(native.url));
    if (target) target.id = nextId++;
  }
  eachBookmark((b: BookmarkNode) => {
    if (b.id === undefined) b.id = nextId++;
  }, bookmarks);

  return bookmarks;
}

/** Remove every bookmark inside the native containers (toolbar only if synced). */
export async function clearAll(
  api: BookmarkApi,
  ids: ContainerIds,
  syncToolbar: boolean,
): Promise<void> {
  const targets = [ids.other, ...(syncToolbar ? [ids.toolbar] : [])];
  if (ids.menu) targets.unshift(ids.menu);
  for (const id of targets) {
    const children = await api.getChildren(id);
    for (const child of children) await api.removeTree(child.id);
  }
}

async function createTree(
  api: BookmarkApi,
  opts: NativeOpts,
  parentId: string,
  toolbarId: string,
  bookmarks: BookmarkNode[],
): Promise<number> {
  let total = 0;
  for (const b of bookmarks) {
    if (b.url === SeparatorUrl) {
      await opts.createSeparator(api, parentId, parentId === toolbarId);
    } else if (b.children) {
      const created = await api.create({ parentId, title: b.title });
      await createTree(api, opts, created.id, toolbarId, b.children);
    } else {
      const created = await api.create({ parentId, title: b.title, url: opts.mapUrl(b.url) });
      void created;
    }
    total += 1;
  }
  return total;
}

/** Populate native containers from synced bookmarks. Returns nodes created. */
export async function populate(
  api: BookmarkApi,
  ids: ContainerIds,
  bookmarks: BookmarkNode[],
  opts: NativeOpts,
  syncToolbar: boolean,
): Promise<number> {
  let total = 0;
  const other = getContainer(BookmarkContainer.Other, bookmarks);
  const menu = getContainer(BookmarkContainer.Menu, bookmarks);
  const toolbar = getContainer(BookmarkContainer.Toolbar, bookmarks);

  if (ids.menu && menu?.children?.length) {
    total += await createTree(api, opts, ids.menu, ids.toolbar, menu.children);
  }
  if (other?.children?.length || (opts.menuFolderInOther && menu?.children?.length)) {
    const otherNodes = [...(other?.children ?? [])];
    if (opts.menuFolderInOther && menu?.children?.length) {
      // Chromium: Menu ships as a folder inside Other.
      const created = await api.create({ parentId: ids.other, title: BookmarkContainer.Menu });
      total += 1 + (await createTree(api, opts, created.id, ids.toolbar, menu.children));
    }
    total += await createTree(api, opts, ids.other, ids.toolbar, otherNodes);
  }
  if (toolbar?.children?.length && syncToolbar) {
    total += await createTree(api, opts, ids.toolbar, ids.toolbar, toolbar.children);
  }
  return total;
}

/** Rebuild positional id mappings after a populate. */
export async function buildMappings(
  api: BookmarkApi,
  ids: ContainerIds,
  bookmarks: BookmarkNode[],
  opts: NativeOpts,
  syncToolbar: boolean,
): Promise<BookmarkIdMapping[]> {
  void opts;
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
  const at = async (id: string | undefined, container: BookmarkContainer): Promise<void> => {
    if (!id) return;
    const target = getContainer(container, bookmarks);
    if (!target?.children?.length) return;
    if (container === BookmarkContainer.Toolbar && !syncToolbar) return;
    const [tree] = await api.getSubTree(id);
    if (!tree) throw new ContainerNotFoundError(t('err.containerNative'));
    let natives = tree.children ?? [];
    if (container === BookmarkContainer.Other) {
      // Skip the chromium Menu folder: it maps under the Menu container instead.
      const menuFolder = findMenuFolder(natives);
      const menuTarget = getContainer(BookmarkContainer.Menu, bookmarks);
      if (menuFolder?.children && menuTarget?.children?.length) {
        out.push(...mapIds(menuFolder.children, menuTarget.children));
      }
      natives = natives.filter((c) => c.title !== BookmarkContainer.Menu || !!c.url);
    }
    out.push(...mapIds(natives, target.children!));
  };
  await at(ids.menu, BookmarkContainer.Menu);
  await at(ids.other, BookmarkContainer.Other);
  await at(ids.toolbar, BookmarkContainer.Toolbar);
  return out.sort((x, y) => x.syncedId - y.syncedId);
}
