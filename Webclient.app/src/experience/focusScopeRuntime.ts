export type FocusTarget =
  | HTMLElement
  | string
  | (() => HTMLElement | null | undefined)
  | null
  | undefined;

export interface FocusScopeOptions {
  readonly document: Document;
  readonly container: HTMLElement;
  readonly initialFocus?: FocusTarget;
  readonly fallbackFocus?: FocusTarget;
  readonly restoreFocus?: boolean;
  readonly closeOnEscape?: boolean;
  readonly trapFocus?: boolean;
  readonly onEscape?: (event: KeyboardEvent) => void;
  readonly onFocusError?: (error: unknown) => void;
}

export interface FocusScopeSnapshot {
  readonly active: boolean;
  readonly topMost: boolean;
  readonly focusableCount: number;
  readonly sequence: number;
}

export interface FocusScopeHandle {
  readonly activate: () => void;
  readonly deactivate: () => void;
  readonly focusInitial: () => boolean;
  readonly getSnapshot: () => FocusScopeSnapshot;
  readonly dispose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

interface DocumentScopeState {
  readonly scopes: FocusScopeController[];
}

const documentScopes = new WeakMap<Document, DocumentScopeState>();

const getDocumentState = (document: Document): DocumentScopeState => {
  const existing = documentScopes.get(document);
  if (existing) return existing;

  const created: DocumentScopeState = { scopes: [] };
  documentScopes.set(document, created);
  return created;
};

const isHTMLElement = (value: unknown): value is HTMLElement =>
  typeof HTMLElement !== 'undefined' && value instanceof HTMLElement;

const isElementHiddenFromInteraction = (element: HTMLElement): boolean => {
  if (!element.isConnected) return true;
  if (element.hidden) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return true;
  if (element.hasAttribute('disabled')) return true;
  return false;
};

export const isFocusableElement = (element: HTMLElement): boolean => {
  if (isElementHiddenFromInteraction(element)) return false;
  if (element.tabIndex < 0) return false;
  return true;
};

export const getFocusableElements = (container: HTMLElement): readonly HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isFocusableElement);

const resolveTarget = (
  target: FocusTarget,
  document: Document,
  container: HTMLElement,
): HTMLElement | null => {
  if (!target) return null;
  if (typeof target === 'function') {
    try {
      return target() ?? null;
    } catch (error) {
      globalThis.reportError?.(error);
      return null;
    }
  }
  if (typeof target === 'string') {
    const selected = container.querySelector<HTMLElement>(target)
      ?? document.querySelector<HTMLElement>(target);
    return selected ?? null;
  }
  return target;
};

const safeFocus = (
  target: HTMLElement | null,
  onError: ((error: unknown) => void) | undefined,
): boolean => {
  if (!target || !target.isConnected || isElementHiddenFromInteraction(target)) return false;
  try {
    target.focus({ preventScroll: true });
    return target.ownerDocument.activeElement === target;
  } catch (error) {
    try {
      onError?.(error);
    } catch (observerError) {
      globalThis.reportError?.(observerError);
    }
    return false;
  }
};

class FocusScopeController implements FocusScopeHandle {
  readonly #document: Document;
  readonly #container: HTMLElement;
  readonly #initialFocus: FocusTarget;
  readonly #fallbackFocus: FocusTarget;
  readonly #restoreFocus: boolean;
  readonly #closeOnEscape: boolean;
  readonly #trapFocus: boolean;
  readonly #onEscape: ((event: KeyboardEvent) => void) | undefined;
  readonly #onFocusError: ((error: unknown) => void) | undefined;

  #active = false;
  #disposed = false;
  #previousFocus: HTMLElement | null = null;
  #sequence = 0;

  constructor(options: FocusScopeOptions) {
    this.#document = options.document;
    this.#container = options.container;
    this.#initialFocus = options.initialFocus;
    this.#fallbackFocus = options.fallbackFocus;
    this.#restoreFocus = options.restoreFocus ?? true;
    this.#closeOnEscape = options.closeOnEscape ?? true;
    this.#trapFocus = options.trapFocus ?? true;
    this.#onEscape = options.onEscape;
    this.#onFocusError = options.onFocusError;
  }

