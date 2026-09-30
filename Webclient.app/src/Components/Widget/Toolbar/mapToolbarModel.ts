export type MapToolbarActionId =
  | 'feedback'
  | 'basemap'
  | 'address'
  | 'location'
  | 'parcel'
  | 'measure'
  | 'streetview'
  | 'home';

export type MapToolbarGroupId = 'municipal' | 'analysis' | 'navigation';
export type MapToolbarLocationPhase = 'idle' | 'locating' | 'success' | 'fallback' | 'error';
export type MapToolbarActionKind = 'external' | 'window' | 'location' | 'home';

export interface MapToolbarPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapToolbarActionDefinition {
  readonly id: MapToolbarActionId;
  readonly group: MapToolbarGroupId;
  readonly kind: MapToolbarActionKind;
  readonly label: string;
  readonly target?: string;
}

export interface MapToolbarActionPresentation extends MapToolbarActionDefinition {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly tooltip: string;
}

export interface MapToolbarSnapshot {
  readonly revision: number;
  readonly locationPhase: MapToolbarLocationPhase;
  readonly announcement: string;
  readonly actions: readonly MapToolbarActionPresentation[];
}

export interface MapToolbarCatalogFinding {
  readonly code:
    | 'duplicate-action-id'
    | 'empty-label'
    | 'missing-target'
    | 'unknown-group'
    | 'location-cardinality'
    | 'home-cardinality';
  readonly actionId?: string;
  readonly detail: string;
}

export interface MapToolbarLocateDependencies {
  readonly requestPosition: () => Promise<MapToolbarPoint>;
  readonly showLocation: (point: MapToolbarPoint) => Promise<void> | void;
  readonly showSidebar: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface MapToolbarModelOptions {
  readonly onListenerError?: (error: unknown) => void;
  readonly maxListeners?: number;
}

export const MAP_TOOLBAR_FALLBACK_LOCATION: Readonly<MapToolbarPoint> = Object.freeze({
  x: 32.80409955978453,
  y: 39.94494728389463,
});

export const MAP_TOOLBAR_GROUP_LABELS: Readonly<Record<MapToolbarGroupId, string>> = Object.freeze({
  municipal: 'Belediye ve harita görünümü',
  analysis: 'Arama ve analiz araçları',
  navigation: 'Harita görünümünü sıfırla',
});

export const MAP_TOOLBAR_ACTIONS: readonly MapToolbarActionDefinition[] = Object.freeze([
  Object.freeze({
    id: 'feedback',
    group: 'municipal',
    kind: 'external',
    label: 'Geri Bildirim (Başkent 153)',
    target: 'https://ulakbell.ankara.bel.tr/WebForm/basket153basvuru#/',
  }),
  Object.freeze({
    id: 'basemap',
    group: 'municipal',
    kind: 'window',
    label: 'Altlık Haritalar',
    target: 'basemap-widget',
  }),
  Object.freeze({
    id: 'address',
    group: 'analysis',
    kind: 'window',
    label: 'Adres Arama',
    target: 'numbering-query-window',
  }),
  Object.freeze({
    id: 'location',
    group: 'analysis',
    kind: 'location',
    label: 'Konum Bul',
  }),
  Object.freeze({
    id: 'parcel',
    group: 'analysis',
    kind: 'window',
    label: 'Ada-Parsel Arama',
    target: 'cityblockparcel-query-window',
  }),
  Object.freeze({
    id: 'measure',
    group: 'analysis',
    kind: 'window',
    label: 'Ölçüm Aracı',
    target: 'measurement-widget',
  }),
  Object.freeze({
    id: 'streetview',
    group: 'analysis',
    kind: 'window',
    label: 'Sokak Görüntüsü',
    target: 'streetview-widget',
  }),
  Object.freeze({
    id: 'home',
    group: 'navigation',
    kind: 'home',
    label: 'Başlangıç görünümüne dön',
  }),
]);

const LOCATION_ANNOUNCEMENTS: Readonly<Record<MapToolbarLocationPhase, string>> = Object.freeze({
  idle: '',
  locating: 'Konumunuz bulunuyor.',
  success: 'Konumunuz haritada gösterildi.',
  fallback: 'Konum alınamadı. Ankara merkez konumu gösterildi.',
  error: 'Konum gösterilemedi. Harita araçlarını kullanmaya devam edebilirsiniz.',
});

const DEFAULT_MAX_LISTENERS = 24;
const MAX_MAX_LISTENERS = 100;
const VALID_GROUPS = new Set<MapToolbarGroupId>(['municipal', 'analysis', 'navigation']);
const TARGET_REQUIRED_KINDS = new Set<MapToolbarActionKind>(['external', 'window']);

const normalizeListenerLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LISTENERS;
  return Math.max(1, Math.min(MAX_MAX_LISTENERS, Math.trunc(value ?? DEFAULT_MAX_LISTENERS)));
};

