import type {
  MapWorkspaceLandmarkId,
  MapWorkspaceShellModel,
  MapWorkspaceShellSnapshot,
} from './mapWorkspaceShellModel';
import type { MapWorkspaceFocusResult, MapWorkspaceShellBrowserRuntime } from './mapWorkspaceShellBrowserRuntime';

export type MapWorkspaceShellKeyboardIntent = 'none' | 'focus-next' | 'focus-previous';

export interface MapWorkspaceShellKeyboardDecision {
  readonly intent: MapWorkspaceShellKeyboardIntent;
  readonly preventDefault: boolean;
}

export interface MapWorkspaceShellKeyboardDiagnostics {
  readonly attached: boolean;
  readonly handledCount: number;
  readonly successfulFocusCount: number;
  readonly failedFocusCount: number;
  readonly skippedEditableCount: number;
  readonly lastTargetId: MapWorkspaceLandmarkId | null;
}

export interface MapWorkspaceShellKeyboardControllerOptions {
  readonly window?: Window;
  readonly document?: Document;
}

const NONE: MapWorkspaceShellKeyboardDecision = Object.freeze({ intent: 'none', preventDefault: false });

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
};

export const resolveMapWorkspaceShellKeyboardIntent = (event: KeyboardEvent): MapWorkspaceShellKeyboardDecision => {
  if (event.defaultPrevented || event.isComposing) return NONE;
  if (event.ctrlKey || event.metaKey || event.altKey) return NONE;
  if (event.key !== 'F6') return NONE;
  return Object.freeze({
    intent: event.shiftKey ? 'focus-previous' : 'focus-next',
    preventDefault: true,
  });
};

const availableIds = (snapshot: MapWorkspaceShellSnapshot): readonly MapWorkspaceLandmarkId[] => (
  snapshot.landmarks.filter((landmark) => landmark.available).map((landmark) => landmark.id)
);

export const resolveNextWorkspaceLandmark = (
  snapshot: MapWorkspaceShellSnapshot,
  direction: 'next' | 'previous',
): MapWorkspaceLandmarkId | null => {
  const ids = availableIds(snapshot);
  if (ids.length === 0) return null;
  const currentIndex = snapshot.activeLandmarkId === null ? -1 : ids.indexOf(snapshot.activeLandmarkId);
  if (direction === 'next') {
    if (currentIndex < 0) return ids[0] ?? null;
    return ids[(currentIndex + 1) % ids.length] ?? ids[0] ?? null;
  }
  if (currentIndex < 0) return ids[ids.length - 1] ?? null;
  return ids[(currentIndex - 1 + ids.length) % ids.length] ?? ids[ids.length - 1] ?? null;
};

export class MapWorkspaceShellKeyboardController {
  readonly #model: MapWorkspaceShellModel;
  readonly #runtime: Pick<MapWorkspaceShellBrowserRuntime, 'focus'>;
  readonly #window: Window;
  readonly #document: Document;
  #attached = false;
  #disposed = false;
  #handledCount = 0;
  #successfulFocusCount = 0;
  #failedFocusCount = 0;
  #skippedEditableCount = 0;
  #lastTargetId: MapWorkspaceLandmarkId | null = null;

  constructor(
    model: MapWorkspaceShellModel,
    runtime: Pick<MapWorkspaceShellBrowserRuntime, 'focus'>,
    options: MapWorkspaceShellKeyboardControllerOptions = {},
  ) {
    this.#model = model;
    this.#runtime = runtime;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
  }

  getDiagnostics(): MapWorkspaceShellKeyboardDiagnostics {
    return Object.freeze({
      attached: this.#attached,
      handledCount: this.#handledCount,
      successfulFocusCount: this.#successfulFocusCount,
      failedFocusCount: this.#failedFocusCount,
      skippedEditableCount: this.#skippedEditableCount,
      lastTargetId: this.#lastTargetId,
    });
  }

  attach(): void {
    if (this.#disposed || this.#attached) return;
    this.#attached = true;
    this.#window.addEventListener('keydown', this.#handleKeyDown, true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#attached) this.#window.removeEventListener('keydown', this.#handleKeyDown, true);
    this.#attached = false;
  }

  focusNext(): MapWorkspaceFocusResult | null {
    return this.#move('next');
  }

  focusPrevious(): MapWorkspaceFocusResult | null {
    return this.#move('previous');
  }

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    const decision = resolveMapWorkspaceShellKeyboardIntent(event);
    if (decision.intent === 'none') return;
    if (isEditableTarget(event.target)) {
      this.#skippedEditableCount += 1;
      return;
    }
    if (decision.preventDefault) event.preventDefault();
    this.#handledCount += 1;
    if (decision.intent === 'focus-next') this.#move('next');
    else this.#move('previous');
  };

  #move(direction: 'next' | 'previous'): MapWorkspaceFocusResult | null {
    const snapshot = this.#model.getSnapshot();
    const ids = availableIds(snapshot);
    if (ids.length === 0) return null;

    let target = resolveNextWorkspaceLandmark(snapshot, direction);
    if (!target) return null;

    for (let attempt = 0; attempt < ids.length; attempt += 1) {
      const result = this.#runtime.focus(target);
      this.#lastTargetId = target;
      if (result.ok) {
        this.#successfulFocusCount += 1;
        return result;
      }
      this.#failedFocusCount += 1;
      const currentIndex = ids.indexOf(target);
      const nextIndex = direction === 'next'
        ? (currentIndex + 1) % ids.length
        : (currentIndex - 1 + ids.length) % ids.length;
      target = ids[nextIndex] ?? null;
      if (!target) return result;
    }

    return Object.freeze({
      ok: false,
      id: this.#lastTargetId ?? ids[0],
      reason: 'focus-failed',
    });
  }
}
