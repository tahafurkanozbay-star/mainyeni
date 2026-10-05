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
import type { BookmarkExperienceModel } from './bookmarkExperienceModel';

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

export interface BookmarkInteractionControllerOptions {
  readonly model: BookmarkExperienceModel;
  readonly storage: BookmarkStoragePort;
  readonly map: BookmarkMapPort;
  readonly onNotice?: (notice: BookmarkInteractionNotice) => void;
  readonly operationTimeoutMs?: number;
}

export interface BookmarkInteractionController {
  readonly getSnapshot: () => BookmarkInteractionSnapshot;
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

export const createBookmarkInteractionController = (
  options: BookmarkInteractionControllerOptions,
): BookmarkInteractionController => {
  const listeners = new Set<() => void>();
  let disposed = false;
  let snapshot = createSnapshot(0, 'idle', null, null, 0);

  const publish = (
    phase: BookmarkInteractionSnapshot['phase'],
    pendingBookmarkKey: string | null,
    notice: BookmarkInteractionNotice | null,
    operationGeneration = snapshot.operationGeneration,
  ): void => {
    if (disposed) return;
    snapshot = createSnapshot(snapshot.revision + 1, phase, pendingBookmarkKey, notice, operationGeneration);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // State propagation must continue for healthy observers. The model carries observer diagnostics.
      }
    }
  };

  const notify = (severity: BookmarkInteractionSeverity, message: string): BookmarkInteractionNotice => {
    const notice = sanitizeNotice(severity, message);
    try {
      options.onNotice?.(notice);
    } catch {
      // Notification adapters are non-authoritative and cannot break bookmark state transitions.
    }
    return notice;
  };

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
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Non-authoritative observer failures are isolated from operation lifecycle.
      }
    }
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
    const current = options.model.getSnapshot().entries.map((entry) => entry.bookmark);
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
    const snapshotModel = options.model.getSnapshot();
    const index = snapshotModel.entries.findIndex((entry) => entry.key === key);
    if (index < 0) return false;
    const target = snapshotModel.entries[index];
    const all = snapshotModel.entries.map((entry) => entry.bookmark);
    publish('deleting', key, null);
    if (!persist(removeBookmarkAt(all, index))) return false;
    publish('idle', null, notify('info', `${target.bookmark.Title} silindi.`));
    return true;
  };

  const navigate = async (key: string): Promise<boolean> => {
    if (disposed) return false;
    const target = options.model.getSnapshot().entries.find((entry) => entry.key === key);
    if (!target) return false;
    const view = options.map.getView();
    if (!view?.goTo) {
      publish('error', key, notify('error', 'Harita görünümü henüz hazır değil.'));
      return false;
    }
    publish('navigating', key, null);
    try {
      await operationGate.run(
        () => Promise.resolve(view.goTo?.({
          center: [target.bookmark.Lng, target.bookmark.Lat],
          zoom: target.bookmark.Zoom,
        })),
        { timeoutMs: options.operationTimeoutMs },
      );
      if (disposed) return false;
      publish('idle', null, notify('info', `${target.bookmark.Title} görünümüne gidildi.`));
      return true;
    } catch (error) {
      if (disposed || isAbortLikeError(error)) return false;
      publish('error', key, notify('error', normalizeWidgetError(error, 'Yer işaretine gidilemedi.')));
      return false;
    }
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed || listeners.size >= MAX_LISTENERS) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
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
      operationGate.dispose();
    },
  });
};
