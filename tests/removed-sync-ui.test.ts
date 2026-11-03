// @vitest-environment happy-dom
// The popup notice for a server-removed sync is informational only: no backup
// wording and no backup actions. The kept copy lives in the manager's Backup
// section, where the user goes on their own.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('popup removed-sync card states the fact and offers nothing about backups', () => {
  const html = readFileSync('src/popup.html', 'utf8');
  expect(html).not.toContain('btn-removed-download');
  expect(html).not.toContain('btn-removed-dismiss');
  expect(html).not.toContain('btn-removed-open-backup');
  expect(html).not.toContain('removed-error');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const card = doc.getElementById('p-removed');
  expect(card?.querySelector('[data-i18n="removed.short"]')).not.toBeNull();
  expect(card?.textContent?.toLowerCase()).not.toContain('backup');
});
