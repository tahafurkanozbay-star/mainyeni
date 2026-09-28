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

const DEFAULT_LIMITS: CommandCenterLimits = Object.freeze({
  maxItems: 512,
  maxQueryLength: 160,
  maxTokens: 12,
  maxGroups: 64,
  pageStep: 6,
});

const trLocale = 'tr-TR';

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const normalizeText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase(trLocale)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const sanitizeId = (value: string): string => value
  .normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f\s]+/g, '-')
  .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 128);

const sanitizeItem = (item: CommandCenterItem): CommandCenterItem | null => {
  const id = sanitizeId(item.id);
  const label = item.label.normalize('NFKC').trim().slice(0, 160);
  if (!id || !label) return null;
  return Object.freeze({
    id,
    group: item.group.normalize('NFKC').trim().slice(0, 120) || 'Diğer',
    label,
    description: item.description.normalize('NFKC').trim().slice(0, 320),
    searchText: normalizeText(`${item.searchText} ${label} ${item.group} ${item.description}`).slice(0, 1024),
    ...(item.disabled === true ? { disabled: true } : {}),
  });
};

const sanitizeItems = (
  items: readonly CommandCenterItem[],
  limits: CommandCenterLimits,
): readonly CommandCenterItem[] => {
  const result: CommandCenterItem[] = [];
  const ids = new Set<string>();
  const groups = new Set<string>();
  for (const candidate of items) {
    if (result.length >= limits.maxItems) break;
    const item = sanitizeItem(candidate);
    if (!item || ids.has(item.id)) continue;
    if (!groups.has(item.group) && groups.size >= limits.maxGroups) continue;
    ids.add(item.id);
    groups.add(item.group);
    result.push(item);
  }
  return Object.freeze(result);
};

const queryTokens = (query: string, limits: CommandCenterLimits): readonly string[] =>
  Object.freeze(normalizeText(query).split(' ').filter(Boolean).slice(0, limits.maxTokens));

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
      matches.push(Object.freeze({ item, sourceIndex, score: 0, matchedTokens: Object.freeze([]) }));
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
    const label = normalizeText(item.label);
    if (tokens.some(token => label === token)) score += 80;
    else if (tokens.some(token => label.startsWith(token))) score += 35;
    matches.push(Object.freeze({ item, sourceIndex, score, matchedTokens: Object.freeze(matched) }));
  });
  matches.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex || a.item.id.localeCompare(b.item.id, trLocale));
  return Object.freeze(matches);
};

const announcementFor = (matches: readonly CommandCenterMatch[], query: string): string => {
  if (!query) return `${matches.length} komut kullanılabilir.`;
  if (matches.length === 0) return `“${query}” için sonuç bulunamadı.`;
  return `“${query}” için ${matches.length} sonuç bulundu.`;
};

const normalizeLimits = (limits?: Partial<CommandCenterLimits>): CommandCenterLimits => Object.freeze({
  maxItems: clampInteger(limits?.maxItems ?? DEFAULT_LIMITS.maxItems, 1, 2048),
  maxQueryLength: clampInteger(limits?.maxQueryLength ?? DEFAULT_LIMITS.maxQueryLength, 16, 512),
  maxTokens: clampInteger(limits?.maxTokens ?? DEFAULT_LIMITS.maxTokens, 1, 32),
  maxGroups: clampInteger(limits?.maxGroups ?? DEFAULT_LIMITS.maxGroups, 1, 256),
  pageStep: clampInteger(limits?.pageStep ?? DEFAULT_LIMITS.pageStep, 1, 24),
});

const nextActiveId = (
  matches: readonly CommandCenterMatch[],
  currentId: string | null,
  delta: number,
): string | null => {
  if (matches.length === 0) return null;
  const currentIndex = currentId ? matches.findIndex(match => match.item.id === currentId) : -1;
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

export interface CommandCenterInteractionModel {
  readonly limits: CommandCenterLimits;
  getState(): CommandCenterState;
  getItems(): readonly CommandCenterItem[];
  dispatch(action: CommandCenterAction): CommandCenterState;
  getActiveMatch(): CommandCenterMatch | null;
  canExecuteActive(): boolean;
}

export const createCommandCenterInteractionModel = (
  initialItems: readonly CommandCenterItem[],
  options?: Partial<CommandCenterLimits>,
): CommandCenterInteractionModel => {
  const limits = normalizeLimits(options);
  let items = sanitizeItems(initialItems, limits);
  let initialMatches = matchItems(items, '', limits);
  let state: CommandCenterState = Object.freeze({
    open: false,
    query: '',
    activeId: initialMatches[0]?.item.id ?? null,
    matches: initialMatches,
    modality: 'programmatic',
    revision: 0,
    announcement: announcementFor(initialMatches, ''),
  });

  const updateQuery = (raw: string, modality: CommandCenterInputModality): CommandCenterState => {
    const query = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limits.maxQueryLength).trimStart();
    const matches = matchItems(items, query, limits);
    const retained = state.activeId && matches.some(match => match.item.id === state.activeId)
      ? state.activeId
      : matches[0]?.item.id ?? null;
    state = stateWith(state, {
      query,
      matches,
      activeId: retained,
      modality,
      announcement: announcementFor(matches, query),
    });
    return state;
  };

  const dispatch = (action: CommandCenterAction): CommandCenterState => {
    const modality = 'modality' in action ? action.modality ?? state.modality : state.modality;
    switch (action.type) {
      case 'open': {
        const matches = matchItems(items, '', limits);
        state = stateWith(state, {
          open: true,
          query: '',
          matches,
          activeId: matches[0]?.item.id ?? null,
          modality,
          announcement: announcementFor(matches, ''),
        });
        return state;
      }
      case 'close':
        state = stateWith(state, { open: false, modality, announcement: 'Komut merkezi kapatıldı.' });
        return state;
      case 'query':
        return updateQuery(action.value, modality);
      case 'move':
        state = stateWith(state, {
          activeId: nextActiveId(state.matches, state.activeId, clampInteger(action.delta, -2048, 2048)),
          modality,
        });
        return state;
      case 'first':
        state = stateWith(state, { activeId: state.matches[0]?.item.id ?? null, modality });
        return state;
      case 'last':
        state = stateWith(state, { activeId: state.matches.at(-1)?.item.id ?? null, modality });
        return state;
      case 'page-forward':
        state = stateWith(state, { activeId: nextActiveId(state.matches, state.activeId, limits.pageStep), modality });
        return state;
      case 'page-backward':
        state = stateWith(state, { activeId: nextActiveId(state.matches, state.activeId, -limits.pageStep), modality });
        return state;
      case 'activate': {
        const safeId = sanitizeId(action.id);
        if (!state.matches.some(match => match.item.id === safeId)) return state;
        state = stateWith(state, { activeId: safeId, modality });
        return state;
      }
      case 'items-changed': {
        items = sanitizeItems(action.items, limits);
        const matches = matchItems(items, state.query, limits);
        const activeId = state.activeId && matches.some(match => match.item.id === state.activeId)
          ? state.activeId
          : matches[0]?.item.id ?? null;
        state = stateWith(state, {
          matches,
          activeId,
          announcement: announcementFor(matches, state.query),
        });
        return state;
      }
      default:
        return state;
    }
  };

  return Object.freeze({
    limits,
    getState: () => state,
    getItems: () => items,
    dispatch,
    getActiveMatch: () => state.matches.find(match => match.item.id === state.activeId) ?? null,
    canExecuteActive: () => state.open && state.matches.some(match => match.item.id === state.activeId),
  });
};
