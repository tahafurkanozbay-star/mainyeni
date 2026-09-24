import type { DialogStackSnapshot } from './dialogStackModel';
import {
  acquireOverlayLease,
  type OverlayLease,
} from './overlayLifecycleRuntime';

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

type OverlayLeaseMode = 'none' | 'non-modal' | 'modal';

export const createDialogFocusRuntime = (options: DialogFocusRuntimeOptions): DialogFocusRuntime => {
  const backgroundRoots = [...(options.backgroundRoots ?? [])];
  const originalBackgroundState = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
  let current: DialogStackSnapshot | null = null;
  let previousActiveId: string | null = null;
  let lifecycleLease: OverlayLease | null = null;
  let lifecycleLeaseMode: OverlayLeaseMode = 'none';
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

  const synchronizeOverlayLease = (snapshot: DialogStackSnapshot): void => {
    const desiredMode: OverlayLeaseMode = snapshot.dialogs.length === 0
      ? 'none'
      : snapshot.pageInert
        ? 'modal'
        : 'non-modal';
    if (desiredMode === lifecycleLeaseMode) return;

    lifecycleLease?.release();
    lifecycleLease = null;
    lifecycleLeaseMode = desiredMode;
    if (desiredMode === 'none') return;

    lifecycleLease = acquireOverlayLease({
      document: options.document,
      id: 'experience-dialog-stack',
      modal: desiredMode === 'modal',
      lockScroll: desiredMode === 'modal',
      root: options.overlayRoot,
    });
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
      synchronizeOverlayLease(snapshot);

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
      lifecycleLease?.release();
      lifecycleLease = null;
      lifecycleLeaseMode = 'none';
      originalBackgroundState.forEach((state, element) => {
        element.inert = state.inert;
        if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', state.ariaHidden);
      });
      originalBackgroundState.clear();
      options.overlayRoot.removeAttribute('data-experience-overlay-active');
      options.overlayRoot.removeAttribute('data-experience-reduced-motion');
      options.overlayRoot.removeAttribute('data-experience-forced-colors');
      options.overlayRoot.removeAttribute('data-experience-coarse-pointer');
      current = null;
      previousActiveId = null;
    },
  };
};