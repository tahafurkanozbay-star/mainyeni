import {
  normalizeSidebarSearchText,
  type ShellSidebarGroup,
  type ShellSidebarItem,
} from './sidebarCatalogRuntime';

export type SidebarNavigationView = 'all' | 'favorites' | 'recent';
export type SidebarNavigationEmptyReason = 'none' | 'no-results' | 'no-favorites' | 'no-recents';

export interface SidebarNavigationLimits {
  readonly maxGroups?: number;
  readonly maxItems?: number;
  readonly maxQueryLength?: number;
  readonly maxFavoriteIds?: number;
  readonly maxRecentIds?: number;
}

export interface SidebarNavigationViewCounts {
  readonly all: number;
  readonly favorites: number;
  readonly recent: number;
}

export interface SidebarNavigationSnapshot {
  readonly visible: boolean;
  readonly collapsed: boolean;
  readonly activeGroupId: string | null;
  readonly activeGroup: ShellSidebarGroup | null;
  readonly view: SidebarNavigationView;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly favoriteIds: readonly string[];
  readonly recentIds: readonly string[];
  readonly visibleItems: readonly ShellSidebarItem[];
  readonly activeItemId: string | null;
  readonly activeIndex: number;
  readonly resultCount: number;
  readonly counts: SidebarNavigationViewCounts;
  readonly emptyReason: SidebarNavigationEmptyReason;
  readonly announcement: string;
  readonly revision: number;
}

export interface SidebarNavigationObserverDiagnostics {
  readonly failureCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
}

export interface SidebarNavigationModelInput {
  readonly groups: readonly ShellSidebarGroup[];
  readonly items: readonly ShellSidebarItem[];
  readonly initialFavoriteIds?: readonly string[];
  readonly initialRecentIds?: readonly string[];
  readonly limits?: SidebarNavigationLimits;
}

export interface SidebarNavigationModel {
  readonly getSnapshot: () => SidebarNavigationSnapshot;
  readonly getObserverDiagnostics: () => SidebarNavigationObserverDiagnostics;
  readonly subscribe: (listener: () => void) => () => void;
  readonly show: () => void;
  readonly close: () => void;
  readonly setCollapsed: (collapsed: boolean) => void;
  readonly toggleCollapsed: () => void;
  readonly toggleGroup: (groupId: string) => void;
  readonly setGroup: (groupId: string | null) => void;
  readonly setView: (view: SidebarNavigationView) => void;
  readonly setQuery: (query: string) => void;
  readonly clearQuery: () => void;
  readonly setFavoriteIds: (ids: readonly string[]) => void;
  readonly toggleFavorite: (windowId: string) => void;
  readonly setRecentIds: (ids: readonly string[]) => void;
  readonly recordRecent: (windowId: string) => void;
  readonly setActiveItem: (windowId: string | null) => void;
  readonly moveActive: (delta: number) => void;
  readonly moveActiveByPage: (deltaPages: number, pageSize?: number) => void;
  readonly focusFirst: () => void;
  readonly focusLast: () => void;
  readonly getActiveItem: () => ShellSidebarItem | null;
  readonly dispose: () => void;
}

const DEFAULT_LIMITS: Required<SidebarNavigationLimits> = Object.freeze({
  maxGroups: 32,
  maxItems: 512,
  maxQueryLength: 120,
  maxFavoriteIds: 128,
  maxRecentIds: 12,
});

const clampLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
};

const resolveLimits = (limits: SidebarNavigationLimits | undefined): Required<SidebarNavigationLimits> => Object.freeze({
  maxGroups: clampLimit(limits?.maxGroups, DEFAULT_LIMITS.maxGroups, 128),
  maxItems: clampLimit(limits?.maxItems, DEFAULT_LIMITS.maxItems, 2_000),
  maxQueryLength: clampLimit(limits?.maxQueryLength, DEFAULT_LIMITS.maxQueryLength, 240),
  maxFavoriteIds: clampLimit(limits?.maxFavoriteIds, DEFAULT_LIMITS.maxFavoriteIds, 512),
  maxRecentIds: clampLimit(limits?.maxRecentIds, DEFAULT_LIMITS.maxRecentIds, 64),
});

const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const sanitizeQuery = (value: string, maxLength: number): string => {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) continue;
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
};

