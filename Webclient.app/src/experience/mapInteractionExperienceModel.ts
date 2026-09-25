export type MapInputModality = 'unknown' | 'keyboard' | 'pointer';
export type MapNavigationIntent =
  | 'focus-next'
  | 'focus-previous'
  | 'pan'
  | 'zoom-in'
  | 'zoom-out'
  | 'escape'
  | 'activate'
  | 'other';

export interface MapInteractionSnapshot {
  readonly revision: number;
  readonly modality: MapInputModality;
  readonly mapFocused: boolean;
  readonly keyboardHintsVisible: boolean;
  readonly interactionCount: number;
  readonly lastIntent: MapNavigationIntent | null;
  readonly lastChangedAt: number | null;
  readonly announcement: string;
}

export interface MapInteractionTransition {
  readonly revision: number;
  readonly changedAt: number;
  readonly modality: MapInputModality;
  readonly mapFocused: boolean;
  readonly intent: MapNavigationIntent | null;
}

export interface MapInteractionExperienceModel {
  readonly snapshot: () => MapInteractionSnapshot;
  readonly history: () => readonly MapInteractionTransition[];
  readonly recordKeyboard: (key: string, shiftKey?: boolean) => MapInteractionSnapshot;
  readonly recordPointer: () => MapInteractionSnapshot;
  readonly setMapFocused: (focused: boolean) => MapInteractionSnapshot;
  readonly subscribe: (observer: (snapshot: MapInteractionSnapshot) => void) => () => void;
  readonly resetHistory: () => void;
}

export interface MapInteractionExperienceModelOptions {
  readonly now?: () => number;
  readonly historyLimit?: number;
  readonly onObserverError?: (error: unknown) => void;
}

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 48;

const clampHistoryLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.round(value ?? DEFAULT_HISTORY_LIMIT)));
};

const normalizeIntent = (key: string, shiftKey: boolean): MapNavigationIntent => {
  switch (key) {
    case 'Tab':
      return shiftKey ? 'focus-previous' : 'focus-next';
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      return 'pan';
    case '+':
    case '=':
    case 'Add':
      return 'zoom-in';
    case '-':
    case '_':
    case 'Subtract':
      return 'zoom-out';
    case 'Escape':
      return 'escape';
    case 'Enter':
    case ' ':
      return 'activate';
    default:
      return 'other';
  }
};

const announcementFor = (
  modality: MapInputModality,
  mapFocused: boolean,
  intent: MapNavigationIntent | null,
): string => {
  if (modality !== 'keyboard' || !mapFocused) return '';
  switch (intent) {
    case 'pan':
      return 'Haritada yön tuşlarıyla gezinme etkin.';
    case 'zoom-in':
      return 'Harita yakınlaştırma klavye komutu algılandı.';
    case 'zoom-out':
      return 'Harita uzaklaştırma klavye komutu algılandı.';
    case 'escape':
      return 'Escape ile açık harita aracı veya panel kapatılabilir.';
    case 'activate':
      return 'Harita üzerindeki odaklanmış kontrol etkinleştirilebilir.';
    case 'focus-next':
    case 'focus-previous':
      return 'Tab tuşlarıyla harita kontrolleri arasında ilerleyebilirsiniz.';
    default:
      return 'Harita klavye kullanımı etkin. Yön tuşlarıyla gezinip Tab ile kontrollere geçebilirsiniz.';
  }
};

const makeSnapshot = (
  revision: number,
  modality: MapInputModality,
  mapFocused: boolean,
  interactionCount: number,
  lastIntent: MapNavigationIntent | null,
  lastChangedAt: number | null,
): MapInteractionSnapshot => Object.freeze({
  revision,
  modality,
  mapFocused,
  keyboardHintsVisible: modality === 'keyboard' && mapFocused,
  interactionCount,
  lastIntent,
  lastChangedAt,
  announcement: announcementFor(modality, mapFocused, lastIntent),
});

export const createMapInteractionExperienceModel = (
  options: MapInteractionExperienceModelOptions = {},
): MapInteractionExperienceModel => {
  const now = options.now ?? Date.now;
  const historyLimit = clampHistoryLimit(options.historyLimit);
  const observers = new Set<(snapshot: MapInteractionSnapshot) => void>();
  const transitions: MapInteractionTransition[] = [];
  let snapshot = makeSnapshot(0, 'unknown', false, 0, null, null);

  const reportObserverError = (error: unknown): void => {
    if (!options.onObserverError) return;
    try {
      options.onObserverError(error);
    } catch (reportError) {
      console.warn('[experience.map-interaction] observer reporter failed', reportError);
    }
  };

  const notify = (): void => {
    for (const observer of observers) {
      try {
        observer(snapshot);
      } catch (error) {
        reportObserverError(error);
      }
    }
  };

  const commit = (
    modality: MapInputModality,
    mapFocused: boolean,
    intent: MapNavigationIntent | null,
    interactionDelta: 0 | 1,
  ): MapInteractionSnapshot => {
    if (
      snapshot.modality === modality
      && snapshot.mapFocused === mapFocused
      && snapshot.lastIntent === intent
      && interactionDelta === 0
    ) {
      return snapshot;
    }

    const changedAt = Math.max(0, Math.round(now()));
    snapshot = makeSnapshot(
      snapshot.revision + 1,
      modality,
      mapFocused,
      snapshot.interactionCount + interactionDelta,
      intent,
      changedAt,
    );
    transitions.push(Object.freeze({
      revision: snapshot.revision,
      changedAt,
      modality,
      mapFocused,
      intent,
    }));
    if (transitions.length > historyLimit) transitions.splice(0, transitions.length - historyLimit);
    notify();
    return snapshot;
  };

  return Object.freeze({
    snapshot: () => snapshot,
    history: () => Object.freeze([...transitions]),
    recordKeyboard(key: string, shiftKey = false) {
      return commit('keyboard', snapshot.mapFocused, normalizeIntent(key, shiftKey), 1);
    },
    recordPointer() {
      return commit('pointer', snapshot.mapFocused, null, 1);
    },
    setMapFocused(focused: boolean) {
      if (snapshot.mapFocused === focused) return snapshot;
      return commit(snapshot.modality, focused, snapshot.lastIntent, 0);
    },
    subscribe(observer: (snapshot: MapInteractionSnapshot) => void) {
      observers.add(observer);
      try {
        observer(snapshot);
      } catch (error) {
        reportObserverError(error);
      }
      return () => observers.delete(observer);
    },
    resetHistory() {
      transitions.splice(0, transitions.length);
    },
  });
};
