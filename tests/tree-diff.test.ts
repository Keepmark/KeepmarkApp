import { describe, expect, it } from 'vitest';
import { changedNodeCount, contentKey, diffTrees, sameContent } from '../src/shared/tree-diff';
import type { BookmarkNode } from '../src/shared/models';

const bm = (id: number, title: string, url: string, extra: Partial<BookmarkNode> = {}): BookmarkNode => ({ id, title, url, ...extra });
const folder = (id: number, title: string, children: BookmarkNode[]): BookmarkNode => ({ id, title, children });

describe('tree-diff', () => {
  const base = (): BookmarkNode[] => [
    folder(1, '[xbs] Other', [folder(2, 'Dev', [bm(3, 'GitHub', 'https://github.com/')]), bm(4, 'News', 'https://news.example/')]),
  ];

  it('ignores ids: same content with different ids is identical', () => {
    const renumbered = JSON.parse(JSON.stringify(base()).replace(/"id":(\d+)/g, (_m, n) => `"id":${Number(n) + 100}`));
    expect(sameContent(base(), renumbered)).toBe(true);
    expect(diffTrees(base(), renumbered).identical).toBe(true);
  });

  it('pure reorder → orderOnly, nothing moved', () => {
    const r = base();
    r[0].children!.reverse();
    const d = diffTrees(base(), r);
    expect(d).toMatchObject({ identical: false, orderOnly: true, moved: 0, metadataChanged: 0, foldersDiffer: false });
  });

  it('a bookmark in another folder counts as moved, with a readable sample', () => {
    const r: BookmarkNode[] = [folder(1, '[xbs] Other', [folder(2, 'Dev', []), bm(3, 'GitHub', 'https://github.com/'), bm(4, 'News', 'https://news.example/')])];
    const d = diffTrees(base(), r);
    expect(d.moved).toBe(1);
    expect(d.movedSample[0]).toBe('GitHub: [xbs] Other / Dev → [xbs] Other');
    expect(d.orderOnly).toBe(false);
  });

  it('description/tag edits are reported, ignoring tag order', () => {
    const l = base();
    const r = base();
    (r[0].children![1] as BookmarkNode).description = 'daily';
    expect(diffTrees(l, r)).toMatchObject({ metadataChanged: 1, metadataSample: ['News'] });
    (l[0].children![1] as BookmarkNode).tags = ['b', 'a'];
    (r[0].children![1] as BookmarkNode).tags = ['a', 'b'];
    (r[0].children![1] as BookmarkNode).description = undefined;
    expect(diffTrees(l, r).metadataChanged).toBe(0);
  });

  it('an empty folder on one side is a folder difference, not order-only', () => {
    const r = base();
    r[0].children!.push(folder(9, 'Empty', []));
    const d = diffTrees(base(), r);
    expect(d).toMatchObject({ foldersDiffer: true, orderOnly: false, moved: 0 });
  });

  it('empty description/tags equal absent ones', () => {
    const r = base();
    (r[0].children![1] as BookmarkNode).description = '';
    (r[0].children![1] as BookmarkNode).tags = [];
    expect(contentKey(base())).toBe(contentKey(r));
  });
});

describe('changedNodeCount', () => {
  const loose = (count: number): BookmarkNode[] => [
    folder(1, '[xbs] Other', Array.from({ length: count }, (_v, i) => bm(100 + i, `m${i}`, `https://m${i}.example/`))),
  ];
  const inFolder = (count: number): BookmarkNode[] => [
    folder(1, '[xbs] Other', [
      folder(10, 'Dev', Array.from({ length: count }, (_v, i) => bm(100 + i, `m${i}`, `https://m${i}.example/`))),
    ]),
  ];

  it('an ordinary addition is one change', () => {
    expect(changedNodeCount(loose(3), loose(4))).toBe(1);
  });

  it('a bookmark moved between folders counts as removal plus addition', () => {
    const before: BookmarkNode[] = [folder(1, '[xbs] Other', [folder(2, 'Dev', [bm(3, 'A', 'https://a.example/')])])];
    const after: BookmarkNode[] = [folder(1, '[xbs] Other', [folder(2, 'Dev', []), bm(3, 'A', 'https://a.example/')])];
    expect(changedNodeCount(before, after)).toBe(2);
  });

  it('moving a folder that holds > MaxSilentSyncChanges / 2 bookmarks is massive', () => {
    expect(changedNodeCount(inFolder(6), loose(6))).toBeGreaterThan(10);
    expect(changedNodeCount(inFolder(3), loose(3))).toBeLessThanOrEqual(10);
  });

  it('a wipe counts every removed node', () => {
    expect(changedNodeCount(loose(12), loose(0))).toBe(12);
  });
});
