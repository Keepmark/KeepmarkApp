// @vitest-environment happy-dom
// The popup status card is about one sync: its name is the heading, and the
// technical facts stay compact (one muted line + two one-line rows) so the
// sync list below is visible without scrolling.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new DOMParser().parseFromString(
  readFileSync('src/popup.html', 'utf8'),
  'text/html',
);

describe('popup status card', () => {
  it('puts the sync name first, as the card heading', () => {
    const card = doc.querySelector('#view-main .card');
    const heading = card?.querySelector('h2#p-sync-name.status-name');
    expect(heading).not.toBeNull();
    expect(card?.firstElementChild?.firstElementChild).toBe(heading);
  });

  it('has no last-sync row: the header pill already shows it', () => {
    expect(doc.getElementById('p-last')).toBeNull();
  });

  it('keeps the technical facts on one muted line', () => {
    const meta = doc.querySelector('.status-meta');
    expect(meta?.querySelector('#p-server')).not.toBeNull();
    expect(meta?.querySelector('#p-swversion')).not.toBeNull();
    expect(meta?.querySelector('#p-service-badge')).not.toBeNull();
  });

  it('keeps sync ID and space used as one compact row each', () => {
    const facts = doc.querySelector('.status-facts');
    expect(facts?.querySelector('#p-syncid')).not.toBeNull();
    expect(facts?.querySelector('#btn-copy-id')).not.toBeNull();
    expect(facts?.querySelector('#p-space')).not.toBeNull();
    expect(facts?.querySelector('#p-space-fill')).not.toBeNull();
  });
});
