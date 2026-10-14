import { describe, expect, it } from 'vitest';
import { eachBookmark } from '../src/shared/bookmarks';
import { BookmarkContainer } from '../src/shared/bookmarks';
import { mergeTrees } from '../src/shared/merge';
import type { BookmarkNode } from '../src/shared/models';

function ids(tree: BookmarkNode[]): number[] {
  const out: number[] = [];
  eachBookmark((b) => {
    if (b.id !== undefined) out.push(b.id);
  }, tree);
  return out;
}

function urls(tree: BookmarkNode[]): string[] {
  const out: string[] = [];
  eachBookmark((b) => {
    if (b.url && b.url !== 'xbs:separator') out.push(b.url);
  }, tree);
  return out;
}

const remote: BookmarkNode[] = [
  {
    title: BookmarkContainer.Other,
    children: [
      { id: 1, title: 'Shared', url: 'https://shared.test', description: 'remote meta' },
      { id: 2, title: 'Remote only', url: 'https://remote.test' },
      {
        id: 3,
        title: 'Docs',
        children: [{ id: 4, title: 'Manual', url: 'https://manual.test' }],
      },
    ],
  },
  { title: BookmarkContainer.Menu, children: [] },
];

const local: BookmarkNode[] = [
  {
    title: BookmarkContainer.Other,
    children: [
      { title: 'Shared renamed locally', url: 'https://shared.test' },
      { title: 'Local only', url: 'https://local.test' },
      {
        title: 'Docs',
        children: [{ title: 'Guide', url: 'https://guide.test' }],
      },
      { title: 'New folder', children: [{ title: 'Nested', url: 'https://nested.test' }] },
      { title: '───', url: 'xbs:separator' },
    ],
  },
];

describe('mergeTrees', () => {
  it('unions by URL keeping remote nodes, ids and metadata', () => {
    const before = JSON.stringify({ local, remote });
    const { tree, stats } = mergeTrees(local, remote);
    expect(JSON.stringify({ local, remote })).toBe(before); // inputs untouched
    expect(urls(tree).sort()).toEqual(
      ['https://shared.test', 'https://remote.test', 'https://manual.test', 'https://local.test', 'https://guide.test', 'https://nested.test'].sort(),
    );
    const shared = urls(tree).includes('https://shared.test');
    expect(shared).toBe(true);
    // Remote node kept: same id, remote title and description survive.
    let kept: BookmarkNode | undefined;
    eachBookmark((b) => {
      if (b.url === 'https://shared.test') kept = b;
    }, tree);
    expect(kept).toMatchObject({ id: 1, title: 'Shared', description: 'remote meta' });
    expect(stats).toMatchObject({
      localOnly: 3,
      remoteOnly: 2,
      titleConflicts: 1,
      foldersCreated: 1,
      separatorsAdopted: 1,
    });
  });

  it('produces unique ids above the remote max', () => {
    const { tree } = mergeTrees(local, remote);
    const all = ids(tree);
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...all.filter((id) => id > 4))).toBeGreaterThan(4);
  });

  it('merges into matched folders by path, keeps remote order first', () => {
    const { tree } = mergeTrees(local, remote);
    const other = tree.find((c) => c.title === BookmarkContainer.Other)!;
    const docs = other.children!.find((b) => b.title === 'Docs')!;
    expect(docs.id).toBe(3);
    expect(docs.children!.map((b) => b.url)).toEqual(['https://manual.test', 'https://guide.test']);
  });

  it('keeps dateAdded of adopted local nodes', () => {
    const loc: BookmarkNode[] = [
      {
        title: BookmarkContainer.Other,
        children: [
          { title: 'Local only', url: 'https://only-local.test', dateAdded: 123 },
          { title: 'Brand new folder', dateAdded: 456, children: [] },
        ],
      },
    ];
    const other = mergeTrees(loc, remote).tree.find((c) => c.title === BookmarkContainer.Other)!.children!;
    expect(other.find((n) => n.url === 'https://only-local.test')!.dateAdded).toBe(123);
    expect(other.find((n) => n.title === 'Brand new folder')!.dateAdded).toBe(456);
  });

  it('handles empty sides', () => {
    const onlyRemote = mergeTrees([], remote);
    expect(urls(onlyRemote.tree)).toEqual(urls(remote));
    expect(onlyRemote.stats.localOnly).toBe(0);
    const onlyLocal = mergeTrees(local, []);
    expect(urls(onlyLocal.tree).sort()).toEqual(urls(local).sort());
    expect(onlyLocal.stats.remoteOnly).toBe(0);
    // Missing containers adopted from the local side.
    expect(onlyLocal.tree.map((c) => c.title)).toContain(BookmarkContainer.Other);
    const empty = mergeTrees([], []);
    expect(empty.tree).toEqual([]);
  });

  it('treats tracking-param variants as the same bookmark', () => {
    const l: BookmarkNode[] = [
      { title: BookmarkContainer.Other, children: [{ title: 'A', url: 'https://a.test/?utm_source=x' }] },
    ];
    const r: BookmarkNode[] = [
      { title: BookmarkContainer.Other, children: [{ id: 1, title: 'A', url: 'https://a.test/' }] },
    ];
    const { tree, stats } = mergeTrees(l, r);
    expect(urls(tree)).toEqual(['https://a.test/']);
    expect(stats.localOnly).toBe(0);
    expect(stats.titleConflicts).toBe(0);
  });

  it('flattens corrupt bookmark-with-children instead of dropping', () => {
    const l: BookmarkNode[] = [
      {
        title: BookmarkContainer.Other,
        children: [
          {
            title: 'Weird',
            url: 'https://weird.test',
            children: [{ title: 'Kid', url: 'https://kid.test' }],
          } as BookmarkNode,
        ],
      },
    ];
    const { tree } = mergeTrees(l, []);
    expect(urls(tree).sort()).toEqual(['https://kid.test', 'https://weird.test'].sort());
  });
});
