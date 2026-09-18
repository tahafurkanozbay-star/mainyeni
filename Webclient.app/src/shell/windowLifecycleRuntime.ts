export interface WindowRegistration {
  readonly id: string;
  readonly label?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly initiallyVisible?: boolean;
  readonly initiallyMinimized?: boolean;
}

export interface WindowRuntimeRecord {
  readonly id: string;
  readonly label: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly registeredAt: number;
  readonly updatedAt: number;
  readonly activationOrder: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WindowRuntimeSnapshot {
  readonly revision: number;
  readonly capacity: number;
  readonly destroyed: boolean;
  readonly windows: readonly WindowRuntimeRecord[];
  readonly activeWindowId: string | null;
  readonly visibleCount: number;
  readonly minimizedCount: number;
  readonly observerFailures: number;
}

export interface WindowRuntimeEvent {
  readonly type:
    | 'registered'
    | 'unregistered'
    | 'shown'
    | 'hidden'
    | 'minimized'
    | 'restored'
    | 'activated'
    | 'destroyed';
  readonly window: WindowRuntimeRecord | null;
  readonly timestamp: number;
  readonly revision: number;
}

export interface WindowLifecycleRuntime {
  readonly register: (registration: WindowRegistration) => WindowRuntimeRecord;
  readonly unregister: (id: string) => boolean;
  readonly show: (id: string) => WindowRuntimeRecord;
  readonly hide: (id: string) => WindowRuntimeRecord;
  readonly minimize: (id: string) => WindowRuntimeRecord;
  readonly restore: (id: string) => WindowRuntimeRecord;
  readonly activate: (id: string) => WindowRuntimeRecord;
  readonly has: (id: string) => boolean;
  readonly get: (id: string) => WindowRuntimeRecord | null;
  readonly snapshot: () => WindowRuntimeSnapshot;
  readonly subscribe: (listener: (event: WindowRuntimeEvent) => void) => () => boolean;
  readonly destroy: () => void;
}

export interface WindowLifecycleOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

const capacityOf = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 64;
  return Math.min(256, Math.max(1, Math.trunc(parsed)));
};

const idOf = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Window id must be a string.');
  const normalized = value.trim();
  if (!normalized) throw new TypeError('Window id cannot be empty.');
  if (normalized.length > 128) throw new RangeError('Window id exceeds 128 characters.');
  return normalized;
};

const labelOf = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 180) : fallback;
};

const metadataOf = (
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> => {
  if (!value) return Object.freeze({});
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    const normalized = key.trim();
    if (!normalized) continue;
    if (/(token|secret|password|credential|authorization|cookie)/iu.test(normalized)) continue;
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') continue;
    output[normalized] = item;
  }
  return Object.freeze(output);
};

const freezeRecord = (record: WindowRuntimeRecord): WindowRuntimeRecord =>
  Object.freeze({ ...record, metadata: Object.freeze({ ...record.metadata }) });

