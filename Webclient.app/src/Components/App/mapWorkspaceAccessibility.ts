export type MapWorkspacePhase = 'booting' | 'ready' | 'updating' | 'degraded' | 'error';
export type MapWorkspaceHealth = 'starting' | 'healthy' | 'busy' | 'degraded' | 'failed';
export type MapWorkspaceDelayKind = 'boot' | 'update' | null;
export type MapWorkspaceResourceKey = 'map-view' | 'kent-rehberi-data';
export type MapWorkspaceResourceStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'failed';
export type MapWorkspaceEventKind = 'attempt' | 'phase' | 'resource' | 'delay' | 'recovery';

export interface MapWorkspaceResourceSnapshot {
  readonly key: MapWorkspaceResourceKey;
  readonly label: string;
  readonly status: MapWorkspaceResourceStatus;
  readonly required: boolean;
  readonly message: string | null;
}

export interface MapWorkspaceHealthEvent {
  readonly id: number;
  readonly kind: MapWorkspaceEventKind;
  readonly label: string;
  readonly phase: MapWorkspacePhase;
  readonly resource: MapWorkspaceResourceKey | null;
}

export interface MapWorkspaceAccessibilitySnapshot {
  readonly revision: number;
  readonly phase: MapWorkspacePhase;
  readonly health: MapWorkspaceHealth;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly canRetry: boolean;
  readonly retryExhausted: boolean;
  readonly isInteractive: boolean;
  readonly isBusy: boolean;
  readonly isDelayed: boolean;
  readonly delayKind: MapWorkspaceDelayKind;
  readonly issueCount: number;
  readonly announcement: string;
  readonly errorMessage: string | null;
  readonly resources: readonly MapWorkspaceResourceSnapshot[];
  readonly recentEvents: readonly MapWorkspaceHealthEvent[];
}

export interface MapWorkspaceObserverDiagnostics {
  readonly failureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceAccessibilityModelOptions {
  readonly maxAttempts?: number;
  readonly slowBootAfterMs?: number;
  readonly slowUpdateAfterMs?: number;
  readonly maxEvents?: number;
  readonly maxListeners?: number;
  readonly onObserverError?: (error: unknown) => void;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearScheduledTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

type Listener = () => void;
type TimeoutHandle = ReturnType<typeof setTimeout>;

export const MAP_WORKSPACE_OBSERVER_LIMIT = 64;
export const MAP_WORKSPACE_MAX_ATTEMPTS = 3;
export const MAP_WORKSPACE_EVENT_LIMIT = 12;
export const MAP_WORKSPACE_SLOW_BOOT_MS = 4_500;
export const MAP_WORKSPACE_SLOW_UPDATE_MS = 2_000;

const MAX_ERROR_LENGTH = 180;
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 30_000;
const MIN_EVENT_LIMIT = 4;
const MAX_EVENT_LIMIT = 32;
const MIN_LISTENER_LIMIT = 1;
const MAX_LISTENER_LIMIT = 128;

const RESOURCE_META: Readonly<Record<MapWorkspaceResourceKey, { readonly label: string; readonly required: boolean }>> = Object.freeze({
  'map-view': Object.freeze({ label: 'Harita görünümü', required: true }),
  'kent-rehberi-data': Object.freeze({ label: 'Kent Rehberi veri katmanı', required: false }),
});

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const isControlCode = (codePoint: number): boolean => codePoint < 32 || codePoint === 127;

const stripControlCharacters = (value: string): string => {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && isControlCode(codePoint) ? ' ' : character;
  }
  return sanitized;
};

export const sanitizeMapWorkspaceMessage = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return stripControlCharacters(value).replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_LENGTH);
};

const classifyObserverFailure = (error: unknown): string => {
  if (error instanceof Error) return sanitizeMapWorkspaceMessage(error.name) || 'Error';
  if (error === null) return 'null';
  const type = typeof error;
  return type.length <= 24 ? type : 'unknown';
};

const createResource = (
  key: MapWorkspaceResourceKey,
  status: MapWorkspaceResourceStatus,
  message: string | null = null,
): MapWorkspaceResourceSnapshot => Object.freeze({
  key,
  label: RESOURCE_META[key].label,
  required: RESOURCE_META[key].required,
  status,
  message,
});

