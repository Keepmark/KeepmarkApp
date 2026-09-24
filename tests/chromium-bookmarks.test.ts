import { describe, expect, it } from 'vitest';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getContainerIds,
  getNativeBookmarksAsBookmarks,
  type BookmarkApi,
} from '../src/chromium/bookmarks';
import { getNewTabUrl, urlIsNativeConfigPage, urlIsSupported } from '../src/chromium/platform';
import { chromiumIsSeparator } from '../src/shared/native';
import { BookmarkContainer, type NativeNode } from '../src/shared/bookmarks';

/** In-memory chrome.bookmarks mock with Chromium root ids. */
function makeChromiumMockApi(): BookmarkApi & { nodes: Map<string, NativeNode> } {
  const nodes = new Map<string, NativeNode>();
  let counter = 0;
  const root: NativeNode = {
    id: '0',
    title: '',
    children: [
      { id: '1', parentId: '0', title: 'Bookmarks bar', children: [] },
      { id: '2', parentId: '0', title: 'Other bookmarks', children: [] },
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
  return {
    nodes,
    getTree: async () => [root],
    getSubTree: async (id) => [find(id)],
    getChildren: async (id) => [...(find(id).children ?? [])],
    create: async (details) => {
      counter += 1;
      const parent = find(details.parentId!);
      const node: NativeNode = {
        id: `cmock${counter}`,
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
}

describe('chromium native service', () => {
  it('reads fixed container ids', async () => {
    await expect(getContainerIds(makeChromiumMockApi())).resolves.toEqual({ other: '2', toolbar: '1' });
  });

  it('ships Menu as a folder inside Other and reads it back', async () => {
    const api = makeChromiumMockApi();
    const synced = [
      {
        title: BookmarkContainer.Menu,
        children: [{ id: 1, title: 'M', url: 'https://m.test' }],
      },
      {
        title: BookmarkContainer.Other,
        children: [{ id: 2, title: 'O', url: 'https://o.test' }],
      },
    ];
    const created = await createNativeBookmarksFromBookmarks(api, structuredClone(synced), true);
    expect(created).toBe(3); // menu folder + menu link + other link
    const otherChildren = await api.getChildren('2');
    const menuFolder = otherChildren.find((c) => c.title === BookmarkContainer.Menu)!;
    expect(menuFolder).toBeDefined();
    expect(menuFolder.children).toHaveLength(1);

    const back = await getNativeBookmarksAsBookmarks(api, true);
    const menu = back.find((c) => c.title === BookmarkContainer.Menu)!;
    expect(menu.children).toHaveLength(1);
    expect(menu.children![0].url).toBe('https://m.test');
    // Menu folder must not leak into Other.
    const other = back.find((c) => c.title === BookmarkContainer.Other)!;
    expect(other.children!.map((b) => b.title)).not.toContain(BookmarkContainer.Menu);

    const mappings = await buildIdMappings(api, back, true);
    expect(mappings.length).toBeGreaterThanOrEqual(2);
  });

  it('round-trips bookmark-style separators', async () => {
    const api = makeChromiumMockApi();
    await api.create({ parentId: '2', title: '───' });
    await api.create({ parentId: '1', title: '|' });
    const synced = await getNativeBookmarksAsBookmarks(api, true);
    const other = synced.find((c) => c.title === BookmarkContainer.Other)!;
    expect(other.children![0].url).toBe('xbs:separator');
    await clearNativeBookmarks(api, true);
    expect(await api.getChildren('2')).toHaveLength(0);
  });

  it('chromium separator detection', () => {
    const newTab = getNewTabUrl();
    expect(chromiumIsSeparator({ id: 's', title: '---' }, newTab)).toBe(true);
    expect(chromiumIsSeparator({ id: 's', title: '───' }, newTab)).toBe(true);
    expect(chromiumIsSeparator({ id: 's', title: 'x', url: 'https://x.test' }, newTab)).toBe(false);
    // Folders titled with dashes are not separators.
    expect(
      chromiumIsSeparator({ id: 's', title: '---', children: [{ id: 'c', title: 'x' }] }, newTab),
    ).toBe(false);
  });

  it('platform url rules', () => {
    expect(getNewTabUrl()).toBe('chrome://newtab/');
    expect(getNewTabUrl('edge')).toBe('edge://newtab/');
    expect(urlIsNativeConfigPage('chrome://settings')).toBe(true);
    expect(urlIsNativeConfigPage('https://example.com')).toBe(false);
    expect(urlIsSupported('https://example.com')).toBe(true);
    expect(urlIsSupported('ftp://host/file')).toBe(true);
  });
});
