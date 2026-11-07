// Popup height fit. Browsers cap a popup at 600 px of window height; with page
// zoom above 100% that is fewer CSS px than the 600 px the layout asks for, so
// the bottom of the page (the action bar) fell outside the window. Once the
// popup has settled and is still clipped, cap the page to the window height:
// the header stays, <main> scrolls and its sticky action bar stays in view.
// The full tab needs none of this (the page itself scrolls).

/** Height the popup layout asks for (CSS px), mirrored in popup.css. */
export const PopupMaxHeight = 600;
/** Settle time: a growing popup fires resize events before this elapses. */
export const FitDelayMs = 150;

let timer: ReturnType<typeof setTimeout> | undefined;

/** Measure now: cap `--win-h` to the window when the page overflows it. */
export function fitNow(win: Window = window): void {
  const doc = win.document;
  const root = doc.documentElement;
  root.style.removeProperty('--win-h');
  if (doc.body.classList.contains('fullpage')) return;
  const height = win.innerHeight;
  if (height > 0 && height < PopupMaxHeight && root.scrollHeight > height + 1) {
    root.style.setProperty('--win-h', `${height}px`);
  }
}

/** Debounced fit: drops the cap at once (so the popup may grow), measures
 *  after the window settled. Call on view changes and window resize. */
export function fitToWindow(win: Window = window): void {
  win.document.documentElement.style.removeProperty('--win-h');
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    fitNow(win);
  }, FitDelayMs);
}
