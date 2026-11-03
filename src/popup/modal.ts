// A task that takes over the manager: one page-level <dialog> at a time.
//
// The manager has several workflows that need the whole screen for a while
// (add a sync, activate another one, change the sync lock, rename or remove a
// saved sync). Leaving them inline meant the rest of the section stayed
// clickable: half an operation on one row, another operation started on the
// row below, and two Cancel buttons on screen. A native modal dialog makes
// everything behind it inert, so a task is the only thing the user can act on
// until it ends.
//
// Two guarantees, in one place:
//   - only one task is open: opening another closes the previous one;
//   - every async answer captures `token` and is dropped when the task it
//     belongs to was closed or replaced meanwhile.

export interface TaskDialogOptions {
  /** Runs once after the dialog closed for any reason (button, Escape,
   *  backdrop, another task opening). Idempotent: it resets the task. */
  onClose?: () => void;
}

/** The task currently owning the screen, if any. */
let current: TaskDialog | undefined;

export class TaskDialog {
  private seq = 0;
  private opener: HTMLElement | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly options: TaskDialogOptions = {},
  ) {
    dialog.hidden = true;
    // Escape cancels the task exactly like its Cancel button.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    // A click that starts and ends on the backdrop cancels; a drag that starts
    // inside (e.g. selecting text in a field) never does.
    let downOnBackdrop = false;
    const outside = (event: MouseEvent): boolean => {
      if (event.target !== dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener('pointerdown', (event) => { downOnBackdrop = outside(event); });
    dialog.addEventListener('click', (event) => {
      if (downOnBackdrop && outside(event)) this.close();
      downOnBackdrop = false;
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Bumped on every open and close: an answer from an older task is stale. */
  get token(): number {
    return this.seq;
  }

  /** Opens the task, closing any other one first. `focus` picks the initial
   *  control (a destructive confirm focuses Cancel, never the red button). */
  open(opener?: HTMLElement, focus?: HTMLElement | null): void {
    if (current && current !== this) current.close();
    current = this;
    ++this.seq;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.dialog.hidden = false;
    if (!this.dialog.open) this.dialog.showModal();
    const target = focus
      ?? this.dialog.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button.primary');
    target?.focus();
  }

  close(): void {
    // A task that never opened (or already closed) must not run onClose twice.
    if (!this.dialog.open && this.dialog.hidden) return;
    ++this.seq;
    this.dialog.hidden = true;
    if (this.dialog.open) this.dialog.close();
    if (current === this) current = undefined;
    const back = this.opener;
    this.opener = null;
    this.options.onClose?.();
    // The control that opened the task is still on the page: focus goes back
    // to it, so keyboard users do not land on the document body.
    if (back?.isConnected) back.focus();
  }
}
