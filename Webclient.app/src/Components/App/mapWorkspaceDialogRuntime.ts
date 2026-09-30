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

const setBackgroundInert = (dialog: HTMLElement, inert: boolean): readonly HTMLElement[] => {
  const root = dialog.parentElement;
  if (!root) return [];
  const siblings = Array.from(root.parentElement?.children ?? []).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== root,
  );
  if (inert) {
    siblings.forEach((element) => element.setAttribute('inert', ''));
  } else {
    siblings.forEach((element) => element.removeAttribute('inert'));
  }
  return siblings;
};

export const createMapWorkspaceDialogSession = (
  dialog: HTMLElement,
  onClose: () => void,
  environment: MapWorkspaceDialogEnvironment = { document, body: document.body },
): MapWorkspaceDialogSession => {
  const { document: ownerDocument, body } = environment;
  const restoreTarget = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null;
  const previousOverflow = body.style.overflow;
  const inertSiblings = setBackgroundInert(dialog, true);
  let disposed = false;

  body.style.overflow = 'hidden';

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
    body.style.overflow = previousOverflow;
    inertSiblings.forEach((element) => element.removeAttribute('inert'));
    focusWithoutScroll(restoreTarget);
  };

  return Object.freeze({ focusInitial, handleKeyDown, dispose });
};