const isFiniteCoordinate = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const invokeErrorReporter = (
  reporter: ((error: unknown) => void) | undefined,
  error: unknown,
): unknown | null => {
  if (!reporter) return null;
  try {
    reporter(error);
    return null;
  } catch (reporterError) {
    return reporterError;
  }
};

export const normalizeMapToolbarPoint = (value: unknown): MapToolbarPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<MapToolbarPoint>;
  if (!isFiniteCoordinate(candidate.x) || !isFiniteCoordinate(candidate.y)) return null;
  if (candidate.x < -180 || candidate.x > 180 || candidate.y < -90 || candidate.y > 90) return null;
  return Object.freeze({ x: candidate.x, y: candidate.y });
};

export const auditMapToolbarCatalog = (
  actions: readonly MapToolbarActionDefinition[] = MAP_TOOLBAR_ACTIONS,
): readonly MapToolbarCatalogFinding[] => {
  const findings: MapToolbarCatalogFinding[] = [];
  const seen = new Set<string>();
  let locationCount = 0;
  let homeCount = 0;

  for (const action of actions) {
    if (seen.has(action.id)) {
      findings.push(Object.freeze({
        code: 'duplicate-action-id',
        actionId: action.id,
        detail: `Duplicate toolbar action id: ${action.id}`,
      }));
    } else {
      seen.add(action.id);
    }

    if (!action.label.trim()) {
      findings.push(Object.freeze({
        code: 'empty-label',
        actionId: action.id,
        detail: `Toolbar action ${action.id} must have an accessible label.`,
      }));
    }

    if (!VALID_GROUPS.has(action.group)) {
      findings.push(Object.freeze({
        code: 'unknown-group',
        actionId: action.id,
        detail: `Toolbar action ${action.id} references unknown group ${String(action.group)}.`,
      }));
    }

    if (TARGET_REQUIRED_KINDS.has(action.kind) && !action.target?.trim()) {
      findings.push(Object.freeze({
        code: 'missing-target',
        actionId: action.id,
        detail: `Toolbar action ${action.id} requires a target.`,
      }));
    }

    if (action.kind === 'location') locationCount += 1;
    if (action.kind === 'home') homeCount += 1;
  }

  if (locationCount !== 1) {
    findings.push(Object.freeze({
      code: 'location-cardinality',
      detail: `Toolbar catalog must define exactly one location action; found ${locationCount}.`,
    }));
  }

  if (homeCount !== 1) {
    findings.push(Object.freeze({
      code: 'home-cardinality',
      detail: `Toolbar catalog must define exactly one home action; found ${homeCount}.`,
    }));
  }

  return Object.freeze(findings);
};

export const findMapToolbarAction = (
  id: string,
  actions: readonly MapToolbarActionDefinition[] = MAP_TOOLBAR_ACTIONS,
): MapToolbarActionDefinition | null => actions.find((action) => action.id === id) ?? null;

