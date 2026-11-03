// @vitest-environment happy-dom
// Settings holds preferences only: service, API version, sync ID and the saved
// syncs are reported by Status and Sync. The bookmarks-toolbar switch explains
// what it does, and changing the sync password is a modal task whose warning
// states the consequence above the fields.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../src/shared/i18n/en';

const doc = new DOMParser().parseFromString(
  readFileSync('src/manager.html', 'utf8'),
  'text/html',
);
const settings = doc.getElementById('sec-settings')!;
const dialog = doc.getElementById('m-pw-dialog')!;

describe('settings screen', () => {
  it('keeps sync and service details out: they live in Status and Sync', () => {
    expect(doc.getElementById('m-service-info')).toBeNull();
    expect(settings.querySelector('dl')).toBeNull();
    // One pointer, so the information is still findable without repeating it.
    expect(settings.querySelector('[data-i18n="manager.settings.syncHint"]')).not.toBeNull();
    for (const id of ['m-syncs-list', 'status-card']) {
      expect(settings.querySelector(`#${id}`)).toBeNull();
    }
  });

  it('groups the remaining preferences instead of one flat column', () => {
    const groups = settings.querySelectorAll('.settings-group');
    expect(groups.length).toBe(2);
    expect(groups[0]?.querySelector('h3[data-i18n="manager.nav.syncs"]')).not.toBeNull();
    expect(groups[1]?.querySelector('h3[data-i18n="manager.nav.logs"]')).not.toBeNull();
    // Language stays the plain top field, before the cards.
    expect(settings.querySelector('#m-opt-language')).not.toBeNull();
    expect(settings.querySelector('.settings-group #m-opt-language')).toBeNull();
  });

  it('explains the bookmarks-toolbar switch instead of naming it alone', () => {
    const check = settings.querySelector('.check');
    const box = check?.querySelector('input#m-opt-toolbar') as HTMLInputElement | null;
    const label = check?.querySelector('b[data-i18n="manager.settings.toolbar"]');
    const hint = check?.querySelector('small[data-i18n="manager.settings.toolbarHint"]');
    expect(box?.type).toBe('checkbox');
    expect(label?.textContent).toMatch(/toolbar/i);
    // The hint says what happens on both sides and when it applies.
    expect(hint?.textContent).toMatch(/uploaded/i);
    expect(hint?.textContent).toMatch(/stays local/i);
    expect(hint?.textContent).toMatch(/next sync/i);
    expect(en['manager.settings.toolbarHint']).toContain('nothing there is uploaded');
  });

  it('changes the password in a modal task, not in the section', () => {
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.classList.contains('task')).toBe(true);
    expect(dialog.closest('section')).toBeNull();
    expect(dialog.hasAttribute('hidden')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('m-pw-title');
    // No password field is left on the page outside the task.
    for (const id of ['m-current-password', 'm-new-password', 'm-new-password-confirm', 'm-pw-switch']) {
      expect(doc.getElementById(id)).not.toBeNull();
      expect(dialog.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(settings.querySelector('input[type="password"]')).toBeNull();
    // The section keeps only the trigger, gated on a linked sync.
    const trigger = settings.querySelector('button#m-btn-password');
    expect(trigger?.hasAttribute('data-needs-link')).toBe(true);
    expect(trigger?.getAttribute('type')).toBeNull();
  });

  it('states the password-change consequence above the fields, with an icon', () => {
    const warning = dialog.querySelector('.task-warning');
    const form = dialog.querySelector('form#m-pw-form');
    expect(warning).not.toBeNull();
    expect(warning?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(warning?.textContent).toMatch(/other devices stop syncing/i);
    expect(warning!.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One submit inside the task, its Cancel beside it, errors next to it.
    const submit = form?.querySelector('#m-btn-password-go');
    expect(submit?.getAttribute('type')).toBe('submit');
    expect(submit?.textContent).toBe(en['manager.settings.changePw']);
    expect(form?.querySelector('#m-btn-password-cancel')?.getAttribute('type')).toBe('button');
    expect(form?.querySelector('#pw-error')?.getAttribute('role')).toBe('alert');
  });

  it('does not repeat the old inline change-password block', () => {
    expect(settings.querySelector('#pw-error')).toBeNull();
    expect(settings.querySelector('[data-i18n="manager.settings.changePwHint"]')).toBeNull();
    // The result of the task still lands in the section, next to its trigger.
    expect(settings.querySelector('.settings-group #pw-result')).not.toBeNull();
  });
});
