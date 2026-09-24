// Firefox native bookmark service. Thin wrapper over the shared generic
// layer with Firefox roots (menu________/unfiled_____/toolbar_____),
// all three containers, and type:'separator' separators.

import type { BookmarkNode } from '../shared/models.js';
import {
  buildMappings,
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

const opts: NativeOpts = {
  newTabUrl: getNewTabUrl(),
  mapUrl: getSupportedUrl,
  menuFolderInOther: false,
  createSeparator: (api, parentId) => api.create({ parentId, type: 'separator' }) as Promise<unknown>,
  isSeparatorNode: (node) => node.type === 'separator',
};

export async function getContainerIds(api: BookmarkApi): Promise<Required<ContainerIds>> {
  const [root] = await api.getTree();
  const menu = root.children?.find((x) => x.id === 'menu________');
  const other = root.children?.find((x) => x.id === 'unfiled_____');
  const toolbar = root.children?.find((x) => x.id === 'toolbar_____');
  if (!menu || !other || !toolbar) throw new ContainerNotFoundError();
  return { menu: menu.id, other: other.id, toolbar: toolbar.id };
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
