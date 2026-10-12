export type MapWorkspaceRecoveryPhase = 'idle' | 'booting' | 'delayed' | 'ready' | 'error';
export type MapWorkspaceRecoveryErrorKind = 'runtime' | 'configuration' | 'network' | 'unknown';

export interface MapWorkspaceRecoverySnapshot {
  readonly revision: number;
  readonly phase: MapWorkspaceRecoveryPhase;
  readonly attemptId: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly canRetry: boolean;
  readonly isBusy: boolean;
  readonly startedAt: number | null;
  readonly lastDurationMs: number | null;
  readonly errorKind: MapWorkspaceRecoveryErrorKind | null;
  readonly errorMessage: string | null;
  readonly announcement: string;
}

export interface MapWorkspaceRecoveryDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly observerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastObserverFailureKind: string | null;
  readonly lastReporterFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceRecoveryOptions {
  readonly maxAttempts?: number;
  readonly maxObservers?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = () => void;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 5;
const DEFAULT_MAX_OBSERVERS = 24;
const MAX_OBSERVERS_LIMIT = 64;
const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const safeNow = (clock: () => number): number => {
  const value = clock();
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const sanitizeDiagnosticCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > 40) return null;
  for (const character of normalized) {
    const valid = (
      (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9')
      || character === '_'
      || character === '-'
    );
    if (!valid) return null;
  }
  return normalized;
};

const classifyErrorKind = (error: unknown): MapWorkspaceRecoveryErrorKind => {
  if (!(error instanceof Error)) return 'unknown';
  const name = error.name.toLocaleLowerCase('en-US');
  const message = error.message.toLocaleLowerCase('en-US');
  if (name.includes('network') || message.includes('network') || message.includes('fetch')) return 'network';
  if (name.includes('config') || message.includes('configuration')) return 'configuration';
  return 'runtime';
};

const genericErrorMessage = (kind: MapWorkspaceRecoveryErrorKind): string => {
  if (kind === 'network') return 'Harita bileşenleri yüklenemedi. Ağ bağlantınızı kontrol edin.';
  if (kind === 'configuration') return 'Harita yapılandırması güvenli biçimde yüklenemedi.';
  return 'Harita çalışma alanı güvenli biçimde başlatılamadı.';
};

const createSnapshot = (input: {
  revision: number;
  phase: MapWorkspaceRecoveryPhase;
  attemptId: number;
  attempt: number;
  maxAttempts: number;
  startedAt: number | null;
  lastDurationMs: number | null;
  errorKind: MapWorkspaceRecoveryErrorKind | null;
  errorMessage: string | null;
  announcement: string;
}): MapWorkspaceRecoverySnapshot => Object.freeze({
  revision: input.revision,
  phase: input.phase,
  attemptId: input.attemptId,
  attempt: input.attempt,
  maxAttempts: input.maxAttempts,
  canRetry: input.phase === 'error' && input.attempt < input.maxAttempts,
  isBusy: input.phase === 'booting' || input.phase === 'delayed',
  startedAt: input.startedAt,
  lastDurationMs: input.lastDurationMs,
  errorKind: input.errorKind,
  errorMessage: input.errorMessage,
  announcement: input.announcement,
});

export class MapWorkspaceRecoveryModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxAttempts: number;
  readonly #maxObservers: number;
  readonly #now: () => number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  #snapshot: MapWorkspaceRecoverySnapshot;
  #diagnostics: MapWorkspaceRecoveryDiagnostics;
  #disposed = false;

  constructor(options: MapWorkspaceRecoveryOptions = {}) {
    this.#maxAttempts = clampInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_LIMIT);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#now = options.now ?? Date.now;
    this.#onObserverError = options.onObserverError;
    this.#snapshot = createSnapshot({
      revision: 0,
      phase: 'idle',
      attemptId: 0,
      attempt: 0,
      maxAttempts: this.#maxAttempts,
      startedAt: null,
      lastDurationMs: null,
      errorKind: null,
      errorMessage: null,
      announcement: 'Harita çalışma alanı başlatılmayı bekliyor.',
    });
    this.#diagnostics = Object.freeze({
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      observerFailureCount: 0,
      reporterFailureCount: 0,
      lastObserverFailureKind: null,
      lastReporterFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): MapWorkspaceRecoverySnapshot => this.#snapshot;

  readonly getDiagnostics = (): MapWorkspaceRecoveryDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxObservers) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  beginAttempt(): number | null {
    if (this.#disposed) return null;
    if (this.#snapshot.phase === 'booting' || this.#snapshot.phase === 'delayed') return this.#snapshot.attemptId;
    if (this.#snapshot.attempt >= this.#maxAttempts) return null;
    const attempt = this.#snapshot.attempt + 1;
    const attemptId = this.#snapshot.attemptId + 1;
    this.#emit(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'booting',
      attemptId,
      attempt,
      maxAttempts: this.#maxAttempts,
      startedAt: safeNow(this.#now),
      lastDurationMs: this.#snapshot.lastDurationMs,
      errorKind: null,
      errorMessage: null,
      announcement: attempt > 1
        ? `Harita çalışma alanı yeniden hazırlanıyor. Deneme ${attempt}.`
        : 'Harita çalışma alanı hazırlanıyor.',
    }));
    return attemptId;
  }

  markDelayed(attemptId: number): void {
    if (
      this.#disposed
      || this.#snapshot.attemptId !== attemptId
      || this.#snapshot.phase !== 'booting'
    ) return;
    this.#emit(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'delayed',
      attemptId: this.#snapshot.attemptId,
      attempt: this.#snapshot.attempt,
      maxAttempts: this.#maxAttempts,
      startedAt: this.#snapshot.startedAt,
      lastDurationMs: this.#snapshot.lastDurationMs,
      errorKind: null,
      errorMessage: null,
      announcement: 'Harita hazırlığı beklenenden uzun sürüyor. Bağlantı ve grafik bileşenleri denetleniyor.',
    }));
  }

  succeed(attemptId: number): void {
    if (
      this.#disposed
      || this.#snapshot.attemptId !== attemptId
      || (this.#snapshot.phase !== 'booting' && this.#snapshot.phase !== 'delayed')
    ) return;
    const duration = this.#duration();
    this.#emit(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'ready',
      attemptId: this.#snapshot.attemptId,
      attempt: this.#snapshot.attempt,
      maxAttempts: this.#maxAttempts,
      startedAt: null,
      lastDurationMs: duration,
      errorKind: null,
      errorMessage: null,
      announcement: 'Harita çalışma alanı kullanıma hazır.',
    }));
  }

  fail(attemptId: number, error: unknown, diagnosticCode?: unknown): void {
    if (
      this.#disposed
      || this.#snapshot.attemptId !== attemptId
      || (this.#snapshot.phase !== 'booting' && this.#snapshot.phase !== 'delayed')
    ) return;
    const kind = classifyErrorKind(error);
    const safeCode = sanitizeDiagnosticCode(diagnosticCode);
    const base = genericErrorMessage(kind);
    const errorMessage = safeCode ? `${base} Hata kodu: ${safeCode}.` : base;
    const canRetry = this.#snapshot.attempt < this.#maxAttempts;
    this.#emit(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'error',
      attemptId: this.#snapshot.attemptId,
      attempt: this.#snapshot.attempt,
      maxAttempts: this.#maxAttempts,
      startedAt: null,
      lastDurationMs: this.#duration(),
      errorKind: kind,
      errorMessage,
      announcement: canRetry
        ? `${errorMessage} Yeniden deneyebilirsiniz.`
        : `${errorMessage} Otomatik yeniden deneme sınırına ulaşıldı.`,
    }));
  }

  canRetry(): boolean {
    return !this.#disposed && this.#snapshot.canRetry;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  disposed(): boolean {
    return this.#disposed;
  }

  #duration(): number | null {
    if (this.#snapshot.startedAt === null) return this.#snapshot.lastDurationMs;
    return Math.max(0, safeNow(this.#now) - this.#snapshot.startedAt);
  }

  #emit(next: MapWorkspaceRecoverySnapshot): void {
    if (this.#disposed || next === this.#snapshot) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordObserverFailure(error);
      }
    }
  }

  #recordObserverFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      observerFailureCount: this.#diagnostics.observerFailureCount + 1,
      lastObserverFailureKind: classifyFailure(error),
    });
    if (!this.#onObserverError) return;
    try {
      this.#onObserverError(error);
    } catch (reporterError) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        reporterFailureCount: this.#diagnostics.reporterFailureCount + 1,
        lastReporterFailureKind: classifyFailure(reporterError),
      });
    }
  }

  #recordRejectedObserver(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
    });
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshObserverCount();
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
  }
}
