// @vitest-environment happy-dom
// Settings holds preferences only: service, API version, sync ID and the saved
// syncs are reported by Status and Sync. Every container is always synced (no
// toolbar switch), and changing the sync password is a modal task whose warning
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
    // No pointer sentence either: Settings explains only what it owns.
    expect(settings.querySelector('[data-i18n="manager.settings.syncHint"]')).toBeNull();
    for (const id of ['m-syncs-list', 'status-card']) {
      expect(settings.querySelector(`#${id}`)).toBeNull();
    }
  });

  it('keeps the log out of the sidebar behind one button', () => {
    // Troubleshooting only: no nav entry, and the panel starts folded.
    expect(doc.querySelector('#sidebar button[data-section="logs"]')).toBeNull();
    expect(doc.getElementById('sec-logs')).toBeNull();
    const toggle = settings.querySelector<HTMLButtonElement>('#m-btn-logs-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-controls')).toBe('m-logs-panel');
    const panel = settings.querySelector<HTMLElement>('#m-logs-panel');
    expect(panel?.hasAttribute('hidden')).toBe(true);
    // The disclosure holds the verbosity choice AND the old log panel.
    expect(panel?.querySelector('#m-opt-verbosity')).not.toBeNull();
    expect(panel?.querySelector('#m-btn-logs')).not.toBeNull();
    expect(panel?.querySelector('#m-log-list')).not.toBeNull();
    expect(panel?.querySelector('#logs-error')).not.toBeNull();
  });

  it('groups the remaining preferences instead of one flat column', () => {
    const groups = settings.querySelectorAll('.settings-group');
    expect(groups.length).toBe(2);
    expect(groups[0]?.querySelector('h3[data-i18n="manager.settings.safetyTitle"]')).not.toBeNull();
    expect(groups[0]?.querySelector('#m-opt-safety-keep')).not.toBeNull();
    expect(groups[1]?.querySelector('h3[data-i18n="manager.nav.logs"]')).not.toBeNull();
    // Language stays the plain top field, before the card.
    expect(settings.querySelector('#m-opt-language')).not.toBeNull();
    expect(settings.querySelector('.settings-group #m-opt-language')).toBeNull();
  });

  it('offers no toolbar switch: every container is always synced', () => {
    expect(settings.querySelector('#m-opt-toolbar')).toBeNull();
    expect(settings.querySelector('[data-i18n="manager.settings.toolbar"]')).toBeNull();
    expect(doc.getElementById('m-activate-toolbar-note')).toBeNull();
    expect(doc.getElementById('p-saved-toolbar-note')).toBeNull();
    expect('manager.settings.toolbarHint' in en).toBe(false);
  });

  it('changes the password in a modal task opened from the active sync', () => {
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.classList.contains('task')).toBe(true);
    expect(dialog.closest('section')).toBeNull();
    expect(dialog.hasAttribute('hidden')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('m-pw-title');
    // No password field is left on the page outside the task.
    for (const id of ['m-current-password', 'm-new-password', 'm-new-password-confirm']) {
      expect(doc.getElementById(id)).not.toBeNull();
      expect(dialog.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(settings.querySelector('input[type="password"]')).toBeNull();
    // The password belongs to the active sync: Settings has no trigger at all
    // (the row builds it), and the task never asks for the switch lock.
    expect(settings.querySelector('button#m-btn-password')).toBeNull();
    expect(dialog.querySelector('#m-pw-switch')).toBeNull();
    expect(dialog.querySelector('#m-pw-switch-wrap')).toBeNull();
    // The task names the sync it re-encrypts.
    expect(dialog.querySelector('#m-pw-target')).not.toBeNull();
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

  it('does not keep any change-password block in the section', () => {
    expect(settings.querySelector('#pw-error')).toBeNull();
    expect(settings.querySelector('[data-i18n="manager.settings.changePwHint"]')).toBeNull();
    expect(settings.querySelector('#pw-result')).toBeNull();
  });
});