  #state(): DocumentScopeState {
    return getDocumentState(this.#document);
  }

  #isTopMost(): boolean {
    const scopes = this.#state().scopes;
    return scopes.length > 0 && scopes[scopes.length - 1] === this;
  }

  #removeFromStack(): void {
    const scopes = this.#state().scopes;
    const index = scopes.lastIndexOf(this);
    if (index >= 0) scopes.splice(index, 1);
  }

  #focusFallback(): boolean {
    const focusable = getFocusableElements(this.#container);
    if (safeFocus(focusable[0] ?? null, this.#onFocusError)) return true;

    const fallback = resolveTarget(
      this.#fallbackFocus,
      this.#document,
      this.#container,
    );
    if (safeFocus(fallback, this.#onFocusError)) return true;

    if (this.#container.tabIndex >= 0) {
      return safeFocus(this.#container, this.#onFocusError);
    }
    return false;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.#active || !this.#isTopMost() || event.defaultPrevented) return;

    if (
      event.key === 'Escape'
      && this.#closeOnEscape
      && !event.isComposing
    ) {
      event.preventDefault();
      try {
        this.#onEscape?.(event);
      } catch (error) {
        try {
          this.#onFocusError?.(error);
        } catch (observerError) {
          globalThis.reportError?.(observerError);
        }
      }
      return;
    }

    if (
      event.key !== 'Tab'
      || !this.#trapFocus
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.isComposing
    ) {
      return;
    }

    const focusable = getFocusableElements(this.#container);
    if (focusable.length === 0) {
      event.preventDefault();
      this.#focusFallback();
      return;
    }

    const activeElement = this.#document.activeElement;
    const activeIndex = isHTMLElement(activeElement)
      ? focusable.indexOf(activeElement)
      : -1;

    if (event.shiftKey) {
      if (activeIndex <= 0) {
        event.preventDefault();
        safeFocus(focusable[focusable.length - 1] ?? null, this.#onFocusError);
      }
      return;
    }

    if (activeIndex === -1 || activeIndex === focusable.length - 1) {
      event.preventDefault();
      safeFocus(focusable[0] ?? null, this.#onFocusError);
    }
  };

  activate(): void {
    if (this.#disposed || this.#active) return;

    const activeElement = this.#document.activeElement;
    this.#previousFocus = isHTMLElement(activeElement) ? activeElement : null;
    this.#active = true;
    this.#sequence += 1;

    const scopes = this.#state().scopes;
    this.#removeFromStack();
    scopes.push(this);

    this.#document.addEventListener('keydown', this.#onKeyDown, true);
    this.focusInitial();
  }

  deactivate(): void {
    if (!this.#active) return;

    const wasTopMost = this.#isTopMost();
    this.#active = false;
    this.#sequence += 1;
    this.#document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#removeFromStack();

    if (
      wasTopMost
      && this.#restoreFocus
      && this.#previousFocus
      && this.#previousFocus.isConnected
    ) {
      safeFocus(this.#previousFocus, this.#onFocusError);
    }
  }

  focusInitial(): boolean {
    if (this.#disposed) return false;

    const initial = resolveTarget(
      this.#initialFocus,
      this.#document,
      this.#container,
    );
    if (safeFocus(initial, this.#onFocusError)) return true;
    return this.#focusFallback();
  }

  getSnapshot(): FocusScopeSnapshot {
    return Object.freeze({
      active: this.#active,
      topMost: this.#active && this.#isTopMost(),
      focusableCount: getFocusableElements(this.#container).length,
      sequence: this.#sequence,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.deactivate();
    this.#disposed = true;
    this.#previousFocus = null;
  }
}

export const createFocusScope = (
  options: FocusScopeOptions,
): FocusScopeHandle => new FocusScopeController(options);
