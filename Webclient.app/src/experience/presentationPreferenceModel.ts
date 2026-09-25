export type PresentationMotion = 'full' | 'reduced';
export type PresentationContrast = 'standard' | 'more';
export type PresentationColorMode = 'normal' | 'forced';
export type PresentationPointer = 'fine' | 'coarse';
export type PresentationViewport = 'compact' | 'regular' | 'wide';

export interface PresentationEnvironmentInput {
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  readonly forcedColors: boolean;
  readonly coarsePointer: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface PresentationPreferenceSnapshot {
  readonly revision: number;
  readonly changeCount: number;
  readonly changedAt: number | null;
  readonly motion: PresentationMotion;
  readonly contrast: PresentationContrast;
  readonly colorMode: PresentationColorMode;
  readonly pointer: PresentationPointer;
  readonly viewport: PresentationViewport;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly targetSizePx: 44 | 48;
  readonly density: 'comfortable' | 'compact';
  readonly canAnimate: boolean;
  readonly shouldUseLargeTargets: boolean;
  readonly shouldPreferSingleColumnPanels: boolean;
  readonly shouldAvoidDecorativeTransparency: boolean;
}

export interface PresentationPreferenceTransition {
  readonly revision: number;
  readonly changedAt: number;
  readonly from: Readonly<{
    motion: PresentationMotion;
    contrast: PresentationContrast;
    colorMode: PresentationColorMode;
    pointer: PresentationPointer;
    viewport: PresentationViewport;
  }>;
  readonly to: Readonly<{
    motion: PresentationMotion;
    contrast: PresentationContrast;
    colorMode: PresentationColorMode;
    pointer: PresentationPointer;
    viewport: PresentationViewport;
  }>;
}

export interface PresentationPreferenceModel {
  readonly snapshot: () => PresentationPreferenceSnapshot;
  readonly history: () => readonly PresentationPreferenceTransition[];
  readonly update: (next: Partial<PresentationEnvironmentInput>) => PresentationPreferenceSnapshot;
  readonly replace: (next: PresentationEnvironmentInput) => PresentationPreferenceSnapshot;
  readonly subscribe: (observer: (snapshot: PresentationPreferenceSnapshot) => void) => () => void;
  readonly resetHistory: () => void;
}

export interface PresentationPreferenceModelOptions {
  readonly initial?: Partial<PresentationEnvironmentInput>;
  readonly now?: () => number;
  readonly historyLimit?: number;
  readonly onObserverError?: (error: unknown) => void;
}

export type PresentationDataAttributes = Readonly<{
  'data-exp-motion': PresentationMotion;
  'data-exp-contrast': PresentationContrast;
  'data-exp-color-mode': PresentationColorMode;
  'data-exp-pointer': PresentationPointer;
  'data-exp-viewport': PresentationViewport;
  'data-exp-density': PresentationPreferenceSnapshot['density'];
}>;

const DEFAULT_ENVIRONMENT: PresentationEnvironmentInput = Object.freeze({
  reducedMotion: false,
  highContrast: false,
  forcedColors: false,
  coarsePointer: false,
  viewportWidth: 1280,
  viewportHeight: 720,
});

const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 16_384;
const DEFAULT_HISTORY_LIMIT = 24;
const MAX_HISTORY_LIMIT = 64;

const clampDimension = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, Math.round(value)));
};

const clampHistoryLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.round(value ?? DEFAULT_HISTORY_LIMIT)));
};

const normalizeEnvironment = (
  input: Partial<PresentationEnvironmentInput>,
  fallback: PresentationEnvironmentInput = DEFAULT_ENVIRONMENT,
): PresentationEnvironmentInput => Object.freeze({
  reducedMotion: input.reducedMotion ?? fallback.reducedMotion,
  highContrast: input.highContrast ?? fallback.highContrast,
  forcedColors: input.forcedColors ?? fallback.forcedColors,
  coarsePointer: input.coarsePointer ?? fallback.coarsePointer,
  viewportWidth: clampDimension(input.viewportWidth ?? fallback.viewportWidth, fallback.viewportWidth),
  viewportHeight: clampDimension(input.viewportHeight ?? fallback.viewportHeight, fallback.viewportHeight),
});

const viewportClass = (width: number): PresentationViewport => {
  if (width < 768) return 'compact';
  if (width < 1280) return 'regular';
  return 'wide';
};

