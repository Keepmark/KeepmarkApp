// @vitest-environment happy-dom
// Popup/full-tab layout: one scroller (the page), every action reachable at
// any zoom through the sticky action bar.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/popup/popup.css', 'utf8');
/** Body of the first rule whose selector line is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('popup.css layout', () => {
  it('never hides overflow on body (it would remove the page scrollbar)', () => {
    expect(rule('body')).not.toMatch(/overflow/);
    expect(rule('body.fullpage')).not.toMatch(/overflow/);
  });

  it('has a single scroller: no inner scrolling box, no fixed body height', () => {
    expect(rule('body')).not.toMatch(/max-height|height:/);
    expect(rule('main')).not.toMatch(/overflow/);
    expect(css).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
  });

  it('action bar is sticky at the window bottom', () => {
    const actions = rule('.row.actions');
    expect(actions).toMatch(/position:\s*sticky/);
    expect(actions).toMatch(/bottom:\s*0/);
    expect(actions).toMatch(/background:/);
  });

  it('both popup action bars use the sticky class', () => {
    const html = readFileSync('src/popup.html', 'utf8');
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
    expect(doc.querySelector('#view-connect > .row.actions #btn-connect')).not.toBeNull();
    expect(doc.querySelector('#view-main > .row.actions #btn-sync-now')).not.toBeNull();
  });
});
