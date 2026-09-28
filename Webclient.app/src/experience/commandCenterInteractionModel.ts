export type CommandCenterInputModality = 'keyboard' | 'pointer' | 'programmatic';

export interface CommandCenterItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly searchText: string;
  readonly disabled?: boolean;
}

export interface CommandCenterLimits {
  readonly maxItems: number;
  readonly maxQueryLength: number;
  readonly maxTokens: number;
  readonly maxGroups: number;
  readonly pageStep: number;
}

export interface CommandCenterInventoryFacts {
  readonly submittedCount: number;
  readonly acceptedCount: number;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly groupCount: number;
  readonly truncated: boolean;
}

export interface CommandCenterMatch {
  readonly item: CommandCenterItem;
  readonly sourceIndex: number;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

export interface CommandCenterState {
  readonly open: boolean;
  readonly query: string;
  readonly activeId: string | null;
  readonly matches: readonly CommandCenterMatch[];
  readonly modality: CommandCenterInputModality;
  readonly revision: number;
  readonly announcement: string;
}

export type CommandCenterAction =
  | { readonly type: 'open'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'close'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'query'; readonly value: string; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'move'; readonly delta: number; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'first'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'last'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'page-forward'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'page-backward'; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'activate'; readonly id: string; readonly modality?: CommandCenterInputModality }
  | { readonly type: 'items-changed'; readonly items: readonly CommandCenterItem[] };

export type CommandCenterStateObserver = (
  state: CommandCenterState,
  previous: CommandCenterState,
) => void;

export interface CommandCenterInteractionOptions extends Partial<CommandCenterLimits> {
  readonly onObserverError?: (error: unknown) => void;
}

const DEFAULT_LIMITS: CommandCenterLimits = Object.freeze({
  maxItems: 512,
  maxQueryLength: 160,
  maxTokens: 12,
  maxGroups: 64,
  pageStep: 6,
});

const MAX_TEXT_SCAN = 4096;
const MAX_ID_SCAN = 256;
const MAX_OBSERVERS = 32;
const trLocale = 'tr-TR';

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const isControlCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0 && codePoint <= 31) || codePoint === 127;

const replaceControlCharacters = (
  value: string,
  replacement: string,
  scanLimit: number,
): string => {
  const source = String(value ?? '').slice(0, scanLimit);
  let result = '';
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && isControlCodePoint(codePoint)
      ? replacement
      : character;
  }
  return result;
};

const normalizeDisplayText = (
  value: string,
  maxLength: number,
  fallback = '',
): string => {
  const normalized = replaceControlCharacters(value, ' ', MAX_TEXT_SCAN)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || fallback;
};

const normalizeSearchText = (value: string): string => replaceControlCharacters(
  value,
  ' ',
  MAX_TEXT_SCAN,
)
  .normalize('NFKD')
  .toLocaleLowerCase(trLocale)
  .replace(/\p{M}+/gu, '')
  .replace(/ı/g, 'i')
  .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const sanitizeId = (value: string): string => replaceControlCharacters(
  value,
  '-',
  MAX_ID_SCAN,
)
  .normalize('NFKC')
  .replace(/\s+/g, '-')
  .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 128);

const sanitizeQueryDisplay = (
  value: string,
  maxLength: number,
): string => replaceControlCharacters(value, ' ', Math.min(MAX_TEXT_SCAN, maxLength * 4))
  .normalize('NFKC')
  .slice(0, maxLength)
  .trimStart();

const sanitizeItem = (item: CommandCenterItem): CommandCenterItem | null => {
  const id = sanitizeId(item.id);
  const label = normalizeDisplayText(item.label, 160);
  if (!id || !label) return null;
  const group = normalizeDisplayText(item.group, 120, 'Diğer');
  const description = normalizeDisplayText(item.description, 320);
  const searchText = normalizeSearchText(
    `${item.searchText} ${label} ${group} ${description} ${id}`,
  ).slice(0, 1024);

  return Object.freeze({
    id,
    group,
    label,
    description,
    searchText,
    ...(item.disabled === true ? { disabled: true } : {}),
  });
};

interface SanitizedInventory {
  readonly items: readonly CommandCenterItem[];
  readonly facts: CommandCenterInventoryFacts;
}

const sanitizeItems = (
  items: readonly CommandCenterItem[],
  limits: CommandCenterLimits,
): SanitizedInventory => {
  const result: CommandCenterItem[] = [];
  const ids = new Set<string>();
  const groups = new Set<string>();
  let disabledCount = 0;

  for (const candidate of items) {
    if (result.length >= limits.maxItems) break;
    const item = sanitizeItem(candidate);
    if (!item || ids.has(item.id)) continue;
    if (!groups.has(item.group) && groups.size >= limits.maxGroups) continue;
    ids.add(item.id);
    groups.add(item.group);
    if (item.disabled) disabledCount += 1;
    result.push(item);
  }

  const frozenItems = Object.freeze(result);
  const facts: CommandCenterInventoryFacts = Object.freeze({
    submittedCount: items.length,
    acceptedCount: frozenItems.length,
    enabledCount: frozenItems.length - disabledCount,
    disabledCount,
    groupCount: groups.size,
    truncated: frozenItems.length < items.length,
  });

  return Object.freeze({ items: frozenItems, facts });
};

