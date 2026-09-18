export type ManagedWindowFocusRestorePolicy = 'always' | 'if-focus-within';

export interface ManagedWindowFocusOptions {
  readonly root: HTMLElement | null;
  readonly opener?: HTMLElement | null;
  readonly initialFocusSelector?: string;
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
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const hasUnavailableAncestor = (element: HTMLElement): boolean => {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden || current.hasAttribute('hidden')) return true;
    if (current.hasAttribute('inert')) return true;
    if (current.getAttribute('aria-hidden') === 'true') return true;
    current = current.parentElement;
  }
  return false;
};

export const isManagedFocusCandidate = (
  element: HTMLElement | null | undefined,
): element is HTMLElement => {
  if (!element?.isConnected) return false;
  if (hasUnavailableAncestor(element)) return false;
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  return true;
};

const findInitialFocusTarget = (
  root: HTMLElement,
  selector: string,
): HTMLElement | null => {
  try {
    for (const candidate of root.querySelectorAll<HTMLElement>(selector)) {
      if (isManagedFocusCandidate(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
};

export const focusManagedWindow = ({
  root,
  initialFocusSelector = DEFAULT_FOCUS_SELECTOR,
}: ManagedWindowFocusOptions): HTMLElement | null => {
  if (!isManagedFocusCandidate(root)) return null;
  const target = findInitialFocusTarget(root, initialFocusSelector);
  if (target) {
    target.focus({ preventScroll: true });
    return target;
  }
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
  return root;
};

export const restoreManagedWindowFocus = (
  opener: HTMLElement | null | undefined,
): boolean => {
  if (!isManagedFocusCandidate(opener)) return false;
  opener.focus({ preventScroll: true });
  return opener.ownerDocument.activeElement === opener;
};

export const captureManagedWindowOpener = (
  documentRef: Document = document,
): HTMLElement | null => {
  const active = documentRef.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === documentRef.body) return null;
  return isManagedFocusCandidate(active) ? active : null;
};

export const scheduleManagedWindowFocus = (
  options: ManagedWindowFocusOptions,
): (() => void) => {
  const windowRef = options.root?.ownerDocument.defaultView;
  if (!windowRef) return () => undefined;
  const frame = windowRef.requestAnimationFrame(() => {
    focusManagedWindow(options);
  });
  return () => windowRef.cancelAnimationFrame(frame);
};

const shouldRestoreFocus = (
  documentRef: Document,
  root: HTMLElement | null,
  policy: ManagedWindowFocusRestorePolicy,
): boolean => {
  if (policy === 'always') return true;
  const active = documentRef.activeElement;
  if (!active || active === documentRef.body) return true;
  return Boolean(root && (active === root || root.contains(active)));
};

export const createManagedWindowFocusLifecycle = (
  documentRef: Document = document,
): ManagedWindowFocusLifecycle => {
  let opened = false;
  let opener: HTMLElement | null = null;
  let root: HTMLElement | null = null;
  let restorePolicy: ManagedWindowFocusRestorePolicy = 'if-focus-within';
  let cancelScheduledFocus: (() => void) | null = null;

  const cancelPending = (): void => {
    cancelScheduledFocus?.();
    cancelScheduledFocus = null;
  };

  const resetCycle = (): void => {
    opener = null;
    root = null;
    restorePolicy = 'if-focus-within';
  };

  return {
    isOpen: () => opened,
    open: (options) => {
      cancelPending();
      if (!opened) {
        opener = Object.prototype.hasOwnProperty.call(options, 'opener')
          ? options.opener ?? null
          : captureManagedWindowOpener(documentRef);
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
    },
  };
};
