export interface DeploymentRecoveryDiagnostics {
  record(
    type: string,
    details?: Record<string, unknown>,
    options?: { severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message?: unknown },
  ): unknown;
  captureError?(
    error: unknown,
    context?: Record<string, unknown>,
    severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
  ): unknown;
}

export interface DeploymentRecoveryHandle {
  dispose(): void;
}

export interface DeploymentRecoveryOptions {
  readonly cooldownMs?: number;
  readonly storageKey?: string;
  readonly now?: () => number;
  readonly reload?: () => void;
  readonly eventTarget?: Window;
  readonly storage?: Storage | null;
}

export const DEFAULT_DEPLOYMENT_RECOVERY_COOLDOWN_MS = 60_000;
export const DEFAULT_DEPLOYMENT_RECOVERY_STORAGE_KEY = 'kent-rehberi:deployment-recovery:v1';

const STALE_DEPLOYMENT_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /load failed for module/i,
  /unable to preload css/i,
  /dynamically imported module/i,
] as const;

const normalizeMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string') return candidate.message;
    if (candidate.cause !== undefined) return normalizeMessage(candidate.cause);
  }
  try {
    return String(value ?? '');
  } catch {
    return '';
  }
};

/**
 * Detect only the narrow browser/Vite failure family associated with a stale HTML document
 * referencing immutable chunks that no longer exist after an atomic deployment.
 */
export const isLikelyStaleDeploymentError = (value: unknown): boolean => {
  const message = normalizeMessage(value);
  return STALE_DEPLOYMENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

export const canAttemptDeploymentRecovery = (
  previousAttemptAt: number | null,
  now: number,
  cooldownMs = DEFAULT_DEPLOYMENT_RECOVERY_COOLDOWN_MS,
): boolean => {
  if (!Number.isFinite(now)) return false;
  if (previousAttemptAt === null || !Number.isFinite(previousAttemptAt)) return true;
  return now - previousAttemptAt >= Math.max(1_000, cooldownMs);
};

const readPreviousAttempt = (storage: Storage | null, key: string): number | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeAttempt = (storage: Storage | null, key: string, timestamp: number): void => {
  if (!storage) return;
  try {
    storage.setItem(key, String(timestamp));
  } catch {
    // Storage can be denied by privacy mode or browser policy. The in-memory gate still applies.
  }
};

const resolveSessionStorage = (browserWindow: Window): Storage | null => {
  try {
    return browserWindow.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Installs a bounded one-shot stale-deployment recovery path.
 *
 * Vite emits `vite:preloadError` when a dynamic import/preload cannot resolve. This commonly
 * happens when a long-lived tab still references the previous deployment's content-hashed chunk.
 * Reloading once lets the browser obtain the current HTML/asset graph. A session-scoped cooldown
 * prevents loops when the failure is caused by a real outage or a broken deployment.
 */
export const installDeploymentRecovery = (
  diagnostics: DeploymentRecoveryDiagnostics,
  options: DeploymentRecoveryOptions = {},
): DeploymentRecoveryHandle => {
  if (typeof window === 'undefined' && !options.eventTarget) {
    return { dispose: () => undefined };
  }

  const eventTarget = options.eventTarget ?? window;
  const now = options.now ?? Date.now;
  const reload = options.reload ?? (() => eventTarget.location.reload());
  const cooldownMs = Math.max(
    1_000,
    options.cooldownMs ?? DEFAULT_DEPLOYMENT_RECOVERY_COOLDOWN_MS,
  );
  const storageKey = options.storageKey ?? DEFAULT_DEPLOYMENT_RECOVERY_STORAGE_KEY;
  const storage = options.storage === undefined
    ? resolveSessionStorage(eventTarget)
    : options.storage;

  let memoryAttemptAt: number | null = null;
  let disposed = false;

  const attemptRecovery = (reason: string, error: unknown): boolean => {
    if (disposed) return false;

    const timestamp = now();
    const storedAttemptAt = readPreviousAttempt(storage, storageKey);
    const previousAttemptAt = Math.max(
      memoryAttemptAt ?? Number.NEGATIVE_INFINITY,
      storedAttemptAt ?? Number.NEGATIVE_INFINITY,
    );
    const normalizedPrevious = Number.isFinite(previousAttemptAt) ? previousAttemptAt : null;

    if (!canAttemptDeploymentRecovery(normalizedPrevious, timestamp, cooldownMs)) {
      diagnostics.record('deployment.recovery.suppressed', {
        reason,
        cooldownMs,
      }, {
        severity: 'warn',
        message: 'A stale-deployment reload was suppressed to prevent a reload loop.',
      });
      return false;
    }

    memoryAttemptAt = timestamp;
    writeAttempt(storage, storageKey, timestamp);
    diagnostics.record('deployment.recovery.reload', {
      reason,
      cooldownMs,
      errorType: error instanceof Error ? error.name : typeof error,
    }, {
      severity: 'warn',
      message: 'Reloading once to recover from a stale deployment asset reference.',
    });

    try {
      reload();
      return true;
    } catch (reloadError) {
      diagnostics.captureError?.(
        reloadError,
        { source: 'deployment.recovery.reload', reason },
        'error',
      );
      return false;
    }
  };

  const onPreloadError = (event: Event): void => {
    const preloadEvent = event as Event & { payload?: unknown };
    const recovered = attemptRecovery('vite-preload-error', preloadEvent.payload);
    if (recovered) event.preventDefault();
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (!isLikelyStaleDeploymentError(event.reason)) return;
    attemptRecovery('dynamic-import-rejection', event.reason);
  };

  eventTarget.addEventListener('vite:preloadError', onPreloadError as EventListener);
  eventTarget.addEventListener('unhandledrejection', onUnhandledRejection);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      eventTarget.removeEventListener('vite:preloadError', onPreloadError as EventListener);
      eventTarget.removeEventListener('unhandledrejection', onUnhandledRejection);
    },
  };
};
