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
import type { BookmarkIdMapping } from './id-mapper.js';
import type { BookmarkNode } from './models.js';

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
/** Chromium separator rule: dashes-only title without children, or legacy titles + newtab url. */
export function chromiumIsSeparator(node: NativeNode, newTabUrl: string): boolean {
  if (!node || node.title === undefined) return false;
  if (/^[-─]+$/.test(node.title) && !node.children?.length) return true;
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
  let otherChildren = otherTree.children ?? [];
  collect(otherTree.children);
  let menu: BookmarkNode[] = [];
  if (!opts.menuFolderInOther && ids.menu) {
    const [menuTree] = await api.getSubTree(ids.menu);
    menu = toSynced(menuTree.children ?? [], opts);
    collect(menuTree.children);
  } else if (opts.menuFolderInOther) {
    // The synced Menu container is a folder inside Other (chromium model).
    const menuFolder = otherChildren.find((c) => c.title === BookmarkContainer.Menu);
    if (menuFolder?.children) {
      menu = toSynced(menuFolder.children, opts);
    }
    otherChildren = otherChildren.filter((c) => c.title !== BookmarkContainer.Menu);
  }
  const other = toSynced(otherChildren, opts);

  let toolbar: BookmarkNode[] = [];
  if (syncToolbar) {
    const [toolbarTree] = await api.getSubTree(ids.toolbar);
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
  for (const native of sorted) {
    eachBookmark((b: BookmarkNode) => {
      if (b.id !== undefined) return;
      const match = !native.url ? b.title === native.title : b.url === native.url;
      if (match) b.id = getNewBookmarkId(bookmarks);
    }, bookmarks);
  }
  eachBookmark((b: BookmarkNode) => {
    if (b.id === undefined) b.id = getNewBookmarkId(bookmarks);
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
    if (b.url === 'xbs:separator') {
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
    let natives = tree.children ?? [];
    if (container === BookmarkContainer.Other) {
      // Skip the chromium Menu folder: it maps under the Menu container instead.
      const menuFolder = natives.find((c) => c.title === BookmarkContainer.Menu);
      const menuTarget = getContainer(BookmarkContainer.Menu, bookmarks);
      if (menuFolder?.children && menuTarget?.children?.length) {
        out.push(...mapIds(menuFolder.children, menuTarget.children));
      }
      natives = natives.filter((c) => c.title !== BookmarkContainer.Menu);
    }
    out.push(...mapIds(natives, target.children!));
  };
  await at(ids.menu, BookmarkContainer.Menu);
  await at(ids.other, BookmarkContainer.Other);
  await at(ids.toolbar, BookmarkContainer.Toolbar);
  return out.sort((x, y) => x.syncedId - y.syncedId);
}