const deriveSnapshot = (
  environment: PresentationEnvironmentInput,
  revision: number,
  changeCount: number,
  changedAt: number | null,
): PresentationPreferenceSnapshot => {
  const viewport = viewportClass(environment.viewportWidth);
  const pointer: PresentationPointer = environment.coarsePointer ? 'coarse' : 'fine';
  const motion: PresentationMotion = environment.reducedMotion ? 'reduced' : 'full';
  const contrast: PresentationContrast = environment.highContrast ? 'more' : 'standard';
  const colorMode: PresentationColorMode = environment.forcedColors ? 'forced' : 'normal';
  const targetSizePx: 44 | 48 = pointer === 'coarse' ? 48 : 44;
  const density = viewport === 'compact' || pointer === 'coarse' ? 'comfortable' : 'compact';

  return Object.freeze({
    revision,
    changeCount,
    changedAt,
    motion,
    contrast,
    colorMode,
    pointer,
    viewport,
    viewportWidth: environment.viewportWidth,
    viewportHeight: environment.viewportHeight,
    targetSizePx,
    density,
    canAnimate: motion === 'full',
    shouldUseLargeTargets: pointer === 'coarse',
    shouldPreferSingleColumnPanels: viewport === 'compact',
    shouldAvoidDecorativeTransparency: contrast === 'more' || colorMode === 'forced',
  });
};

const transitionIdentity = (snapshot: PresentationPreferenceSnapshot) => Object.freeze({
  motion: snapshot.motion,
  contrast: snapshot.contrast,
  colorMode: snapshot.colorMode,
  pointer: snapshot.pointer,
  viewport: snapshot.viewport,
});

const sameEnvironment = (
  left: PresentationEnvironmentInput,
  right: PresentationEnvironmentInput,
): boolean => (
  left.reducedMotion === right.reducedMotion
  && left.highContrast === right.highContrast
  && left.forcedColors === right.forcedColors
  && left.coarsePointer === right.coarsePointer
  && left.viewportWidth === right.viewportWidth
  && left.viewportHeight === right.viewportHeight
);

export const presentationDataAttributes = (
  snapshot: PresentationPreferenceSnapshot,
): PresentationDataAttributes => Object.freeze({
  'data-exp-motion': snapshot.motion,
  'data-exp-contrast': snapshot.contrast,
  'data-exp-color-mode': snapshot.colorMode,
  'data-exp-pointer': snapshot.pointer,
  'data-exp-viewport': snapshot.viewport,
  'data-exp-density': snapshot.density,
});

export const createPresentationPreferenceModel = (
  options: PresentationPreferenceModelOptions = {},
): PresentationPreferenceModel => {
  const now = options.now ?? Date.now;
  const historyLimit = clampHistoryLimit(options.historyLimit);
  const observers = new Set<(snapshot: PresentationPreferenceSnapshot) => void>();
  const transitions: PresentationPreferenceTransition[] = [];
  let environment = normalizeEnvironment(options.initial ?? {});
  let snapshot = deriveSnapshot(environment, 0, 0, null);

  const reportObserverError = (error: unknown): void => {
    if (!options.onObserverError) return;
    try {
      options.onObserverError(error);
    } catch (reportError) {
      console.warn('[experience.presentation-preference] observer reporter failed', reportError);
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

  const commit = (nextEnvironment: PresentationEnvironmentInput): PresentationPreferenceSnapshot => {
    if (sameEnvironment(environment, nextEnvironment)) return snapshot;

    const previous = snapshot;
    const changedAt = Math.max(0, Math.round(now()));
    environment = nextEnvironment;
    snapshot = deriveSnapshot(
      environment,
      previous.revision + 1,
      previous.changeCount + 1,
      changedAt,
    );

    transitions.push(Object.freeze({
      revision: snapshot.revision,
      changedAt,
      from: transitionIdentity(previous),
      to: transitionIdentity(snapshot),
    }));
    if (transitions.length > historyLimit) transitions.splice(0, transitions.length - historyLimit);

    notify();
    return snapshot;
  };

  return Object.freeze({
    snapshot: () => snapshot,
    history: () => Object.freeze([...transitions]),
    update: (next) => commit(normalizeEnvironment(next, environment)),
    replace: (next) => commit(normalizeEnvironment(next)),
    subscribe(observer) {
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
