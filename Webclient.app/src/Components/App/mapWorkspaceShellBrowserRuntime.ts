import {
  MAP_WORKSPACE_LANDMARKS,
  type MapWorkspaceInputModality,
  type MapWorkspaceLandmarkId,
  type MapWorkspaceShellEnvironment,
  type MapWorkspaceShellModel,
} from './mapWorkspaceShellModel';

export interface MapWorkspaceFocusResult {
  readonly ok: boolean;
  readonly id: MapWorkspaceLandmarkId;
  readonly reason: 'focused' | 'missing' | 'hidden' | 'focus-failed';
}

export interface MapWorkspaceShellRuntimeDiagnostics {
  readonly started: boolean;
  readonly refreshCount: number;
  readonly mutationRefreshCount: number;
  readonly mediaRefreshCount: number;
  readonly resizeRefreshCount: number;
  readonly focusFailureCount: number;
  readonly lastFocusFailureKind: string | null;
}

export interface MapWorkspaceShellBrowserRuntimeOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly onError?: (error: unknown) => void;
}

const MEDIA_COARSE_POINTER = '(pointer: coarse)';
const MEDIA_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MEDIA_FORCED_COLORS = '(forced-colors: active)';

const isHTMLElement = (value: unknown): value is HTMLElement => value instanceof HTMLElement;