const createInitialResources = (): readonly MapWorkspaceResourceSnapshot[] => Object.freeze([
  createResource('map-view', 'idle'),
  createResource('kent-rehberi-data', 'idle'),
]);

const replaceResource = (
  resources: readonly MapWorkspaceResourceSnapshot[],
  key: MapWorkspaceResourceKey,
  status: MapWorkspaceResourceStatus,
  message: string | null = null,
): readonly MapWorkspaceResourceSnapshot[] => Object.freeze(resources.map((resource) => (
  resource.key === key ? createResource(key, status, message) : resource
)));

const getResource = (
  resources: readonly MapWorkspaceResourceSnapshot[],
  key: MapWorkspaceResourceKey,
): MapWorkspaceResourceSnapshot => resources.find((resource) => resource.key === key) ?? createResource(key, 'idle');

const resourceIssueCount = (resources: readonly MapWorkspaceResourceSnapshot[]): number => resources.filter((resource) => (
  resource.status === 'degraded' || resource.status === 'failed'
)).length;

const hasOptionalDegradation = (resources: readonly MapWorkspaceResourceSnapshot[]): boolean => resources.some((resource) => (
  !resource.required && resource.status === 'degraded'
));

const isViewReady = (resources: readonly MapWorkspaceResourceSnapshot[]): boolean => getResource(resources, 'map-view').status === 'ready';

const deriveHealth = (
  phase: MapWorkspacePhase,
  delayed: boolean,
  resources: readonly MapWorkspaceResourceSnapshot[],
): MapWorkspaceHealth => {
  if (phase === 'error') return 'failed';
  if (phase === 'degraded' || hasOptionalDegradation(resources)) return 'degraded';
  if (phase === 'booting') return delayed ? 'busy' : 'starting';
  if (phase === 'updating') return 'busy';
  return 'healthy';
};

const deriveInteractive = (
  phase: MapWorkspacePhase,
  resources: readonly MapWorkspaceResourceSnapshot[],
): boolean => phase !== 'error' && isViewReady(resources);

const deriveBusy = (phase: MapWorkspacePhase): boolean => phase === 'booting' || phase === 'updating';

const announcementFor = (
  phase: MapWorkspacePhase,
  delayed: boolean,
  delayKind: MapWorkspaceDelayKind,
  errorMessage: string | null,
  resources: readonly MapWorkspaceResourceSnapshot[],
): string => {
  if (phase === 'error') {
    return errorMessage
      ? `Harita çalışma alanı hazırlanamadı. ${errorMessage}`
      : 'Harita çalışma alanı hazırlanamadı.';
  }
  if (phase === 'degraded' || hasOptionalDegradation(resources)) {
    const degraded = resources.find((resource) => resource.status === 'degraded');
    return degraded?.message
      ? `Harita kullanılabilir, ancak ${degraded.label.toLocaleLowerCase('tr-TR')} sınırlı. ${degraded.message}`
      : 'Harita kullanılabilir, ancak bazı çalışma alanı kaynakları sınırlı.';
  }
  if (phase === 'booting') {
    return delayed && delayKind === 'boot'
      ? 'Harita çalışma alanı beklenenden uzun sürede hazırlanıyor.'
      : 'Harita çalışma alanı hazırlanıyor.';
  }
  if (phase === 'updating') {
    return delayed && delayKind === 'update'
      ? 'Harita görünümü güncelleniyor. İşlem beklenenden uzun sürüyor.'
      : 'Harita görünümü güncelleniyor.';
  }
  return 'Harita çalışma alanı kullanıma hazır.';
};

