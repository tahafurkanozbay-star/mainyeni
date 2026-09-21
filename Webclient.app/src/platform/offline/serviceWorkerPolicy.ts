export type ServiceWorkerPhase = 'idle' | 'registering' | 'active' | 'update-available' | 'activating' | 'degraded' | 'disposed';
export type ServiceWorkerTrigger = 'startup' | 'focus' | 'visibility' | 'manual';

export interface ServiceWorkerPolicyOptions {
  readonly scriptUrl?: string;
  readonly scope?: string;
  readonly minUpdateIntervalMs?: number;
  readonly registrationTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
}

export interface ServiceWorkerRegistrationPort {
  readonly scope: string;
  readonly active: ServiceWorkerHandle | null;
  readonly waiting: ServiceWorkerHandle | null;
  readonly installing: ServiceWorkerHandle | null;
  update(): Promise<void>;
  unregister(): Promise<boolean>;
  addEventListener(type: 'updatefound', listener: () => void): void;
  removeEventListener(type: 'updatefound', listener: () => void): void;
}

export interface ServiceWorkerHandle {
  readonly state: string;
  postMessage(message: Readonly<Record<string, unknown>>): void;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface ServiceWorkerNavigatorPort {
  readonly controller: ServiceWorkerHandle | null;
  register(scriptUrl: string, options: { scope: string; updateViaCache: 'none' }): Promise<ServiceWorkerRegistrationPort>;
  readonly ready: Promise<ServiceWorkerRegistrationPort>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface ServiceWorkerPolicySnapshot {
  readonly phase: ServiceWorkerPhase;
  readonly supported: boolean;
  readonly registered: boolean;
  readonly controlled: boolean;
  readonly updateAvailable: boolean;
  readonly consecutiveFailures: number;
  readonly lastRegistrationAt?: number;
  readonly lastUpdateCheckAt?: number;
  readonly lastActivationAt?: number;
  readonly reason?: string;
}

export interface ServiceWorkerPolicyEvent extends ServiceWorkerPolicySnapshot {
  readonly sequence: number;
  readonly at: number;
  readonly action: 'register' | 'registered' | 'check' | 'update-found' | 'activate' | 'activated' | 'failure' | 'dispose';
}

const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const boundedPath = (name: string, value: string, maxLength: number): string => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) throw new TypeError(`${name} contains control characters`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !normalized.startsWith('/') || normalized.startsWith('//')) {
    throw new TypeError(`${name} must be a same-origin absolute path`);
  }
  return normalized;
};

const safeReason = (error: unknown): string => {
  const value = error instanceof Error ? error.name : typeof error === 'string' ? error : 'unknown';
  return value.slice(0, 80);
};