const isElementVisible = (element: HTMLElement): boolean => {
  if (element.hidden) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

const shouldTemporarilyAddTabIndex = (element: HTMLElement): boolean => (
  element.tabIndex < 0 && !element.hasAttribute('tabindex')
);

const classifyError = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const findDefinition = (id: MapWorkspaceLandmarkId) => (
  MAP_WORKSPACE_LANDMARKS.find((landmark) => landmark.id === id) ?? null
);

export const resolveMapWorkspaceLandmark = (
  id: MapWorkspaceLandmarkId,
  doc: Document = document,
): HTMLElement | null => {
  const definition = findDefinition(id);
  if (!definition) return null;
  const element = doc.getElementById(definition.targetId);
  return isHTMLElement(element) ? element : null;
};

export const focusMapWorkspaceLandmark = (
  id: MapWorkspaceLandmarkId,
  options: {
    readonly document?: Document;
    readonly preventScroll?: boolean;
    readonly onError?: (error: unknown) => void;
  } = {},
): MapWorkspaceFocusResult => {
  const doc = options.document ?? document;
  const element = resolveMapWorkspaceLandmark(id, doc);
  if (!element) return Object.freeze({ ok: false, id, reason: 'missing' });
  if (!isElementVisible(element)) return Object.freeze({ ok: false, id, reason: 'hidden' });

  const addTemporaryTabIndex = shouldTemporarilyAddTabIndex(element);
  try {
    if (addTemporaryTabIndex) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: options.preventScroll ?? true });
    if (doc.activeElement !== element && !element.contains(doc.activeElement)) {
      return Object.freeze({ ok: false, id, reason: 'focus-failed' });
    }
    if (addTemporaryTabIndex) {
      const cleanup = (): void => {
        element.removeEventListener('blur', cleanup);
        if (element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
      };
      element.addEventListener('blur', cleanup, { once: true });
    }
    return Object.freeze({ ok: true, id, reason: 'focused' });
  } catch (error) {
    options.onError?.(error);
    if (addTemporaryTabIndex && element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
    return Object.freeze({ ok: false, id, reason: 'focus-failed' });
  }
};

const mediaMatches = (win: Window, query: string): boolean => {
  if (typeof win.matchMedia !== 'function') return false;
  return win.matchMedia(query).matches;
};

const createEnvironment = (win: Window): MapWorkspaceShellEnvironment => Object.freeze({
  width: Math.max(1, Math.trunc(win.innerWidth || 1)),
  height: Math.max(1, Math.trunc(win.innerHeight || 1)),
  coarsePointer: mediaMatches(win, MEDIA_COARSE_POINTER),
  reducedMotion: mediaMatches(win, MEDIA_REDUCED_MOTION),
  forcedColors: mediaMatches(win, MEDIA_FORCED_COLORS),
});

const modalityFromPointerEvent = (event: PointerEvent): MapWorkspaceInputModality => {
  if (event.pointerType === 'touch') return 'touch';
  return 'pointer';
};

const mapActiveElementToLandmark = (
  target: EventTarget | null,
  doc: Document,
): MapWorkspaceLandmarkId | null => {
  if (!(target instanceof Node)) return null;
  for (const definition of MAP_WORKSPACE_LANDMARKS) {
    const element = doc.getElementById(definition.targetId);
    if (element instanceof HTMLElement && (target === element || element.contains(target))) return definition.id;
  }
  return null;
};

export class MapWorkspaceShellBrowserRuntime {
  readonly #model: MapWorkspaceShellModel;
  readonly #document: Document;
  readonly #window: Window;
  readonly #onError?: (error: unknown) => void;
  readonly #mediaQueries: readonly MediaQueryList[];
  #started = false;
  #disposed = false;
  #animationFrame = 0;
  #mutationObserver: MutationObserver | null = null;
  #refreshCount = 0;
  #mutationRefreshCount = 0;
  #mediaRefreshCount = 0;
  #resizeRefreshCount = 0;
  #focusFailureCount = 0;
  #lastFocusFailureKind: string | null = null;

  constructor(model: MapWorkspaceShellModel, options: MapWorkspaceShellBrowserRuntimeOptions = {}) {
    this.#model = model;
    this.#document = options.document ?? document;
    this.#window = options.window ?? window;
    this.#onError = options.onError;
    this.#mediaQueries = Object.freeze([
      this.#window.matchMedia?.(MEDIA_COARSE_POINTER),
      this.#window.matchMedia?.(MEDIA_REDUCED_MOTION),
      this.#window.matchMedia?.(MEDIA_FORCED_COLORS),
    ].filter((query): query is MediaQueryList => query !== undefined));
  }

  getDiagnostics(): MapWorkspaceShellRuntimeDiagnostics {
    return Object.freeze({
      started: this.#started,
      refreshCount: this.#refreshCount,
      mutationRefreshCount: this.#mutationRefreshCount,
      mediaRefreshCount: this.#mediaRefreshCount,
      resizeRefreshCount: this.#resizeRefreshCount,
      focusFailureCount: this.#focusFailureCount,
      lastFocusFailureKind: this.#lastFocusFailureKind,
    });
  }

  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.#window.addEventListener('resize', this.#handleResize, { passive: true });
    this.#document.addEventListener('keydown', this.#handleKeyDown, true);
    this.#document.addEventListener('pointerdown', this.#handlePointerDown, true);
    this.#document.addEventListener('focusin', this.#handleFocusIn, true);

    for (const query of this.#mediaQueries) query.addEventListener?.('change', this.#handleMediaChange);

    if (typeof MutationObserver !== 'undefined' && this.#document.body) {
      this.#mutationObserver = new MutationObserver(this.#handleMutation);
      this.#mutationObserver.observe(this.#document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['id', 'hidden', 'aria-hidden', 'class'],
      });
    }

    this.refreshNow();
  }

  refreshNow(): void {
    if (this.#disposed) return;
    this.#cancelScheduledRefresh();
    this.#refreshCount += 1;
    this.#model.setEnvironment(createEnvironment(this.#window));
    const availability = new Map<MapWorkspaceLandmarkId, boolean>();
    for (const definition of MAP_WORKSPACE_LANDMARKS) {
      const element = this.#document.getElementById(definition.targetId);
      availability.set(definition.id, element instanceof HTMLElement && isElementVisible(element));
    }
    this.#model.setAllLandmarkAvailability(availability);
    this.#model.setActiveLandmark(mapActiveElementToLandmark(this.#document.activeElement, this.#document));
  }

  focus(id: MapWorkspaceLandmarkId): MapWorkspaceFocusResult {
    const result = focusMapWorkspaceLandmark(id, {
      document: this.#document,
      onError: (error) => this.#recordFocusFailure(error),
    });
    if (result.ok) this.#model.setActiveLandmark(id);
    else if (result.reason === 'focus-failed') this.#focusFailureCount += 1;
    return result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    this.#cancelScheduledRefresh();
    this.#window.removeEventListener('resize', this.#handleResize);
    this.#document.removeEventListener('keydown', this.#handleKeyDown, true);
    this.#document.removeEventListener('pointerdown', this.#handlePointerDown, true);
    this.#document.removeEventListener('focusin', this.#handleFocusIn, true);
    for (const query of this.#mediaQueries) query.removeEventListener?.('change', this.#handleMediaChange);
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
  }

  readonly #handleResize = (): void => {
    this.#resizeRefreshCount += 1;
    this.#scheduleRefresh();
  };

  readonly #handleMediaChange = (): void => {
    this.#mediaRefreshCount += 1;
    this.#scheduleRefresh();
  };

  readonly #handleMutation = (): void => {
    this.#mutationRefreshCount += 1;
    this.#scheduleRefresh();
  };

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    this.#model.setInputModality('keyboard');
  };

  readonly #handlePointerDown = (event: PointerEvent): void => {
    this.#model.setInputModality(modalityFromPointerEvent(event));
  };

  readonly #handleFocusIn = (event: FocusEvent): void => {
    this.#model.setActiveLandmark(mapActiveElementToLandmark(event.target, this.#document));
  };

  #scheduleRefresh(): void {
    if (this.#animationFrame !== 0 || this.#disposed) return;
    this.#animationFrame = this.#window.requestAnimationFrame(() => {
      this.#animationFrame = 0;
      this.refreshNow();
    });
  }

  #cancelScheduledRefresh(): void {
    if (this.#animationFrame === 0) return;
    this.#window.cancelAnimationFrame(this.#animationFrame);
    this.#animationFrame = 0;
  }

  #recordFocusFailure(error: unknown): void {
    this.#focusFailureCount += 1;
    this.#lastFocusFailureKind = classifyError(error);
    if (!this.#onError) return;
    try {
      this.#onError(error);
    } catch (reporterError) {
      this.#lastFocusFailureKind = `reporter:${classifyError(reporterError)}`;
    }
  }
}
