// Wire models. Property names are camelCase to stay byte-compatible
// with sync blobs written by the original JS client and Keepmark.
// Port of Keepmark.Core/Models/Models.cs.

import { DescriptionMaxLength, SeparatorUrl } from './constants.js';

export interface BookmarkNode {
  id?: number;
  title?: string;
  url?: string;
  description?: string;
  tags?: string[];
  children?: BookmarkNode[];
}

export function isFolder(node: BookmarkNode): boolean {
  // Array check matches getBookmarkType in bookmarks.ts: a corrupt
  // non-array `children` (other clients, tampered backups) is a bookmark.
  return Array.isArray(node.children);
}

export function isSeparator(node: BookmarkNode, separatorUrl = SeparatorUrl): boolean {
  return node.url === separatorUrl;
}

/** Service status values mirror ApiServiceStatus in the original client. */
export enum ServiceStatus {
  Error = -1,
  Online = 1,
  Offline = 2,
  NoNewSyncs = 3,
}

export interface ServiceInfo {
  location?: string;
  maxSyncSize: number;
  message?: string;
  status: ServiceStatus;
  version?: string;
  url?: string;
  /** v1.2 capability advertisement (absent on legacy services). */
  capabilities?: ApiCapabilities;
}

/** v1.2 capability advertisement (absent on legacy services). */
export interface ApiCapabilities {
  revision?: boolean;
  conditionalGet?: boolean;
  delete?: boolean;
  /** Days an unused sync is kept before the server deletes it; 0 = forever. */
  syncExpiryDays?: number;
}

/** True when the service speaks the v1.2 extended contract. */
export function supportsV12(info: ServiceInfo): boolean {
  return info.capabilities?.revision === true;
}

/** Server-advertised `syncExpiryDays`, or undefined when absent or malformed (never trust a wire value). */
export function validExpiryDays(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Normalize a tree like Keepmark SyncEngine: empty descriptions/tags -> undefined, trim to DescriptionMaxLength. */
export function normalizeBookmarks(nodes: BookmarkNode[], maxDescription = DescriptionMaxLength): BookmarkNode[] {
  return nodes.map((n) => {
    const out: BookmarkNode = { ...n };
    if (out.description !== undefined) {
      const t = out.description.trim();
      out.description = t ? t.slice(0, maxDescription) : undefined;
    }
    if (out.tags !== undefined) {
      const tags = out.tags.map((t) => t.trim()).filter((t) => t.length > 0);
      out.tags = tags.length > 0 ? tags : undefined;
    }
    if (out.children !== undefined) out.children = normalizeBookmarks(out.children, maxDescription);
    return out;
  });
}
