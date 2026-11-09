// Netscape bookmark file (bookmarks.html) export. Mirror of
// Keepmark.Core/Html/NetscapeBookmarks.Write in the Android app, so both
// clients produce the same layout:
//
//   [xbs] Menu children     -> top level of the file
//   [xbs] Toolbar           -> H3 PERSONAL_TOOLBAR_FOLDER
//   [xbs] Other             -> H3 UNFILED_BOOKMARKS_FOLDER
//   folder / bookmark / sep -> DT H3 + DL / DT A / HR
//
// The file is NOT encrypted: the UI warns before writing it.

import { BookmarkContainer } from './bookmarks.js';
import { backupSlug } from './backup.js';
import { t } from './i18n.js';
import { isFolder, isSeparator, type BookmarkNode } from './models.js';

export const HtmlFileSuffix = '.html';

/** `keepmark-[slug-]YYYYMMDD-HHmmss.html` in local time (same as Android). */
export function htmlFileName(syncName: string | undefined, date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const slug = backupSlug(syncName);
  return slug ? `keepmark-${slug}-${stamp}${HtmlFileSuffix}` : `keepmark-${stamp}${HtmlFileSuffix}`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESC[c]);
}

function oneLine(value: string): string {
  return value.split(/\s+/).filter((s) => s.length > 0).join(' ');
}

function indent(depth: number): string {
  return ' '.repeat(depth * 4);
}

function date(ms: number | undefined): string {
  return typeof ms === 'number' && ms > 0 ? ` ADD_DATE="${Math.floor(ms / 1000)}"` : '';
}

/** Count of real bookmarks (no folders, no separators) in the tree. */
export function countHtmlBookmarks(nodes: BookmarkNode[]): number {
  let n = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isFolder(node)) stack.push(...node.children!);
    else if (!isSeparator(node) && node.url) n++;
  }
  return n;
}

export function writeNetscape(roots: BookmarkNode[]): string {
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n',
    '<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n',
    '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n',
  ];

  const find = (title: string) => roots.find((r) => r.title === title && isFolder(r));
  const menu = find(BookmarkContainer.Menu);
  const toolbar = find(BookmarkContainer.Toolbar);
  const other = find(BookmarkContainer.Other);

  const writeNode = (node: BookmarkNode, depth: number): void => {
    if (isFolder(node)) {
      writeFolder(node, node.title, undefined, depth);
      return;
    }
    if (isSeparator(node)) {
      out.push(`${indent(depth)}<HR>\n`);
      return;
    }
    // Neither folder nor link: no browser could read it back, and
    // countHtmlBookmarks does not count it either.
    if (!node.url) return;
    let line = `${indent(depth)}<DT><A HREF="${esc(node.url)}"${date(node.dateAdded)}`;
    const tags = (node.tags ?? [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/,/g, ' ').trim())
      .filter((x) => x.length > 0);
    if (tags.length > 0) line += ` TAGS="${esc(tags.join(','))}"`;
    line += `>${esc(node.title ?? node.url ?? '')}</A>\n`;
    out.push(line);
    if (node.description && node.description.trim().length > 0) {
      out.push(`${indent(depth)}<DD>${esc(oneLine(node.description))}\n`);
    }
  };

  const writeFolder = (folder: BookmarkNode, title: string | undefined, flag: string | undefined, depth: number): void => {
    const flagAttr = flag ? ` ${flag}="true"` : '';
    out.push(`${indent(depth)}<DT><H3${date(folder.dateAdded)}${flagAttr}>${esc(title ?? '')}</H3>\n`);
    out.push(`${indent(depth)}<DL><p>\n`);
    for (const child of folder.children ?? []) writeNode(child, depth + 1);
    out.push(`${indent(depth)}</DL><p>\n`);
  };

  for (const child of menu?.children ?? []) writeNode(child, 1);
  if (toolbar) writeFolder(toolbar, t('container.toolbar'), 'PERSONAL_TOOLBAR_FOLDER', 1);
  if (other) writeFolder(other, t('container.other'), 'UNFILED_BOOKMARKS_FOLDER', 1);
  for (const root of roots) {
    if (root === menu || root === toolbar || root === other) continue;
    writeNode(root, 1);
  }

  out.push('</DL><p>\n');
  return out.join('');
}
