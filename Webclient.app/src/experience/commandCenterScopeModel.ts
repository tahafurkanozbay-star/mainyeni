export type CommandCenterScopeId = 'all' | 'map' | 'analysis' | 'services' | 'help';
export type CommandCenterConcreteScope = Exclude<CommandCenterScopeId, 'all'>;

export interface CommandCenterScopeItem {
  readonly id: string;
  readonly scopes: readonly CommandCenterConcreteScope[];
}

export interface CommandCenterScopeCounts {
  readonly all: number;
  readonly map: number;
  readonly analysis: number;
  readonly services: number;
  readonly help: number;
}

export interface CommandCenterScopeSnapshot {
  readonly activeScope: CommandCenterScopeId;
  readonly counts: CommandCenterScopeCounts;
  readonly visibleIds: readonly string[];
  readonly revision: number;
}

export type CommandCenterScopeObserver = (
  snapshot: CommandCenterScopeSnapshot,
  previous: CommandCenterScopeSnapshot,
) => void;

export interface CommandCenterScopeOptions {
  readonly maxItems?: number;
  readonly onObserverError?: (error: unknown) => void;
}

export interface CommandCenterScopeModel {
  readonly maxItems: number;
  snapshot(): CommandCenterScopeSnapshot;
  setScope(scope: CommandCenterScopeId): CommandCenterScopeSnapshot;
  reconcile(items: readonly CommandCenterScopeItem[]): CommandCenterScopeSnapshot;
  includes(commandId: string): boolean;
  subscribe(observer: CommandCenterScopeObserver): () => void;
  dispose(): void;
}

const MAX_OBSERVERS = 24;
const DEFAULT_MAX_ITEMS = 1024;
const scopeIds: readonly CommandCenterConcreteScope[] = Object.freeze([
  'map', 'analysis', 'services', 'help',
]);

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const sanitizeId = (value: string): string => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, '-')
  .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 128);

const sanitizeScopes = (
  scopes: readonly CommandCenterConcreteScope[],
): readonly CommandCenterConcreteScope[] => {
  const unique = new Set<CommandCenterConcreteScope>();
  for (const scope of scopes) {
    if (scopeIds.includes(scope)) unique.add(scope);
  }
  return Object.freeze(Array.from(unique));
};

interface NormalizedScopeItem {
  readonly id: string;
  readonly scopes: readonly CommandCenterConcreteScope[];
}

const normalizeItems = (
  items: readonly CommandCenterScopeItem[],
  maxItems: number,
): readonly NormalizedScopeItem[] => {
  const normalized: NormalizedScopeItem[] = [];
  const seen = new Set<string>();
  for (const candidate of items) {
    if (normalized.length >= maxItems) break;
    const id = sanitizeId(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(Object.freeze({
      id,
      scopes: sanitizeScopes(candidate.scopes),
    }));
  }
  return Object.freeze(normalized);
};

const createCounts = (
  items: readonly NormalizedScopeItem[],
): CommandCenterScopeCounts => {
  const counts = {
    all: items.length,
    map: 0,
    analysis: 0,
    services: 0,
    help: 0,
  };
  for (const item of items) {
    for (const scope of item.scopes) counts[scope] += 1;
  }
  return Object.freeze(counts);
};

const visibleIdsFor = (
  items: readonly NormalizedScopeItem[],
  scope: CommandCenterScopeId,
): readonly string[] => Object.freeze(
  items
    .filter(item => scope === 'all' || item.scopes.includes(scope))
    .map(item => item.id),
);

const createSnapshot = (
  items: readonly NormalizedScopeItem[],
  activeScope: CommandCenterScopeId,
  revision: number,
): CommandCenterScopeSnapshot => Object.freeze({
  activeScope,
  counts: createCounts(items),
  visibleIds: visibleIdsFor(items, activeScope),
  revision,
});

const reportObserverError = (
  reporter: CommandCenterScopeOptions['onObserverError'],
  error: unknown,
): void => {
  if (!reporter) {
    globalThis.reportError?.(error);
    return;
  }
  try {
    reporter(error);
  } catch (reportingError) {
    globalThis.reportError?.(reportingError);
  }
};

export const createCommandCenterScopeModel = (
  initialItems: readonly CommandCenterScopeItem[],
  options: CommandCenterScopeOptions = {},
): CommandCenterScopeModel => {
  const maxItems = clampInteger(options.maxItems ?? DEFAULT_MAX_ITEMS, 1, 4096);
  let items = normalizeItems(initialItems, maxItems);
  let current = createSnapshot(items, 'all', 0);
  let disposed = false;
  const observers = new Set<CommandCenterScopeObserver>();

  const commit = (
    activeScope: CommandCenterScopeId,
  ): CommandCenterScopeSnapshot => {
    if (disposed) return current;
    const previous = current;
    current = createSnapshot(items, activeScope, previous.revision + 1);
    const observerSnapshot = Array.from(observers);
    for (const observer of observerSnapshot) {
      try {
        observer(current, previous);
      } catch (error) {
        reportObserverError(options.onObserverError, error);
      }
    }
    return current;
  };

  return Object.freeze({
    maxItems,
    snapshot: () => current,
    setScope(scope: CommandCenterScopeId) {
      if (disposed || current.activeScope === scope) return current;
      return commit(scope);
    },
    reconcile(nextItems: readonly CommandCenterScopeItem[]) {
      if (disposed) return current;
      const normalized = normalizeItems(nextItems, maxItems);
      const unchanged = normalized.length === items.length
        && normalized.every((item, index) => {
          const existing = items[index];
          return existing?.id === item.id
            && existing.scopes.length === item.scopes.length
            && existing.scopes.every((scope, scopeIndex) => scope === item.scopes[scopeIndex]);
        });
      if (unchanged) return current;
      items = normalized;
      return commit(current.activeScope);
    },
    includes(commandId: string) {
      const id = sanitizeId(commandId);
      return id.length > 0 && current.visibleIds.includes(id);
    },
    subscribe(observer: CommandCenterScopeObserver) {
      if (disposed) return () => undefined;
      if (observers.size >= MAX_OBSERVERS && !observers.has(observer)) {
        throw new Error(`Command center scope observer capacity exceeded (${MAX_OBSERVERS}).`);
      }
      observers.add(observer);
      try {
        observer(current, current);
      } catch (error) {
        reportObserverError(options.onObserverError, error);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        observers.delete(observer);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observers.clear();
      items = Object.freeze([]);
    },
  });
};
