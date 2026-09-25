export type StartupPhase =
  | 'idle'
  | 'starting'
  | 'delayed'
  | 'offline'
  | 'failed'
  | 'ready';

export type StartupTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export interface StartupFailureInput {
  readonly message: string;
  readonly code?: string | null;
  readonly retryable?: boolean;
}

export interface StartupFailure {
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean;
}

export interface StartupExperienceSnapshot {
  readonly phase: StartupPhase;
  readonly tone: StartupTone;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly online: boolean;
  readonly startedAt: number | null;
  readonly elapsedMs: number;
  readonly delayedAfterMs: number;
  readonly failure: StartupFailure | null;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly canRetry: boolean;
  readonly exhausted: boolean;
  readonly heading: string;
  readonly message: string;
  readonly announcement: string;
  readonly revision: number;
}

export interface StartupExperienceModelOptions {
  readonly delayedAfterMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly initialOnline?: boolean;
  readonly onObserverError?: (error: unknown) => void;
}

export interface StartupExperienceModel {
  snapshot(): StartupExperienceSnapshot;
  beginAttempt(): boolean;
  refresh(): void;
  setOnline(online: boolean): void;
  fail(failure: StartupFailureInput): void;
  succeed(): void;
  reset(): void;
  subscribe(observer: (snapshot: StartupExperienceSnapshot) => void): () => void;
}

interface MutableStartupState {
  phase: StartupPhase;
  attempt: number;
  online: boolean;
  startedAt: number | null;
  failure: StartupFailure | null;
  revision: number;
}

const DEFAULT_DELAYED_AFTER_MS = 7_000;
const MIN_DELAYED_AFTER_MS = 1_500;
const MAX_DELAYED_AFTER_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const HARD_MAX_ATTEMPTS = 8;
const MAX_FAILURE_MESSAGE = 320;
const MAX_FAILURE_CODE = 48;

const clampInteger = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
};

const normalizeMessage = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').slice(0, MAX_FAILURE_MESSAGE);

const normalizeCode = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,48}$/.test(normalized)
    ? normalized.slice(0, MAX_FAILURE_CODE)
    : null;
};

const freezeFailure = (input: StartupFailureInput): StartupFailure => Object.freeze({
  message: normalizeMessage(input.message) || 'Harita çalışma alanı başlatılamadı.',
  code: normalizeCode(input.code),
  retryable: input.retryable !== false,
});

const phaseTone = (phase: StartupPhase): StartupTone => {
  switch (phase) {
    case 'starting':
      return 'info';
    case 'delayed':
    case 'offline':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'ready':
      return 'success';
    default:
      return 'neutral';
  }
};

const deriveCopy = (
  phase: StartupPhase,
  failure: StartupFailure | null,
  attempt: number,
  maxAttempts: number,
): Readonly<{ heading: string; message: string; announcement: string }> => {
  switch (phase) {
    case 'starting':
      return Object.freeze({
        heading: attempt > 1 ? 'Kent Rehberi yeniden hazırlanıyor' : 'Kent Rehberi hazırlanıyor',
        message: 'Harita motoru, çalışma alanı ve güvenli uygulama yapılandırması yükleniyor.',
        announcement: attempt > 1
          ? `Kent Rehberi yeniden başlatılıyor. Deneme ${attempt}.`
          : 'Kent Rehberi başlatılıyor.',
      });
    case 'delayed':
      return Object.freeze({
        heading: 'Başlatma beklenenden uzun sürüyor',
        message: 'İşlem devam ediyor. Ağ bağlantısı veya harita kaynakları yavaş yanıt veriyor olabilir.',
        announcement: 'Başlatma işlemi beklenenden uzun sürüyor ancak devam ediyor.',
      });
    case 'offline':
      return Object.freeze({
        heading: 'Bağlantı bekleniyor',
        message: 'Kent Rehberi çevrimiçi kaynaklarla başlatılabilmek için ağ bağlantısının geri gelmesini bekliyor.',
        announcement: 'Ağ bağlantısı yok. Bağlantı geri geldiğinde tekrar deneyebilirsiniz.',
      });
    case 'failed': {
      const suffix = failure?.code ? ` Hata kodu: ${failure.code}.` : '';
      const exhausted = attempt >= maxAttempts;
      return Object.freeze({
        heading: exhausted ? 'Başlatma sınırına ulaşıldı' : 'Kent Rehberi başlatılamadı',
        message: failure?.message ?? 'Harita çalışma alanı başlatılırken beklenmeyen bir hata oluştu.',
        announcement: `${failure?.message ?? 'Kent Rehberi başlatılamadı.'}${suffix}`,
      });
    }
    case 'ready':
      return Object.freeze({
        heading: 'Kent Rehberi hazır',
        message: 'Harita çalışma alanı kullanıma hazır.',
        announcement: 'Kent Rehberi hazır.',
      });
    default:
      return Object.freeze({
        heading: 'Kent Rehberi hazırlanıyor',
        message: 'Başlatma işlemi hazırlanıyor.',
        announcement: 'Kent Rehberi hazırlanıyor.',
      });
  }
};

