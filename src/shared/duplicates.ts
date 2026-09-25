// Duplicate-URL detection + cleanup plan. Ports the Keepmark /duplicates
// page rule: group by normalized URL, the newest copy (max id) is locked
// (structural enforcement — it can never be selected for deletion).

import { eachBookmark } from './bookmarks.js';
import type { DuplicateGroup } from './messages.js';
import type { BookmarkNode } from './models.js';

/**
 * Normalize a URL for duplicate grouping: lowercase host, strip default
 * ports/fragments/trailing slashes (non-root), drop common tracking params.
 * Falls back to the legacy trim+lowercase for unparsable input.
 */
export function normalizeUrl(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(raw);
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|msclkid$|mc_|igshid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    let out = parsed.toString();
    if (parsed.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
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
    if (entries.length <= 1) continue;
    // Deterministic order: ascending id, so the locked survivor (max id,
    // i.e. the newest bookmark) is stable no matter how the UI sorts groups.
    entries.sort((a, b) => a.id - b.id);
    groups.push({ url, entries });
  }
  return groups.sort((a, b) => b.entries.length - a.entries.length || (a.url < b.url ? -1 : 1));
}

/**
 * Ids to delete for the given groups. Entries are id-sorted with the max id
 * locked (the newest copy always survives, deterministically). Pass a subset
 * of entry ids to delete only those (locked entries in the subset are
 * silently ignored).
 *
 * Atomicity note: deletions run as sequential whole-blob reconcile+push
 * steps, so no partial blob is ever persisted — each step leaves a
 * consistent state behind.
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
