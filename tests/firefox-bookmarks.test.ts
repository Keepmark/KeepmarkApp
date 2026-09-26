import { describe, expect, it } from 'vitest';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getContainerIds,
  getNativeBookmarksAsBookmarks,
  type BookmarkApi,
} from '../src/firefox/bookmarks';
import { getSupportedUrl, urlIsSupported } from '../src/firefox/platform';
import type { NativeNode } from '../src/shared/bookmarks';
import { BookmarkContainer, HorizontalSeparatorTitle } from '../src/shared/bookmarks';

/** In-memory browser.bookmarks mock with Firefox root ids. */
export function makeMockApi(): BookmarkApi & { nodes: Map<string, NativeNode> } {
  const nodes = new Map<string, NativeNode>();
  let counter = 0;
  const root: NativeNode = {
    id: 'root________',
    title: '',
    children: [
      { id: 'menu________', parentId: 'root________', title: 'Bookmarks Menu', children: [] },
      { id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children: [] },
      { id: 'toolbar_____', parentId: 'root________', title: 'Bookmarks Toolbar', children: [] },
    ],
  };
  const index = (n: NativeNode): void => {
    nodes.set(n.id, n);
    n.children?.forEach(index);
  };
  index(root);

  const find = (id: string): NativeNode => {
    const n = nodes.get(id);
    if (!n) throw new Error(`no such node ${id}`);
    return n;
  };

  const api: BookmarkApi & { nodes: Map<string, NativeNode> } = {
    nodes,
    getTree: async () => [root],
    getSubTree: async (id) => [find(id)],
    getChildren: async (id) => [...(find(id).children ?? [])],
    create: async (details) => {
      counter += 1;
      const parent = find(details.parentId!);
      const node: NativeNode = {
        id: `mock${counter}`,
        parentId: parent.id,
        title: details.title ?? '',
        url: details.url,
        type: details.type ?? (details.url ? 'bookmark' : 'folder'),
        children: details.type === 'separator' || details.url ? undefined : [],
        dateAdded: Date.now() + counter,
      };
      parent.children ??= [];
      parent.children.push(node);
      nodes.set(node.id, node);
      return node;
    },
    removeTree: async (id) => {
      const n = find(id);
      const parent = n.parentId ? nodes.get(n.parentId) : undefined;
      if (parent?.children) parent.children = parent.children.filter((c) => c.id !== id);
      const drop = (x: NativeNode): void => {
        nodes.delete(x.id);
        x.children?.forEach(drop);
      };
      drop(n);
    },
  };
  return api;
}

describe('firefox native service', () => {
  it('reads container ids from the tree', async () => {
    const api = makeMockApi();
    await expect(getContainerIds(api)).resolves.toEqual({
      menu: 'menu________',
      other: 'unfiled_____',
      toolbar: 'toolbar_____',
    });
  });

  it('round-trips native -> synced -> native', async () => {
    const api = makeMockApi();
    await api.create({ parentId: 'unfiled_____', title: 'Example', url: 'https://example.com' });
    await api.create({ parentId: 'unfiled_____', type: 'separator' });
    await api.create({ parentId: 'menu________', title: 'Menu link', url: 'https://menu.test' });

    const synced = await getNativeBookmarksAsBookmarks(api, true);
    expect(synced.map((c) => c.title)).toContain(BookmarkContainer.Other);
    const other = synced.find((c) => c.title === BookmarkContainer.Other)!;
    expect(other.children).toHaveLength(2);
    expect(other.children![1]).toEqual({ url: 'xbs:separator', id: expect.any(Number) });

    await clearNativeBookmarks(api, true);
    expect(await api.getChildren('unfiled_____')).toHaveLength(0);

    const created = await createNativeBookmarksFromBookmarks(api, synced, true);
    expect(created).toBe(3);
    const children = await api.getChildren('unfiled_____');
    expect(children.map((c) => c.type)).toEqual(['bookmark', 'separator']);
  });

  it('buildIdMappings aligns native and synced children positionally', async () => {
    const api = makeMockApi();
    await api.create({ parentId: 'unfiled_____', title: 'A', url: 'https://a.test' });
    const synced = await getNativeBookmarksAsBookmarks(api, true);
    const mappings = await buildIdMappings(api, synced, true);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].syncedId).toBe(
      synced.find((c) => c.title === BookmarkContainer.Other)!.children![0].id,
    );
  });

  it('treats legacy title+newtab nodes as separators', async () => {
    const api = makeMockApi();
    await api.create({ parentId: 'unfiled_____', title: HorizontalSeparatorTitle, url: 'about:newtab' });
    const synced = await getNativeBookmarksAsBookmarks(api, true);
    const other = synced.find((c) => c.title === BookmarkContainer.Other)!;
    expect(other.children![0].url).toBe('xbs:separator');
  });

  it('matches ids by identity across containers (oldest native keeps id 1)', async () => {
    const api = makeMockApi();
    // Toolbar folder is OLDEST, but Other traverses first: positional
    // assignment would give Other id 1 — identity matching must not.
    // Folders (no url) exercise the title pool; urls exercise the url pool.
    await api.create({ parentId: 'toolbar_____', title: 'FT' });
    await api.create({ parentId: 'unfiled_____', title: 'FO' });
    await api.create({ parentId: 'toolbar_____', title: 'T', url: 'https://t.test' });
    await api.create({ parentId: 'unfiled_____', title: 'O', url: 'https://o.test' });
    const synced = await getNativeBookmarksAsBookmarks(api, true);
    const other = synced.find((c) => c.title === BookmarkContainer.Other)!;
    const toolbar = synced.find((c) => c.title === BookmarkContainer.Toolbar)!;
    expect(toolbar.children!.map((b) => b.title)).toEqual(['FT', 'T']);
    expect(toolbar.children![0].id).toBe(1);
    expect(toolbar.children![1].id).toBe(3);
    expect(other.children![0].id).toBe(2);
    expect(other.children![1].id).toBe(4);
  });

  it('skips toolbar when syncToolbar is false', async () => {
    const api = makeMockApi();
    await api.create({ parentId: 'toolbar_____', title: 'T', url: 'https://t.test' });
    const synced = await getNativeBookmarksAsBookmarks(api, false);
    const toolbar = synced.find((c) => c.title === BookmarkContainer.Toolbar)!;
    expect(toolbar.children ?? []).toHaveLength(0);
  });

  it('url support is case-insensitive (uppercase schemes stay intact)', () => {
    expect(urlIsSupported('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(urlIsSupported('FTP://host/file')).toBe(true);
    expect(urlIsSupported('chrome://settings')).toBe(false);
    expect(urlIsSupported('data:text/plain,hi')).toBe(false);
    expect(getSupportedUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });
});
