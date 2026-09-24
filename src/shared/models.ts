// Wire models. Property names are camelCase to stay byte-compatible
// with sync blobs written by the original JS client and Keepmark.
// Port of Keepmark.Core/Models/Models.cs.

import { DefaultServiceUrl } from './constants.js';

export interface BookmarkNode {
  id?: number;
  title?: string;
  url?: string;
  description?: string;
  tags?: string[];
  children?: BookmarkNode[];
}

export function isFolder(node: BookmarkNode): boolean {
  return node.children !== undefined && node.children !== null;
}

export function isSeparator(node: BookmarkNode, separatorUrl = 'xbs:separator'): boolean {
  return node.url === separatorUrl;
}

/** Locally stored sync credentials + state. password holds the derived key, never raw. */
export interface SyncState {
  id: string;
  serviceUrl: string;
  version?: string;
  lastUpdated?: string;
}

export function emptySyncState(): SyncState {
  return { id: '', serviceUrl: DefaultServiceUrl };
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
}

/** Normalize a tree like Keepmark SyncEngine: empty descriptions/tags -> undefined, trim 300ch. */
export function normalizeBookmarks(nodes: BookmarkNode[], maxDescription = 300): BookmarkNode[] {
  return nodes.map((n) => {
    const out: BookmarkNode = { ...n };
    if (out.description !== undefined) {
      const t = out.description.trim();
      out.description = t ? t.slice(0, maxDescription) : undefined;
    }
    if (out.tags !== undefined && out.tags.length === 0) out.tags = undefined;
    if (out.children !== undefined) out.children = normalizeBookmarks(out.children, maxDescription);
    return out;
  });
}
