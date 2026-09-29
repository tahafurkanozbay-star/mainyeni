export interface NavigationShortcutEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly target?: EventTarget | null;
  readonly preventDefault: () => void;
}

export interface NavigationShortcutTarget {
  readonly addEventListener: (type: 'keydown', listener: (event: KeyboardEvent) => void) => void;
  readonly removeEventListener: (type: 'keydown', listener: (event: KeyboardEvent) => void) => void;
}

export interface NavigationSearchFocusable {
  readonly focus: (options?: FocusOptions) => void;
  readonly select?: () => void;
}

export interface NavigationSearchShortcutDiagnostics {
  readonly focusFailureCount: number;
  readonly lastFailureKind: string | null;
}

export interface NavigationSearchShortcutControllerOptions {
  readonly target: NavigationShortcutTarget;
  readonly getSearchInput: () => NavigationSearchFocusable | null;
}

export interface NavigationSearchShortcutController {
  readonly start: () => void;
  readonly stop: () => void;
  readonly getDiagnostics: () => NavigationSearchShortcutDiagnostics;
  readonly handleKeyDown: (event: NavigationShortcutEventLike) => boolean;
}

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const isEditableTarget = (target: EventTarget | null | undefined): boolean => {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest('[contenteditable="true"]') !== null;
};

export const isNavigationSearchShortcut = (event: Pick<
  NavigationShortcutEventLike,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'
>): boolean => {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLocaleLowerCase('tr-TR') === 'k';
};

export const createNavigationSearchShortcutController = (
  options: NavigationSearchShortcutControllerOptions,
): NavigationSearchShortcutController => {
  if (!options?.target || typeof options.getSearchInput !== 'function') {
    throw new TypeError('Navigation search shortcut controller requires a target and input resolver.');
  }

  let started = false;
  let diagnostics: NavigationSearchShortcutDiagnostics = Object.freeze({
    focusFailureCount: 0,
    lastFailureKind: null,
  });

  const recordFocusFailure = (error: unknown): void => {
    diagnostics = Object.freeze({
      focusFailureCount: diagnostics.focusFailureCount + 1,
      lastFailureKind: classifyFailure(error),
    });
  };

  const handleKeyDown = (event: NavigationShortcutEventLike): boolean => {
    if (!isNavigationSearchShortcut(event)) return false;
    const input = options.getSearchInput();
    if (input === null) return false;

    event.preventDefault();
    try {
      input.focus({ preventScroll: true });
      if (!isEditableTarget(event.target)) input.select?.();
      return true;
    } catch (error) {
      recordFocusFailure(error);
      return false;
    }
  };

  const nativeListener = (event: KeyboardEvent): void => {
    handleKeyDown(event);
  };

  const start = (): void => {
    if (started) return;
    options.target.addEventListener('keydown', nativeListener);
    started = true;
  };

  const stop = (): void => {
    if (!started) return;
    options.target.removeEventListener('keydown', nativeListener);
    started = false;
  };

  const getDiagnostics = (): NavigationSearchShortcutDiagnostics => diagnostics;

  return Object.freeze({ start, stop, getDiagnostics, handleKeyDown });
};