const withDeadline = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class ServiceWorkerPolicy {
  readonly scriptUrl: string;
  readonly scope: string;
  readonly minUpdateIntervalMs: number;
  readonly registrationTimeoutMs: number;
  readonly activationTimeoutMs: number;
  readonly maxConsecutiveFailures: number;
  readonly historyLimit: number;
  readonly #clock: () => number;
  readonly #history: ServiceWorkerPolicyEvent[] = [];
  #navigator: ServiceWorkerNavigatorPort | undefined;
  #registration: ServiceWorkerRegistrationPort | undefined;
  #phase: ServiceWorkerPhase = 'idle';
  #disposed = false;
  #sequence = 0;
  #consecutiveFailures = 0;
  #lastRegistrationAt: number | undefined;
  #lastUpdateCheckAt: number | undefined;
  #lastActivationAt: number | undefined;
  #reason: string | undefined;
  #operation: Promise<void> | undefined;
  #waiting: ServiceWorkerHandle | undefined;

  constructor(options: ServiceWorkerPolicyOptions = {}) {
    this.scriptUrl = boundedPath('scriptUrl', options.scriptUrl ?? '/service-worker.js', 256);
    this.scope = boundedPath('scope', options.scope ?? '/', 128);
    this.minUpdateIntervalMs = boundedInteger('minUpdateIntervalMs', options.minUpdateIntervalMs ?? 15 * 60_000, 10_000, 24 * 60 * 60_000);
    this.registrationTimeoutMs = boundedInteger('registrationTimeoutMs', options.registrationTimeoutMs ?? 15_000, 1_000, 60_000);
    this.activationTimeoutMs = boundedInteger('activationTimeoutMs', options.activationTimeoutMs ?? 15_000, 1_000, 60_000);
    this.maxConsecutiveFailures = boundedInteger('maxConsecutiveFailures', options.maxConsecutiveFailures ?? 3, 1, 10);
    this.historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 64, 0, 512);
    this.#clock = options.clock ?? Date.now;
  }

  attach(navigatorPort: ServiceWorkerNavigatorPort | undefined): void {
    if (this.#disposed) return;
    if (this.#navigator === navigatorPort) return;
    this.#detachListeners();
    this.#navigator = navigatorPort;
    if (navigatorPort) navigatorPort.addEventListener('controllerchange', this.#onControllerChange);
  }

  async register(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#navigator) { this.#phase = 'degraded'; this.#reason = 'unsupported'; return; }
    if (this.#operation) return this.#operation;
    const operation = this.#registerInternal();
    this.#operation = operation;
    try { await operation; } finally { if (this.#operation === operation) this.#operation = undefined; }
  }

  async checkForUpdate(trigger: ServiceWorkerTrigger = 'manual'): Promise<boolean> {
    if (this.#disposed || !this.#registration) return false;
    const now = this.#clock();
    if (this.#lastUpdateCheckAt !== undefined && now - this.#lastUpdateCheckAt < this.minUpdateIntervalMs && trigger !== 'manual') return false;
    this.#lastUpdateCheckAt = now;
    this.#record('check');
    try {
      await withDeadline(this.#registration.update(), this.registrationTimeoutMs, 'service-worker-update');
      this.#consecutiveFailures = 0; this.#reason = undefined; this.#captureWaiting(); return true;
    } catch (error) { this.#fail(error); return false; }
  }

  async activateWaiting(): Promise<boolean> {
    if (this.#disposed) return false;
    this.#captureWaiting();
    const waiting = this.#waiting;
    if (!waiting) return false;
    this.#phase = 'activating'; this.#record('activate');
    const navigatorPort = this.#navigator;
    if (!navigatorPort) return false;
    try {
      const changed = new Promise<void>((resolve) => {
        const listener = (): void => { navigatorPort.removeEventListener('controllerchange', listener); resolve(); };
        navigatorPort.addEventListener('controllerchange', listener);
      });
      waiting.postMessage(Object.freeze({ type: 'SKIP_WAITING' }));
      await withDeadline(changed, this.activationTimeoutMs, 'service-worker-activation');
      this.#lastActivationAt = this.#clock(); this.#waiting = undefined; this.#phase = 'active'; this.#consecutiveFailures = 0; this.#reason = undefined; this.#record('activated'); return true;
    } catch (error) { this.#fail(error); return false; }
  }

  snapshot(): Readonly<ServiceWorkerPolicySnapshot> {
    return Object.freeze({ phase: this.#phase, supported: this.#navigator !== undefined, registered: this.#registration !== undefined, controlled: this.#navigator?.controller != null, updateAvailable: this.#waiting !== undefined || this.#registration?.waiting != null, consecutiveFailures: this.#consecutiveFailures, ...(this.#lastRegistrationAt === undefined ? {} : { lastRegistrationAt: this.#lastRegistrationAt }), ...(this.#lastUpdateCheckAt === undefined ? {} : { lastUpdateCheckAt: this.#lastUpdateCheckAt }), ...(this.#lastActivationAt === undefined ? {} : { lastActivationAt: this.#lastActivationAt }), ...(this.#reason === undefined ? {} : { reason: this.#reason }) });
  }

  history(): readonly ServiceWorkerPolicyEvent[] { return Object.freeze(this.#history.map(event => Object.freeze({ ...event }))); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#detachListeners(); this.#phase = 'disposed'; this.#record('dispose'); this.#navigator = undefined; this.#registration = undefined; this.#waiting = undefined;
  }

  async #registerInternal(): Promise<void> {
    const navigatorPort = this.#navigator;
    if (!navigatorPort) return;
    this.#phase = 'registering'; this.#record('register');
    try {
      const registration = await withDeadline(navigatorPort.register(this.scriptUrl, { scope: this.scope, updateViaCache: 'none' }), this.registrationTimeoutMs, 'service-worker-registration');
      if (this.#disposed) return;
      this.#setRegistration(registration); this.#lastRegistrationAt = this.#clock(); this.#phase = registration.waiting ? 'update-available' : 'active'; this.#consecutiveFailures = 0; this.#reason = undefined; this.#record('registered');
    } catch (error) { this.#fail(error); }
  }

  #setRegistration(registration: ServiceWorkerRegistrationPort): void {
    if (this.#registration === registration) return;
    if (this.#registration) this.#registration.removeEventListener('updatefound', this.#onUpdateFound);
    this.#registration = registration; registration.addEventListener('updatefound', this.#onUpdateFound); this.#captureWaiting();
  }

  #captureWaiting(): void { const waiting = this.#registration?.waiting ?? undefined; if (waiting) { this.#waiting = waiting; this.#phase = 'update-available'; } }

  readonly #onUpdateFound = (): void => {
    if (this.#disposed) return;
    const installing = this.#registration?.installing;
    if (!installing) { this.#captureWaiting(); return; }
    const onStateChange = (): void => {
      if (installing.state === 'installed') { installing.removeEventListener('statechange', onStateChange); this.#captureWaiting(); if (this.#waiting) this.#record('update-found'); }
      else if (installing.state === 'redundant') { installing.removeEventListener('statechange', onStateChange); this.#fail(new Error('service-worker-install-redundant')); }
    };
    installing.addEventListener('statechange', onStateChange);
  };

  readonly #onControllerChange = (): void => { if (this.#disposed) return; if (this.#navigator?.controller) { this.#phase = 'active'; this.#reason = undefined; } };
  #detachListeners(): void { this.#registration?.removeEventListener('updatefound', this.#onUpdateFound); this.#navigator?.removeEventListener('controllerchange', this.#onControllerChange); }
  #fail(error: unknown): void { this.#consecutiveFailures += 1; this.#reason = safeReason(error); this.#phase = 'degraded'; this.#record('failure'); }
  #record(action: ServiceWorkerPolicyEvent['action']): void { if (this.historyLimit === 0) return; const event = Object.freeze({ ...this.snapshot(), sequence: ++this.#sequence, at: this.#clock(), action }); this.#history.push(event); if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit); }
}
