// Two-way bookmark merge (union by identity). Pure: no I/O, no storage,
// inputs never mutated — the same function serves Preview (dry-run) and the
// confirmed link/switch flows, so the preview counts always match the merge.
//
// Rules:
// - Remote is the shared truth: its nodes, ids and metadata are kept as-is.
// - Local bookmarks whose normalized URL is absent remotely are adopted with
//   fresh ids (maxRemote+1…) into the matching folder (matched by full title
//   path) or a newly created one.
// - Same URL, different title → remote title wins (counted as a conflict).
// - Separators are unioned from both sides (they carry no identity; guessing
//   matches would delete user data — the merge never deletes anything).
// - Deletes are NOT merged (no tombstones in the protocol): items deleted on
//   one side while the other was offline reappear. The preview says so.

import { eachBookmark } from './bookmarks.js';
import { normalizeUrl } from './duplicates.js';
import type { BookmarkNode } from './models.js';

/** Counts shown in the pre-merge preview (wire-safe, plain data). */
export interface MergeStats {
  /** Local bookmarks absent remotely — will upload. */
  localOnly: number;
  /** Remote bookmarks absent locally — will download. */
  remoteOnly: number;
  /** Same URL both sides, different title — remote title kept. */
  titleConflicts: number;
  /** Local folders with no remote path match — created. */
  foldersCreated: number;
  /** Local separators adopted (unioned, never matched). */
  separatorsAdopted: number;
  /** Bookmarks seen locally / remotely (denominators for the preview). */
  localCount: number;
  remoteCount: number;
}

export interface MergeResult {
  tree: BookmarkNode[];
  stats: MergeStats;
}

export const SeparatorMarker = 'xbs:separator';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function maxId(tree: BookmarkNode[]): number {
  let max = 0;
  eachBookmark((b) => {
    if (b.id !== undefined && b.id > max) max = b.id;
  }, tree);
  return max;
}

function isSeparator(node: BookmarkNode): boolean {
  return node.url === SeparatorMarker;
}

function isFolder(node: BookmarkNode): boolean {
  return !node.url && Array.isArray(node.children);
}

const pathKey = (trail: string[]): string => trail.join('\n');

