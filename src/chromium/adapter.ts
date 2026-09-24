// Chromium implementation of the background NativeAdapter.
// Menu has no native root: it is a folder inside Other.

import {
  BookmarkContainer,
  type NativeNode,
} from '../shared/bookmarks.js';
import { HorizontalSeparatorTitle, VerticalSeparatorTitle } from '../shared/bookmarks.js';
import type { BookmarkIdMapping } from '../shared/id-mapper.js';
import {
  buildMappings,
  chromiumIsSeparator,
  clearAll,
  populate,
  readAll,
  type BookmarkApi,
  type ContainerIds,
  type NativeOpts,
} from '../shared/native.js';
import { getContainerIds } from './bookmarks.js';
import { getNewTabUrl, getSupportedUrl } from '../chromium/platform.js';
import type { AddNativeInput, NativeAdapter } from '../background/adapter.js';

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

async function menuFolderId(api: BookmarkApi, createIfMissing: boolean): Promise<string | undefined> {
  const c = await getContainerIds(api);
  const children = await api.getChildren(c.other);
  const folder = children.find((n) => n.title === BookmarkContainer.Menu && n.children !== undefined);
  if (folder) return folder.id;
  if (!createIfMissing) return undefined;
  const created = await api.create({ parentId: c.other, title: BookmarkContainer.Menu });
  return created.id;
}

export function makeChromiumAdapter(api: BookmarkApi): NativeAdapter {
  const ids = (): Promise<ContainerIds> => getContainerIds(api);

  return {
    platformName: 'chromium',
    newTabUrl,
    syncContainers: [BookmarkContainer.Other, BookmarkContainer.Toolbar],

    readAll: async (syncToolbar) => readAll(api, await ids(), opts, syncToolbar),

    clearAndPopulate: async (bookmarks, syncToolbar) => {
      const c = await ids();
      await clearAll(api, c, syncToolbar);
      await populate(api, c, bookmarks, opts, syncToolbar);
    },

    rebuildMappings: async (bookmarks, syncToolbar) =>
      buildMappings(api, await ids(), bookmarks, opts, syncToolbar),

    readContainer: async (container) => {
      if (container === BookmarkContainer.Menu) {
        const folderId = await menuFolderId(api, false);
        if (!folderId) return [];
        const [tree] = await api.getSubTree(folderId);
        return tree.children ?? [];
      }
      const c = await ids();
      const [tree] = await api.getSubTree(container === BookmarkContainer.Other ? c.other : c.toolbar);
      // Hide the Menu folder from Other (it reconciles under Menu instead).
      const children = tree.children ?? [];
      return container === BookmarkContainer.Other
        ? children.filter((n) => n.title !== BookmarkContainer.Menu)
        : children;
    },

    removeBySyncedId: async (syncedId, mappings) => {
      const mapping = mappings.find((m) => m.syncedId === syncedId);
      if (!mapping) throw new Error(`No native mapping for bookmark ${syncedId}`);
      await api.removeTree(mapping.nativeId);
    },

    addNative: async (input: AddNativeInput, mappings) => {
      const parentNativeId = await resolveParent(api, input, mappings);
      const created = await api.create({
        parentId: parentNativeId,
        title: input.title,
        url: input.url ? getSupportedUrl(input.url, newTabUrl) : undefined,
      });
      return created.id;
    },
  };
}

export async function resolveParent(
  api: BookmarkApi,
  input: AddNativeInput,
  mappings: BookmarkIdMapping[],
): Promise<string> {
  if (input.parentSyncedId !== undefined) {
    const mapping = mappings.find((m) => m.syncedId === input.parentSyncedId);
    if (!mapping) throw new Error(`No native mapping for parent ${input.parentSyncedId}`);
    return mapping.nativeId;
  }
  if (input.container === BookmarkContainer.Toolbar) return (await getContainerIds(api)).toolbar;
  if (input.container === BookmarkContainer.Menu) {
    const folderId = await menuFolderId(api, true);
    return folderId!;
  }
  return (await getContainerIds(api)).other;
}

export type { BookmarkApi, NativeNode };
