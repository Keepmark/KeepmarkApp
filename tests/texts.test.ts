import { describe, expect, it } from 'vitest';

import {
  DeleteRemoteImplication,
  DirectionOrder,
  LinkImplication,
  UnlinkImplication,
  directionConfirm,
  dupDeleteConfirm,
  dupDeleteDone,
  removedSyncText,
  undoConfirm,
  undoneText,
} from '../src/popup/texts';

describe('workflow texts', () => {
  it('unlink says what is needed to link again and what is lost', () => {
    expect(UnlinkImplication()).toContain('sync ID and password');
    expect(UnlinkImplication()).toContain('Unsynced edits stay only here');
    expect(UnlinkImplication()).toContain('Undo is cleared');
  });

  it('delete names other devices, no undelete and no kept copy', () => {
    expect(DeleteRemoteImplication()).toContain('other devices');
    expect(DeleteRemoteImplication()).toContain('no undelete');
    expect(DeleteRemoteImplication()).toContain('keeps no copy');
    expect(DeleteRemoteImplication()).not.toContain("Backup section");
    // The safety entry is deleted with the sync: never point users there.
    expect(DeleteRemoteImplication()).not.toContain('Safety backups');
  });

  it('removed-sync text counts items and points at the manager backup', () => {
    expect(removedSyncText(1)).toContain('1 item,');
    expect(removedSyncText(3)).toContain('3 items,');
    expect(removedSyncText(3)).toContain('not encrypted');
    expect(removedSyncText(3)).toContain("manager's Backup section");
    expect(removedSyncText(3, '2026-10-01T10:00:00Z')).toContain('(last synced');
    expect(removedSyncText(3)).not.toContain('(last synced');
  });

  it('one direction order and the shared confirm vocabulary', () => {
    expect(DirectionOrder).toEqual(['pull', 'merge', 'push']);
    expect(DirectionOrder.map((d) => directionConfirm(d).confirmLabel)).toEqual([
      'Yes, download',
      'Yes, merge',
      'Yes, upload',
    ]);
    expect(directionConfirm('pull').implication).toContain('bookmarks will be replaced');
    expect(directionConfirm('push').implication).toContain('Other linked devices');
    expect(directionConfirm('merge').implication).toContain('Items deleted from only one copy may return');
  });

  it('move says the old sync and the other devices stay', () => {
    expect(LinkImplication()).toContain('old sync stays');
    expect(LinkImplication()).toContain('Other devices keep using it until you move them');
  });

  it('undo names the action in words, never the raw key', () => {
    expect(undoneText('change-password')).toBe('Undone: changed the sync password.');
    const c = undoConfirm('connect-pull');
    expect(c.confirmLabel).toBe('Yes, undo');
    expect(c.implication).toContain('downloaded the server copy');
    expect(c.implication).toContain('Changes made since then are discarded');
    expect(c.implication).not.toContain('connect-pull');
  });

  it('duplicate deletes say one copy stays and where the safety backup is', () => {
    const c = dupDeleteConfirm(3);
    expect(c.message).toBe('Delete 3 marked duplicates?');
    expect(c.implication).toContain('One copy of each URL always stays');
    expect(c.implication).toContain('safety backup');
    expect(dupDeleteDone(3)).toContain('Backup → Safety backups');
  });
});