const createSnapshot = (input: {
  readonly revision: number;
  readonly phase: MapWorkspacePhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayed: boolean;
  readonly delayKind: MapWorkspaceDelayKind;
  readonly errorMessage: string | null;
  readonly resources: readonly MapWorkspaceResourceSnapshot[];
  readonly events: readonly MapWorkspaceHealthEvent[];
}): MapWorkspaceAccessibilitySnapshot => {
  const canRetry = input.phase === 'error' && input.attempt < input.maxAttempts;
  const resources = Object.freeze(input.resources.map((resource) => Object.freeze({ ...resource })));
  const recentEvents = Object.freeze(input.events.map((event) => Object.freeze({ ...event })));
  return Object.freeze({
    revision: input.revision,
    phase: input.phase,
    health: deriveHealth(input.phase, input.delayed, resources),
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    canRetry,
    retryExhausted: input.phase === 'error' && !canRetry,
    isInteractive: deriveInteractive(input.phase, resources),
    isBusy: deriveBusy(input.phase),
    isDelayed: input.delayed,
    delayKind: input.delayKind,
    issueCount: resourceIssueCount(resources),
    announcement: announcementFor(input.phase, input.delayed, input.delayKind, input.errorMessage, resources),
    errorMessage: input.errorMessage,
    resources,
    recentEvents,
  });
};

const sameResource = (
  current: MapWorkspaceResourceSnapshot,
  status: MapWorkspaceResourceStatus,
  message: string | null,
): boolean => current.status === status && current.message === message;

/**
 * Single external-store authority for map-shell operational and accessibility state.
 * ArcGIS remains the map runtime authority. This model only translates lifecycle,
 * resource health and bounded recovery facts into deterministic React/UI state.
 */
export class MapWorkspaceAccessibilityModel {
  private readonly listeners = new Set<Listener>();
  private readonly maxAttempts: number;
  private readonly slowBootAfterMs: number;
  private readonly slowUpdateAfterMs: number;
  private readonly maxEvents: number;
  private readonly maxListeners: number;
  private readonly onObserverError?: (error: unknown) => void;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  private readonly clearScheduledTimeout: (handle: TimeoutHandle) => void;
  private snapshot: MapWorkspaceAccessibilitySnapshot;
  private resources: readonly MapWorkspaceResourceSnapshot[] = createInitialResources();
  private events: readonly MapWorkspaceHealthEvent[] = Object.freeze([]);
  private nextEventId = 1;
  private bootDelayHandle: TimeoutHandle | null = null;
  private updateDelayHandle: TimeoutHandle | null = null;
  private disposed = false;
  private observerDiagnostics: MapWorkspaceObserverDiagnostics = Object.freeze({
    failureCount: 0,
    activeObserverCount: 0,
    rejectedObserverCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
    disposed: false,
  });

  constructor(options: MapWorkspaceAccessibilityModelOptions = {}) {
    this.maxAttempts = clampInteger(options.maxAttempts, MAP_WORKSPACE_MAX_ATTEMPTS, 1, 8);
    this.slowBootAfterMs = clampInteger(options.slowBootAfterMs, MAP_WORKSPACE_SLOW_BOOT_MS, MIN_DELAY_MS, MAX_DELAY_MS);
    this.slowUpdateAfterMs = clampInteger(options.slowUpdateAfterMs, MAP_WORKSPACE_SLOW_UPDATE_MS, MIN_DELAY_MS, MAX_DELAY_MS);
    this.maxEvents = clampInteger(options.maxEvents, MAP_WORKSPACE_EVENT_LIMIT, MIN_EVENT_LIMIT, MAX_EVENT_LIMIT);
    this.maxListeners = clampInteger(options.maxListeners, MAP_WORKSPACE_OBSERVER_LIMIT, MIN_LISTENER_LIMIT, MAX_LISTENER_LIMIT);
    this.onObserverError = options.onObserverError;
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? ((handle) => clearTimeout(handle));
    this.snapshot = createSnapshot({
      revision: 0,
      phase: 'booting',
      attempt: 0,
      maxAttempts: this.maxAttempts,
      delayed: false,
      delayKind: null,
      errorMessage: null,
      resources: this.resources,
      events: this.events,
    });
  }

  readonly getSnapshot = (): MapWorkspaceAccessibilitySnapshot => this.snapshot;