export function mergeTrees(local: BookmarkNode[], remote: BookmarkNode[]): MergeResult {
  const merged = clone(remote);
  let nextId = maxId(merged) + 1;
  const freshId = (): number => nextId++;

  // Remote indexes over the merged clone (nodes appended below are found).
  const byUrl = new Map<string, BookmarkNode>();
  const foldersByPath = new Map<string, BookmarkNode>();
  // Original remote URL set: remote-only is computed against the remote as
  // received, not against the merged tree (which also holds adopted nodes).
  const remoteUrls = new Set<string>();
  const indexRemote = (nodes: BookmarkNode[], trail: string[]): void => {
    for (const node of nodes) {
      if (node.url !== undefined && !isSeparator(node)) {
        const key = normalizeUrl(node.url);
        remoteUrls.add(key);
        if (!byUrl.has(key)) byUrl.set(key, node);
      }
      if (isFolder(node) || trail.length === 0) {
        // Containers (trail empty) and folders are addressable by path.
        const key = pathKey([...trail, node.title ?? '']);
        if (!foldersByPath.has(key)) foldersByPath.set(key, node);
      }
      if (node.children) indexRemote(node.children, [...trail, node.title ?? '']);
    }
  };
  indexRemote(merged, []);

  const stats: MergeStats = {
    localOnly: 0,
    remoteOnly: 0,
    titleConflicts: 0,
    foldersCreated: 0,
    separatorsAdopted: 0,
    localCount: 0,
    remoteCount: 0,
  };
  const localUrls = new Set<string>();

  const adoptSubtree = (node: BookmarkNode): BookmarkNode => {
    // Fresh ids throughout: adopted subtrees come from the local id
    // namespace and must never collide with remote ids. Counts every
    // adopted bookmark/separator/folder at all levels.
    const out: BookmarkNode = { title: node.title, id: freshId() };
    if (node.url !== undefined) out.url = node.url;
    if (node.description !== undefined) out.description = node.description;
    if (node.tags !== undefined) out.tags = [...node.tags];
    if (node.children) {
      out.children = [];
      for (const child of node.children) {
        const adopted = adoptSubtree(child);
        out.children.push(adopted);
        if (isSeparator(adopted)) stats.separatorsAdopted += 1;
        else if (adopted.url !== undefined) stats.localOnly += 1;
        else stats.foldersCreated += 1;
      }
    } else if (!out.url) {
      out.children = [];
    }
    return out;
  };

  const mergeChildren = (locals: BookmarkNode[] | undefined, target: BookmarkNode, trail: string[]): void => {
    target.children ??= [];
    for (const node of locals ?? []) {
      if (isSeparator(node)) {
        target.children.push({ ...clone(node), id: freshId() });
        stats.separatorsAdopted += 1;
        continue;
      }
      if (node.url !== undefined) {
        // Bookmark: match by normalized URL against the remote side.
        stats.localCount += 1;
        localUrls.add(normalizeUrl(node.url));
        const known = byUrl.get(normalizeUrl(node.url));
        if (known) {
          if (known.title !== node.title) stats.titleConflicts += 1;
          // Remote node kept as-is (ids + metadata untouched).
        } else {
          const adopted: BookmarkNode = { title: node.title, url: node.url, id: freshId() };
          if (node.description !== undefined) adopted.description = node.description;
          if (node.tags !== undefined) adopted.tags = [...node.tags];
          target.children.push(adopted);
          stats.localOnly += 1;
        }
        if (node.children?.length) {
          // Corrupt shape (bookmark carrying children): keep the bookmarks,
          // flatten into the same folder instead of dropping them.
          mergeChildren(node.children, target, trail);
        }
        continue;
      }
      // Folder (or url-less node): match by full title path.
      const childTrail = [...trail, node.title ?? ''];
      const match = foldersByPath.get(pathKey(childTrail));
      if (match && match.children) {
        mergeChildren(node.children, match, childTrail);
      } else {
        const created: BookmarkNode = { title: node.title, children: [], id: freshId() };
        if (node.description !== undefined) created.description = node.description;
        if (node.tags !== undefined) created.tags = [...node.tags];
        target.children.push(created);
        foldersByPath.set(pathKey(childTrail), created);
        stats.foldersCreated += 1;
        mergeChildren(node.children, created, childTrail);
      }
    }
  };

  for (const root of local) {
    const key = pathKey([root.title ?? '']);
    let target = foldersByPath.get(key);
    if (!target) {
      // Whole container missing remotely (e.g. no Menu yet): adopt with
      // fresh ids throughout so no id ever collides with the remote side.
      target = adoptSubtree(root);
      // Adopted containers themselves are structure, not content.
      merged.push(target);
      foldersByPath.set(key, target);
      // Register adopted folders for deeper path matches — without touching
      // the remote URL set (adopted nodes are local content, and remote-only
      // must stay computed against the remote as received).
      const registerFolders = (nodes: BookmarkNode[], trail: string[]): void => {
        for (const node of nodes) {
          if (isFolder(node)) {
            const k = pathKey([...trail, node.title ?? '']);
            if (!foldersByPath.has(k)) foldersByPath.set(k, node);
          }
          if (node.children) registerFolders(node.children, [...trail, node.title ?? '']);
        }
      };
      registerFolders(target.children ?? [], [root.title ?? '']);
      continue;
    }
    mergeChildren(root.children, target, [root.title ?? '']);
  }

  // Remote-only: unique remote URLs absent locally (informational — the
  // merged tree holds everything by construction).
  stats.remoteCount = remoteUrls.size;
  stats.remoteOnly = [...remoteUrls].filter((u) => !localUrls.has(u)).length;

  return { tree: merged, stats };
}
