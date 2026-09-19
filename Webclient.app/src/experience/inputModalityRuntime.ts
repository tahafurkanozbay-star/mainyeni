export type InputModality = 'keyboard' | 'pointer' | 'touch' | 'unknown';

export interface InputModalitySnapshot {
  modality: InputModality;
  keyboardNavigation: boolean;
  coarsePointer: boolean;
  sequence: number;
}

export interface InputModalityHandle {
  getSnapshot(): InputModalitySnapshot;
  subscribe(listener: (snapshot: InputModalitySnapshot) => void): () => void;
  dispose(): void;
}

export interface InputModalityEnvironment {
  document: Document;
  window: Window;
  matchMedia?: (query: string) => MediaQueryList;
  reportError?: (error: unknown) => void;
}

const COARSE_POINTER_QUERY = '(pointer: coarse)';
const MODALITY_ATTRIBUTE = 'data-input-modality';
const KEYBOARD_ATTRIBUTE = 'data-keyboard-navigation';
const COARSE_ATTRIBUTE = 'data-coarse-pointer';

const isModifierOnlyKey = (key: string): boolean =>
  key === 'Alt' || key === 'Control' || key === 'Meta' || key === 'Shift';

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
};

const shouldEnterKeyboardMode = (event: KeyboardEvent): boolean => {
  if (event.defaultPrevented || event.isComposing || isModifierOnlyKey(event.key)) return false;
  if (isEditableTarget(event.target)) {
    return event.key === 'Tab' || event.key === 'Escape';
  }
  return true;
};

const createSnapshot = (
  modality: InputModality,
  coarsePointer: boolean,
  sequence: number,
): InputModalitySnapshot => ({
  modality,
  keyboardNavigation: modality === 'keyboard',
  coarsePointer,
  sequence,
});

const snapshotsEqual = (left: InputModalitySnapshot, right: InputModalitySnapshot): boolean =>
  left.modality === right.modality
  && left.keyboardNavigation === right.keyboardNavigation
  && left.coarsePointer === right.coarsePointer;

const setBooleanAttribute = (element: HTMLElement, name: string, value: boolean): void => {
  if (value) element.setAttribute(name, 'true');
  else element.removeAttribute(name);
};

const publishToDocument = (document: Document, snapshot: InputModalitySnapshot): void => {
  const root = document.documentElement;
  root.setAttribute(MODALITY_ATTRIBUTE, snapshot.modality);
  setBooleanAttribute(root, KEYBOARD_ATTRIBUTE, snapshot.keyboardNavigation);
  setBooleanAttribute(root, COARSE_ATTRIBUTE, snapshot.coarsePointer);
};

const clearDocumentState = (document: Document): void => {
  const root = document.documentElement;
  root.removeAttribute(MODALITY_ATTRIBUTE);
  root.removeAttribute(KEYBOARD_ATTRIBUTE);
  root.removeAttribute(COARSE_ATTRIBUTE);
};

export const installInputModalityRuntime = (
  environment: InputModalityEnvironment,
): InputModalityHandle => {
  const { document, window } = environment;
  const matchMedia = environment.matchMedia ?? window.matchMedia?.bind(window);
  const coarseQuery = matchMedia?.(COARSE_POINTER_QUERY) ?? null;
  const reportError = environment.reportError ?? globalThis.reportError?.bind(globalThis);
  const listeners = new Set<(snapshot: InputModalitySnapshot) => void>();
  let disposed = false;
  let sequence = 0;
  let snapshot = createSnapshot('unknown', Boolean(coarseQuery?.matches), sequence);

  const notify = (next: InputModalitySnapshot): void => {
    if (disposed || snapshotsEqual(snapshot, next)) return;
    sequence += 1;
    snapshot = { ...next, sequence };
    publishToDocument(document, snapshot);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        // Observer isolation: a UI listener must not break input handling, but
        // failures remain observable through the host diagnostics boundary.
        reportError?.(error);
      }
    }
  };

  const setModality = (modality: InputModality): void => {
    notify(createSnapshot(modality, snapshot.coarsePointer, sequence));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (shouldEnterKeyboardMode(event)) setModality('keyboard');
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') setModality('touch');
    else setModality('pointer');
  };

  const onMouseDown = (): void => setModality('pointer');
  const onTouchStart = (): void => setModality('touch');

  const onCoarsePointerChange = (event: MediaQueryListEvent): void => {
    notify(createSnapshot(snapshot.modality, event.matches, sequence));
  };

  document.addEventListener('keydown', onKeyDown, true);
  if ('PointerEvent' in window) document.addEventListener('pointerdown', onPointerDown, true);
  else {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  }
  coarseQuery?.addEventListener?.('change', onCoarsePointerChange);
  publishToDocument(document, snapshot);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      document.removeEventListener('keydown', onKeyDown, true);
      if ('PointerEvent' in window) document.removeEventListener('pointerdown', onPointerDown, true);
      else {
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('touchstart', onTouchStart, true);
      }
      coarseQuery?.removeEventListener?.('change', onCoarsePointerChange);
      clearDocumentState(document);
    },
  };
};
