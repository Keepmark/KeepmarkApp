// @vitest-environment happy-dom
// The add-sync gate must be a real modal: a page-level <dialog> that covers the
// manager, not a block appended at the bottom of the Sync section (where the
// user had to scroll to find it).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new DOMParser().parseFromString(
  readFileSync('src/manager.html', 'utf8'),
  'text/html',
);

describe('add-sync gate', () => {
  it('is a page-level dialog, outside every section', () => {
    const gate = doc.getElementById('m-link-gate');
    expect(gate?.tagName).toBe('DIALOG');
    expect(gate?.closest('section')).toBeNull();
    expect(doc.querySelector('#sec-syncs #m-link-gate')).toBeNull();
  });

  it('keeps the whole step inside it: field, submit, cancel, error', () => {
    const gate = doc.getElementById('m-link-gate');
    expect(gate?.querySelector('form#m-link-gate-form')).not.toBeNull();
    expect(gate?.querySelector('input#m-link-gate-pw')).not.toBeNull();
    expect(gate?.querySelector('#m-btn-link-gate-go')?.getAttribute('type')).toBe('submit');
    expect(gate?.querySelector('#m-btn-link-gate-cancel')?.getAttribute('type')).toBe('button');
    expect(gate?.querySelector('#link-gate-error')?.getAttribute('role')).toBe('alert');
  });

  it('is labelled by its own title and explanation', () => {
    const gate = doc.getElementById('m-link-gate');
    expect(gate?.getAttribute('aria-labelledby')).toBe('m-link-gate-title');
    expect(gate?.getAttribute('aria-describedby')).toBe('m-link-gate-intro');
    expect(gate?.querySelector('#m-link-gate-title')).not.toBeNull();
  });
});
