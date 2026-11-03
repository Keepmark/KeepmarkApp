// Content diff between two synced trees, beyond the URL-level merge stats:
// what a conflict is really about when every URL exists on both sides
// (moves between folders, description/tag edits, pure reorders) and whether
// the two sides are in fact identical (phantom conflict). Pure, DOM-free.

import { normalizeUrl } from './duplicates.js';
import { SeparatorUrl } from './constants.js';
import type { BookmarkNode } from './models.js';

export interface TreeDiff {
  /** Same content, order included (ids ignored): nothing to resolve. */
  identical: boolean;
  /** URLs on both sides that live in different folders. */
  moved: number;
  movedSample: string[];
  /** URLs on both sides, same title, different description or tags. */
  metadataChanged: number;
  metadataSample: string[];
  /** The set of folder paths differs (e.g. an empty folder on one side). */
  foldersDiffer: boolean;
  /** Same bookmarks in the same folders with the same metadata and the same
   *  folder set: only the order differs. */
  orderOnly: boolean;
}

/** Content key of a tree: titles, urls, metadata, structure — never ids. */
export function contentKey(nodes: BookmarkNode[]): string {
  const strip = (list: BookmarkNode[]): unknown[] =>
    list.map((n) => [
      n.title ?? '',
      n.url ?? null,
      n.description ? n.description : null,
      n.tags && n.tags.length > 0 ? n.tags : null,
      Array.isArray(n.children) ? strip(n.children) : null,
    ]);
  return JSON.stringify(strip(nodes));
}

export function sameContent(a: BookmarkNode[], b: BookmarkNode[]): boolean {
  return contentKey(a) === contentKey(b);
}

interface Placement {
  path: string;
  title: string;
  meta: string;
}

function placements(tree: BookmarkNode[]): Map<string, Placement[]> {
  const out = new Map<string, Placement[]>();
  const walk = (nodes: BookmarkNode[], path: string[]): void => {
    for (const n of nodes) {
      if (Array.isArray(n.children)) {
        walk(n.children, [...path, n.title ?? '']);
      } else if (n.url && n.url !== SeparatorUrl) {
        const key = normalizeUrl(n.url);
        const list = out.get(key) ?? [];
        list.push({
          path: path.join(' / '),
          title: n.title ?? '',
          meta: JSON.stringify([n.description || null, n.tags?.length ? [...n.tags].sort() : null]),
        });
        out.set(key, list);
      }
    }
  };
  walk(tree, []);
  return out;
}

/** Sorted folder paths — detects empty/extra folders. */
function folderShape(tree: BookmarkNode[]): string {
  const paths: string[] = [];
  const walk = (nodes: BookmarkNode[], path: string[]): void => {
    for (const n of nodes) {
      if (Array.isArray(n.children)) {
        const p = [...path, n.title ?? ''];
        paths.push(p.join(' / '));
        walk(n.children, p);
      }
    }
  };
  walk(tree, []);
  return paths.sort().join('\n');
}

export function diffTrees(local: BookmarkNode[], remote: BookmarkNode[], sampleSize = 5): TreeDiff {
  const identical = sameContent(local, remote);
  const l = placements(local);
  const r = placements(remote);
  let moved = 0;
  let metadataChanged = 0;
  const movedSample: string[] = [];
  const metadataSample: string[] = [];
  let sameUrlSets = l.size === r.size;
  for (const [url, lp] of l) {
    const rp = r.get(url);
    if (!rp) {
      sameUrlSets = false;
      continue;
    }
    const lPaths = lp.map((p) => p.path).sort();
    const rPaths = rp.map((p) => p.path).sort();
    if (JSON.stringify(lPaths) !== JSON.stringify(rPaths)) {
      moved += 1;
      if (movedSample.length < sampleSize) {
        movedSample.push(`${lp[0].title || url}: ${lPaths.join(', ') || '/'} → ${rPaths.join(', ') || '/'}`);
      }
    }
    if (lp[0].title === rp[0].title && lp[0].meta !== rp[0].meta) {
      metadataChanged += 1;
      if (metadataSample.length < sampleSize) metadataSample.push(lp[0].title || url);
    }
  }
  const titlesEqual = [...l].every(([url, lp]) => {
    const rp = r.get(url);
    return !rp || lp[0].title === rp[0].title;
  });
  const foldersDiffer = folderShape(local) !== folderShape(remote);
  const orderOnly =
    !identical && sameUrlSets && titlesEqual && moved === 0 && metadataChanged === 0 && !foldersDiffer;
  return { identical, moved, movedSample, metadataChanged, metadataSample, foldersDiffer, orderOnly };
}

/**
 * Magnitude of a replace: nodes that exist on one side only (bookmarks by
 * normalized URL, folders by path below the three roots). Used to spot a
 * massive, unexpected change — a wipe, a bad import, another client gone
 * wrong — so it gets a safety snapshot even though a normal sync does not.
 * The roots themselves are skipped: their titles are browser-localized.
 */
export function changedNodeCount(a: BookmarkNode[], b: BookmarkNode[]): number {
  const urls = (tree: BookmarkNode[]): Set<string> => {
    const out = new Set<string>();
    const walk = (nodes: BookmarkNode[]): void => {
      for (const n of nodes) {
        if (Array.isArray(n.children)) walk(n.children);
        else if (n.url && n.url !== SeparatorUrl) out.add(normalizeUrl(n.url));
      }
    };
    walk(tree);
    return out;
  };
  const folders = (tree: BookmarkNode[]): Set<string> => {
    const out = new Set<string>();
    const walk = (nodes: BookmarkNode[], path: string[], depth: number): void => {
      for (const n of nodes) {
        if (!Array.isArray(n.children)) continue;
        const next = [...path, n.title ?? ''];
        // Depth 0 = the three roots: their titles are localized.
        if (depth > 0) out.add(next.join(' / '));
        walk(n.children, next, depth + 1);
      }
    };
    walk(tree, [], 0);
    return out;
  };
  const count = (left: Set<string>, right: Set<string>): number => {
    let n = 0;
    for (const value of left) if (!right.has(value)) n += 1;
    for (const value of right) if (!left.has(value)) n += 1;
    return n;
  };
  return count(urls(a), urls(b)) + count(folders(a), folders(b));
}
