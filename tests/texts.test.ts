import { describe, expect, it } from 'vitest';

import { DeleteRemoteImplication, UnlinkImplication, removedSyncText } from '../src/popup/texts';

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
});