const validateCatalog = (
  groups: readonly ShellSidebarGroup[],
  items: readonly ShellSidebarItem[],
  limits: Required<SidebarNavigationLimits>,
): void => {
  if (groups.length > limits.maxGroups) throw new RangeError(`Sidebar group count exceeds ${limits.maxGroups}.`);
  if (items.length > limits.maxItems) throw new RangeError(`Sidebar item count exceeds ${limits.maxItems}.`);

  const groupIds = new Set<string>();
  for (const group of groups) {
    const id = group.id.trim();
    if (!id) throw new TypeError('Sidebar group id cannot be empty.');
    if (groupIds.has(id)) throw new Error(`Duplicate sidebar group id: ${id}`);
    groupIds.add(id);
  }

  const windowIds = new Set<string>();
  for (const item of items) {
    const windowId = item.windowId.trim();
    if (!windowId) throw new TypeError('Sidebar item window id cannot be empty.');
    if (!groupIds.has(item.group)) throw new Error(`Sidebar item references unknown group: ${item.group}`);
    if (windowIds.has(windowId)) throw new Error(`Duplicate sidebar window id: ${windowId}`);
    windowIds.add(windowId);
  }
};

const cloneGroups = (groups: readonly ShellSidebarGroup[]): readonly ShellSidebarGroup[] => freezeArray(
  groups.map((group) => Object.freeze({ ...group })),
);

const cloneItems = (items: readonly ShellSidebarItem[]): readonly ShellSidebarItem[] => freezeArray(
  items.map((item) => Object.freeze({ ...item })),
);