const queryTokens = (
  query: string,
  limits: CommandCenterLimits,
): readonly string[] => Object.freeze(
  normalizeSearchText(query)
    .split(' ')
    .filter(Boolean)
    .slice(0, limits.maxTokens),
);

const scoreToken = (haystack: string, token: string): number => {
  if (haystack === token) return 120;
  if (haystack.startsWith(token)) return 80;
  const wordIndex = haystack.indexOf(` ${token}`);
  if (wordIndex >= 0) return 55 - Math.min(20, Math.floor(wordIndex / 20));
  const index = haystack.indexOf(token);
  if (index >= 0) return 30 - Math.min(20, Math.floor(index / 25));
  return -1;
};

const matchItems = (
  items: readonly CommandCenterItem[],
  query: string,
  limits: CommandCenterLimits,
): readonly CommandCenterMatch[] => {
  const tokens = queryTokens(query, limits);
  const matches: CommandCenterMatch[] = [];

  items.forEach((item, sourceIndex) => {
    if (item.disabled) return;
    if (tokens.length === 0) {
      matches.push(Object.freeze({
        item,
        sourceIndex,
        score: 0,
        matchedTokens: Object.freeze([]),
      }));
      return;
    }

    let score = 0;
    const matched: string[] = [];
    for (const token of tokens) {
      const tokenScore = scoreToken(item.searchText, token);
      if (tokenScore < 0) return;
      score += tokenScore;
      matched.push(token);
    }

    const label = normalizeSearchText(item.label);
    if (tokens.some(token => label === token)) score += 80;
    else if (tokens.some(token => label.startsWith(token))) score += 35;

    matches.push(Object.freeze({
      item,
      sourceIndex,
      score,
      matchedTokens: Object.freeze(matched),
    }));
  });

  matches.sort((left, right) => (
    right.score - left.score
    || left.sourceIndex - right.sourceIndex
    || left.item.id.localeCompare(right.item.id, trLocale)
  ));
  return Object.freeze(matches);
};

const announcementFor = (
  matches: readonly CommandCenterMatch[],
  query: string,
): string => {
  if (!query) return `${matches.length} komut kullanılabilir.`;
  if (matches.length === 0) return `“${query}” için sonuç bulunamadı.`;
  return `“${query}” için ${matches.length} sonuç bulundu.`;
};

const normalizeLimits = (
  options?: CommandCenterInteractionOptions,
): CommandCenterLimits => Object.freeze({
  maxItems: clampInteger(options?.maxItems ?? DEFAULT_LIMITS.maxItems, 1, 2048),
  maxQueryLength: clampInteger(
    options?.maxQueryLength ?? DEFAULT_LIMITS.maxQueryLength,
    16,
    512,
  ),
  maxTokens: clampInteger(options?.maxTokens ?? DEFAULT_LIMITS.maxTokens, 1, 32),
  maxGroups: clampInteger(options?.maxGroups ?? DEFAULT_LIMITS.maxGroups, 1, 256),
  pageStep: clampInteger(options?.pageStep ?? DEFAULT_LIMITS.pageStep, 1, 24),
});

const nextActiveId = (
  matches: readonly CommandCenterMatch[],
  currentId: string | null,
  delta: number,
): string | null => {
  if (matches.length === 0) return null;
  const currentIndex = currentId
    ? matches.findIndex(match => match.item.id === currentId)
    : -1;
  const origin = currentIndex >= 0 ? currentIndex : 0;
  const next = ((origin + delta) % matches.length + matches.length) % matches.length;
  return matches[next]?.item.id ?? null;
};

const stateWith = (
  previous: CommandCenterState,
  patch: Partial<Omit<CommandCenterState, 'revision'>>,
): CommandCenterState => Object.freeze({
  ...previous,
  ...patch,
  revision: previous.revision + 1,
});

