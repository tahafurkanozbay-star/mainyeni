import {
  appendBookmark,
  createBookmarkRecord,
  createLatestOperationGate,
  decodeBookmarks,
  isAbortLikeError,
  normalizeWidgetError,
  removeBookmarkAt,
  sanitizeWidgetLabel,
  type BookmarkRecord,
  type LatestOperationGate,
} from '../_shared/MapWidgetRuntime';
import { bookmarkIdentity, type BookmarkExperienceModel } from './bookmarkExperienceModel';

export interface BookmarkMapViewPort {
  readonly center?: unknown;
  readonly zoom?: unknown;
  readonly goTo?: (target: unknown) => Promise<unknown> | unknown;
}

export interface BookmarkStoragePort {
  readonly read: () => unknown;
  readonly write: (bookmarks: readonly BookmarkRecord[]) => void;
}

export interface BookmarkMapPort {
  readonly getView: () => BookmarkMapViewPort | null;
}

export type BookmarkInteractionSeverity = 'info' | 'warning' | 'error';

export interface BookmarkInteractionNotice {
  readonly severity: BookmarkInteractionSeverity;
  readonly message: string;
}

export interface BookmarkInteractionSnapshot {
  readonly revision: number;
  readonly phase: 'idle' | 'saving' | 'navigating' | 'deleting' | 'error';
  readonly pendingBookmarkKey: string | null;
  readonly lastNotice: BookmarkInteractionNotice | null;
  readonly operationGeneration: number;
}

