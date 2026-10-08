import { describe, expect, it } from 'vitest';

import {
  DeleteRemoteImplication,
  DirectionOrder,
  MoveImplication,
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
    expect(UnlinkImplication).toContain('sync ID and its password');
    expect(UnlinkImplication).toContain('not yet synced');
    expect(UnlinkImplication).toContain('Undo is cleared');
  });

  it('delete names other devices, no undelete, and where the kept copy is', () => {
    expect(DeleteRemoteImplication).toContain('other devices');
    expect(DeleteRemoteImplication).toContain('no undelete');
    expect(DeleteRemoteImplication).toContain('Keepmark popup');
    // The safety entry is locked to the deleted sync: never point users there.
    expect(DeleteRemoteImplication).not.toContain('Safety backups');
  });

  it('removed-sync text counts items and warns the file is not encrypted', () => {
    expect(removedSyncText(1)).toContain('1 item,');
    expect(removedSyncText(3)).toContain('3 items,');
    expect(removedSyncText(3)).toContain('not encrypted');
    expect(removedSyncText(3, '2026-10-01T10:00:00Z')).toContain('(last synced');
    expect(removedSyncText(3)).not.toContain('(last synced');
  });

  it('one direction order and the shared confirm vocabulary', () => {
    expect(DirectionOrder).toEqual(['pull', 'merge', 'push']);
    expect(DirectionOrder.map((d) => directionConfirm[d].confirmLabel)).toEqual([
      'Yes, download',
      'Yes, merge',
      'Yes, upload',
    ]);
    expect(directionConfirm.pull.implication).toContain('not yet synced are lost');
    expect(directionConfirm.push.implication).toContain('other devices');
    expect(directionConfirm.merge.implication).toContain('Nothing is deleted');
  });

  it('move says the old sync and the other devices stay', () => {
    expect(MoveImplication).toContain('old sync stays');
    expect(MoveImplication).toContain('other devices stay linked');
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
    expect(c.message).toBe('Delete 3 marked duplicate(s)?');
    expect(c.implication).toContain('One copy of each URL always stays');
    expect(c.implication).toContain('safety backup');
    expect(dupDeleteDone(3)).toContain('Backup → Safety backups');
  });
});
