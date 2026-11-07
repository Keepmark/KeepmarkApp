// @vitest-environment happy-dom
// Popup/full-tab layout: every action stays reachable at any zoom.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FitDelayMs, fitNow, fitToWindow, PopupMaxHeight } from '../src/popup/layout';

const css = readFileSync('src/popup/popup.css', 'utf8');
/** Body of the first rule whose selector line is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('popup.css layout', () => {
  it('full tab never hides overflow (it would remove the page scrollbar)', () => {
    expect(rule('body.fullpage')).not.toMatch(/overflow/);
    expect(rule('body')).not.toMatch(/overflow/);
    expect(rule('body.fullpage main')).toMatch(/overflow:\s*visible/);
  });

  it('popup caps the body to the window and scrolls main', () => {
    expect(rule('body')).toMatch(/max-height:\s*min\(600px,\s*var\(--win-h,\s*600px\)\)/);
    expect(rule('body')).toMatch(/flex-direction:\s*column/);
    expect(rule('main')).toMatch(/overflow-y:\s*auto/);
    expect(rule('main')).toMatch(/min-height:\s*0/);
  });

  it('action bar is sticky at the bottom of the scrolling area', () => {
    const actions = rule('.row.actions');
    expect(actions).toMatch(/position:\s*sticky/);
    expect(actions).toMatch(/bottom:\s*-14px/);
    expect(rule('body.fullpage .row.actions')).toMatch(/bottom:\s*0/);
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

describe('fitToWindow', () => {
  const root = () => document.documentElement;
  function size(innerHeight: number, scrollHeight: number): void {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    Object.defineProperty(root(), 'scrollHeight', { configurable: true, value: scrollHeight });
  }
  beforeEach(() => {
    document.body.className = '';
    root().style.removeProperty('--win-h');
  });
  afterEach(() => vi.useRealTimers());

  it('caps to the window when zoom leaves the popup shorter than its content', () => {
    size(400, 600);
    fitNow();
    expect(root().style.getPropertyValue('--win-h')).toBe('400px');
  });

  it('leaves the 600 px layout alone when it fits', () => {
    size(PopupMaxHeight, 600);
    fitNow();
    expect(root().style.getPropertyValue('--win-h')).toBe('');
    size(400, 380);
    fitNow();
    expect(root().style.getPropertyValue('--win-h')).toBe('');
  });

  it('never caps the full tab', () => {
    document.body.classList.add('fullpage');
    size(400, 1200);
    fitNow();
    expect(root().style.getPropertyValue('--win-h')).toBe('');
  });

  it('debounced: drops the cap at once, measures after the popup settled', () => {
    vi.useFakeTimers();
    root().style.setProperty('--win-h', '300px');
    size(400, 600);
    fitToWindow();
    expect(root().style.getPropertyValue('--win-h')).toBe('');
    size(500, 600); // the popup grew meanwhile
    fitToWindow();
    vi.advanceTimersByTime(FitDelayMs);
    expect(root().style.getPropertyValue('--win-h')).toBe('500px');
  });
});
