// @vitest-environment happy-dom
// The popup notice for a server-removed sync is informational only: the kept
// plaintext copy is a backup, and backups live in the manager.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('popup removed-sync card offers no download or dismissal, only the manager', () => {
  const html = readFileSync('src/popup.html', 'utf8');
  expect(html).not.toContain('btn-removed-download');
  expect(html).not.toContain('btn-removed-dismiss');
  expect(html).not.toContain('removed-error');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const open = doc.getElementById('btn-removed-open-backup');
  expect(open?.getAttribute('data-i18n')).toBe('removed.openBackup');
});
