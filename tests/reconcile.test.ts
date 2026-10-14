import { describe, expect, it } from 'vitest';
import { BookmarkContainer, type NativeNode } from '../src/shared/bookmarks';
import type { BookmarkIdMapping } from '../src/shared/id-mapper';
import type { BookmarkNode } from '../src/shared/models';
import { reconcileContainer } from '../src/shared/reconcile';

const NEW_TAB = 'about:newtab';

function syncedTree(): BookmarkNode[] {
  return [
    {
      title: BookmarkContainer.Other,
      children: [
        { id: 1, title: 'A', url: 'https://a.test' },
        { id: 2, title: 'Folder', children: [{ id: 3, title: 'B', url: 'https://b.test' }] },
      ],
    },
  ];
}

function mappings(): BookmarkIdMapping[] {
  return [
    { nativeId: 'n1', syncedId: 1 },
    { nativeId: 'n2', syncedId: 2 },
    { nativeId: 'n3', syncedId: 3 },
  ];
}

function natives(): NativeNode[] {
  return [
    { id: 'n1', title: 'A', url: 'https://a.test' },
    { id: 'n2', title: 'Folder', children: [{ id: 'n3', title: 'B', url: 'https://b.test' }] },
  ];
}

describe('reconcileContainer', () => {
  it('no changes when trees match', () => {
    const res = reconcileContainer(natives(), BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(false);
    expect(res.bookmarks[0].children).toHaveLength(2);
    expect(res.mappings).toHaveLength(3);
  });

  it('adds native nodes with fresh ids', () => {
    const nn = [...natives(), { id: 'n9', title: 'New', url: 'https://new.test' }];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    const added = res.bookmarks[0].children!.find((b) => b.title === 'New')!;
    expect(added.id).toBe(4);
    expect(res.mappings.find((m) => m.nativeId === 'n9')).toEqual({ nativeId: 'n9', syncedId: 4 });
  });

  it('drops synced nodes missing natively', () => {
    const res = reconcileContainer([natives()[0]], BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    expect(res.bookmarks[0].children).toHaveLength(1);
    expect(res.mappings.find((m) => m.syncedId === 2)).toBeUndefined();
  });

  it('picks up title/url edits keeping the id', () => {
    const nn: NativeNode[] = [{ id: 'n1', title: 'A renamed', url: 'https://a.test' }];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    expect(res.bookmarks[0].children![0]).toMatchObject({ id: 1, title: 'A renamed' });
  });

  it('pure reorder marks changed so the new order is pushed', () => {
    const nn: NativeNode[] = [natives()[1], natives()[0]];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    expect(res.bookmarks[0].children!.map((b) => b.id)).toEqual([2, 1]);
  });

  it('preserves description/tags owned by the synced side', () => {
    const tree = syncedTree();
    tree[0].children![0].description = 'keep me';
    tree[0].children![0].tags = ['k'];
    const res = reconcileContainer(natives(), BookmarkContainer.Other, tree, mappings(), NEW_TAB);
    expect(res.changed).toBe(false);
    expect(res.bookmarks[0].children![0]).toMatchObject({ description: 'keep me', tags: ['k'] });
  });

  it('keeps the synced dateAdded (never a diff source) and stamps new natives', () => {
    const tree = syncedTree();
    tree[0].children![0].dateAdded = 1000;
    const nn: NativeNode[] = [
      { ...natives()[0], dateAdded: 999_999 },
      natives()[1],
      { id: 'n8', title: 'Dated', url: 'https://dated.test', dateAdded: 5000 },
      { id: 'n9', title: 'Undated', url: 'https://undated.test' },
    ];
    const before = Date.now();
    const res = reconcileContainer(nn, BookmarkContainer.Other, tree, mappings(), NEW_TAB);
    const kids = res.bookmarks[0].children!;
    expect(kids[0].dateAdded).toBe(1000);
    expect('dateAdded' in kids[1]).toBe(false);
    expect(kids[2].dateAdded).toBe(5000);
    expect(kids[3].dateAdded).toBeGreaterThanOrEqual(before);
    // Only a known node with a native-side date: no push.
    const same = reconcileContainer([{ ...natives()[0], dateAdded: 7 }, natives()[1]], BookmarkContainer.Other, tree, mappings(), NEW_TAB);
    expect(same.changed).toBe(false);
  });

  it('folder<->bookmark type flip is a change with normalized shape', () => {
    // Synced folder id 2 becomes a plain bookmark natively.
    const nn: NativeNode[] = [
      { id: 'n1', title: 'A', url: 'https://a.test' },
      { id: 'n2', title: 'Folder', url: 'https://f.test' },
    ];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    const flipped = res.bookmarks[0].children!.find((b) => b.id === 2)!;
    expect(flipped.url).toBe('https://f.test');
    expect(flipped.children).toBeUndefined();
  });

  it('uses the platform separator predicate (chromium dashes)', () => {
    const nn: NativeNode[] = [{ id: 'n1', title: '---' }];
    const chromiumSep = (n: NativeNode): boolean => n.title === '---';
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB, chromiumSep);
    expect(res.changed).toBe(true);
    const added = res.bookmarks[0].children!.find((b) => b.title === undefined);
    expect(added?.url).toBe('xbs:separator');
  });

  it('emptied native folder clears synced children', () => {
    const nn: NativeNode[] = [
      { id: 'n1', title: 'A', url: 'https://a.test' },
      { id: 'n2', title: 'Folder', children: [] },
    ];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(true);
    expect(res.bookmarks[0].children![1].children).toEqual([]);
  });

  it('nested reorder inside a folder marks changed', () => {
    const nn: NativeNode[] = [
      { id: 'n1', title: 'A', url: 'https://a.test' },
      {
        id: 'n2',
        title: 'Folder',
        children: [
          { id: 'n4', title: 'C', url: 'https://c.test' },
          { id: 'n3', title: 'B', url: 'https://b.test' },
        ],
      },
    ];
    const tree = syncedTree();
    tree[0].children![1].children!.push({ id: 4, title: 'C', url: 'https://c.test' });
    const maps: BookmarkIdMapping[] = [...mappings(), { nativeId: 'n4', syncedId: 4 }];
    const res = reconcileContainer(nn, BookmarkContainer.Other, tree, maps, NEW_TAB);
    expect(res.changed).toBe(true);
    expect(res.bookmarks[0].children![1].children!.map((b) => b.id)).toEqual([4, 3]);
  });

  it('appends a missing container instead of dropping native content', () => {
    const nn: NativeNode[] = [{ id: 'nm', title: 'M', url: 'https://m.test' }];
    const res = reconcileContainer(nn, BookmarkContainer.Menu, [], [], NEW_TAB);
    expect(res.changed).toBe(true);
    const menu = res.bookmarks.find((b) => b.title === BookmarkContainer.Menu)!;
    expect(menu.children).toHaveLength(1);
    expect(menu.children![0].url).toBe('https://m.test');
  });

  it('keeps other containers and their mappings untouched', () => {
    const withMenu: BookmarkNode[] = [
      ...syncedTree(),
      { title: BookmarkContainer.Menu, children: [{ id: 10, title: 'M', url: 'https://m.test' }] },
    ];
    const all = [...mappings(), { nativeId: 'nm', syncedId: 10 }];
    const res = reconcileContainer(natives(), BookmarkContainer.Other, withMenu, all, NEW_TAB);
    expect(res.bookmarks).toHaveLength(2);
    expect(res.mappings.find((m) => m.syncedId === 10)).toEqual({ nativeId: 'nm', syncedId: 10 });
  });
});
