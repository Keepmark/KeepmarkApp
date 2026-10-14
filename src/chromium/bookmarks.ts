// Chromium native bookmark service. Thin wrapper over the shared generic
// layer with Chromium roots (Other + Toolbar, found by folderType), Menu as a folder inside
// Other, and bookmark-style separators (dashes title, '|' on toolbar).

import type { BookmarkNode } from '../shared/models.js';
import type { NativeNode } from '../shared/bookmarks.js';
import { HorizontalSeparatorTitle, VerticalSeparatorTitle } from '../shared/bookmarks.js';
import {
  buildMappings,
  chromiumIsSeparator,
  clearAll,
  populate,
  readAll,
  type BookmarkApi,
  type ContainerIds,
  type NativeOpts,
  ContainerNotFoundError,
} from '../shared/native.js';
import { getNewTabUrl, getSupportedUrl } from './platform.js';

export type { BookmarkApi, ContainerIds };
export { ContainerNotFoundError };
export { ensureContainersExist } from '../shared/bookmarks.js';

const newTabUrl = getNewTabUrl();

/** Canonical Chromium native opts (single source of truth for bookmarks.ts + adapter.ts). */
export const chromiumNativeOpts: NativeOpts = {
  newTabUrl,
  mapUrl: (url) => getSupportedUrl(url, newTabUrl),
  menuFolderInOther: true,
  createSeparator: (api, parentId, parentIsToolbar) =>
    api.create({
      parentId,
      title: parentIsToolbar ? VerticalSeparatorTitle : HorizontalSeparatorTitle,
      url: newTabUrl,
    }) as Promise<unknown>,
  isSeparatorNode: (node) => chromiumIsSeparator(node, newTabUrl),
};

const opts = chromiumNativeOpts;

/**
 * Pick a permanent root folder without assuming fixed ids. Chrome 134+ tags
 * roots with `folderType`; with account bookmarks a signed-in profile holds
 * two roots per type (local + account) whose ids are not '1'/'2'. Prefer the
 * account-synced one (where Chrome saves new bookmarks), then any match by
 * type, then the legacy fixed id, then the legacy position under the root.
 */
function findRoot(
  roots: NativeNode[],
  folderType: 'bookmarks-bar' | 'other',
  legacyId: string,
  legacyIndex: number,
): NativeNode | undefined {
  const typed = roots.filter((x) => x.folderType === folderType);
  if (typed.length > 0) return typed.find((x) => x.syncing) ?? typed[0];
  if (roots.some((x) => x.folderType !== undefined)) return undefined;
  return roots.find((x) => x.id === legacyId) ?? roots.filter((x) => !x.url)[legacyIndex];
}

export async function getContainerIds(api: BookmarkApi): Promise<ContainerIds> {
  const [root] = await api.getTree();
  const roots = root?.children ?? [];
  const toolbar = findRoot(roots, 'bookmarks-bar', '1', 0);
  const other = findRoot(roots, 'other', '2', 1);
  if (!other || !toolbar || other.id === toolbar.id) throw new ContainerNotFoundError();
  return { other: other.id, toolbar: toolbar.id };
}

export function getNativeBookmarksAsBookmarks(api: BookmarkApi, syncToolbar: boolean): Promise<BookmarkNode[]> {
  return getContainerIds(api).then((ids) => readAll(api, ids, opts, syncToolbar));
}

export function clearNativeBookmarks(api: BookmarkApi, syncToolbar: boolean): Promise<void> {
  return getContainerIds(api).then((ids) => clearAll(api, ids, syncToolbar));
}

export function createNativeBookmarksFromBookmarks(
  api: BookmarkApi,
  bookmarks: BookmarkNode[],
  syncToolbar: boolean,
): Promise<number> {
  return getContainerIds(api).then((ids) => populate(api, ids, bookmarks, opts, syncToolbar));
}

export function buildIdMappings(api: BookmarkApi, bookmarks: BookmarkNode[], syncToolbar: boolean) {
  return getContainerIds(api).then((ids) => buildMappings(api, ids, bookmarks, opts, syncToolbar));
}
