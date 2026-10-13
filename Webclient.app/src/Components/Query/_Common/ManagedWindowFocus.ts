import { getDeepActiveElement, isManagedFocusCandidate, isWithinComposedSubtree } from '../../../experience/focusCandidate';
export { isManagedFocusCandidate } from '../../../experience/focusCandidate';

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

const findInitialFocusTarget = (
  root: HTMLElement,
  selector: string,
): HTMLElement | null => {
  try {
    // QuerySelectorAll does not cross ShadowRoot boundaries. Traverse in
    // composed reading order so a shadow-hosted first action is discoverable
    // without privileging a later light-DOM button.
    const find = (parent: Element | ShadowRoot): HTMLElement | null => {
      for (const child of parent.children) {
        if (child instanceof HTMLElement && child.matches(selector) && isManagedFocusCandidate(child)) {
          return child;
        }
        if (child instanceof HTMLElement && child.shadowRoot) {
          const shadowTarget = find(child.shadowRoot);
          if (shadowTarget) return shadowTarget;
        }
        const descendant = find(child);
        if (descendant) return descendant;
      }
      return null;
    };
    return find(root);
  } catch {
    // Invalid caller selectors must never break opening the managed window.
    return null;
  }
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
  return getDeepActiveElement(opener.ownerDocument) === opener;
};

export const captureManagedWindowOpener = (
  documentRef: Document = document,
): HTMLElement | null => {
  const active = getDeepActiveElement(documentRef);
  if (!(active instanceof HTMLElement)) return null;
  if (active === documentRef.body) return null;
  return isManagedFocusCandidate(active) ? active : null;
};

export const scheduleManagedWindowFocus = (
  options: ManagedWindowFocusOptions,
): (() => void) => {
  const windowRef = options.root?.ownerDocument.defaultView;
  if (!windowRef) return () => undefined;
  const documentRef = options.root?.ownerDocument;
  const initialFocus = documentRef ? getDeepActiveElement(documentRef) : null;
  let cancelled = false;
  let frame = 0;
  const removeListeners = (): void => {
    documentRef?.removeEventListener('pointerdown', cancel, true);
    documentRef?.removeEventListener('keydown', cancel, true);
    documentRef?.removeEventListener('focusin', cancel, true);
    documentRef?.removeEventListener('visibilitychange', cancel);
    windowRef.removeEventListener('blur', cancel);
    windowRef.removeEventListener('pagehide', cancel);
  };
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    removeListeners();
    windowRef.cancelAnimationFrame(frame);
  };
  documentRef?.addEventListener('pointerdown', cancel, true);
  documentRef?.addEventListener('keydown', cancel, true);
  documentRef?.addEventListener('focusin', cancel, true);
  documentRef?.addEventListener('visibilitychange', cancel);
  windowRef.addEventListener('blur', cancel);
  windowRef.addEventListener('pagehide', cancel);
  frame = windowRef.requestAnimationFrame(() => {
    removeListeners();
    if (cancelled || documentRef?.visibilityState === 'hidden') return;
    const currentFocus = documentRef ? getDeepActiveElement(documentRef) : null;
    // A delayed focus request cannot reclaim focus after deliberate navigation.
    // Only the browser's fallback to body after opener removal is exempt.
    if (currentFocus !== initialFocus && !(
      currentFocus === documentRef?.body && initialFocus && !initialFocus.isConnected
    )) return;
    focusManagedWindow(options);
  });
  return cancel;
};

const shouldRestoreFocus = (
  documentRef: Document,
  root: HTMLElement | null,
  policy: ManagedWindowFocusRestorePolicy,
): boolean => {
  if (policy === 'always') return true;
  const active = getDeepActiveElement(documentRef);
  if (!active || active === documentRef.body) return true;
  return isWithinComposedSubtree(root, active);
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