export const createStartupExperienceModel = (
  options: StartupExperienceModelOptions = {},
): StartupExperienceModel => {
  const delayedAfterMs = clampInteger(
    options.delayedAfterMs,
    DEFAULT_DELAYED_AFTER_MS,
    MIN_DELAYED_AFTER_MS,
    MAX_DELAYED_AFTER_MS,
  );
  const maxAttempts = clampInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    1,
    HARD_MAX_ATTEMPTS,
  );
  const now = options.now ?? Date.now;
  const observers = new Set<(snapshot: StartupExperienceSnapshot) => void>();
  const state: MutableStartupState = {
    phase: 'idle',
    attempt: 0,
    online: options.initialOnline !== false,
    startedAt: null,
    failure: null,
    revision: 0,
  };

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reporterError) {
      void reporterError;
    }
  };

  const elapsed = (): number => {
    if (state.startedAt === null) return 0;
    return Math.max(0, Math.floor(now() - state.startedAt));
  };

  const effectivePhase = (): StartupPhase => {
    if (state.phase === 'ready' || state.phase === 'failed') return state.phase;
    if (!state.online && state.attempt > 0) return 'offline';
    if (state.phase === 'starting' || state.phase === 'delayed') {
      return elapsed() >= delayedAfterMs ? 'delayed' : 'starting';
    }
    return state.phase;
  };

  const buildSnapshot = (): StartupExperienceSnapshot => {
    const phase = effectivePhase();
    const exhausted = state.attempt >= maxAttempts;
    const copy = deriveCopy(phase, state.failure, state.attempt, maxAttempts);
    const retryableFailure = state.failure?.retryable !== false;
    const canRetry = phase === 'failed'
      && state.online
      && retryableFailure
      && !exhausted;

    return Object.freeze({
      phase,
      tone: phaseTone(phase),
      attempt: state.attempt,
      maxAttempts,
      online: state.online,
      startedAt: state.startedAt,
      elapsedMs: elapsed(),
      delayedAfterMs,
      failure: state.failure,
      ready: phase === 'ready',
      busy: phase === 'idle' || phase === 'starting' || phase === 'delayed' || phase === 'offline',
      canRetry,
      exhausted,
      heading: copy.heading,
      message: copy.message,
      announcement: copy.announcement,
      revision: state.revision,
    });
  };

  const notify = (): void => {
    state.revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach((observer) => {
      try {
        observer(snapshot);
      } catch (error) {
        report(error);
      }
    });
  };

  const beginAttempt = (): boolean => {
    if (state.phase === 'ready') return false;
    if (state.attempt >= maxAttempts) return false;
    if (!state.online) {
      state.phase = 'offline';
      state.startedAt = null;
      state.failure = null;
      notify();
      return false;
    }
    state.attempt += 1;
    state.phase = 'starting';
    state.startedAt = now();
    state.failure = null;
    notify();
    return true;
  };

  return {
    snapshot: buildSnapshot,
    beginAttempt,
    refresh() {
      if (state.phase !== 'starting' && state.phase !== 'delayed' && state.phase !== 'offline') return;
      notify();
    },
    setOnline(online) {
      if (state.online === online) return;
      state.online = online;
      if (!online && state.phase !== 'ready' && state.phase !== 'failed') {
        state.phase = 'offline';
      } else if (online && state.phase === 'offline') {
        state.phase = state.startedAt === null ? 'idle' : 'starting';
      }
      notify();
    },
    fail(input) {
      if (state.phase === 'ready') return;
      state.phase = 'failed';
      state.failure = freezeFailure(input);
      notify();
    },
    succeed() {
      if (state.phase === 'ready') return;
      state.phase = 'ready';
      state.failure = null;
      notify();
    },
    reset() {
      state.phase = 'idle';
      state.attempt = 0;
      state.startedAt = null;
      state.failure = null;
      notify();
    },
    subscribe(observer) {
      observers.add(observer);
      try {
        observer(buildSnapshot());
      } catch (error) {
        report(error);
      }
      return () => observers.delete(observer);
    },
  };
};
