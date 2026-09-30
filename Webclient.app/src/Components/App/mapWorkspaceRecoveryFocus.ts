import type { MapWorkspaceAccessibilitySnapshot } from './mapWorkspaceAccessibility';

export interface MapWorkspaceRecoveryFocusTarget {
  focus: (options?: FocusOptions) => void;
}

export interface MapWorkspaceRecoveryFocusOptions {
  readonly getTarget: () => MapWorkspaceRecoveryFocusTarget | null;
  readonly onError?: (error: unknown) => void;
  readonly maxPendingRevisions?: number;
}

export interface MapWorkspaceRecoveryFocusDiagnostics {
  readonly requestCount: number;
  readonly restoreCount: number;
  readonly coalescedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly lastErrorKind: string | null;
  readonly pending: boolean;
  readonly disposed: boolean;
}

export interface MapWorkspaceRecoveryFocusController {
  readonly requestRestore: () => boolean;
  readonly sync: (snapshot: MapWorkspaceAccessibilitySnapshot) => boolean;
  readonly cancel: () => void;
  readonly diagnostics: () => MapWorkspaceRecoveryFocusDiagnostics;
  readonly dispose: () => void;
}

const DEFAULT_MAX_PENDING_REVISIONS = 16;
const MIN_PENDING_REVISIONS = 2;
const MAX_PENDING_REVISIONS = 64;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const classifyError = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  const kind = typeof error;
  return kind.length <= 24 ? kind : 'unknown';
};

const frozenDiagnostics = (input: {
  readonly requestCount: number;
  readonly restoreCount: number;
  readonly coalescedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly lastErrorKind: string | null;
  readonly pending: boolean;
  readonly disposed: boolean;
}): MapWorkspaceRecoveryFocusDiagnostics => Object.freeze({ ...input });

const isRestorableSnapshot = (snapshot: MapWorkspaceAccessibilitySnapshot): boolean => (
  snapshot.isInteractive && (snapshot.phase === 'ready' || snapshot.phase === 'degraded')
);

/**
 * One-shot focus restoration for map recovery. A retry request arms the
 * controller; focus is restored only after a future interactive workspace
 * snapshot arrives. It never steals focus during normal updates or startup.
 */
export const createMapWorkspaceRecoveryFocusController = (
  options: MapWorkspaceRecoveryFocusOptions,
): MapWorkspaceRecoveryFocusController => {
  const maxPendingRevisions = clampInteger(
    options.maxPendingRevisions,
    DEFAULT_MAX_PENDING_REVISIONS,
    MIN_PENDING_REVISIONS,
    MAX_PENDING_REVISIONS,
  );
  let requestCount = 0;
  let restoreCount = 0;
  let coalescedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let lastErrorKind: string | null = null;
  let requestedAtRevision: number | null = null;
  let lastSeenRevision = 0;
  let pending = false;
  let disposed = false;

  const recordError = (error: unknown): void => {
    errorCount += 1;
    lastErrorKind = classifyError(error);
  };

  const reportError = (error: unknown): void => {
    recordError(error);
    if (!options.onError) return;
    try {
      options.onError(error);
    } catch (reporterError) {
      recordError(reporterError);
    }
  };

  const clearPending = (): void => {
    pending = false;
    requestedAtRevision = null;
  };

  const requestRestore = (): boolean => {
    if (disposed) return false;
    requestCount += 1;
    if (pending) {
      coalescedCount += 1;
      return true;
    }
    pending = true;
    requestedAtRevision = lastSeenRevision;
    return true;
  };

  const sync = (snapshot: MapWorkspaceAccessibilitySnapshot): boolean => {
    if (disposed) return false;
    lastSeenRevision = Math.max(lastSeenRevision, snapshot.revision);
    if (!pending) return false;

    const baseline = requestedAtRevision ?? snapshot.revision;
    if (snapshot.revision - baseline > maxPendingRevisions) {
      skippedCount += 1;
      clearPending();
      return false;
    }

    if (!isRestorableSnapshot(snapshot)) return false;

    const target = options.getTarget();
    if (!target) {
      skippedCount += 1;
      clearPending();
      return false;
    }

    try {
      target.focus({ preventScroll: true });
      restoreCount += 1;
      clearPending();
      return true;
    } catch (error) {
      reportError(error);
      clearPending();
      return false;
    }
  };

  return Object.freeze({
    requestRestore,
    sync,
    cancel: () => {
      if (disposed) return;
      clearPending();
    },
    diagnostics: () => frozenDiagnostics({
      requestCount,
      restoreCount,
      coalescedCount,
      skippedCount,
      errorCount,
      lastErrorKind,
      pending,
      disposed,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearPending();
    },
  });
};
