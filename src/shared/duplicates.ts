// Duplicate-URL detection + cleanup plan. Ports the Keepmark /duplicates
// page rule: group by normalized URL, the LAST copy in each group is locked
// (structural enforcement — it can never be selected for deletion).

import { eachBookmark } from './bookmarks.js';
import type { DuplicateGroup } from './messages.js';
import type { BookmarkNode } from './models.js';

export function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/$/, '');
}

export interface LocatedNode {
  id: number;
  title?: string;
  path: string;
}

/** Build breadcrumb paths for every bookmark, then group ids by normalized URL. */
export function getDuplicateGroups(bookmarks: BookmarkNode[]): DuplicateGroup[] {
  const byUrl = new Map<string, LocatedNode[]>();
  const walk = (nodes: BookmarkNode[] | undefined, trail: string[]): void => {
    for (const node of nodes ?? []) {
      if (node.url && node.id !== undefined) {
        const key = normalizeUrl(node.url);
        const list = byUrl.get(key) ?? [];
        list.push({ id: node.id, title: node.title, path: [...trail, node.title ?? ''].join(' / ') });
        byUrl.set(key, list);
      }
      if (node.children) walk(node.children, [...trail, node.title ?? '']);
    }
  };
  for (const root of bookmarks) {
    if (root.children) walk(root.children, [root.title ?? '']);
  }
  const groups: DuplicateGroup[] = [];
  for (const [url, entries] of byUrl) {
    if (entries.length > 1) groups.push({ url, entries });
  }
  return groups.sort((a, b) => b.entries.length - a.entries.length || (a.url < b.url ? -1 : 1));
}

/**
 * Ids to delete for the given groups. The last entry of each group is locked
 * and never returned. Pass a subset of entry ids to delete only those
 * (locked entries in the subset are silently ignored).
 */
export function planDuplicateDeletion(groups: DuplicateGroup[], onlyIds?: Set<number>): number[] {
  const out: number[] = [];
  for (const group of groups) {
    const locked = group.entries[group.entries.length - 1].id;
    for (const entry of group.entries) {
      if (entry.id === locked) continue;
      if (onlyIds && !onlyIds.has(entry.id)) continue;
      out.push(entry.id);
    }
  }
  return out;
}

/** Remove nodes by synced id (pure, returns a new tree). */
export function deleteByIds(bookmarks: BookmarkNode[], ids: Set<number>): BookmarkNode[] {
  const remove = (nodes: BookmarkNode[]): BookmarkNode[] =>
    nodes
      .filter((n) => n.id === undefined || !ids.has(n.id))
      .map((n) => (n.children ? { ...n, children: remove(n.children) } : n));
  return remove(bookmarks);
}

export { eachBookmark };
