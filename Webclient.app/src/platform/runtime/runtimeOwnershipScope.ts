export type RuntimeOwnedDisposer = () => void | Promise<void>;

export interface RuntimeOwnershipScopeOptions {
  readonly label?: string;
  readonly maxResources?: number;
  readonly maxFailures?: number;
  readonly now?: () => number;
  readonly onFailure?: (failure: RuntimeOwnershipFailure) => void;
}

export interface RuntimeOwnershipFailure {
  readonly at: number;
  readonly resourceId: number;
  readonly label: string;
  readonly message: string;
}

export interface RuntimeOwnedResourceSnapshot {
  readonly id: number;
  readonly label: string;
  readonly ownedAt: number;
  readonly released: boolean;
}

export interface RuntimeOwnershipScopeSnapshot {
  readonly generatedAt: number;
  readonly label: string;
  readonly disposed: boolean;
  readonly resourceCount: number;
  readonly resources: readonly RuntimeOwnedResourceSnapshot[];
  readonly failures: readonly RuntimeOwnershipFailure[];
  readonly aborted: boolean;
}

export interface RuntimeOwnershipDisposalReport {
  readonly disposedAt: number;
  readonly released: number;
  readonly failures: readonly RuntimeOwnershipFailure[];
}

interface OwnedResource {
  readonly id: number;
  readonly label: string;
  readonly ownedAt: number;
  readonly dispose: RuntimeOwnedDisposer;
  released: boolean;
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const normalizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 200) : fallback;
};

const messageFor = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === 'string') return error.slice(0, 1000);
  return 'Unknown resource disposal failure.';
};

const safeFailureObserver = (
  observer: RuntimeOwnershipScopeOptions['onFailure'],
  failure: RuntimeOwnershipFailure,
): void => {
  if (!observer) return;
  try {
    observer(failure);
  } catch {
    // Disposal observers are diagnostics only.
  }
};

export class RuntimeOwnershipCapacityError extends Error {
  readonly code = 'RUNTIME_OWNERSHIP_CAPACITY';

  constructor(limit: number) {
    super(`Runtime ownership scope capacity ${limit} has been reached.`);
    this.name = 'RuntimeOwnershipCapacityError';
  }
}

export class RuntimeOwnershipDisposedError extends Error {
  readonly code = 'RUNTIME_OWNERSHIP_DISPOSED';

  constructor(label: string) {
    super(`Runtime ownership scope "${label}" has been disposed.`);
    this.name = 'RuntimeOwnershipDisposedError';
  }
}

export class RuntimeOwnershipScope {
  readonly #label: string;
  readonly #maxResources: number;
  readonly #maxFailures: number;
  readonly #now: () => number;
  readonly #onFailure: RuntimeOwnershipScopeOptions['onFailure'];
  readonly #controller = new AbortController();
  readonly #resources = new Map<number, OwnedResource>();
  readonly #failures: RuntimeOwnershipFailure[] = [];
  #sequence = 0;
  #disposed = false;
  #disposePromise: Promise<RuntimeOwnershipDisposalReport> | null = null;

  constructor(options: RuntimeOwnershipScopeOptions = {}) {
    this.#label = normalizeLabel(options.label, 'runtime-scope');
    this.#maxResources = boundedInteger(options.maxResources, 256, 1, 8192);
    this.#maxFailures = boundedInteger(options.maxFailures, 32, 1, 1024);
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure;
  }

