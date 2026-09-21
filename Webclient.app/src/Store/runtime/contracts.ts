import type { RootState } from '../contracts';

export type StoreSliceName = 'Common' | 'Map' | 'ContextMenu' | 'DynamicLayers';
export type StoreInvariantSeverity = 'info' | 'warning' | 'error';
export type StoreTransitionStatus = 'changed' | 'noop' | 'failed';

export type SafeJsonPrimitive = string | number | boolean | null;
export type SafeJsonValue =
  | SafeJsonPrimitive
  | readonly SafeJsonValue[]
  | { readonly [key: string]: SafeJsonValue };

export interface StoreRuntimeLimits {
  readonly maxHistoryEntries: number;
  readonly maxSubscribers: number;
  readonly maxInvariantIssues: number;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshotAgeMs: number;
  readonly maxProjectionDepth: number;
  readonly maxProjectionEntries: number;
  readonly maxProjectionTextLength: number;
  readonly maxWindows: number;
  readonly maxVisibleWindows: number;
  readonly maxGraphics: number;
  readonly maxDynamicLayers: number;
  readonly maxServices: number;
  readonly maxMessageLength: number;
}

export interface StoreRuntimeConfiguration {
  readonly limits?: Partial<StoreRuntimeLimits>;
  readonly clock?: () => number;
}

export interface SafeWindowSnapshot {
  readonly id: string;
  readonly title: string | null;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly order: number | null;
  readonly lazy: boolean;
  readonly query: SafeJsonValue | null;
}

export interface SafeServiceSnapshot {
  readonly key: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly type: string | null;
}

export interface SafeMessageSnapshot {
  readonly type: string | number | null;
  readonly text: string | null;
}

export interface StoreStateProjection {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly common: Readonly<{
    moduleSelectBarVisible: boolean;
    windows: readonly SafeWindowSnapshot[];
    mapConfiguration: SafeJsonValue | null;
    services: readonly SafeServiceSnapshot[];
    message: SafeMessageSnapshot | null;
  }>;
  readonly map: Readonly<{
    isUpdating: boolean;
    mobileRightClickEnabled: boolean;
    graphicsCount: number;
    hasMapView: boolean;
    hasMapClickHandler: boolean;
  }>;
  readonly contextMenu: Readonly<{
    activeOnLeftClick: boolean;
  }>;
  readonly dynamicLayers: Readonly<{
    count: number;
  }>;
}

export interface StoreInvariantIssue {
  readonly code: string;
  readonly severity: StoreInvariantSeverity;
  readonly slice: StoreSliceName | 'root';
  readonly detail: string;
}

export interface StoreInvariantReport {
  readonly generatedAt: number;
  readonly healthy: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly truncated: boolean;
  readonly issues: readonly StoreInvariantIssue[];
}

export interface StoreTransitionDescriptor {
  readonly actionType: string;
  readonly actionAudit: import('./stateActionAudit').StoreActionAudit;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly status: StoreTransitionStatus;
  readonly changedSlices: readonly StoreSliceName[];
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly invariantErrors: number;
  readonly invariantWarnings: number;
  readonly errorCode: string | null;
}

export interface StoreHistorySnapshot {
  readonly capacity: number;
  readonly retained: number;
  readonly totalRecorded: number;
  readonly dropped: number;
  readonly changed: number;
  readonly noop: number;
  readonly failed: number;
  readonly entries: readonly StoreTransitionDescriptor[];
}

export interface StoreRuntimeHealthSnapshot {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly dispatches: number;
  readonly changedTransitions: number;
  readonly noopTransitions: number;
  readonly failedTransitions: number;
  readonly subscriberCount: number;
  readonly subscriberErrors: number;
  readonly historyRetained: number;
  readonly invariantErrors: number;
  readonly invariantWarnings: number;
  readonly stateFingerprint: string;
  readonly lastActionType: string | null;
}

export interface StoreRuntimeSnapshot {
  readonly generatedAt: number;
  readonly health: StoreRuntimeHealthSnapshot;
  readonly projection: StoreStateProjection | null;
  readonly invariants: StoreInvariantReport | null;
  readonly history: StoreHistorySnapshot;
}

