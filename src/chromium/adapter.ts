// Chromium implementation of the background NativeAdapter.
// Menu has no native root: it is a folder inside Other.

import {
  BookmarkContainer,
  type NativeNode,
} from '../shared/bookmarks.js';
import type { BookmarkIdMapping } from '../shared/id-mapper.js';
import {
  buildMappings,
  clearAll,
  ContainerNotFoundError,
  populate,
  readAll,
  type BookmarkApi,
  type ContainerIds,
} from '../shared/native.js';
import { chromiumNativeOpts, getContainerIds } from './bookmarks.js';
import { getNewTabUrl, getSupportedUrl } from '../chromium/platform.js';
import type { AddNativeInput, NativeAdapter } from '../background/adapter.js';

const newTabUrl = getNewTabUrl();
const opts = chromiumNativeOpts;

async function menuFolderId(api: BookmarkApi, createIfMissing: boolean): Promise<string | undefined> {
  const c = await getContainerIds(api);
  const children = await api.getChildren(c.other);
  // NOTE: getChildren nodes carry no `children` array — folders are nodes
  // without a url. Checking `children !== undefined` never matches on Chrome.
  const folder = children.find((n) => n.title === BookmarkContainer.Menu && !n.url);
  if (folder) return folder.id;
  if (!createIfMissing) return undefined;
  // Create-race guard: two concurrent addNative(Menu) calls share one create
  // instead of producing twin "[xbs] Menu" folders (only one stays visible).
  menuFolderCreating ??= api.create({ parentId: c.other, title: BookmarkContainer.Menu }).then(
    (created) => {
      menuFolderCreating = undefined;
      return created.id;
    },
    (err) => {
      menuFolderCreating = undefined;
      throw err;
    },
  );
  return menuFolderCreating;
}

let menuFolderCreating: Promise<string> | undefined;

export function makeChromiumAdapter(api: BookmarkApi): NativeAdapter {
  const ids = (): Promise<ContainerIds> => getContainerIds(api);

  return {
    platformName: 'chromium',
    newTabUrl,
    isSeparatorNode: opts.isSeparatorNode,
    // Menu is a folder inside Other but reconciles as its own container:
    // readContainer(Other) hides it, readContainer(Menu) reads it.
    syncContainers: [BookmarkContainer.Menu, BookmarkContainer.Other, BookmarkContainer.Toolbar],

    rootKey: async () => {
      const c = await ids();
      return `${c.other}|${c.toolbar}`;
    },

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
        // Folder deleted between lookup and read: treat as empty, the next
        // reconcile recreates it via addNative if content exists.
        if (!tree) return [];
        return tree.children ?? [];
      }
      const c = await ids();
      const [tree] = await api.getSubTree(container === BookmarkContainer.Other ? c.other : c.toolbar);
      if (!tree) throw new ContainerNotFoundError('Native container vanished mid-read.');
      const children = tree.children ?? [];
      // Hide the Menu folder from Other (it reconciles under Menu instead).
      // Match folders only: a user bookmark legitimately titled "[xbs] Menu"
      // must never be swallowed (it would desync in a loop).
      return container === BookmarkContainer.Other
        ? children.filter((n) => n.title !== BookmarkContainer.Menu || !!n.url)
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

/** Build-config alias so the background entry stays platform-agnostic. */
export const makeAdapter = makeChromiumAdapter;