const reportObserverError = (
  reporter: CommandCenterInteractionOptions['onObserverError'],
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

export interface CommandCenterInteractionModel {
  readonly limits: CommandCenterLimits;
  getState(): CommandCenterState;
  getItems(): readonly CommandCenterItem[];
  getInventoryFacts(): CommandCenterInventoryFacts;
  dispatch(action: CommandCenterAction): CommandCenterState;
  getActiveMatch(): CommandCenterMatch | null;
  getMatch(id: string): CommandCenterMatch | null;
  canExecuteActive(): boolean;
  subscribe(observer: CommandCenterStateObserver): () => void;
  dispose(): void;
}

export const createCommandCenterInteractionModel = (
  initialItems: readonly CommandCenterItem[],
  options: CommandCenterInteractionOptions = {},
): CommandCenterInteractionModel => {
  const limits = normalizeLimits(options);
  let inventory = sanitizeItems(initialItems, limits);
  let items = inventory.items;
  const initialMatches = matchItems(items, '', limits);
  let state: CommandCenterState = Object.freeze({
    open: false,
    query: '',
    activeId: initialMatches[0]?.item.id ?? null,
    matches: initialMatches,
    modality: 'programmatic',
    revision: 0,
    announcement: announcementFor(initialMatches, ''),
  });
  const observers = new Set<CommandCenterStateObserver>();
  let disposed = false;

  const notify = (previous: CommandCenterState): void => {
    const observerSnapshot = Array.from(observers);
    for (const observer of observerSnapshot) {
      try {
        observer(state, previous);
      } catch (error) {
        reportObserverError(options.onObserverError, error);
      }
    }
  };

  const commit = (
    patch: Partial<Omit<CommandCenterState, 'revision'>>,
  ): CommandCenterState => {
    if (disposed) return state;
    const previous = state;
    state = stateWith(previous, patch);
    notify(previous);
    return state;
  };

  const updateQuery = (
    raw: string,
    modality: CommandCenterInputModality,
  ): CommandCenterState => {
    const query = sanitizeQueryDisplay(raw, limits.maxQueryLength);
    const matches = matchItems(items, query, limits);
    const retained = state.activeId
      && matches.some(match => match.item.id === state.activeId)
      ? state.activeId
      : matches[0]?.item.id ?? null;

    return commit({
      query,
      matches,
      activeId: retained,
      modality,
      announcement: announcementFor(matches, query),
    });
  };

  const dispatch = (action: CommandCenterAction): CommandCenterState => {
    if (disposed) return state;
    const modality = 'modality' in action
      ? action.modality ?? state.modality
      : state.modality;

    switch (action.type) {
      case 'open': {
        const matches = matchItems(items, '', limits);
        return commit({
          open: true,
          query: '',
          matches,
          activeId: matches[0]?.item.id ?? null,
          modality,
          announcement: announcementFor(matches, ''),
        });
      }
      case 'close':
        return commit({
          open: false,
          modality,
          announcement: 'Komut merkezi kapatıldı.',
        });
      case 'query':
        return updateQuery(action.value, modality);
      case 'move': {
        const delta = clampInteger(action.delta, -2048, 2048);
        if (delta === 0 || state.matches.length === 0) return state;
        return commit({
          activeId: nextActiveId(state.matches, state.activeId, delta),
          modality,
        });
      }
      case 'first': {
        const activeId = state.matches[0]?.item.id ?? null;
        if (activeId === state.activeId) return state;
        return commit({ activeId, modality });
      }
      case 'last': {
        const activeId = state.matches.at(-1)?.item.id ?? null;
        if (activeId === state.activeId) return state;
        return commit({ activeId, modality });
      }
      case 'page-forward': {
        if (state.matches.length === 0) return state;
        return commit({
          activeId: nextActiveId(state.matches, state.activeId, limits.pageStep),
          modality,
        });
      }
      case 'page-backward': {
        if (state.matches.length === 0) return state;
        return commit({
          activeId: nextActiveId(state.matches, state.activeId, -limits.pageStep),
          modality,
        });
      }
      case 'activate': {
        const safeId = sanitizeId(action.id);
        if (!state.matches.some(match => match.item.id === safeId)) return state;
        if (state.activeId === safeId && state.modality === modality) return state;
        return commit({ activeId: safeId, modality });
      }
      case 'items-changed': {
        inventory = sanitizeItems(action.items, limits);
        items = inventory.items;
        const matches = matchItems(items, state.query, limits);
        const activeId = state.activeId
          && matches.some(match => match.item.id === state.activeId)
          ? state.activeId
          : matches[0]?.item.id ?? null;
        return commit({
          matches,
          activeId,
          announcement: announcementFor(matches, state.query),
        });
      }
      default:
        return state;
    }
  };

  return Object.freeze({
    limits,
    getState: () => state,
    getItems: () => items,
    getInventoryFacts: () => inventory.facts,
    dispatch,
    getActiveMatch: () => state.matches.find(
      match => match.item.id === state.activeId,
    ) ?? null,
    getMatch: (id: string) => {
      const safeId = sanitizeId(id);
      return state.matches.find(match => match.item.id === safeId) ?? null;
    },
    canExecuteActive: () => state.open && state.activeId !== null
      && state.matches.some(match => match.item.id === state.activeId),
    subscribe(observer: CommandCenterStateObserver) {
      if (disposed) return () => undefined;
      if (observers.size >= MAX_OBSERVERS && !observers.has(observer)) {
        throw new Error(`Command center observer capacity exceeded (${MAX_OBSERVERS}).`);
      }
      observers.add(observer);
      try {
        observer(state, state);
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
    },
  });
};
