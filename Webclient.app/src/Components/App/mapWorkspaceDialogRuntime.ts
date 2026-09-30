export interface MapWorkspaceDialogEnvironment {
  readonly document: Document;
  readonly body: HTMLElement;
}

export interface MapWorkspaceDialogSession {
  readonly focusInitial: () => void;
  readonly handleKeyDown: (event: KeyboardEvent) => boolean;
  readonly dispose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface InertLease {
  count: number;
  readonly initiallyInert: boolean;
}

interface ScrollLease {
  count: number;
  readonly initialOverflow: string;
}

const inertLeases = new WeakMap<HTMLElement, InertLease>();
const scrollLeases = new WeakMap<HTMLElement, ScrollLease>();

const isFocusable = (element: HTMLElement): boolean => {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[inert]')) return false;
  return true;
};

export const getMapDialogFocusableElements = (container: HTMLElement): readonly HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);

const focusWithoutScroll = (element: HTMLElement | null | undefined): void => {
  if (!element?.isConnected) return;
  element.focus({ preventScroll: true });
};

const acquireInert = (element: HTMLElement): void => {
  const activeLease = inertLeases.get(element);
  if (activeLease) {
    activeLease.count += 1;
    return;
  }
  inertLeases.set(element, { count: 1, initiallyInert: element.hasAttribute('inert') });
  element.setAttribute('inert', '');
};

const releaseInert = (element: HTMLElement): void => {
  const activeLease = inertLeases.get(element);
  if (!activeLease) return;
  activeLease.count -= 1;
  if (activeLease.count > 0) return;
  inertLeases.delete(element);
  if (!activeLease.initiallyInert) element.removeAttribute('inert');
};

const acquireBackgroundInert = (dialog: HTMLElement): readonly HTMLElement[] => {
  const root = dialog.parentElement;
  if (!root) return [];
  const siblings = Array.from(root.parentElement?.children ?? []).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== root,
  );
  siblings.forEach(acquireInert);
  return siblings;
};

const acquireScrollLock = (body: HTMLElement): void => {
  const activeLease = scrollLeases.get(body);
  if (activeLease) {
    activeLease.count += 1;
    return;
  }
  scrollLeases.set(body, { count: 1, initialOverflow: body.style.overflow });
  body.style.overflow = 'hidden';
};

const releaseScrollLock = (body: HTMLElement): void => {
  const activeLease = scrollLeases.get(body);
  if (!activeLease) return;
  activeLease.count -= 1;
  if (activeLease.count > 0) return;
  scrollLeases.delete(body);
  body.style.overflow = activeLease.initialOverflow;
};

export const createMapWorkspaceDialogSession = (
  dialog: HTMLElement,
  onClose: () => void,
  environment: MapWorkspaceDialogEnvironment = { document, body: document.body },
): MapWorkspaceDialogSession => {
  const { document: ownerDocument, body } = environment;
  const restoreTarget = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null;
  const inertSiblings = acquireBackgroundInert(dialog);
  let disposed = false;

  acquireScrollLock(body);

  const focusInitial = (): void => {
    if (disposed) return;
    focusWithoutScroll(getMapDialogFocusableElements(dialog)[0] ?? dialog);
  };

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (disposed) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    }
    if (event.key !== 'Tab') return false;

    const focusables = getMapDialogFocusableElements(dialog);
    if (focusables.length === 0) {
      event.preventDefault();
      focusWithoutScroll(dialog);
      return true;
    }

    const first = focusables[0];
    const last = focusables.at(-1);
    if (!first || !last) return false;
    const active = ownerDocument.activeElement;
    const activeInside = active instanceof Node && dialog.contains(active);

    if (!activeInside) {
      event.preventDefault();
      focusWithoutScroll(event.shiftKey ? last : first);
      return true;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      focusWithoutScroll(last);
      return true;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      focusWithoutScroll(first);
      return true;
    }
    return false;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    releaseScrollLock(body);
    inertSiblings.forEach(releaseInert);
    focusWithoutScroll(restoreTarget);
  };

  return Object.freeze({ focusInitial, handleKeyDown, dispose });
};
