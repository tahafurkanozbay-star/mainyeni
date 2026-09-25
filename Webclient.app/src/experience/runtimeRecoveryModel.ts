export type RuntimeRecoveryPhase = 'healthy' | 'crashed' | 'recovering' | 'locked';
export type RuntimeRecoveryTone = 'neutral' | 'warning' | 'danger';

export interface RuntimeFailureInput {
  readonly error: unknown;
  readonly source?: string;
  readonly componentStack?: string | null;
}

export interface RuntimeFailureSummary {
  readonly name: string;
  readonly code: string | null;
  readonly source: string;
  readonly message: string;
  readonly componentHint: string | null;
  readonly fingerprint: string;
}

export interface RuntimeRecoverySnapshot {
  readonly phase: RuntimeRecoveryPhase;
  readonly tone: RuntimeRecoveryTone;
  readonly failure: RuntimeFailureSummary | null;
  readonly recoveryAttempts: number;
  readonly maxRecoveryAttempts: number;
  readonly canRecover: boolean;
  readonly canReload: boolean;
  readonly capturedAt: number | null;
  readonly lastRecoveredAt: number | null;
  readonly heading: string;
  readonly message: string;
  readonly announcement: string;
  readonly revision: number;
}

export interface RuntimeRecoveryModelOptions {
  readonly maxRecoveryAttempts?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

export interface RuntimeRecoveryModel {
  snapshot(): RuntimeRecoverySnapshot;
  capture(input: RuntimeFailureInput): RuntimeRecoverySnapshot;
  beginRecovery(): boolean;
  completeRecovery(): void;
  failRecovery(input: RuntimeFailureInput): void;
  reset(): void;
  subscribe(observer: (snapshot: RuntimeRecoverySnapshot) => void): () => void;
}

interface MutableState {
  phase: RuntimeRecoveryPhase;
  failure: RuntimeFailureSummary | null;
  recoveryAttempts: number;
  capturedAt: number | null;
  lastRecoveredAt: number | null;
  revision: number;
}

const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;
const HARD_MAX_RECOVERY_ATTEMPTS = 4;
const MAX_MESSAGE_LENGTH = 240;
const MAX_SOURCE_LENGTH = 72;
const MAX_COMPONENT_HINT_LENGTH = 120;

const clampInteger = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
};

const sanitizeWhitespace = (value: string, limit: number): string =>
  value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

const sanitizeSource = (value: string | undefined): string => {
  const normalized = sanitizeWhitespace(value ?? '', MAX_SOURCE_LENGTH);
  return /^[a-zA-Z0-9._:-]{1,72}$/.test(normalized) ? normalized : 'react.render';
};

const extractSafeCode = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const candidate = (error as Error & { code?: unknown }).code;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,48}$/.test(normalized) ? normalized : null;
};

const safeErrorName = (error: unknown): string => {
  if (!(error instanceof Error)) return 'RuntimeError';
  const name = sanitizeWhitespace(error.name || 'Error', 48);
  return /^[a-zA-Z0-9_.-]{1,48}$/.test(name) ? name : 'Error';
};

const safeErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Arayüz çalışma zamanı beklenmeyen bir durumla karşılaştı.';
  const message = sanitizeWhitespace(error.message, MAX_MESSAGE_LENGTH);
  return message || 'Arayüz çalışma zamanı beklenmeyen bir durumla karşılaştı.';
};

const componentHint = (stack: string | null | undefined): string | null => {
  if (!stack) return null;
  const lines = stack
    .split('\n')
    .map(line => sanitizeWhitespace(line, MAX_COMPONENT_HINT_LENGTH))
    .filter(Boolean);
  const firstComponent = lines.find(line => /^at\s+[A-Z][A-Za-z0-9_$.-]*/.test(line));
  if (!firstComponent) return null;
  return firstComponent
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+at\s+/g, ' at ')
    .trim()
    .slice(0, MAX_COMPONENT_HINT_LENGTH);
};

const hashText = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const summarizeFailure = (input: RuntimeFailureInput): RuntimeFailureSummary => {
  const name = safeErrorName(input.error);
  const code = extractSafeCode(input.error);
  const source = sanitizeSource(input.source);
  const message = safeErrorMessage(input.error);
  const hint = componentHint(input.componentStack);
  const fingerprint = `UI-${hashText(`${name}|${code ?? ''}|${source}|${message}|${hint ?? ''}`)}`;

  return Object.freeze({
    name,
    code,
    source,
    message,
    componentHint: hint,
    fingerprint,
  });
};

