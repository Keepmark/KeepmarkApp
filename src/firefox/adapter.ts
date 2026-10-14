// Firefox implementation of the background NativeAdapter.

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
import { firefoxNativeOpts, getContainerIds } from './bookmarks.js';
import type { AddNativeInput, NativeAdapter } from '../background/adapter.js';

const opts = firefoxNativeOpts;

export function makeFirefoxAdapter(api: BookmarkApi): NativeAdapter {
  const ids = (): Promise<Required<ContainerIds>> => getContainerIds(api);

  return {
    platformName: 'firefox',
    newTabUrl: opts.newTabUrl,
    isSeparatorNode: opts.isSeparatorNode,
    syncContainers: [BookmarkContainer.Menu, BookmarkContainer.Other, BookmarkContainer.Toolbar],

    rootKey: async () => {
      const c = await ids();
      return `${c.menu}|${c.other}|${c.toolbar}`;
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
      const c = await ids();
      const id = container === BookmarkContainer.Menu ? c.menu : container === BookmarkContainer.Other ? c.other : c.toolbar;
      const [tree] = await api.getSubTree(id);
      if (!tree) throw new ContainerNotFoundError('Native container vanished mid-read.');
      return tree.children ?? [];
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
        url: input.url ? opts.mapUrl(input.url) : undefined,
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
  const c = await getContainerIds(api);
  if (input.container === BookmarkContainer.Menu) return c.menu;
  if (input.container === BookmarkContainer.Toolbar) return c.toolbar;
  return c.other;
}

export type { BookmarkApi, NativeNode };

/** Build-config alias so the background entry stays platform-agnostic. */
export const makeAdapter = makeFirefoxAdapter;
