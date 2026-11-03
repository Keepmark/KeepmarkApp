// @vitest-environment happy-dom
// Every Sync task is a page-level modal dialog: the add wizard (with its sync
// lock gate as the first step), activation, the sync lock and the row actions.
// The rest of the page is inert while one is open, so two operations can never
// run at the same time.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new DOMParser().parseFromString(
  readFileSync('src/manager.html', 'utf8'),
  'text/html',
);

const task = (id: string): Element | null => doc.getElementById(id);

describe('sync tasks are modals', () => {
  it('keeps every task outside the sections, as a <dialog>', () => {
    for (const id of ['m-link-dialog', 'm-activate-dialog', 'm-lock-dialog', 'm-row-dialog']) {
      const dialog = task(id);
      expect(dialog?.tagName).toBe('DIALOG');
      expect(dialog?.classList.contains('task')).toBe(true);
      expect(dialog?.closest('section')).toBeNull();
      expect(dialog?.hasAttribute('hidden')).toBe(true);
    }
  });

  it('owns the whole add task: gate first, wizard in the same dialog', () => {
    const dialog = task('m-link-dialog');
    const gate = dialog?.querySelector('#m-link-gate');
    const wizard = dialog?.querySelector('#m-link-form');
    expect(gate).not.toBeNull();
    expect(wizard).not.toBeNull();
    expect(wizard?.hasAttribute('hidden')).toBe(true);
    // The proof is a step of this task, not a separate dialog on the page.
    expect(doc.getElementById('m-link-gate')?.tagName).toBe('DIV');
    expect(gate?.querySelector('form#m-link-gate-form')).not.toBeNull();
    expect(gate?.querySelector('input#m-link-gate-pw')).not.toBeNull();
    expect(gate?.querySelector('#m-btn-link-gate-go')?.getAttribute('type')).toBe('submit');
  });

  it('puts the add task Cancel next to its title, not at the end of the form', () => {
    const head = task('m-link-dialog')?.querySelector('#m-link-form .task-head');
    expect(head?.querySelector('h2#m-link-add-title')).not.toBeNull();
    expect(head?.querySelector('#m-btn-add-cancel')).not.toBeNull();
    // No second Cancel at the bottom of the wizard.
    expect(task('m-link-dialog')?.querySelectorAll('#m-btn-add-cancel')).toHaveLength(1);
  });

  it('asks the sync lock password inside the activation modal', () => {
    const dialog = task('m-activate-dialog');
    expect(dialog?.querySelector('#m-syncs-activate-text')).not.toBeNull();
    expect(dialog?.querySelector('#m-syncs-pw-row input#m-syncs-activate-pw')).not.toBeNull();
    expect(dialog?.querySelector('form#m-activate-form')).not.toBeNull();
    expect(dialog?.querySelector('#m-activate-error')?.getAttribute('role')).toBe('alert');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('m-activate-title');
  });

  it('keeps the sync lock fields in their own modal', () => {
    const dialog = task('m-lock-dialog');
    for (const id of ['m-link-lock-current-pw', 'm-link-lock-new', 'm-link-lock-confirm']) {
      expect(dialog?.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(dialog?.querySelector('#switch-pw-error')?.getAttribute('role')).toBe('alert');
    expect(doc.querySelector('#sec-syncs #m-lock-panel')).toBeNull();
  });

  it('keeps rename and the removals in the row modal', () => {
    const dialog = task('m-row-dialog');
    expect(dialog?.querySelector('#m-row-title')).not.toBeNull();
    expect(dialog?.querySelector('#m-row-field-row input#m-row-field')).not.toBeNull();
    expect(dialog?.querySelector('#m-btn-row-go')).not.toBeNull();
    expect(dialog?.querySelector('#m-row-error')?.getAttribute('role')).toBe('alert');
  });
});
