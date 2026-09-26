// Duplicate-URL detection + cleanup plan. Ports the Keepmark /duplicates
// page rule: group by normalized URL, the newest copy (max id) is locked
// (structural enforcement — it can never be selected for deletion).

import { eachBookmark } from './bookmarks.js';
import { SeparatorUrl } from './constants.js';
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
      // Bare `mc_` matched legit params (mcfitting…): only Mailchimp ids go.
      if (/^(utm_|fbclid$|gclid$|msclkid$|mc_(cid|eid)$|igshid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    let out = parsed.toString();
    if (parsed.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    // NOTE: host is already lowercased above; path+query stay case-sensitive
    // per RFC (example.com/Page !== example.com/page).
    return out;
  } catch {
    // Unparsable input: legacy trim+lowercase, trailing slash and fragment
    // dropped so `x#frag` still groups with `x`.
    return raw.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

export interface LocatedNode {
  id: number;
  title?: string;
  path: string;
  url: string;
}

/** Build breadcrumb paths for every bookmark, then group ids by normalized URL. */
export function getDuplicateGroups(bookmarks: BookmarkNode[]): DuplicateGroup[] {
  const byUrl = new Map<string, LocatedNode[]>();
  const walk = (nodes: BookmarkNode[] | undefined, trail: string[]): void => {
    for (const node of nodes ?? []) {
      // Separators share the marker URL but are structural, never duplicates.
      if (node.url && node.url !== SeparatorUrl && node.id !== undefined) {
        const key = normalizeUrl(node.url);
        const list = byUrl.get(key) ?? [];
        list.push({ id: node.id, title: node.title, path: [...trail, node.title ?? ''].join(' / '), url: node.url });
        byUrl.set(key, list);
      }
      if (node.children) walk(node.children, [...trail, node.title ?? '']);
    }
  };
  // Walk from the roots themselves (not only root.children) so top-level
  // bookmarks in container-less trees are grouped too.
  walk(bookmarks, []);
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
    if (!group.entries.length) continue;
    const locked = Math.max(...group.entries.map((e) => e.id));
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