const deriveCopy = (
  phase: RuntimeRecoveryPhase,
  attempts: number,
  maxAttempts: number,
): Readonly<{ heading: string; message: string; announcement: string }> => {
  switch (phase) {
    case 'crashed':
      return Object.freeze({
        heading: 'Arayüz güvenli moda alındı',
        message: 'Beklenmeyen bir görüntüleme hatası yakalandı. Harita verisi değiştirilmeden arayüz yeniden kurulabilir.',
        announcement: 'Arayüz hatası yakalandı. Güvenli kurtarma seçeneği kullanılabilir.',
      });
    case 'recovering':
      return Object.freeze({
        heading: 'Arayüz yeniden kuruluyor',
        message: `Kullanıcı arayüzü temiz bir render döngüsüyle yeniden başlatılıyor. Kurtarma ${attempts}/${maxAttempts}.`,
        announcement: `Arayüz kurtarma işlemi başlatıldı. Deneme ${attempts}.`,
      });
    case 'locked':
      return Object.freeze({
        heading: 'Güvenli kurtarma sınırına ulaşıldı',
        message: 'Tekrarlayan render hatalarını sonsuz döngüye sokmamak için otomatik kurtarma durduruldu. Sayfayı yenileyerek temiz bir oturum başlatın.',
        announcement: 'Arayüz kurtarma sınırına ulaşıldı. Sayfanın yenilenmesi gerekiyor.',
      });
    default:
      return Object.freeze({
        heading: 'Arayüz sağlıklı',
        message: 'Kent Rehberi kullanıcı arayüzü normal çalışıyor.',
        announcement: 'Arayüz hazır.',
      });
  }
};

const toneForPhase = (phase: RuntimeRecoveryPhase): RuntimeRecoveryTone => {
  if (phase === 'healthy') return 'neutral';
  if (phase === 'recovering') return 'warning';
  return 'danger';
};

export const createRuntimeRecoveryModel = (
  options: RuntimeRecoveryModelOptions = {},
): RuntimeRecoveryModel => {
  const maxRecoveryAttempts = clampInteger(
    options.maxRecoveryAttempts,
    DEFAULT_MAX_RECOVERY_ATTEMPTS,
    1,
    HARD_MAX_RECOVERY_ATTEMPTS,
  );
  const now = options.now ?? Date.now;
  const observers = new Set<(snapshot: RuntimeRecoverySnapshot) => void>();
  const state: MutableState = {
    phase: 'healthy',
    failure: null,
    recoveryAttempts: 0,
    capturedAt: null,
    lastRecoveredAt: null,
    revision: 0,
  };

  const reportObserverError = (error: unknown): void => {
    if (!options.onObserverError) return;
    try {
      options.onObserverError(error);
    } catch (reportError) {
      void reportError;
    }
  };

  const buildSnapshot = (): RuntimeRecoverySnapshot => {
    const exhausted = state.recoveryAttempts >= maxRecoveryAttempts;
    const effectivePhase = state.phase === 'crashed' && exhausted ? 'locked' : state.phase;
    const copy = deriveCopy(effectivePhase, state.recoveryAttempts, maxRecoveryAttempts);
    return Object.freeze({
      phase: effectivePhase,
      tone: toneForPhase(effectivePhase),
      failure: state.failure,
      recoveryAttempts: state.recoveryAttempts,
      maxRecoveryAttempts,
      canRecover: effectivePhase === 'crashed' && !exhausted,
      canReload: effectivePhase === 'crashed' || effectivePhase === 'locked',
      capturedAt: state.capturedAt,
      lastRecoveredAt: state.lastRecoveredAt,
      heading: copy.heading,
      message: copy.message,
      announcement: copy.announcement,
      revision: state.revision,
    });
  };

  const notify = (): RuntimeRecoverySnapshot => {
    state.revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach(observer => {
      try {
        observer(snapshot);
      } catch (error) {
        reportObserverError(error);
      }
    });
    return snapshot;
  };

  return {
    snapshot: buildSnapshot,
    capture(input) {
      state.failure = summarizeFailure(input);
      state.capturedAt = now();
      state.phase = state.recoveryAttempts >= maxRecoveryAttempts ? 'locked' : 'crashed';
      return notify();
    },
    beginRecovery() {
      if (state.phase !== 'crashed') return false;
      if (state.recoveryAttempts >= maxRecoveryAttempts) {
        state.phase = 'locked';
        notify();
        return false;
      }
      state.recoveryAttempts += 1;
      state.phase = 'recovering';
      notify();
      return true;
    },
    completeRecovery() {
      if (state.phase !== 'recovering') return;
      state.phase = 'healthy';
      state.failure = null;
      state.lastRecoveredAt = now();
      notify();
    },
    failRecovery(input) {
      state.failure = summarizeFailure(input);
      state.capturedAt = now();
      state.phase = state.recoveryAttempts >= maxRecoveryAttempts ? 'locked' : 'crashed';
      notify();
    },
    reset() {
      state.phase = 'healthy';
      state.failure = null;
      state.recoveryAttempts = 0;
      state.capturedAt = null;
      state.lastRecoveredAt = null;
      notify();
    },
    subscribe(observer) {
      observers.add(observer);
      try {
        observer(buildSnapshot());
      } catch (error) {
        reportObserverError(error);
      }
      return () => observers.delete(observer);
    },
  };
};
