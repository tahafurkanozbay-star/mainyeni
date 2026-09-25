export type ConnectivityPhase = 'online' | 'offline' | 'restored';
export type ConnectivityTone = 'neutral' | 'warning' | 'success';

export interface ConnectivityExperienceSnapshot {
  readonly phase: ConnectivityPhase;
  readonly tone: ConnectivityTone;
  readonly online: boolean;
  readonly offlineSince: number | null;
  readonly restoredAt: number | null;
  readonly offlineDurationMs: number;
  readonly interruptionCount: number;
  readonly restoredVisibleMs: number;
  readonly visible: boolean;
  readonly heading: string;
  readonly message: string;
  readonly announcement: string;
  readonly revision: number;
}

export interface ConnectivityExperienceModelOptions {
  readonly initialOnline?: boolean;
  readonly restoredVisibleMs?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

export interface ConnectivityExperienceModel {
  snapshot(): ConnectivityExperienceSnapshot;
  setOnline(online: boolean): void;
  refresh(): void;
  dismissRestored(): void;
  reset(): void;
  subscribe(observer: (snapshot: ConnectivityExperienceSnapshot) => void): () => void;
}

interface MutableConnectivityState {
  phase: ConnectivityPhase;
  online: boolean;
  offlineSince: number | null;
  restoredAt: number | null;
  lastOfflineDurationMs: number;
  interruptionCount: number;
  revision: number;
}

const DEFAULT_RESTORED_VISIBLE_MS = 4_500;
const MIN_RESTORED_VISIBLE_MS = 1_500;
const MAX_RESTORED_VISIBLE_MS = 15_000;
const MAX_INTERRUPTION_COUNT = 999;

const clampInteger = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
};

const durationCopy = (durationMs: number): string => {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 2) return 'kısa süreli';
  if (seconds < 60) return `${seconds} saniyelik`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} dakikalık`;
};

const deriveCopy = (
  phase: ConnectivityPhase,
  offlineDurationMs: number,
): Readonly<{ heading: string; message: string; announcement: string }> => {
  if (phase === 'offline') {
    return Object.freeze({
      heading: 'Bağlantı kesildi',
      message: 'Harita ve kent servisleri çevrimiçi bağlantı gerektirebilir. Açık işlemler korunur; bağlantı geri geldiğinde arayüz otomatik güncellenir.',
      announcement: 'Ağ bağlantısı kesildi. Harita servisleri geçici olarak kullanılamayabilir.',
    });
  }

  if (phase === 'restored') {
    const duration = durationCopy(offlineDurationMs);
    return Object.freeze({
      heading: 'Bağlantı yeniden kuruldu',
      message: `${durationCopy(offlineDurationMs)} bağlantı kesintisi sona erdi. Yeni harita ve sorgu işlemleri yeniden kullanılabilir.`,
      announcement: `Ağ bağlantısı yeniden kuruldu. ${duration} kesinti sona erdi.`,
    });
  }

  return Object.freeze({
    heading: 'Bağlantı etkin',
    message: 'Kent Rehberi çevrimiçi.',
    announcement: 'Ağ bağlantısı etkin.',
  });
};

const toneForPhase = (phase: ConnectivityPhase): ConnectivityTone => {
  if (phase === 'offline') return 'warning';
  if (phase === 'restored') return 'success';
  return 'neutral';
};

export const createConnectivityExperienceModel = (
  options: ConnectivityExperienceModelOptions = {},
): ConnectivityExperienceModel => {
  const now = options.now ?? Date.now;
  const restoredVisibleMs = clampInteger(
    options.restoredVisibleMs,
    DEFAULT_RESTORED_VISIBLE_MS,
    MIN_RESTORED_VISIBLE_MS,
    MAX_RESTORED_VISIBLE_MS,
  );
  const initialOnline = options.initialOnline !== false;
  const observers = new Set<(snapshot: ConnectivityExperienceSnapshot) => void>();
  const state: MutableConnectivityState = {
    phase: initialOnline ? 'online' : 'offline',
    online: initialOnline,
    offlineSince: initialOnline ? null : now(),
    restoredAt: null,
    lastOfflineDurationMs: 0,
    interruptionCount: initialOnline ? 0 : 1,
    revision: 0,
  };

  const reportObserverError = (error: unknown): void => {
    if (!options.onObserverError) return;
    try {
      options.onObserverError(error);
    } catch (reporterError) {
      void reporterError;
    }
  };

  const liveOfflineDuration = (): number => {
    if (state.phase === 'offline' && state.offlineSince !== null) {
      return Math.max(0, Math.floor(now() - state.offlineSince));
    }
    return state.lastOfflineDurationMs;
  };

  const effectivePhase = (): ConnectivityPhase => {
    if (
      state.phase === 'restored'
      && state.restoredAt !== null
      && now() - state.restoredAt >= restoredVisibleMs
    ) {
      return 'online';
    }
    return state.phase;
  };

  const buildSnapshot = (): ConnectivityExperienceSnapshot => {
    const phase = effectivePhase();
    const offlineDurationMs = liveOfflineDuration();
    const copy = deriveCopy(phase, offlineDurationMs);
    return Object.freeze({
      phase,
      tone: toneForPhase(phase),
      online: state.online,
      offlineSince: state.offlineSince,
      restoredAt: state.restoredAt,
      offlineDurationMs,
      interruptionCount: state.interruptionCount,
      restoredVisibleMs,
      visible: phase !== 'online',
      heading: copy.heading,
      message: copy.message,
      announcement: copy.announcement,
      revision: state.revision,
    });
  };

  const notify = (): void => {
    state.revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach(observer => {
      try {
        observer(snapshot);
      } catch (error) {
        reportObserverError(error);
      }
    });
  };

  return {
    snapshot: buildSnapshot,
    setOnline(online) {
      if (state.online === online) return;
      const currentTime = now();
      state.online = online;

      if (!online) {
        state.phase = 'offline';
        state.offlineSince = currentTime;
        state.restoredAt = null;
        state.interruptionCount = Math.min(
          MAX_INTERRUPTION_COUNT,
          state.interruptionCount + 1,
        );
      } else {
        const started = state.offlineSince;
        state.lastOfflineDurationMs = started === null
          ? 0
          : Math.max(0, Math.floor(currentTime - started));
        state.phase = 'restored';
        state.offlineSince = null;
        state.restoredAt = currentTime;
      }
      notify();
    },
    refresh() {
      if (state.phase === 'online') return;
      if (state.phase === 'restored' && effectivePhase() === 'online') {
        state.phase = 'online';
        state.restoredAt = null;
      }
      notify();
    },
    dismissRestored() {
      if (state.phase !== 'restored') return;
      state.phase = 'online';
      state.restoredAt = null;
      notify();
    },
    reset() {
      const online = state.online;
      state.phase = online ? 'online' : 'offline';
      state.offlineSince = online ? null : now();
      state.restoredAt = null;
      state.lastOfflineDurationMs = 0;
      state.interruptionCount = online ? 0 : 1;
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