export interface BookmarkInteractionDiagnostics {
  readonly observerFailureCount: number;
  readonly noticeAdapterFailureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface BookmarkInteractionControllerOptions {
  readonly model: BookmarkExperienceModel;
  readonly storage: BookmarkStoragePort;
  readonly map: BookmarkMapPort;
  readonly onNotice?: (notice: BookmarkInteractionNotice) => void;
  readonly operationTimeoutMs?: number;
}

export interface BookmarkInteractionController {
  readonly getSnapshot: () => BookmarkInteractionSnapshot;
  readonly getDiagnostics: () => BookmarkInteractionDiagnostics;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => void;
  readonly saveCurrentView: (title: string) => boolean;
  readonly remove: (key: string) => boolean;
  readonly navigate: (key: string) => Promise<boolean>;
  readonly clearNotice: () => void;
  readonly dispose: () => void;
}

const MAX_LISTENERS = 24;

const createSnapshot = (
  revision: number,
  phase: BookmarkInteractionSnapshot['phase'],
  pendingBookmarkKey: string | null,
  lastNotice: BookmarkInteractionNotice | null,
  operationGeneration: number,
): BookmarkInteractionSnapshot => Object.freeze({
  revision,
  phase,
  pendingBookmarkKey,
  lastNotice,
  operationGeneration,
});

const sanitizeNotice = (
  severity: BookmarkInteractionSeverity,
  message: string,
): BookmarkInteractionNotice => Object.freeze({
  severity,
  message: normalizeWidgetError(message, 'İşlem tamamlanamadı.'),
});

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

export const createBookmarkInteractionController = (
  options: BookmarkInteractionControllerOptions,
): BookmarkInteractionController => {
  const listeners = new Set<() => void>();
  let disposed = false;
  let snapshot = createSnapshot(0, 'idle', null, null, 0);
  let diagnostics: BookmarkInteractionDiagnostics = Object.freeze({
    observerFailureCount: 0,
    noticeAdapterFailureCount: 0,
    activeObserverCount: 0,
    rejectedObserverCount: 0,
    lastFailureKind: null,
    disposed: false,
  });

  const recordObserverFailure = (error: unknown): void => {
    diagnostics = Object.freeze({
      ...diagnostics,
      observerFailureCount: diagnostics.observerFailureCount + 1,
      lastFailureKind: classifyFailure(error),
    });
  };

  const recordNoticeAdapterFailure = (error: unknown): void => {
    diagnostics = Object.freeze({
      ...diagnostics,
      noticeAdapterFailureCount: diagnostics.noticeAdapterFailureCount + 1,
      lastFailureKind: classifyFailure(error),
    });
  };

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        recordObserverFailure(error);
      }
    }
  };

  const publish = (
    phase: BookmarkInteractionSnapshot['phase'],
    pendingBookmarkKey: string | null,
    notice: BookmarkInteractionNotice | null,
    operationGeneration = snapshot.operationGeneration,
  ): void => {
    if (disposed) return;
    snapshot = createSnapshot(snapshot.revision + 1, phase, pendingBookmarkKey, notice, operationGeneration);
    emit();
  };

  const notify = (severity: BookmarkInteractionSeverity, message: string): BookmarkInteractionNotice => {
    const notice = sanitizeNotice(severity, message);
    if (options.onNotice) {
      try {
        options.onNotice(notice);
      } catch (error) {
        recordNoticeAdapterFailure(error);
      }
    }
    return notice;
  };

  const readCanonical = (): readonly BookmarkRecord[] => decodeBookmarks(options.storage.read()).bookmarks;

  const persist = (bookmarks: readonly BookmarkRecord[]): boolean => {
    try {
      options.storage.write(bookmarks);
      options.model.setBookmarks(bookmarks, 0);
      return true;
    } catch (error) {
      publish('error', null, notify('error', normalizeWidgetError(error, 'Yer işaretleri kaydedilemedi.')));
      return false;
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    try {
      const decoded = decodeBookmarks(options.storage.read());
      options.model.setBookmarks(decoded.bookmarks, decoded.rejected);
      const notice = decoded.rejected > 0
        ? notify('warning', `${decoded.rejected} geçersiz veya yinelenen yer işareti güvenli biçimde atlandı.`)
        : null;
      publish('idle', null, notice);
    } catch (error) {
      options.model.setBookmarks([], 0);
      publish('error', null, notify('error', normalizeWidgetError(error, 'Yer işaretleri okunamadı.')));
    }
  };

  let operationGate: LatestOperationGate;
  operationGate = createLatestOperationGate((operation) => {
    if (disposed) return;
    snapshot = createSnapshot(
      snapshot.revision + 1,
      operation.phase === 'running'
        ? 'navigating'
        : operation.phase === 'error'
          ? 'error'
          : 'idle',
      snapshot.pendingBookmarkKey,
      operation.error
        ? notify('error', operation.error)
        : snapshot.lastNotice,
      operation.generation,
    );
    emit();
  });

  const saveCurrentView = (title: string): boolean => {
    if (disposed) return false;
    const normalizedTitle = sanitizeWidgetLabel(title, '');
    if (!normalizedTitle) {
      publish('error', null, notify('warning', 'Lütfen yer işareti adını doldurunuz.'));
      return false;
    }
    const view = options.map.getView();
    const bookmark = createBookmarkRecord(normalizedTitle, view?.center, view?.zoom);
    if (!bookmark) {
      publish('error', null, notify('error', 'Harita konumu okunamadı.'));
      return false;
    }
    let current: readonly BookmarkRecord[];
    try {
      current = readCanonical();
    } catch (error) {
      publish('error', null, notify('error', normalizeWidgetError(error, 'Yer işaretleri okunamadı.')));
      return false;
    }
    const next = appendBookmark(current, bookmark);
    if (next === current) {
      publish('error', null, notify('warning', 'Aynı adla bir yer işareti bulunuyor. Lütfen farklı bir isim giriniz.'));
      return false;
    }
    publish('saving', null, null);
    if (!persist(next)) return false;
    publish('idle', null, notify('info', `${bookmark.Title} kaydedildi.`));
    return true;
  };

  const remove = (key: string): boolean => {
    if (disposed) return false;
    let current: readonly BookmarkRecord[];
    try {
      current = readCanonical();
    } catch (error) {
      publish('error', key, notify('error', normalizeWidgetError(error, 'Yer işaretleri okunamadı.')));
      return false;
    }
    const index = current.findIndex((bookmark) => bookmarkIdentity(bookmark) === key);
    if (index < 0) return false;
    const target = current[index];
    if (!target) return false;
    publish('deleting', key, null);
    if (!persist(removeBookmarkAt(current, index))) return false;
    publish('idle', null, notify('info', `${target.Title} silindi.`));
    return true;
  };

  const navigate = async (key: string): Promise<boolean> => {
    if (disposed) return false;

    let bookmark: BookmarkRecord | undefined = options.model.getSnapshot().entries
      .find((entry) => entry.key === key)?.bookmark;
    if (!bookmark) {
      let canonical: readonly BookmarkRecord[];
      try {
        canonical = readCanonical();
      } catch (error) {
        publish('error', key, notify('error', normalizeWidgetError(error, 'Yer işaretleri okunamadı.')));
        return false;
      }
      bookmark = canonical.find((candidate) => bookmarkIdentity(candidate) === key);
    }
    if (!bookmark) return false;

    const view = options.map.getView();
    if (!view?.goTo) {
      publish('error', key, notify('error', 'Harita görünümü henüz hazır değil.'));
      return false;
    }
    publish('navigating', key, null);
    try {
      const gateOptions = options.operationTimeoutMs === undefined
        ? undefined
        : Object.freeze({ timeoutMs: options.operationTimeoutMs });
      await operationGate.run(
        () => Promise.resolve(view.goTo?.({
          center: [bookmark.Lng, bookmark.Lat],
          zoom: bookmark.Zoom,
        })),
        gateOptions,
      );
      if (disposed) return false;
      publish('idle', null, notify('info', `${bookmark.Title} görünümüne gidildi.`));
      return true;
    } catch (error) {
      if (disposed || isAbortLikeError(error)) return false;
      publish('error', key, notify('error', normalizeWidgetError(error, 'Yer işaretine gidilemedi.')));
      return false;
    }
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    getDiagnostics: () => diagnostics,
    subscribe(listener: () => void) {
      if (disposed || listeners.size >= MAX_LISTENERS) {
        diagnostics = Object.freeze({
          ...diagnostics,
          rejectedObserverCount: diagnostics.rejectedObserverCount + 1,
        });
        return () => undefined;
      }
      if (listeners.has(listener)) return () => undefined;
      listeners.add(listener);
      diagnostics = Object.freeze({
        ...diagnostics,
        activeObserverCount: listeners.size,
      });
      return () => {
        listeners.delete(listener);
        diagnostics = Object.freeze({
          ...diagnostics,
          activeObserverCount: listeners.size,
        });
      };
    },
    refresh,
    saveCurrentView,
    remove,
    navigate,
    clearNotice() {
      if (disposed || !snapshot.lastNotice) return;
      publish(snapshot.phase === 'error' ? 'idle' : snapshot.phase, snapshot.pendingBookmarkKey, null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      diagnostics = Object.freeze({
        ...diagnostics,
        activeObserverCount: 0,
        disposed: true,
      });
      operationGate.dispose();
    },
  });
};
