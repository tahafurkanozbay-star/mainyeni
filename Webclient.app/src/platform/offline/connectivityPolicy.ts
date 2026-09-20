export type ConnectivitySignalKind = 'browser' | 'probe-success' | 'probe-failure' | 'request-success' | 'request-failure';
export type ConnectivityState = 'online' | 'degraded' | 'offline' | 'unknown';

export interface ConnectivitySignal {
  readonly kind: ConnectivitySignalKind;
  readonly at?: number;
  readonly online?: boolean;
  readonly latencyMs?: number;
  readonly status?: number;
  readonly reason?: string;
}

export interface ConnectivityPolicyOptions {
  readonly historyLimit?: number;
  readonly offlineFailureThreshold?: number;
  readonly recoverySuccessThreshold?: number;
  readonly degradedLatencyMs?: number;
  readonly staleAfterMs?: number;
  readonly maxReasonLength?: number;
  readonly clock?: () => number;
}

export interface ConnectivitySnapshot {
  readonly state: ConnectivityState;
  readonly confidence: number;
  readonly consecutiveSuccesses: number;
  readonly consecutiveFailures: number;
  readonly lastSignalAt?: number;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
  readonly latencyMs?: number;
  readonly reason?: string;
}

export interface ConnectivityEvent extends ConnectivitySnapshot {
  readonly sequence: number;
  readonly signal: ConnectivitySignalKind;
  readonly at: number;
}

const integer = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const finite = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const isControlCodePoint = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
};

const replaceControlCodePoints = (value: string): string => {
  let result = '';
  let replacing = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const control = codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    if (control) {
      if (!replacing) result += ' ';
      replacing = true;
    } else {
      result += character;
      replacing = false;
    }
  }
  return result;
};

const classifyFailure = (signal: ConnectivitySignal): boolean => {
  if (signal.kind === 'probe-failure' || signal.kind === 'request-failure') return true;
  if (signal.kind === 'browser') return signal.online === false;
  return false;
};

const classifySuccess = (signal: ConnectivitySignal): boolean => {
  if (signal.kind === 'probe-success' || signal.kind === 'request-success') return true;
  if (signal.kind === 'browser') return signal.online === true;
  return false;
};

export class ConnectivityPolicy {
  readonly historyLimit: number;
  readonly offlineFailureThreshold: number;
  readonly recoverySuccessThreshold: number;
  readonly degradedLatencyMs: number;
  readonly staleAfterMs: number;
  readonly maxReasonLength: number;
  readonly #clock: () => number;
  readonly #history: ConnectivityEvent[] = [];
  #state: ConnectivityState = 'unknown';
  #confidence = 0;
  #successes = 0;
  #failures = 0;
  #lastSignalAt: number | undefined;
  #lastSuccessAt: number | undefined;
  #lastFailureAt: number | undefined;
  #latencyMs: number | undefined;
  #reason: string | undefined;
  #sequence = 0;

  constructor(options: ConnectivityPolicyOptions = {}) {
    this.historyLimit = integer('historyLimit', options.historyLimit ?? 64, 0, 1_000);
    this.offlineFailureThreshold = integer('offlineFailureThreshold', options.offlineFailureThreshold ?? 3, 1, 20);
    this.recoverySuccessThreshold = integer('recoverySuccessThreshold', options.recoverySuccessThreshold ?? 2, 1, 20);
    this.degradedLatencyMs = integer('degradedLatencyMs', options.degradedLatencyMs ?? 2_500, 100, 120_000);
    this.staleAfterMs = integer('staleAfterMs', options.staleAfterMs ?? 60_000, 1_000, 24 * 60 * 60 * 1000);
    this.maxReasonLength = integer('maxReasonLength', options.maxReasonLength ?? 160, 16, 1_024);
    this.#clock = options.clock ?? Date.now;
  }

