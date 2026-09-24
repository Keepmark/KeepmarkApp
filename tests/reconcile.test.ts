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

  it('follows native child order (move/reorder)', () => {
    const nn: NativeNode[] = [natives()[1], natives()[0]];
    const res = reconcileContainer(nn, BookmarkContainer.Other, syncedTree(), mappings(), NEW_TAB);
    expect(res.changed).toBe(false); // same set, order is structural
    expect(res.bookmarks[0].children!.map((b) => b.id)).toEqual([2, 1]);
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
