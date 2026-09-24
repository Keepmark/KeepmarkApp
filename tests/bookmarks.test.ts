import { describe, expect, it } from 'vitest';
import type { BookmarkNode } from '../src/shared/models';
import {
  cleanBookmark,
  ensureContainersExist,
  eachBookmark,
  findById,
  getContainer,
  getNewBookmarkId,
  nativeIsSeparator,
  nativeToSynced,
  newBookmark,
  removeEmptyContainers,
  repairBookmarkIds,
  validateBookmarkIds,
  BookmarkContainer,
  HorizontalSeparatorTitle,
  type NativeNode,
} from '../src/shared/bookmarks';

describe('bookmark helpers', () => {
  it('newBookmark builds folders vs bookmarks', () => {
    expect(newBookmark('F')).toEqual({ title: 'F', children: [] });
    const b = newBookmark('  T  ', ' https://example.com ', ' desc ', ['a']);
    expect(b).toMatchObject({ title: 'T', url: 'https://example.com', description: 'desc', tags: ['a'] });
    expect('children' in b).toBe(false);
  });

  it('newBookmark keeps only url for separators', () => {
    expect(newBookmark('---', 'xbs:separator')).toEqual({ url: 'xbs:separator' });
  });

  it('cleanBookmark drops invalid keys, empty description and empty tags', () => {
    const out = cleanBookmark({ title: 't', description: '  ', tags: [], url: 'https://x.test', foo: 1 } as never);
    expect(out).toEqual({ title: 't', url: 'https://x.test' });
  });

  it('getNewBookmarkId returns max+1 honoring taken ids', () => {
    const tree = [{ id: 1, children: [{ id: 5 }] }, { id: 3 }];
    expect(getNewBookmarkId(tree as never)).toBe(6);
    expect(getNewBookmarkId(tree as never, [10])).toBe(11);
  });

  it('containers: ensure creates all three sorted, removeEmpty drops them', () => {
    const ensured = ensureContainersExist([]);
    expect(ensured.map((c) => c.title)).toEqual([
      BookmarkContainer.Menu,
      BookmarkContainer.Other,
      BookmarkContainer.Toolbar,
    ]);
    expect(removeEmptyContainers(ensured)).toEqual([]);
    const withChild = ensureContainersExist([]);
    getContainer(BookmarkContainer.Other, withChild)!.children = [{ id: 1, title: 'x', url: 'https://x.test' }];
    expect(removeEmptyContainers(withChild).map((c) => c.title)).toEqual([BookmarkContainer.Other]);
  });

  it('validate/repair ids', () => {
    expect(validateBookmarkIds([{ id: 1 }, { id: 1 }] as never)).toBe(false);
    expect(validateBookmarkIds([{ title: 'x' }] as never)).toBe(false);
    expect(validateBookmarkIds([{ id: 1, children: [{ id: 2 }] }] as never)).toBe(true);
    const repaired = repairBookmarkIds([{ children: [{ id: 9 }, {}] }, {}] as BookmarkNode[]);
    const ids: number[] = [];
    eachBookmark((b) => ids.push(b.id!), repaired);
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(validateBookmarkIds(repaired)).toBe(true);
  });

  it('findById searches recursively', () => {
    const tree = [{ id: 1, children: [{ id: 2, title: 'deep' }] }];
    expect((findById(2, tree as never) as { title: string }).title).toBe('deep');
    expect(findById(99, tree as never)).toBeUndefined();
  });

  it('native separators detected by type or legacy title+newtab', () => {
    expect(nativeIsSeparator({ id: 's', title: '', type: 'separator' }, 'about:newtab')).toBe(true);
    expect(
      nativeIsSeparator({ id: 's', title: HorizontalSeparatorTitle, url: 'about:newtab' }, 'about:newtab'),
    ).toBe(true);
    expect(nativeIsSeparator({ id: 'b', title: 'x', url: 'https://x.test' }, 'about:newtab')).toBe(false);
  });

  it('nativeToSynced maps separators to marker url and recurses', () => {
    const natives: NativeNode[] = [
      { id: '1', title: 'A', url: 'https://a.test' },
      { id: '2', title: '', type: 'separator' },
      { id: '3', title: 'F', children: [{ id: '4', title: 'B', url: 'https://b.test' }] },
    ];
    const synced = nativeToSynced(natives, 'about:newtab');
    expect(synced[1]).toEqual({ url: 'xbs:separator' });
    expect(synced[2].children).toHaveLength(1);
  });
});
