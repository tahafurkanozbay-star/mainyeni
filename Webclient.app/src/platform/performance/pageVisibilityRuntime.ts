export interface PageVisibilityDocumentLike {
  visibilityState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface PageVisibilityRuntime {
  isVisible: () => boolean;
  subscribe: (listener: (visible: boolean) => void) => () => boolean;
}

const defaultDocument = (): PageVisibilityDocumentLike | null =>
  typeof document === 'undefined' ? null : document;

export const createPageVisibilityRuntime = (
  documentRef: PageVisibilityDocumentLike | null = defaultDocument(),
): PageVisibilityRuntime => {
  const listeners = new Set<(visible: boolean) => void>();

  const isVisible = (): boolean => documentRef?.visibilityState !== 'hidden';

  const onVisibilityChange = (): void => {
    const visible = isVisible();
    listeners.forEach((listener) => listener(visible));
  };

  let listening = false;
  const ensureListening = (): void => {
    if (listening || typeof documentRef?.addEventListener !== 'function') return;
    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    listening = true;
  };
  const stopListeningIfIdle = (): void => {
    if (!listening || listeners.size > 0 || typeof documentRef?.removeEventListener !== 'function') return;
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
    listening = false;
  };

  return Object.freeze({
    isVisible,
    subscribe(listener: (visible: boolean) => void): () => boolean {
      listeners.add(listener);
      ensureListening();
      return () => {
        const removed = listeners.delete(listener);
        stopListeningIfIdle();
        return removed;
      };
    },
  });
};
