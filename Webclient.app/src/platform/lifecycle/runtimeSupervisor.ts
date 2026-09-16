export type RuntimeResourceKind =
  | 'abort-controller'
  | 'disposable'
  | 'timer'
  | 'interval'
  | 'observer'
  | 'subscription'
  | 'custom';

export interface RuntimeResourceSnapshot {
  readonly id: number;
  readonly label: string;
  readonly kind: RuntimeResourceKind;
  readonly createdAt: number;
  readonly ageMs: number;
}

export interface RuntimeSupervisorSnapshot {
  readonly active: number;
  readonly created: number;
  readonly disposed: number;
  readonly failedDisposals: number;
  readonly abortControllers: number;
  readonly oldestAgeMs: number | null;
  readonly resources: readonly RuntimeResourceSnapshot[];
}

export interface RuntimeSupervisorOptions {
  capacity?: number;
  clock?: () => number;
  onError?: (error: unknown, context: Readonly<Record<string, unknown>>) => void;
}

interface ResourceRecord {
  id: number;
  label: string;
  kind: RuntimeResourceKind;
  createdAt: number;
  dispose: () => void | Promise<void>;
  disposed: boolean;
}

export interface RuntimeLease {
  readonly id: number;
  readonly label: string;
  readonly kind: RuntimeResourceKind;
  readonly disposed: boolean;
  dispose(): Promise<boolean>;
}

const safeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const safeLabel = (value: unknown): string => {
  const normalized = String(value || 'runtime-resource')
    .replace(/[?#].*$/, '')
    .replace(/[^a-zA-Z0-9._:/-]+/g, '-')
    .slice(0, 120);
  return normalized || 'runtime-resource';
};

const noop = (): void => undefined;

export class RuntimeSupervisor {
  private readonly capacity: number;
  private readonly clock: () => number;
  private readonly onError: RuntimeSupervisorOptions['onError'];
  private readonly resources = new Map<number, ResourceRecord>();
  private sequence = 0;
  private created = 0;
  private disposed = 0;
  private failedDisposals = 0;
  private closed = false;

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.capacity = safeInteger(options.capacity, 500, 16, 5000);
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.onError = options.onError;
  }

  private report(error: unknown, context: Readonly<Record<string, unknown>>): void {
    if (typeof this.onError !== 'function') return;
    try {
      this.onError(error, context);
    } catch (_error) {
      // Observability hooks must never break resource cleanup.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RuntimeSupervisor is closed');
  }

  private async disposeRecord(record: ResourceRecord): Promise<boolean> {
    if (record.disposed) return false;
    record.disposed = true;
    this.resources.delete(record.id);
    try {
      await record.dispose();
      this.disposed += 1;
      return true;
    } catch (error) {
      this.failedDisposals += 1;
      this.report(error, Object.freeze({
        phase: 'dispose',
        id: record.id,
        kind: record.kind,
        label: record.label
      }));
      return false;
    }
  }

  register(
    dispose: () => void | Promise<void>,
    options: { label?: string; kind?: RuntimeResourceKind } = {}
  ): RuntimeLease {
    this.assertOpen();
    if (typeof dispose !== 'function') throw new TypeError('dispose must be a function');
    if (this.resources.size >= this.capacity) {
      throw new Error(`RuntimeSupervisor capacity exceeded (${this.capacity})`);
    }

    const record: ResourceRecord = {
      id: ++this.sequence,
      label: safeLabel(options.label),
      kind: options.kind || 'custom',
      createdAt: this.clock(),
      dispose,
      disposed: false
    };
    this.resources.set(record.id, record);
    this.created += 1;
    const supervisor = this;

    return {
      get id() { return record.id; },
      get label() { return record.label; },
      get kind() { return record.kind; },
      get disposed() { return record.disposed; },
      dispose: () => supervisor.disposeRecord(record)
    };
  }

  trackAbortController(
    controller = new AbortController(),
    label = 'abort-controller'
  ): { readonly controller: AbortController; readonly lease: RuntimeLease } {
    const lease = this.register(() => {
      if (!controller.signal.aborted) controller.abort();
    }, { label, kind: 'abort-controller' });
    return Object.freeze({ controller, lease });
  }

  trackSubscription(
    unsubscribe: () => void | Promise<void>,
    label = 'subscription'
  ): RuntimeLease {
    return this.register(unsubscribe, { label, kind: 'subscription' });
  }

  trackObserver(
    observer: { disconnect?: () => void },
    label = 'observer'
  ): RuntimeLease {
    return this.register(() => {
      if (typeof observer?.disconnect === 'function') observer.disconnect();
    }, { label, kind: 'observer' });
  }

  trackTimeout(
    callback: () => void,
    delayMs: number,
    label = 'timeout'
  ): RuntimeLease {
    this.assertOpen();
    const delay = safeInteger(delayMs, 0, 0, 2147483647);
    let lease: RuntimeLease | null = null;
    const handle = setTimeout(() => {
      try { callback(); } finally { void lease?.dispose(); }
    }, delay);
    lease = this.register(() => clearTimeout(handle), { label, kind: 'timer' });
    return lease;
  }

  trackInterval(
    callback: () => void,
    intervalMs: number,
    label = 'interval'
  ): RuntimeLease {
    this.assertOpen();
    const delay = safeInteger(intervalMs, 1000, 16, 2147483647);
    const handle = setInterval(callback, delay);
    return this.register(() => clearInterval(handle), { label, kind: 'interval' });
  }

  child(label = 'child-runtime'): RuntimeSupervisor {
    const child = new RuntimeSupervisor({
      capacity: this.capacity,
      clock: this.clock,
      onError: this.onError
    });
    this.register(() => child.disposeAll(), { label, kind: 'disposable' });
    return child;
  }

  async disposeByKind(kind: RuntimeResourceKind): Promise<number> {
    const targets = Array.from(this.resources.values()).filter((record) => record.kind === kind);
    let disposed = 0;
    for (const record of targets.reverse()) {
      if (await this.disposeRecord(record)) disposed += 1;
    }
    return disposed;
  }

  async disposeMatching(predicate: (resource: RuntimeResourceSnapshot) => boolean): Promise<number> {
    if (typeof predicate !== 'function') return 0;
    const now = this.clock();
    const targets = Array.from(this.resources.values()).filter((record) => predicate(Object.freeze({
      id: record.id,
      label: record.label,
      kind: record.kind,
      createdAt: record.createdAt,
      ageMs: Math.max(0, now - record.createdAt)
    })));
    let disposed = 0;
    for (const record of targets.reverse()) {
      if (await this.disposeRecord(record)) disposed += 1;
    }
    return disposed;
  }

  async disposeAll(): Promise<number> {
    const targets = Array.from(this.resources.values()).reverse();
    let disposed = 0;
    for (const record of targets) {
      if (await this.disposeRecord(record)) disposed += 1;
    }
    return disposed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.disposeAll();
  }

  snapshot(limit = 50): RuntimeSupervisorSnapshot {
    const now = this.clock();
    const normalizedLimit = safeInteger(limit, 50, 1, this.capacity);
    const resources = Array.from(this.resources.values())
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, normalizedLimit)
      .map((record) => Object.freeze({
        id: record.id,
        label: record.label,
        kind: record.kind,
        createdAt: record.createdAt,
        ageMs: Math.max(0, now - record.createdAt)
      }));
    const oldestAgeMs = resources.length ? Math.max(...resources.map((item) => item.ageMs)) : null;

    return Object.freeze({
      active: this.resources.size,
      created: this.created,
      disposed: this.disposed,
      failedDisposals: this.failedDisposals,
      abortControllers: Array.from(this.resources.values())
        .filter((record) => record.kind === 'abort-controller').length,
      oldestAgeMs,
      resources: Object.freeze(resources)
    });
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export const createRuntimeSupervisor = (options: RuntimeSupervisorOptions = {}): RuntimeSupervisor =>
  new RuntimeSupervisor(options);

export const noopRuntimeLease: RuntimeLease = Object.freeze({
  id: 0,
  label: 'noop',
  kind: 'custom' as const,
  disposed: true,
  dispose: async () => false
});

export const safeDispose = async (lease: RuntimeLease | null | undefined): Promise<boolean> => {
  if (!lease || typeof lease.dispose !== 'function') return false;
  try {
    return await lease.dispose();
  } catch (_error) {
    noop();
    return false;
  }
};
