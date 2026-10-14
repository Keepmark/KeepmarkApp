import { describe, expect, it } from 'vitest';
import {
  buildIdMappings,
  clearNativeBookmarks,
  createNativeBookmarksFromBookmarks,
  getContainerIds,
  getNativeBookmarksAsBookmarks,
  type BookmarkApi,
  ContainerNotFoundError,
} from '../src/chromium/bookmarks';
import { getNewTabUrl, urlIsNativeConfigPage, urlIsSupported } from '../src/chromium/platform';
import { makeChromiumAdapter } from '../src/chromium/adapter';
import { chromiumIsSeparator } from '../src/shared/native';
import { SeparatorUrl } from '../src/shared/constants';
import type { BookmarkIdMapping } from '../src/shared/id-mapper';
import { BookmarkContainer, type NativeNode } from '../src/shared/bookmarks';

/** In-memory chrome.bookmarks mock with Chromium root ids. */
export function makeChromiumMockApi(
  roots: NativeNode[] = [
    { id: '1', parentId: '0', title: 'Bookmarks bar', children: [] },
    { id: '2', parentId: '0', title: 'Other bookmarks', children: [] },
  ],
): BookmarkApi & { nodes: Map<string, NativeNode> } {
  const nodes = new Map<string, NativeNode>();
  let counter = 0;
  const root: NativeNode = { id: '0', title: '', children: roots };
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

  const rootNode = (id: string, folderType: NativeNode['folderType'], syncing?: boolean): NativeNode => ({
    id,
    parentId: '0',
    title: id,
    folderType,
    syncing,
    children: [],
  });

  it('resolves roots by folderType when ids differ from 1/2', async () => {
    const api = makeChromiumMockApi([rootNode('7', 'bookmarks-bar', true), rootNode('8', 'other', true), rootNode('9', 'mobile', true)]);
    await expect(getContainerIds(api)).resolves.toEqual({ other: '8', toolbar: '7' });
  });

  it('prefers account (syncing) roots over local ones', async () => {
    const api = makeChromiumMockApi([
      rootNode('1', 'bookmarks-bar', false),
      rootNode('2', 'other', false),
      rootNode('3', 'mobile', false),
      rootNode('4', 'bookmarks-bar', true),
      rootNode('5', 'other', true),
      rootNode('6', 'mobile', true),
    ]);
    await expect(getContainerIds(api)).resolves.toEqual({ other: '5', toolbar: '4' });
  });

  it('ignores managed roots and falls back to the first typed match', async () => {
    const api = makeChromiumMockApi([rootNode('10', 'managed'), rootNode('11', 'bookmarks-bar', false), rootNode('12', 'other', false)]);
    await expect(getContainerIds(api)).resolves.toEqual({ other: '12', toolbar: '11' });
  });

  it('falls back to root position when neither folderType nor legacy ids exist', async () => {
    const api = makeChromiumMockApi([
      { id: 'a', parentId: '0', title: 'Bar', children: [] },
      { id: 'b', parentId: '0', title: 'Other', children: [] },
    ]);
    await expect(getContainerIds(api)).resolves.toEqual({ other: 'b', toolbar: 'a' });
  });

  it('throws when a typed tree lacks the other root', async () => {
    const api = makeChromiumMockApi([rootNode('7', 'bookmarks-bar', true), rootNode('9', 'mobile', true)]);
    await expect(getContainerIds(api)).rejects.toThrow(ContainerNotFoundError);
  });

  it('detects chromium separators inside nested folders too', async () => {
    const api = makeChromiumMockApi();
    const other = api.nodes.get('2')!;
    const sep = (id: string): NativeNode => ({ id, parentId: 'f', title: '-----', dateAdded: 2 });
    const folder: NativeNode = { id: 'f', parentId: '2', title: 'F', dateAdded: 1, children: [sep('s1')] };
    other.children!.push(sep('s0'), folder);
    api.nodes.set('f', folder);
    const bookmarks = await getNativeBookmarksAsBookmarks(api, false);
    const otherNodes = bookmarks.find((b) => b.title === BookmarkContainer.Other)!.children!;
    expect(otherNodes[0].url).toBe(SeparatorUrl);
    expect(otherNodes[1].children![0].url).toBe(SeparatorUrl);
    expect(otherNodes[1].children![0].children).toBeUndefined();
  });

  it('syncs end-to-end on an account-storage tree', async () => {
    const api = makeChromiumMockApi([rootNode('4', 'bookmarks-bar', true), rootNode('5', 'other', true)]);
    const synced = [
      { title: BookmarkContainer.Other, children: [{ title: 'a', url: 'https://a.example/' }] },
      { title: BookmarkContainer.Toolbar, children: [{ title: 'b', url: 'https://b.example/' }] },
    ];
    await createNativeBookmarksFromBookmarks(api, synced, true);
    expect(api.nodes.get('5')!.children!.map((c) => c.title)).toEqual(['a']);
    expect(api.nodes.get('4')!.children!.map((c) => c.title)).toEqual(['b']);
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
    // A dashes title WITH a real url is a bookmark: the url must survive.
    expect(chromiumIsSeparator({ id: 's', title: '---', url: 'https://x.test' }, newTab)).toBe(false);
    // Folders titled with dashes are not separators.
    expect(
      chromiumIsSeparator({ id: 's', title: '---', children: [{ id: 'c', title: 'x' }] }, newTab),
    ).toBe(false);
  });

  it('reconciles Menu and creates its folder once under concurrency', async () => {
    const api = makeChromiumMockApi();
    const adapter = makeChromiumAdapter(api);
    expect(adapter.syncContainers).toContain(BookmarkContainer.Menu);
    const mappings: BookmarkIdMapping[] = [];
    await Promise.all([
      adapter.addNative({ container: BookmarkContainer.Menu, title: 'M1', url: 'https://m1.test' }, mappings),
      adapter.addNative({ container: BookmarkContainer.Menu, title: 'M2', url: 'https://m2.test' }, mappings),
    ]);
    const other = await api.getChildren('2');
    expect(other.filter((c) => c.title === BookmarkContainer.Menu && !c.url)).toHaveLength(1);
    expect(await adapter.readContainer(BookmarkContainer.Menu)).toHaveLength(2);
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