export interface StoreRuntimeTransitionInput {
  readonly action: unknown;
  readonly previousState: RootState;
  readonly nextState: RootState;
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface StoreRuntimeFailureInput {
  readonly action: unknown;
  readonly state: RootState;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly error: unknown;
}

export interface StoreSelectorSubscriptionOptions<TSelected> {
  readonly equality?: (left: TSelected, right: TSelected) => boolean;
  readonly fireImmediately?: boolean;
  readonly label?: string;
}

export interface StoreSelectorNotification<TSelected> {
  readonly current: TSelected;
  readonly previous: TSelected;
  readonly actionType: string;
  readonly changedSlices: readonly StoreSliceName[];
}

export interface StoreSelectorSubscriptionHub {
  readonly size: number;
  readonly errorCount: number;
  readonly subscribe: <TSelected>(
    selector: (state: RootState) => TSelected,
    listener: (notification: StoreSelectorNotification<TSelected>) => void,
    options?: StoreSelectorSubscriptionOptions<TSelected>,
  ) => () => void;
  readonly initialize: (state: RootState) => void;
  readonly notify: (
    state: RootState,
    actionType: string,
    changedSlices: readonly StoreSliceName[],
  ) => void;
  readonly clear: () => number;
}

export interface StoreStateRuntime {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly initialize: (state: RootState) => StoreRuntimeSnapshot;
  readonly recordTransition: (input: StoreRuntimeTransitionInput) => StoreTransitionDescriptor;
  readonly recordFailure: (input: StoreRuntimeFailureInput) => StoreTransitionDescriptor;
  readonly inspect: (state?: RootState) => StoreRuntimeSnapshot;
  readonly project: (state?: RootState) => StoreStateProjection | null;
  readonly exportSnapshot: (state?: RootState) => string | null;
  readonly subscribeSelector: StoreSelectorSubscriptionHub['subscribe'];
  readonly clearHistory: () => number;
  readonly dispose: () => void;
}

export const DEFAULT_STORE_RUNTIME_LIMITS: Readonly<StoreRuntimeLimits> = Object.freeze({
  maxHistoryEntries: 256,
  maxSubscribers: 128,
  maxInvariantIssues: 128,
  maxSnapshotBytes: 256 * 1024,
  maxSnapshotAgeMs: 24 * 60 * 60 * 1000,
  maxProjectionDepth: 6,
  maxProjectionEntries: 2_000,
  maxProjectionTextLength: 4_096,
  maxWindows: 128,
  maxVisibleWindows: 8,
  maxGraphics: 5_000,
  maxDynamicLayers: 1_000,
  maxServices: 1_000,
  maxMessageLength: 4_096,
});

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

export const normalizeStoreRuntimeLimits = (
  input: Partial<StoreRuntimeLimits> | null | undefined = {},
): StoreRuntimeLimits => {
  const value = input ?? {};
  const defaults = DEFAULT_STORE_RUNTIME_LIMITS;
  return Object.freeze({
    maxHistoryEntries: boundedInteger(value.maxHistoryEntries, defaults.maxHistoryEntries, 1, 10_000),
    maxSubscribers: boundedInteger(value.maxSubscribers, defaults.maxSubscribers, 1, 10_000),
    maxInvariantIssues: boundedInteger(value.maxInvariantIssues, defaults.maxInvariantIssues, 1, 10_000),
    maxSnapshotBytes: boundedInteger(value.maxSnapshotBytes, defaults.maxSnapshotBytes, 1_024, 16 * 1024 * 1024),
    maxSnapshotAgeMs: boundedInteger(value.maxSnapshotAgeMs, defaults.maxSnapshotAgeMs, 1_000, 30 * 24 * 60 * 60 * 1000),
    maxProjectionDepth: boundedInteger(value.maxProjectionDepth, defaults.maxProjectionDepth, 1, 32),
    maxProjectionEntries: boundedInteger(value.maxProjectionEntries, defaults.maxProjectionEntries, 16, 100_000),
    maxProjectionTextLength: boundedInteger(value.maxProjectionTextLength, defaults.maxProjectionTextLength, 16, 65_536),
    maxWindows: boundedInteger(value.maxWindows, defaults.maxWindows, 1, 10_000),
    maxVisibleWindows: boundedInteger(value.maxVisibleWindows, defaults.maxVisibleWindows, 1, 1_000),
    maxGraphics: boundedInteger(value.maxGraphics, defaults.maxGraphics, 1, 1_000_000),
    maxDynamicLayers: boundedInteger(value.maxDynamicLayers, defaults.maxDynamicLayers, 1, 100_000),
    maxServices: boundedInteger(value.maxServices, defaults.maxServices, 1, 100_000),
    maxMessageLength: boundedInteger(value.maxMessageLength, defaults.maxMessageLength, 16, 65_536),
  });
};

export const readActionType = (action: unknown): string => {
  if (!action || typeof action !== 'object') return 'unknown';
  const type = (action as Readonly<Record<string, unknown>>).type;
  if (typeof type !== 'string') return 'unknown';
  const normalized = type.trim();
  return normalized ? normalized.slice(0, 160) : 'unknown';
};

export const readErrorCode = (error: unknown): string => {
  if (error instanceof Error) return (error.name || 'Error').slice(0, 120);
  if (error && typeof error === 'object') {
    const record = error as Readonly<Record<string, unknown>>;
    if (typeof record.code === 'string' && record.code.trim()) return record.code.trim().slice(0, 120);
    if (typeof record.name === 'string' && record.name.trim()) return record.name.trim().slice(0, 120);
  }
  return 'ERROR';
};
