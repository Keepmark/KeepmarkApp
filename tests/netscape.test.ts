import { describe, expect, it } from 'vitest';
import { BookmarkContainer } from '../src/shared/bookmarks';
import { SeparatorUrl } from '../src/shared/constants';
import type { BookmarkNode } from '../src/shared/models';
import { countHtmlBookmarks, htmlFileName, writeNetscape } from '../src/shared/netscape';

const tree: BookmarkNode[] = [
  {
    id: 1,
    title: BookmarkContainer.Menu,
    children: [{ id: 2, title: 'Menu link', url: 'https://menu.example/' }],
  },
  {
    id: 3,
    title: BookmarkContainer.Toolbar,
    dateAdded: 1_700_000_000_999,
    children: [
      {
        id: 4,
        title: 'A <b>&"quoted"</b>',
        url: 'https://a.example/?x=1&y=2',
        dateAdded: 1_700_000_123_456,
        tags: ['work', 'a,b', ' ', 'news'],
        description: 'line one\n\tline   two',
      },
      { id: 5, url: SeparatorUrl },
      { id: 6, title: 'Sub', children: [{ id: 7, url: 'https://no-title.example/' }] },
    ],
  },
  { id: 8, title: BookmarkContainer.Other, children: [{ id: 9, title: 'Other link', url: 'https://other.example/' }] },
];

describe('writeNetscape', () => {
  const html = writeNetscape(tree);

  it('writes the Netscape header and closes the root list', () => {
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true);
    expect(html).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    expect(html.trimEnd().endsWith('</DL><p>')).toBe(true);
  });

  it('puts Menu children at the top level and flags toolbar / other', () => {
    expect(html).toContain('\n    <DT><A HREF="https://menu.example/">Menu link</A>\n');
    expect(html).toMatch(/<DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">[^<]+<\/H3>/);
    expect(html).toMatch(/<DT><H3 UNFILED_BOOKMARKS_FOLDER="true">[^<]+<\/H3>/);
    expect(html).not.toContain('[xbs]');
    expect(html.indexOf('Menu link')).toBeLessThan(html.indexOf('PERSONAL_TOOLBAR_FOLDER'));
    expect(html.indexOf('PERSONAL_TOOLBAR_FOLDER')).toBeLessThan(html.indexOf('UNFILED_BOOKMARKS_FOLDER'));
  });

  it('escapes text and attributes, keeps dates in seconds and cleans tags', () => {
    expect(html).toContain(
      '<DT><A HREF="https://a.example/?x=1&amp;y=2" ADD_DATE="1700000123" TAGS="work,a b,news">' +
        'A &lt;b&gt;&amp;&quot;quoted&quot;&lt;/b&gt;</A>\n',
    );
    expect(html).toContain('<DD>line one line two\n');
  });

  it('writes separators as HR, nested folders, and the URL when there is no title', () => {
    expect(html).toContain('        <HR>\n');
    expect(html).toContain('        <DT><H3>Sub</H3>\n        <DL><p>\n');
    expect(html).toContain('            <DT><A HREF="https://no-title.example/">https://no-title.example/</A>\n');
  });

  it('writes unknown top-level nodes after the containers', () => {
    const out = writeNetscape([...tree, { id: 10, title: 'Loose', url: 'https://loose.example/' }]);
    expect(out.indexOf('Loose')).toBeGreaterThan(out.indexOf('Other link'));
  });

  it('writes an empty tree as an empty list', () => {
    expect(writeNetscape([])).toContain('<H1>Bookmarks</H1>\n<DL><p>\n</DL><p>\n');
  });
});

describe('countHtmlBookmarks', () => {
  it('counts links only, not folders or separators', () => {
    expect(countHtmlBookmarks(tree)).toBe(4);
  });
});

describe('htmlFileName', () => {
  const when = new Date(2026, 10, 8, 9, 5, 7);
  it('stamps local time and the sync slug', () => {
    expect(htmlFileName('Casa Mia', when)).toBe('keepmark-casa_mia-20261108-090507.html');
    expect(htmlFileName(undefined, when)).toBe('keepmark-20261108-090507.html');
  });
});
