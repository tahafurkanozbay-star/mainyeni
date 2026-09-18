export type ManagedWindowFocusRestorePolicy = 'always' | 'if-focus-within';

export interface ManagedWindowFocusOptions {
  readonly root: HTMLElement | null;
  readonly opener?: HTMLElement | null;
  readonly initialFocusSelector?: string;
  /**
   * Non-modal GIS windows should not steal focus back from a destination the
   * user deliberately reached while the window was open. `always` remains
   * available for callers that own a modal-like interaction.
   */
  readonly restorePolicy?: ManagedWindowFocusRestorePolicy;
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

const hasInertAncestor = (element: HTMLElement): boolean => {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.hasAttribute('inert')) return true;
    current = current.parentElement;
  }
  return false;
};

const isUnavailable = (element: HTMLElement): boolean => {
  if (!element.isConnected) return true;
  if (element.hidden || element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if (element.hasAttribute('disabled')) return true;
  if (hasInertAncestor(element)) return true;
  return false;
};

const isConnectedFocusable = (element: HTMLElement | null | undefined): element is HTMLElement =>
  Boolean(element && !isUnavailable(element));

const findInitialFocusTarget = (root: HTMLElement, selector: string): HTMLElement | null => {
  try {
    const candidates = root.querySelectorAll<HTMLElement>(selector);
    for (const candidate of candidates) {
      if (isConnectedFocusable(candidate)) return candidate;
    }
  } catch {
    // A feature-owned selector must never break the shared window lifecycle.
    return null;
  }
  return null;
};

export function focusManagedWindow({ root, initialFocusSelector = DEFAULT_FOCUS_SELECTOR }: ManagedWindowFocusOptions): HTMLElement | null {
  if (!root?.isConnected || isUnavailable(root)) return null;
  const target = findInitialFocusTarget(root, initialFocusSelector);
  if (target) {
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
  return active instanceof HTMLElement && active !== documentRef.body && isConnectedFocusable(active) ? active : null;
}

export function scheduleManagedWindowFocus(options: ManagedWindowFocusOptions): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const frame = window.requestAnimationFrame(() => focusManagedWindow(options));
  return () => window.cancelAnimationFrame(frame);
}

const shouldRestoreFocus = (
  documentRef: Document,
  root: HTMLElement | null,
  policy: ManagedWindowFocusRestorePolicy
): boolean => {
  if (policy === 'always') return true;
  const active = documentRef.activeElement;
  if (!active || active === documentRef.body) return true;
  return Boolean(root && (active === root || root.contains(active)));
};

/**
 * Owns the focus lifecycle for one managed window without coupling it to the
 * legacy WindowManager implementation. The opener is captured once per open
 * cycle, scheduled focus is cancelled on close/dispose, and focus restoration
 * fails closed when the opener has left the document. Non-modal windows also
 * avoid stealing focus from a destination the user reached outside the window.
 */
export function createManagedWindowFocusLifecycle(documentRef: Document = document): ManagedWindowFocusLifecycle {
  let opened = false;
  let opener: HTMLElement | null = null;
  let root: HTMLElement | null = null;
  let restorePolicy: ManagedWindowFocusRestorePolicy = 'if-focus-within';
  let cancelScheduledFocus: (() => void) | null = null;

  const cancelPending = () => {
    cancelScheduledFocus?.();
    cancelScheduledFocus = null;
  };

  const resetCycle = () => {
    opener = null;
    root = null;
    restorePolicy = 'if-focus-within';
  };

  return {
    isOpen: () => opened,
    open: options => {
      cancelPending();
      if (!opened) {
        opener = options.opener ?? captureManagedWindowOpener(documentRef);
        restorePolicy = options.restorePolicy ?? 'if-focus-within';
      }
      root = options.root;
      opened = true;
      cancelScheduledFocus = scheduleManagedWindowFocus(options);
    },
    close: () => {
      if (!opened) return false;
      opened = false;
      cancelPending();
      const restored = shouldRestoreFocus(documentRef, root, restorePolicy)
        ? restoreManagedWindowFocus(opener)
        : false;
      resetCycle();
      return restored;
    },
    dispose: () => {
      opened = false;
      cancelPending();
      resetCycle();
    }
  };
}