  readonly getObserverDiagnostics = (): MapWorkspaceObserverDiagnostics => this.observerDiagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    if (this.listeners.has(listener)) return () => this.unsubscribe(listener);
    if (this.listeners.size >= this.maxListeners) {
      this.recordRejectedObserver();
      return () => undefined;
    }
    this.listeners.add(listener);
    this.refreshObserverCount();
    return () => this.unsubscribe(listener);
  };

  beginAttempt(): boolean {
    if (this.disposed) return false;
    if (this.snapshot.attempt >= this.maxAttempts && this.snapshot.phase === 'error') return false;
    const attempt = Math.min(this.maxAttempts, this.snapshot.attempt + 1);
    this.clearAllDelays();
    this.resources = Object.freeze([
      createResource('map-view', 'loading'),
      createResource('kent-rehberi-data', 'idle'),
    ]);
    this.appendEvent('attempt', `Harita başlatma denemesi ${attempt}/${this.maxAttempts}.`, 'booting', null);
    this.publish({ phase: 'booting', attempt, delayed: false, delayKind: null, errorMessage: null });
    this.bootDelayHandle = this.scheduleTimeout(() => {
      this.bootDelayHandle = null;
      if (this.disposed || this.snapshot.phase !== 'booting') return;
      this.appendEvent('delay', 'Harita başlatma işlemi gecikti.', 'booting', 'map-view');
      this.publish({ delayed: true, delayKind: 'boot' });
    }, this.slowBootAfterMs);
    return true;
  }

  markReady(): void {
    if (this.disposed) return;
    this.clearBootDelay();
    this.resources = replaceResource(this.resources, 'map-view', 'ready');
    this.appendEvent('phase', 'Harita görünümü kullanıma hazır.', 'ready', 'map-view');
    const phase: MapWorkspacePhase = hasOptionalDegradation(this.resources) ? 'degraded' : 'ready';
    this.publish({ phase, delayed: false, delayKind: null, errorMessage: null });
  }

  markUpdating(updating: boolean): void {
    if (this.disposed) return;
    if (!isViewReady(this.resources)) return;
    if (updating) {
      if (this.snapshot.phase === 'updating') return;
      this.clearUpdateDelay();
      this.appendEvent('phase', 'Harita görünümü güncelleniyor.', 'updating', 'map-view');
      this.publish({ phase: 'updating', delayed: false, delayKind: null });
      this.updateDelayHandle = this.scheduleTimeout(() => {
        this.updateDelayHandle = null;
        if (this.disposed || this.snapshot.phase !== 'updating') return;
        this.appendEvent('delay', 'Harita güncellemesi gecikti.', 'updating', 'map-view');
        this.publish({ delayed: true, delayKind: 'update' });
      }, this.slowUpdateAfterMs);
      return;
    }

    if (this.snapshot.phase !== 'updating') return;
    this.clearUpdateDelay();
    const phase: MapWorkspacePhase = hasOptionalDegradation(this.resources) ? 'degraded' : 'ready';
    this.appendEvent('phase', phase === 'degraded' ? 'Harita güncellendi; sınırlı kaynak mevcut.' : 'Harita güncellemesi tamamlandı.', phase, 'map-view');
    this.publish({ phase, delayed: false, delayKind: null });
  }

  markResourceLoading(key: MapWorkspaceResourceKey): void {
    if (this.disposed) return;
    const current = getResource(this.resources, key);
    if (sameResource(current, 'loading', null)) return;
    this.resources = replaceResource(this.resources, key, 'loading');
    this.appendEvent('resource', `${RESOURCE_META[key].label} yükleniyor.`, this.snapshot.phase, key);
    this.publish({});
  }

  markResourceReady(key: MapWorkspaceResourceKey): void {
    if (this.disposed) return;
    const current = getResource(this.resources, key);
    if (sameResource(current, 'ready', null)) return;
    this.resources = replaceResource(this.resources, key, 'ready');
    this.appendEvent('resource', `${RESOURCE_META[key].label} hazır.`, this.snapshot.phase, key);
    const phase = this.snapshot.phase === 'degraded' && !hasOptionalDegradation(this.resources)
      ? 'ready'
      : this.snapshot.phase;
    this.publish({ phase });
  }

  markResourceFailed(key: MapWorkspaceResourceKey, error: unknown): void {
    if (this.disposed) return;
    if (RESOURCE_META[key].required) {
      this.markError(error);
      return;
    }
    const candidate = error instanceof Error ? error.message : error;
    const message = sanitizeMapWorkspaceMessage(candidate) || 'Kaynak şu anda kullanılamıyor.';
    const current = getResource(this.resources, key);
    if (sameResource(current, 'degraded', message)) return;
    this.resources = replaceResource(this.resources, key, 'degraded', message);
    this.appendEvent('resource', `${RESOURCE_META[key].label} sınırlı.`, 'degraded', key);
    this.publish({ phase: this.snapshot.phase === 'error' ? 'error' : 'degraded' });
  }

  markError(error: unknown): void {
    if (this.disposed) return;
    this.clearAllDelays();
    const candidate = error instanceof Error ? error.message : error;
    const sanitized = sanitizeMapWorkspaceMessage(candidate);
    this.resources = replaceResource(this.resources, 'map-view', 'failed', sanitized || null);
    this.appendEvent('phase', 'Harita çalışma alanı başlatılamadı.', 'error', 'map-view');
    this.publish({ phase: 'error', delayed: false, delayKind: null, errorMessage: sanitized || null });
  }

  reset(): void {
    if (this.disposed) return;
    this.clearAllDelays();
    this.resources = createInitialResources();
    this.events = Object.freeze([]);
    this.nextEventId = 1;
    this.publish({ phase: 'booting', attempt: 0, delayed: false, delayKind: null, errorMessage: null });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllDelays();
    this.listeners.clear();
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  private publish(overrides: Partial<Pick<MapWorkspaceAccessibilitySnapshot,
    'phase' | 'attempt' | 'isDelayed' | 'delayKind' | 'errorMessage'>> & { readonly delayed?: boolean }): void {
    if (this.disposed) return;
    const nextPhase = overrides.phase ?? this.snapshot.phase;
    const delayed = overrides.delayed ?? overrides.isDelayed ?? this.snapshot.isDelayed;
    const next = createSnapshot({
      revision: this.snapshot.revision + 1,
      phase: nextPhase,
      attempt: overrides.attempt ?? this.snapshot.attempt,
      maxAttempts: this.maxAttempts,
      delayed,
      delayKind: overrides.delayKind === undefined ? this.snapshot.delayKind : overrides.delayKind,
      errorMessage: overrides.errorMessage === undefined ? this.snapshot.errorMessage : overrides.errorMessage,
      resources: this.resources,
      events: this.events,
    });
    this.snapshot = next;
    this.emit();
  }

  private appendEvent(
    kind: MapWorkspaceEventKind,
    label: string,
    phase: MapWorkspacePhase,
    resource: MapWorkspaceResourceKey | null,
  ): void {
    const event = Object.freeze({ id: this.nextEventId, kind, label, phase, resource });
    this.nextEventId += 1;
    const nextEvents = this.events.length >= this.maxEvents
      ? [...this.events.slice(this.events.length - this.maxEvents + 1), event]
      : [...this.events, event];
    this.events = Object.freeze(nextEvents);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.recordObserverFailure(error);
        this.reportObserverFailure(error);
      }
    }
  }

  private reportObserverFailure(error: unknown): void {
    if (!this.onObserverError) return;
    try {
      this.onObserverError(error);
    } catch (reporterError) {
      this.recordObserverFailure(reporterError);
    }
  }

  private recordRejectedObserver(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      rejectedObserverCount: this.observerDiagnostics.rejectedObserverCount + 1,
    });
  }

  private unsubscribe(listener: Listener): void {
    if (!this.listeners.delete(listener)) return;
    this.refreshObserverCount();
  }

  private refreshObserverCount(): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      activeObserverCount: this.listeners.size,
    });
  }

  private recordObserverFailure(error: unknown): void {
    this.observerDiagnostics = Object.freeze({
      ...this.observerDiagnostics,
      failureCount: this.observerDiagnostics.failureCount + 1,
      lastFailureRevision: this.snapshot.revision,
      lastFailureKind: classifyObserverFailure(error),
    });
  }

  private clearBootDelay(): void {
    if (this.bootDelayHandle === null) return;
    this.clearScheduledTimeout(this.bootDelayHandle);
    this.bootDelayHandle = null;
  }

  private clearUpdateDelay(): void {
    if (this.updateDelayHandle === null) return;
    this.clearScheduledTimeout(this.updateDelayHandle);
    this.updateDelayHandle = null;
  }

  private clearAllDelays(): void {
    this.clearBootDelay();
    this.clearUpdateDelay();
  }
}