  observe(signal: ConnectivitySignal): ConnectivitySnapshot {
    const at = signal.at ?? this.#clock();
    finite('signal.at', at, 0, Number.MAX_SAFE_INTEGER);
    if (this.#lastSignalAt !== undefined && at < this.#lastSignalAt) throw new RangeError('connectivity signals must be monotonic');
    if (signal.kind === 'browser' && typeof signal.online !== 'boolean') throw new TypeError('browser signal requires online');
    if (signal.latencyMs !== undefined) this.#latencyMs = finite('latencyMs', signal.latencyMs, 0, 300_000);
    if (signal.status !== undefined) integer('status', signal.status, 0, 999);
    this.#reason = this.#sanitizeReason(signal.reason);
    this.#lastSignalAt = at;

    if (classifySuccess(signal)) {
      this.#successes += 1;
      this.#failures = 0;
      this.#lastSuccessAt = at;
      this.#confidence = Math.min(1, this.#confidence + (signal.kind === 'probe-success' ? 0.5 : 0.25));
      const slow = this.#latencyMs !== undefined && this.#latencyMs >= this.degradedLatencyMs;
      if (this.#state === 'offline' && this.#successes < this.recoverySuccessThreshold) {
        this.#state = 'degraded';
      } else {
        this.#state = slow ? 'degraded' : 'online';
      }
    } else if (classifyFailure(signal)) {
      this.#failures += 1;
      this.#successes = 0;
      this.#lastFailureAt = at;
      this.#confidence = Math.max(0, this.#confidence - (signal.kind === 'probe-failure' ? 0.5 : 0.25));
      if (signal.kind === 'browser' && signal.online === false) {
        this.#state = 'offline';
        this.#confidence = 1;
      } else if (this.#failures >= this.offlineFailureThreshold) {
        this.#state = 'offline';
        this.#confidence = Math.max(this.#confidence, 0.75);
      } else {
        this.#state = 'degraded';
      }
    }

    const snapshot = this.snapshot(at);
    this.#record(signal.kind, at, snapshot);
    return snapshot;
  }

  snapshot(now = this.#clock()): ConnectivitySnapshot {
    finite('now', now, 0, Number.MAX_SAFE_INTEGER);
    let state = this.#state;
    let confidence = this.#confidence;
    let reason = this.#reason;
    if (this.#lastSignalAt !== undefined && now - this.#lastSignalAt > this.staleAfterMs) {
      state = 'unknown';
      confidence = 0;
      reason = 'connectivity-evidence-stale';
    }
    return Object.freeze({
      state,
      confidence,
      consecutiveSuccesses: this.#successes,
      consecutiveFailures: this.#failures,
      ...(this.#lastSignalAt !== undefined ? { lastSignalAt: this.#lastSignalAt } : {}),
      ...(this.#lastSuccessAt !== undefined ? { lastSuccessAt: this.#lastSuccessAt } : {}),
      ...(this.#lastFailureAt !== undefined ? { lastFailureAt: this.#lastFailureAt } : {}),
      ...(this.#latencyMs !== undefined ? { latencyMs: this.#latencyMs } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  history(): readonly ConnectivityEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  reset(): void {
    this.#state = 'unknown';
    this.#confidence = 0;
    this.#successes = 0;
    this.#failures = 0;
    this.#lastSignalAt = undefined;
    this.#lastSuccessAt = undefined;
    this.#lastFailureAt = undefined;
    this.#latencyMs = undefined;
    this.#reason = undefined;
    this.#history.splice(0);
  }

  #sanitizeReason(reason: string | undefined): string | undefined {
    if (reason === undefined) return undefined;
    if (typeof reason !== 'string') throw new TypeError('reason must be a string');
    const normalized = (isControlCodePoint(reason) ? replaceControlCodePoints(reason) : reason).trim();
    if (!normalized) return undefined;
    return normalized.slice(0, this.maxReasonLength);
  }

  #record(signal: ConnectivitySignalKind, at: number, snapshot: ConnectivitySnapshot): void {
    if (this.historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, signal, at, ...snapshot }));
    if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit);
  }
}