export const createWindowLifecycleRuntime = (
  options: WindowLifecycleOptions = {},
): WindowLifecycleRuntime => {
  const capacity = capacityOf(options.capacity);
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, WindowRuntimeRecord>();
  const listeners = new Set<(event: WindowRuntimeEvent) => void>();
  let revision = 0;
  let activationSequence = 0;
  let destroyed = false;
  let observerFailures = 0;

  const timestamp = (): number => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('Window lifecycle clock must be finite.');
    return value;
  };

  const assertActive = (): void => {
    if (destroyed) throw new Error('Window lifecycle runtime is destroyed.');
  };

  const emit = (type: WindowRuntimeEvent['type'], record: WindowRuntimeRecord | null): void => {
    const event = Object.freeze({ type, window: record, timestamp: timestamp(), revision });
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        observerFailures += 1;
      }
    }
  };

  const replace = (
    current: WindowRuntimeRecord,
    patch: Partial<Pick<WindowRuntimeRecord, 'visible' | 'minimized' | 'activationOrder'>>,
    type: WindowRuntimeEvent['type'],
  ): WindowRuntimeRecord => {
    const next = freezeRecord({
      ...current,
      ...patch,
      updatedAt: timestamp(),
    });
    records.set(next.id, next);
    revision += 1;
    emit(type, next);
    return next;
  };

  const requireRecord = (idInput: string): WindowRuntimeRecord => {
    const id = idOf(idInput);
    const record = records.get(id);
    if (!record) throw new Error(`Window is not registered: ${id}`);
    return record;
  };

  const register = (registration: WindowRegistration): WindowRuntimeRecord => {
    assertActive();
    const id = idOf(registration.id);
    if (records.has(id)) throw new Error(`Window is already registered: ${id}`);
    if (records.size >= capacity) throw new Error('Window lifecycle capacity exceeded.');
    const at = timestamp();
    const visible = registration.initiallyVisible === true;
    const minimized = visible && registration.initiallyMinimized === true;
    const activationOrder = visible && !minimized ? ++activationSequence : 0;
    const record = freezeRecord({
      id,
      label: labelOf(registration.label, id),
      visible,
      minimized,
      registeredAt: at,
      updatedAt: at,
      activationOrder,
      metadata: metadataOf(registration.metadata),
    });
    records.set(id, record);
    revision += 1;
    emit('registered', record);
    return record;
  };

  const unregister = (idInput: string): boolean => {
    assertActive();
    const id = idOf(idInput);
    const existing = records.get(id);
    if (!existing) return false;
    records.delete(id);
    revision += 1;
    emit('unregistered', existing);
    return true;
  };

  const show = (id: string): WindowRuntimeRecord => {
    assertActive();
    const current = requireRecord(id);
    if (current.visible && !current.minimized) return activate(id);
    return replace(current, {
      visible: true,
      minimized: false,
      activationOrder: ++activationSequence,
    }, 'shown');
  };

  const hide = (id: string): WindowRuntimeRecord => {
    assertActive();
    const current = requireRecord(id);
    if (!current.visible) return current;
    return replace(current, { visible: false, minimized: false }, 'hidden');
  };

  const minimize = (id: string): WindowRuntimeRecord => {
    assertActive();
    const current = requireRecord(id);
    if (!current.visible) throw new Error('Cannot minimize a hidden window.');
    if (current.minimized) return current;
    return replace(current, { minimized: true }, 'minimized');
  };

  const restore = (id: string): WindowRuntimeRecord => {
    assertActive();
    const current = requireRecord(id);
    if (!current.visible) return show(id);
    if (!current.minimized) return activate(id);
    return replace(current, {
      minimized: false,
      activationOrder: ++activationSequence,
    }, 'restored');
  };

  const activate = (id: string): WindowRuntimeRecord => {
    assertActive();
    const current = requireRecord(id);
    if (!current.visible) return show(id);
    if (current.minimized) return restore(id);
    return replace(current, { activationOrder: ++activationSequence }, 'activated');
  };

  const has = (id: string): boolean => {
    assertActive();
    return records.has(idOf(id));
  };

  const get = (id: string): WindowRuntimeRecord | null => {
    assertActive();
    return records.get(idOf(id)) ?? null;
  };

  const snapshot = (): WindowRuntimeSnapshot => {
    assertActive();
    const windows = [...records.values()].sort((left, right) =>
      left.activationOrder === right.activationOrder
        ? left.id.localeCompare(right.id)
        : left.activationOrder - right.activationOrder);
    const active = [...windows]
      .filter((item) => item.visible && !item.minimized)
      .sort((left, right) => right.activationOrder - left.activationOrder)[0] ?? null;
    return Object.freeze({
      revision,
      capacity,
      destroyed: false,
      windows: Object.freeze(windows),
      activeWindowId: active?.id ?? null,
      visibleCount: windows.filter((item) => item.visible).length,
      minimizedCount: windows.filter((item) => item.visible && item.minimized).length,
      observerFailures,
    });
  };

  const subscribe = (listener: (event: WindowRuntimeEvent) => void): (() => boolean) => {
    assertActive();
    if (typeof listener !== 'function') throw new TypeError('Window lifecycle listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    records.clear();
    revision += 1;
    emit('destroyed', null);
    listeners.clear();
    destroyed = true;
  };

  return Object.freeze({
    register,
    unregister,
    show,
    hide,
    minimize,
    restore,
    activate,
    has,
    get,
    snapshot,
    subscribe,
    destroy,
  });
};
