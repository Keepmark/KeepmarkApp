// Chromium native bookmark service. Thin wrapper over the shared generic
// layer with Chromium roots (Other=2, Toolbar=1), Menu as a folder inside
// Other, and bookmark-style separators (dashes title, '|' on toolbar).

import type { BookmarkNode } from '../shared/models.js';
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

const opts: NativeOpts = {
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

export async function getContainerIds(api: BookmarkApi): Promise<ContainerIds> {
  const [root] = await api.getTree();
  const other = root.children?.find((x) => x.id === '2');
  const toolbar = root.children?.find((x) => x.id === '1');
  if (!other || !toolbar) throw new ContainerNotFoundError();
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
