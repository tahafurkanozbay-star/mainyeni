export type MapWorkspaceViewReadinessStatus = 'ready' | 'legacy-ready' | 'aborted' | 'timeout' | 'failed';

export interface MapWorkspaceViewReadinessOutcome {
  readonly status: MapWorkspaceViewReadinessStatus;
  readonly ready: boolean;
  readonly code: string | null;
  readonly failureKind: string | null;
}

export interface MapWorkspaceReadyViewLike {
  readonly destroyed?: boolean;
  readonly when?: () => Promise<unknown>;
}

export interface MapWorkspaceViewReadinessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearScheduledTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export const MAP_WORKSPACE_VIEW_READY_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

const clampTimeout = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return MAP_WORKSPACE_VIEW_READY_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(value ?? MAP_WORKSPACE_VIEW_READY_TIMEOUT_MS)));
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  const type = typeof error;
  return type.length <= 24 ? type : 'unknown';
};

const outcome = (
  status: MapWorkspaceViewReadinessStatus,
  code: string | null,
  failureKind: string | null = null,
): MapWorkspaceViewReadinessOutcome => Object.freeze({
  status,
  ready: status === 'ready' || status === 'legacy-ready',
  code,
  failureKind,
});

const READY = outcome('ready', null);
const LEGACY_READY = outcome('legacy-ready', null);
const ABORTED = outcome('aborted', 'MAP_VIEW_ABORTED');
const TIMED_OUT = outcome('timeout', 'MAP_VIEW_TIMEOUT', 'TimeoutError');
const failedOutcome = (error: unknown): MapWorkspaceViewReadinessOutcome => outcome(
  'failed',
  'MAP_VIEW_FAILED',
  classifyFailure(error),
);
const DESTROYED = outcome('failed', 'MAP_VIEW_FAILED', 'DestroyedView');

/**
 * Wait for the ArcGIS view readiness promise without retaining late completions.
 * Raw failures never escape this boundary; only bounded failure-kind metadata is
 * retained for diagnostics. Older/mocked view contracts without `when()` keep
 * legacy-ready behavior so this boundary can be adopted incrementally.
 */
export const waitForMapWorkspaceViewReady = async (
  view: MapWorkspaceReadyViewLike,
  options: MapWorkspaceViewReadinessOptions = {},
): Promise<MapWorkspaceViewReadinessOutcome> => {
  if (options.signal?.aborted) return ABORTED;
  if (view.destroyed) return DESTROYED;
  if (typeof view.when !== 'function') return LEGACY_READY;

  const timeoutMs = clampTimeout(options.timeoutMs);
  const scheduleTimeout = options.scheduleTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearScheduledTimeout = options.clearScheduledTimeout ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  return new Promise<MapWorkspaceViewReadinessOutcome>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeoutHandle !== null) {
        clearScheduledTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (value: MapWorkspaceViewReadinessOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onAbort = (): void => settle(ABORTED);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    timeoutHandle = scheduleTimeout(() => settle(TIMED_OUT), timeoutMs);

    let readiness: Promise<unknown>;
    try {
      readiness = view.when();
    } catch (error) {
      settle(failedOutcome(error));
      return;
    }

    void Promise.resolve(readiness).then(
      () => settle(view.destroyed ? DESTROYED : READY),
      (error: unknown) => settle(options.signal?.aborted ? ABORTED : failedOutcome(error)),
    );
  });
};

export const mapWorkspaceReadinessMessage = (outcomeValue: MapWorkspaceViewReadinessOutcome): string => {
  switch (outcomeValue.status) {
    case 'ready':
    case 'legacy-ready':
      return 'Harita görünümü hazır.';
    case 'aborted':
      return 'Harita görünümü başlatma işlemi iptal edildi.';
    case 'timeout':
      return 'Harita görünümü beklenen sürede hazır duruma geçemedi.';
    case 'failed':
      return 'Harita görünümü güvenli biçimde başlatılamadı.';
  }
};

export const isMapWorkspaceReadinessFailure = (outcomeValue: MapWorkspaceViewReadinessOutcome): boolean => (
  outcomeValue.status === 'timeout' || outcomeValue.status === 'failed'
);