export const createSidebarNavigationModel = (input: SidebarNavigationModelInput): SidebarNavigationModel => {
  if (!input || !Array.isArray(input.groups) || !Array.isArray(input.items)) {
    throw new TypeError('Sidebar navigation requires group and item arrays.');
  }

  const limits = resolveLimits(input.limits);
  validateCatalog(input.groups, input.items, limits);

  const groups = cloneGroups(input.groups);
  const items = cloneItems(input.items);
  const groupMap = new Map(groups.map((group) => [group.id, group] as const));
  const itemMap = new Map(items.map((item) => [item.windowId, item] as const));
  const searchableText = new Map(items.map((item) => [
    item.windowId,
    normalizeSidebarSearchText([
      item.label,
      item.group,
      item.iconType ?? '',
      item.serviceKey ?? '',
      item.windowId,
    ].join(' ')),
  ] as const));

  const sanitizeIds = (values: readonly string[], maximum: number): readonly string[] => {
    const next: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (!itemMap.has(id) || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
      if (next.length >= maximum) break;
    }
    return freezeArray(next);
  };

  let visible = true;
  let collapsed = false;
  let activeGroupId: string | null = null;
  let view: SidebarNavigationView = 'all';
  let query = '';
  let favoriteIds = sanitizeIds(input.initialFavoriteIds ?? [], limits.maxFavoriteIds);
  let recentIds = sanitizeIds(input.initialRecentIds ?? [], limits.maxRecentIds);
  let activeItemId: string | null = null;
  let revision = 0;
  let disposed = false;
  let announcementOverride: string | null = null;
  const listeners = new Set<() => void>();
  let observerDiagnostics: SidebarNavigationObserverDiagnostics = Object.freeze({
    failureCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
  });

  const getGroupCandidates = (): readonly ShellSidebarItem[] => activeGroupId === null
    ? items
    : items.filter((item) => item.group === activeGroupId);

  const getViewCandidates = (): readonly ShellSidebarItem[] => {
    const groupCandidates = getGroupCandidates();
    if (view === 'all') return groupCandidates;
    if (view === 'favorites') {
      const favorites = new Set(favoriteIds);
      return groupCandidates.filter((item) => favorites.has(item.windowId));
    }
    const groupAllowed = new Set(groupCandidates.map((item) => item.windowId));
    return recentIds
      .map((windowId) => itemMap.get(windowId) ?? null)
      .filter((item): item is ShellSidebarItem => item !== null && groupAllowed.has(item.windowId));
  };

  const getVisibleItems = (): readonly ShellSidebarItem[] => {
    const candidates = getViewCandidates();
    const normalizedQuery = normalizeSidebarSearchText(query);
    if (!normalizedQuery) return freezeArray(candidates);
    const tokens = normalizedQuery.split(' ').filter(Boolean);
    return freezeArray(candidates.filter((item) => {
      const haystack = searchableText.get(item.windowId) ?? '';
      return tokens.every((token) => haystack.includes(token));
    }));
  };

  const countForView = (candidateView: SidebarNavigationView): number => {
    const groupCandidates = getGroupCandidates();
    if (candidateView === 'all') return groupCandidates.length;
    if (candidateView === 'favorites') {
      const favorites = new Set(favoriteIds);
      return groupCandidates.filter((item) => favorites.has(item.windowId)).length;
    }
    const allowed = new Set(groupCandidates.map((item) => item.windowId));
    return recentIds.filter((windowId) => allowed.has(windowId)).length;
  };

  const reconcileActiveItem = (visibleItems: readonly ShellSidebarItem[]): void => {
    if (!visible || collapsed) {
      activeItemId = null;
      return;
    }
    if (activeItemId !== null && visibleItems.some((item) => item.windowId === activeItemId)) return;
    activeItemId = visibleItems[0]?.windowId ?? null;
  };

  const emptyReasonFor = (resultCount: number): SidebarNavigationEmptyReason => {
    if (resultCount > 0) return 'none';
    if (normalizeSidebarSearchText(query)) return 'no-results';
    if (view === 'favorites') return 'no-favorites';
    if (view === 'recent') return 'no-recents';
    return 'no-results';
  };

  const announcementFor = (resultCount: number): string => {
    if (announcementOverride !== null) return announcementOverride;
    if (!visible) return 'Hizmet paneli kapatıldı.';
    if (collapsed) return 'Hizmet paneli daraltıldı.';
    if (resultCount === 0) {
      const reason = emptyReasonFor(resultCount);
      if (reason === 'no-favorites') return 'Henüz favori hizmet yok.';
      if (reason === 'no-recents') return 'Henüz son kullanılan hizmet yok.';
      return 'Arama veya filtreyle eşleşen hizmet bulunamadı.';
    }
    return `${resultCount} hizmet gösteriliyor.`;
  };

  const buildSnapshot = (): SidebarNavigationSnapshot => {
    const visibleItems = getVisibleItems();
    reconcileActiveItem(visibleItems);
    const activeIndex = activeItemId === null ? -1 : visibleItems.findIndex((item) => item.windowId === activeItemId);
    const counts: SidebarNavigationViewCounts = Object.freeze({
      all: countForView('all'),
      favorites: countForView('favorites'),
      recent: countForView('recent'),
    });
    return Object.freeze({
      visible,
      collapsed,
      activeGroupId,
      activeGroup: activeGroupId === null ? null : groupMap.get(activeGroupId) ?? null,
      view,
      query,
      normalizedQuery: normalizeSidebarSearchText(query),
      favoriteIds: freezeArray(favoriteIds),
      recentIds: freezeArray(recentIds),
      visibleItems,
      activeItemId,
      activeIndex,
      resultCount: visibleItems.length,
      counts,
      emptyReason: emptyReasonFor(visibleItems.length),
      announcement: announcementFor(visibleItems.length),
      revision,
    });
  };

  let snapshot = buildSnapshot();

  const assertUsable = (): void => {
    if (disposed) throw new Error('Sidebar navigation model is disposed.');
  };

  const recordObserverFailure = (error: unknown): void => {
    observerDiagnostics = Object.freeze({
      failureCount: observerDiagnostics.failureCount + 1,
      lastFailureRevision: revision,
      lastFailureKind: classifyFailure(error),
    });
  };

  const publish = (announcement: string | null = null): void => {
    assertUsable();
    announcementOverride = announcement;
    revision += 1;
    snapshot = buildSnapshot();
    announcementOverride = null;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        recordObserverFailure(error);
      }
    }
  };

  const change = (mutate: () => boolean, announcement: string | null = null): void => {
    assertUsable();
    if (!mutate()) return;
    publish(announcement);
  };

  const getSnapshot = (): SidebarNavigationSnapshot => snapshot;
  const getObserverDiagnostics = (): SidebarNavigationObserverDiagnostics => observerDiagnostics;

  const subscribe = (listener: () => void): (() => void) => {
    assertUsable();
    if (typeof listener !== 'function') throw new TypeError('Sidebar navigation listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const show = (): void => change(() => {
    if (visible && !collapsed) return false;
    visible = true;
    collapsed = false;
    return true;
  }, 'Hizmet paneli açıldı.');

  const close = (): void => change(() => {
    if (!visible && activeGroupId === null) return false;
    visible = false;
    activeGroupId = null;
    view = 'all';
    query = '';
    activeItemId = null;
    return true;
  }, 'Hizmet paneli kapatıldı.');

  const setCollapsed = (nextCollapsed: boolean): void => change(() => {
    if (collapsed === nextCollapsed) return false;
    collapsed = nextCollapsed;
    if (!collapsed) visible = true;
    return true;
  }, nextCollapsed ? 'Hizmet paneli daraltıldı.' : 'Hizmet paneli genişletildi.');

  const toggleCollapsed = (): void => setCollapsed(!collapsed);

  const setGroup = (groupId: string | null): void => change(() => {
    if (groupId !== null && !groupMap.has(groupId)) throw new Error(`Unknown sidebar group: ${groupId}`);
    if (activeGroupId === groupId && view === 'all' && query === '') return false;
    activeGroupId = groupId;
    view = 'all';
    query = '';
    collapsed = false;
    activeItemId = null;
    return true;
  }, groupId === null ? 'Tüm kurumların hizmetleri gösteriliyor.' : `${groupMap.get(groupId)?.label ?? groupId} hizmetleri gösteriliyor.`);

  const toggleGroup = (groupId: string): void => {
    assertUsable();
    if (!groupMap.has(groupId)) throw new Error(`Unknown sidebar group: ${groupId}`);
    setGroup(activeGroupId === groupId ? null : groupId);
  };

  const setView = (nextView: SidebarNavigationView): void => change(() => {
    if (nextView !== 'all' && nextView !== 'favorites' && nextView !== 'recent') throw new Error(`Unknown sidebar view: ${String(nextView)}`);
    if (view === nextView) return false;
    view = nextView;
    activeItemId = null;
    return true;
  });

  const setQuery = (nextQueryInput: string): void => {
    if (typeof nextQueryInput !== 'string') throw new TypeError('Sidebar query must be a string.');
    const nextQuery = sanitizeQuery(nextQueryInput, limits.maxQueryLength);
    change(() => {
      if (query === nextQuery) return false;
      query = nextQuery;
      activeItemId = null;
      return true;
    });
  };

  const clearQuery = (): void => setQuery('');

  const setFavoriteIds = (ids: readonly string[]): void => {
    if (!Array.isArray(ids)) throw new TypeError('Favorite ids must be an array.');
    const next = sanitizeIds(ids, limits.maxFavoriteIds);
    change(() => {
      if (next.length === favoriteIds.length && next.every((id, index) => id === favoriteIds[index])) return false;
      favoriteIds = next;
      return true;
    });
  };

  const toggleFavorite = (windowId: string): void => {
    assertUsable();
    if (!itemMap.has(windowId)) throw new Error(`Unknown sidebar item: ${windowId}`);
    if (favoriteIds.includes(windowId)) {
      setFavoriteIds(favoriteIds.filter((id) => id !== windowId));
      return;
    }
    setFavoriteIds([...favoriteIds, windowId]);
  };

  const setRecentIds = (ids: readonly string[]): void => {
    if (!Array.isArray(ids)) throw new TypeError('Recent ids must be an array.');
    const next = sanitizeIds(ids, limits.maxRecentIds);
    change(() => {
      if (next.length === recentIds.length && next.every((id, index) => id === recentIds[index])) return false;
      recentIds = next;
      return true;
    });
  };

  const recordRecent = (windowId: string): void => {
    assertUsable();
    if (!itemMap.has(windowId)) throw new Error(`Unknown sidebar item: ${windowId}`);
    setRecentIds([windowId, ...recentIds.filter((id) => id !== windowId)]);
  };

  const setActiveItem = (windowId: string | null): void => change(() => {
    if (windowId === null) {
      if (activeItemId === null) return false;
      activeItemId = null;
      return true;
    }
    const visibleItems = getVisibleItems();
    if (!visibleItems.some((item) => item.windowId === windowId)) throw new Error(`Sidebar item is not currently visible: ${windowId}`);
    if (activeItemId === windowId) return false;
    activeItemId = windowId;
    return true;
  });

  const moveActive = (delta: number): void => {
    assertUsable();
    if (!Number.isFinite(delta) || delta === 0) return;
    const visibleItems = getVisibleItems();
    if (visibleItems.length === 0) return;
    const currentIndex = activeItemId === null ? 0 : Math.max(0, visibleItems.findIndex((item) => item.windowId === activeItemId));
    const normalizedDelta = Math.trunc(delta);
    const nextIndex = ((currentIndex + normalizedDelta) % visibleItems.length + visibleItems.length) % visibleItems.length;
    setActiveItem(visibleItems[nextIndex]?.windowId ?? null);
  };

  const moveActiveByPage = (deltaPages: number, pageSize = 6): void => {
    if (!Number.isFinite(deltaPages) || deltaPages === 0) return;
    const safePageSize = Math.min(24, Math.max(1, Math.trunc(pageSize)));
    moveActive(Math.trunc(deltaPages) * safePageSize);
  };

  const focusFirst = (): void => {
    const first = getVisibleItems()[0];
    if (first) setActiveItem(first.windowId);
  };

  const focusLast = (): void => {
    const visibleItems = getVisibleItems();
    const last = visibleItems[visibleItems.length - 1];
    if (last) setActiveItem(last.windowId);
  };

  const getActiveItem = (): ShellSidebarItem | null => {
    const id = snapshot.activeItemId;
    return id === null ? null : itemMap.get(id) ?? null;
  };

  const dispose = (): void => {
    if (disposed) return;
    listeners.clear();
    disposed = true;
  };

  return Object.freeze({
    getSnapshot,
    getObserverDiagnostics,
    subscribe,
    show,
    close,
    setCollapsed,
    toggleCollapsed,
    toggleGroup,
    setGroup,
    setView,
    setQuery,
    clearQuery,
    setFavoriteIds,
    toggleFavorite,
    setRecentIds,
    recordRecent,
    setActiveItem,
    moveActive,
    moveActiveByPage,
    focusFirst,
    focusLast,
    getActiveItem,
    dispose,
  });
};