  get label(): string {
    return this.#label;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  own(disposer: RuntimeOwnedDisposer, label = 'resource'): () => Promise<void> {
    this.#assertActive();
    if (typeof disposer !== 'function') throw new TypeError('Owned resource disposer must be a function.');
    if (this.#resources.size >= this.#maxResources) throw new RuntimeOwnershipCapacityError(this.#maxResources);
    const id = ++this.#sequence;
    const resource: OwnedResource = {
      id,
      label: normalizeLabel(label, `resource-${id}`),
      ownedAt: this.#now(),
      dispose: disposer,
      released: false,
    };
    this.#resources.set(id, resource);
    return async (): Promise<void> => {
      await this.#release(resource);
    };
  }

  ownAbortController(label = 'abort-controller'): AbortController {
    this.#assertActive();
    const controller = new AbortController();
    const abortChild = (): void => controller.abort(this.#controller.signal.reason);
    this.#controller.signal.addEventListener('abort', abortChild, { once: true });
    this.own(() => {
      this.#controller.signal.removeEventListener('abort', abortChild);
      if (!controller.signal.aborted) controller.abort(new RuntimeOwnershipDisposedError(this.#label));
    }, label);
    return controller;
  }

  ownEventListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
    label?: string,
  ): () => Promise<void>;
  ownEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
    label?: string,
  ): () => Promise<void>;
  ownEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
    label = `event:${type}`,
  ): () => Promise<void> {
    this.#assertActive();
    target.addEventListener(type, listener, options);
    return this.own(() => target.removeEventListener(type, listener, options), label);
  }

  ownTimeout(
    handler: () => void,
    timeoutMs: number,
    label = 'timeout',
  ): () => Promise<void> {
    this.#assertActive();
    const normalizedTimeout = boundedInteger(timeoutMs, 0, 0, 24 * 60 * 60_000);
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      if (!this.#disposed) handler();
    }, normalizedTimeout);
    return this.own(() => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    }, label);
  }

  fork(label: string, options: Omit<RuntimeOwnershipScopeOptions, 'label' | 'now'> = {}): RuntimeOwnershipScope {
    this.#assertActive();
    const child = new RuntimeOwnershipScope({
      ...options,
      label: `${this.#label}/${normalizeLabel(label, 'child')}`,
      now: this.#now,
    });
    const abortChild = (): void => {
      void child.dispose(this.#controller.signal.reason);
    };
    this.#controller.signal.addEventListener('abort', abortChild, { once: true });
    this.own(async () => {
      this.#controller.signal.removeEventListener('abort', abortChild);
      await child.dispose(new RuntimeOwnershipDisposedError(this.#label));
    }, `child:${child.label}`);
    return child;
  }

  snapshot(): RuntimeOwnershipScopeSnapshot {
    return Object.freeze({
      generatedAt: this.#now(),
      label: this.#label,
      disposed: this.#disposed,
      resourceCount: this.#resources.size,
      resources: Object.freeze([...this.#resources.values()]
        .map((resource) => Object.freeze({
          id: resource.id,
          label: resource.label,
          ownedAt: resource.ownedAt,
          released: resource.released,
        }))),
      failures: Object.freeze([...this.#failures]),
      aborted: this.#controller.signal.aborted,
    });
  }

  async dispose(reason: unknown = new RuntimeOwnershipDisposedError(this.#label)): Promise<RuntimeOwnershipDisposalReport> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);

    this.#disposePromise = (async () => {
      let released = 0;
      const resources = [...this.#resources.values()].sort((left, right) => right.id - left.id);
      for (const resource of resources) {
        if (resource.released) continue;
        await this.#release(resource);
        released += 1;
      }
      return Object.freeze({
        disposedAt: this.#now(),
        released,
        failures: Object.freeze([...this.#failures]),
      });
    })();
    return this.#disposePromise;
  }

  async #release(resource: OwnedResource): Promise<void> {
    if (resource.released) return;
    resource.released = true;
    this.#resources.delete(resource.id);
    try {
      await resource.dispose();
    } catch (error) {
      const failure: RuntimeOwnershipFailure = Object.freeze({
        at: this.#now(),
        resourceId: resource.id,
        label: resource.label,
        message: messageFor(error),
      });
      this.#failures.push(failure);
      if (this.#failures.length > this.#maxFailures) this.#failures.splice(0, this.#failures.length - this.#maxFailures);
      safeFailureObserver(this.#onFailure, failure);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new RuntimeOwnershipDisposedError(this.#label);
  }
}