const createActionPresentation = (
  action: MapToolbarActionDefinition,
  locationPhase: MapToolbarLocationPhase,
): MapToolbarActionPresentation => {
  const isLocation = action.kind === 'location';
  const busy = isLocation && locationPhase === 'locating';
  const label = busy ? 'Konum bulunuyor' : action.label;
  return Object.freeze({
    ...action,
    label,
    tooltip: label,
    busy,
    disabled: busy,
  });
};

export const createMapToolbarSnapshot = (
  revision: number,
  locationPhase: MapToolbarLocationPhase,
  actions: readonly MapToolbarActionDefinition[] = MAP_TOOLBAR_ACTIONS,
): MapToolbarSnapshot => Object.freeze({
  revision,
  locationPhase,
  announcement: LOCATION_ANNOUNCEMENTS[locationPhase],
  actions: Object.freeze(actions.map((action) => createActionPresentation(action, locationPhase))),
});

export class MapToolbarModel {
  readonly #listeners = new Set<() => void>();
  readonly #onListenerError: ((error: unknown) => void) | undefined;
  readonly #maxListeners: number;
  #snapshot: MapToolbarSnapshot = createMapToolbarSnapshot(0, 'idle');
  #generation = 0;
  #disposed = false;

  constructor(options: MapToolbarModelOptions = {}) {
    const findings = auditMapToolbarCatalog();
    if (findings.length > 0) {
      throw new Error(`Invalid map toolbar catalog: ${findings.map((item) => item.code).join(', ')}`);
    }
    this.#onListenerError = options.onListenerError;
    this.#maxListeners = normalizeListenerLimit(options.maxListeners);
  }

  readonly getSnapshot = (): MapToolbarSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    if (this.#listeners.size >= this.#maxListeners && !this.#listeners.has(listener)) {
      throw new Error(`MapToolbarModel listener limit exceeded (${this.#maxListeners}).`);
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(locationPhase: MapToolbarLocationPhase): void {
    if (this.#disposed) return;
    this.#snapshot = createMapToolbarSnapshot(this.#snapshot.revision + 1, locationPhase);
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch (error) {
        void invokeErrorReporter(this.#onListenerError, error);
      }
    }
  }

  async locate(dependencies: MapToolbarLocateDependencies): Promise<MapToolbarLocationPhase> {
    if (this.#disposed) return this.#snapshot.locationPhase;
    if (this.#snapshot.locationPhase === 'locating') return 'locating';

    const generation = ++this.#generation;
    this.#publish('locating');

    try {
      const requested = normalizeMapToolbarPoint(await dependencies.requestPosition());
      if (!requested) throw new Error('Geolocation returned invalid coordinates.');
      if (this.#disposed || generation !== this.#generation) return this.#snapshot.locationPhase;
      await dependencies.showLocation(requested);
      if (this.#disposed || generation !== this.#generation) return this.#snapshot.locationPhase;
      this.#publish('success');
      return 'success';
    } catch (primaryError) {
      if (this.#disposed || generation !== this.#generation) return this.#snapshot.locationPhase;
      void invokeErrorReporter(dependencies.onError, primaryError);

      try {
        await dependencies.showLocation(MAP_TOOLBAR_FALLBACK_LOCATION);
        if (this.#disposed || generation !== this.#generation) return this.#snapshot.locationPhase;
        try {
          dependencies.showSidebar();
        } catch (sidebarError) {
          void invokeErrorReporter(dependencies.onError, sidebarError);
        }
        this.#publish('fallback');
        return 'fallback';
      } catch (fallbackError) {
        if (this.#disposed || generation !== this.#generation) return this.#snapshot.locationPhase;
        void invokeErrorReporter(dependencies.onError, fallbackError);
        this.#publish('error');
        return 'error';
      }
    }
  }

  resetLocation(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#publish('idle');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#listeners.clear();
  }

  listenerCount(): number {
    return this.#listeners.size;
  }

  disposed(): boolean {
    return this.#disposed;
  }
}