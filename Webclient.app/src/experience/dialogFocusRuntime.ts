import type { DialogStackSnapshot } from './dialogStackModel';

export interface DialogFocusRuntimeOptions {
  readonly document: Document;
  readonly overlayRoot: HTMLElement;
  readonly backgroundRoots?: readonly HTMLElement[];
  readonly onDismissRequest?: (activeId: string) => void;
  readonly onObserverError?: (error: unknown) => void;
}

export interface DialogFocusRuntime {
  apply(snapshot: DialogStackSnapshot): void;
  dispose(): void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

const isElementVisible = (element: HTMLElement): boolean => {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== 'none' && style?.visibility !== 'hidden';
};

const focusablesWithin = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isElementVisible);

const activeSurfaceElement = (root: HTMLElement, id: string | null): HTMLElement | null => {
  if (!id) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
  return root.querySelector<HTMLElement>(`[data-experience-dialog-id="${escaped}"]`);
};

const restoreTarget = (document: Document, targetId: string | null): HTMLElement | null => {
  if (!targetId) return null;
  const target = document.getElementById(targetId);
  return target instanceof HTMLElement && isElementVisible(target) ? target : null;
};

export const createDialogFocusRuntime = (options: DialogFocusRuntimeOptions): DialogFocusRuntime => {
  const backgroundRoots = [...(options.backgroundRoots ?? [])];
  const originalBackgroundState = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
  const documentElement = options.document.documentElement;
  const body = options.document.body;
  const originalDocumentModalOpen = documentElement.hasAttribute('data-experience-modal-open');
  const originalDocumentOverlayCount = documentElement.getAttribute('data-experience-overlay-count');
  const originalBodyOverflow = body.style.overflow;
  const originalBodyOverscrollBehavior = body.style.overscrollBehavior;
  let current: DialogStackSnapshot | null = null;
  let previousActiveId: string | null = null;
  let disposed = false;

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reporterError) {
      void reporterError;
    }
  };

  const rememberBackground = (element: HTMLElement): void => {
    if (originalBackgroundState.has(element)) return;
    originalBackgroundState.set(element, {
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    });
  };

  const applyBackgroundState = (inert: boolean): void => {
    backgroundRoots.forEach((element) => {
      rememberBackground(element);
      element.inert = inert;
      if (inert) element.setAttribute('aria-hidden', 'true');
      else {
        const original = originalBackgroundState.get(element);
        if (original?.ariaHidden === null) element.removeAttribute('aria-hidden');
        else if (original) element.setAttribute('aria-hidden', original.ariaHidden);
      }
    });
  };

  const applyDocumentState = (snapshot: DialogStackSnapshot): void => {
    documentElement.toggleAttribute('data-experience-modal-open', snapshot.pageInert);
    documentElement.setAttribute('data-experience-overlay-count', String(snapshot.dialogs.length));
    body.style.overflow = snapshot.pageInert ? 'hidden' : originalBodyOverflow;
    body.style.overscrollBehavior = snapshot.pageInert ? 'none' : originalBodyOverscrollBehavior;
  };

  const restoreDocumentState = (): void => {
    documentElement.toggleAttribute('data-experience-modal-open', originalDocumentModalOpen);
    if (originalDocumentOverlayCount === null) documentElement.removeAttribute('data-experience-overlay-count');
    else documentElement.setAttribute('data-experience-overlay-count', originalDocumentOverlayCount);
    body.style.overflow = originalBodyOverflow;
    body.style.overscrollBehavior = originalBodyOverscrollBehavior;
  };

  const focusSurface = (surface: HTMLElement): void => {
    const autofocus = surface.querySelector<HTMLElement>('[autofocus], [data-experience-autofocus="true"]');
    if (autofocus && isElementVisible(autofocus)) {
      autofocus.focus({ preventScroll: true });
      return;
    }
    const firstFocusable = focusablesWithin(surface)[0];
    if (firstFocusable) {
      firstFocusable.focus({ preventScroll: true });
      return;
    }
    if (!surface.hasAttribute('tabindex')) surface.setAttribute('tabindex', '-1');
    surface.focus({ preventScroll: true });
  };

  const containFocus = (surface: HTMLElement, event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusables = focusablesWithin(surface);
    if (focusables.length === 0) {
      event.preventDefault();
      focusSurface(surface);
      return;
    }
    const active = options.document.activeElement;
    const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
    const lastIndex = focusables.length - 1;
    if (event.shiftKey && (index <= 0 || !surface.contains(active))) {
      event.preventDefault();
      focusables[lastIndex]?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (index === lastIndex || !surface.contains(active))) {
      event.preventDefault();
      focusables[0]?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (disposed || !current?.activeId) return;
    const active = current.dialogs.find((dialog) => dialog.id === current?.activeId);
    if (!active) return;
    const surface = activeSurfaceElement(options.overlayRoot, active.id);
    if (!surface) return;

    if (event.key === 'Escape' && current.escapeDismisses) {
      event.preventDefault();
      event.stopPropagation();
      options.onDismissRequest?.(active.id);
      return;
    }
    if (active.trapFocus) containFocus(surface, event);
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (disposed || !current?.activeId) return;
    const active = current.dialogs.find((dialog) => dialog.id === current?.activeId);
    if (!active?.trapFocus) return;
    const surface = activeSurfaceElement(options.overlayRoot, active.id);
    const target = event.target;
    if (!surface || !(target instanceof Node) || surface.contains(target)) return;
    focusSurface(surface);
  };

  options.document.addEventListener('keydown', onKeyDown, true);
  options.document.addEventListener('focusin', onFocusIn, true);

  return {
    apply(snapshot) {
      if (disposed) return;
      const previous = current;
      current = snapshot;
      applyBackgroundState(snapshot.pageInert);
      applyDocumentState(snapshot);

      options.overlayRoot.dataset.experienceOverlayActive = snapshot.activeId ?? '';
      options.overlayRoot.dataset.experienceReducedMotion = String(snapshot.reducedMotion);
      options.overlayRoot.dataset.experienceForcedColors = String(snapshot.forcedColors);
      options.overlayRoot.dataset.experienceCoarsePointer = String(snapshot.coarsePointer);

      snapshot.dialogs.forEach((dialog) => {
        const surface = activeSurfaceElement(options.overlayRoot, dialog.id);
        if (!surface) return;
        surface.setAttribute('aria-hidden', String(dialog.ariaHidden));
        surface.dataset.experienceActive = String(dialog.active);
        surface.dataset.experienceTrapFocus = String(dialog.trapFocus);
      });

      const activeChanged = previousActiveId !== snapshot.activeId;
      if (activeChanged && snapshot.activeId) {
        const surface = activeSurfaceElement(options.overlayRoot, snapshot.activeId);
        if (surface) {
          try {
            focusSurface(surface);
          } catch (error) {
            report(error);
          }
        }
      }

      if (previous?.activeId && !snapshot.activeId) {
        const closed = previous.dialogs.find((dialog) => dialog.id === previous.activeId);
        const target = restoreTarget(options.document, closed?.restoreFocusTo ?? null);
        if (target) {
          try {
            target.focus({ preventScroll: true });
          } catch (error) {
            report(error);
          }
        }
      }
      previousActiveId = snapshot.activeId;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.document.removeEventListener('keydown', onKeyDown, true);
      options.document.removeEventListener('focusin', onFocusIn, true);
      originalBackgroundState.forEach((state, element) => {
        element.inert = state.inert;
        if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', state.ariaHidden);
      });
      originalBackgroundState.clear();
      restoreDocumentState();
      options.overlayRoot.removeAttribute('data-experience-overlay-active');
      options.overlayRoot.removeAttribute('data-experience-reduced-motion');
      options.overlayRoot.removeAttribute('data-experience-forced-colors');
      options.overlayRoot.removeAttribute('data-experience-coarse-pointer');
      current = null;
      previousActiveId = null;
    },
  };
};