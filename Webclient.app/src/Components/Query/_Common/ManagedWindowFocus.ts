export interface ManagedWindowFocusOptions {
  readonly root: HTMLElement | null;
  readonly opener?: HTMLElement | null;
  readonly initialFocusSelector?: string;
}

export interface ManagedWindowFocusLifecycle {
  readonly isOpen: () => boolean;
  readonly open: (options: ManagedWindowFocusOptions) => void;
  readonly close: () => boolean;
  readonly dispose: () => void;
}

const DEFAULT_FOCUS_SELECTOR = [
  '[autofocus]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const isConnectedFocusable = (element: HTMLElement | null | undefined): element is HTMLElement =>
  Boolean(element?.isConnected && !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');

export function focusManagedWindow({ root, initialFocusSelector = DEFAULT_FOCUS_SELECTOR }: ManagedWindowFocusOptions): HTMLElement | null {
  if (!root?.isConnected) return null;
  const target = root.querySelector<HTMLElement>(initialFocusSelector);
  if (isConnectedFocusable(target)) {
    target.focus({ preventScroll: true });
    return target;
  }
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
  return root;
}

export function restoreManagedWindowFocus(opener: HTMLElement | null | undefined): boolean {
  if (!isConnectedFocusable(opener)) return false;
  opener.focus({ preventScroll: true });
  return true;
}

export function captureManagedWindowOpener(documentRef: Document = document): HTMLElement | null {
  const active = documentRef.activeElement;
  return active instanceof HTMLElement && active !== documentRef.body ? active : null;
}

export function scheduleManagedWindowFocus(options: ManagedWindowFocusOptions): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const frame = window.requestAnimationFrame(() => focusManagedWindow(options));
  return () => window.cancelAnimationFrame(frame);
}

/**
 * Owns the focus lifecycle for one managed window without coupling it to the
 * legacy WindowManager implementation. The opener is captured once per open
 * cycle, scheduled focus is cancelled on close/dispose, and focus restoration
 * fails closed when the opener has left the document.
 */
export function createManagedWindowFocusLifecycle(documentRef: Document = document): ManagedWindowFocusLifecycle {
  let opened = false;
  let opener: HTMLElement | null = null;
  let cancelScheduledFocus: (() => void) | null = null;

  const cancelPending = () => {
    cancelScheduledFocus?.();
    cancelScheduledFocus = null;
  };

  return {
    isOpen: () => opened,
    open: options => {
      cancelPending();
      if (!opened) opener = options.opener ?? captureManagedWindowOpener(documentRef);
      opened = true;
      cancelScheduledFocus = scheduleManagedWindowFocus(options);
    },
    close: () => {
      if (!opened) return false;
      opened = false;
      cancelPending();
      const restored = restoreManagedWindowFocus(opener);
      opener = null;
      return restored;
    },
    dispose: () => {
      opened = false;
      opener = null;
      cancelPending();
    }
  };
}
