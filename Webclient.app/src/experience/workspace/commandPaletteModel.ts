export type CommandPaletteGroup = 'navigation' | 'map' | 'tools' | 'view' | 'help';

export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly group: CommandPaletteGroup;
  readonly shortcut?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly priority?: number | undefined;
}

export interface CommandPaletteMatch {
  readonly item: Readonly<CommandPaletteItem>;
  readonly score: number;
  readonly labelRanges: readonly Readonly<{ start: number; end: number }>[];
  readonly keywordMatches: readonly string[];
}

export interface CommandPaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly matches: readonly CommandPaletteMatch[];
  readonly activeIndex: number;
  readonly activeId: string | null;
  readonly resultCount: number;
}

export interface CommandPaletteModelOptions {
  readonly items: readonly CommandPaletteItem[];
  readonly maxResults?: number | undefined;
}

export interface CommandPaletteModel {
  readonly open: () => CommandPaletteState;
  readonly close: () => CommandPaletteState;
  readonly setQuery: (query: string) => CommandPaletteState;
  readonly move: (direction: 1 | -1) => CommandPaletteState;
  readonly home: () => CommandPaletteState;
  readonly end: () => CommandPaletteState;
  readonly getActive: () => Readonly<CommandPaletteItem> | null;
  readonly getState: () => CommandPaletteState;
  readonly replaceItems: (items: readonly CommandPaletteItem[]) => CommandPaletteState;
}

const DEFAULT_MAX_RESULTS = 12;
const MAX_ITEMS = 256;
const MAX_QUERY_LENGTH = 120;
const GROUP_WEIGHT: Readonly<Record<CommandPaletteGroup, number>> = Object.freeze({ navigation: 50, map: 45, tools: 40, view: 35, help: 20 });

const normalizeText = (value: unknown): string => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i')
  .replace(/İ/g, 'I')
  .toLocaleLowerCase('tr-TR')
  .replace(/[^a-z0-9çğıöşü\s-]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeQuery = (value: unknown): string => normalizeText(value).slice(0, MAX_QUERY_LENGTH);
const tokenize = (value: string): readonly string[] => Object.freeze([...new Set(normalizeText(value).split(' ').filter(Boolean))]);

const freezeItem = (item: CommandPaletteItem): Readonly<CommandPaletteItem> => {
  const id = String(item.id ?? '').trim();
  const label = String(item.label ?? '').trim();
  if (!id) throw new Error('Command palette item id is required.');
  if (!label) throw new Error(`Command palette item label is required for "${id}".`);
  if (!(item.group in GROUP_WEIGHT)) throw new Error(`Unsupported command palette group for "${id}".`);
  return Object.freeze({
    ...item,
    id,
    label,
    description: String(item.description ?? '').trim() || undefined,
    keywords: Object.freeze((item.keywords ?? []).map(String).map((entry) => entry.trim()).filter(Boolean)),
    shortcut: String(item.shortcut ?? '').trim() || undefined,
    disabledReason: String(item.disabledReason ?? '').trim() || undefined,
    priority: Number.isFinite(item.priority) ? Math.trunc(item.priority ?? 0) : 0,
  });
};

const normalizeItems = (items: readonly CommandPaletteItem[]): readonly Readonly<CommandPaletteItem>[] => {
  if (items.length > MAX_ITEMS) throw new Error(`Command palette capacity exceeded (${MAX_ITEMS}).`);
  const seen = new Set<string>();
  return Object.freeze(items.map((item) => {
    const normalized = freezeItem(item);
    if (seen.has(normalized.id)) throw new Error(`Duplicate command palette item id "${normalized.id}".`);
    seen.add(normalized.id);
    return normalized;
  }));
};

const findRanges = (label: string, tokens: readonly string[]): readonly Readonly<{ start: number; end: number }>[] => {
  const normalized = normalizeText(label);
  const ranges: Array<Readonly<{ start: number; end: number }>> = [];
  for (const token of tokens) {
    const start = normalized.indexOf(token);
    if (start >= 0) ranges.push(Object.freeze({ start, end: start + token.length }));
  }
  return Object.freeze(ranges.sort((left, right) => left.start - right.start));
};

const subsequenceScore = (needle: string, haystack: string): number => {
  if (!needle || !haystack) return 0;
  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] !== needle[cursor]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 2 + streak;
    cursor += 1;
  }
  return cursor === needle.length ? score : 0;
};

const scoreField = (query: string, field: string, weight: number): number => {
  if (!query || !field) return 0;
  if (field === query) return 1000 * weight;
  if (field.startsWith(query)) return 500 * weight - Math.min(100, field.length - query.length);
  const contains = field.indexOf(query);
  if (contains >= 0) return 250 * weight - Math.min(100, contains);
  return subsequenceScore(query, field) * weight;
};

const matchItem = (item: Readonly<CommandPaletteItem>, query: string): CommandPaletteMatch | null => {
  const tokens = tokenize(query);
  if (!tokens.length) return Object.freeze({ item, score: GROUP_WEIGHT[item.group] + (item.priority ?? 0), labelRanges: Object.freeze([]), keywordMatches: Object.freeze([]) });
  const label = normalizeText(item.label);
  const description = normalizeText(item.description);
  const keywords = (item.keywords ?? []).map(normalizeText);
  const searchable = [label, description, ...keywords].join(' ');
  if (tokens.some((token) => !searchable.includes(token) && subsequenceScore(token, searchable) === 0)) return null;
  let score = GROUP_WEIGHT[item.group] + (item.priority ?? 0);
  const keywordMatches: string[] = [];
  for (const token of tokens) {
    score += scoreField(token, label, 8);
    score += scoreField(token, description, 2);
    for (const keyword of keywords) {
      const keywordScore = scoreField(token, keyword, 4);
      if (keywordScore > 0) {
        score += keywordScore;
        if (!keywordMatches.includes(keyword)) keywordMatches.push(keyword);
      }
    }
  }
  return Object.freeze({ item, score, labelRanges: findRanges(item.label, tokens), keywordMatches: Object.freeze(keywordMatches) });
};

const rank = (items: readonly Readonly<CommandPaletteItem>[], query: string, maxResults: number): readonly CommandPaletteMatch[] => Object.freeze(
  items.map((item) => matchItem(item, query))
    .filter((match): match is CommandPaletteMatch => Boolean(match))
    .sort((left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label, 'tr') || left.item.id.localeCompare(right.item.id))
    .slice(0, maxResults),
);

const freezeState = (state: CommandPaletteState): CommandPaletteState => Object.freeze({ ...state, matches: Object.freeze([...state.matches]) });

export const createCommandPaletteModel = (options: CommandPaletteModelOptions): CommandPaletteModel => {
  const maxResults = Math.max(1, Math.min(MAX_ITEMS, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS)));
  let items = normalizeItems(options.items);
  let state = freezeState({ open: false, query: '', matches: rank(items, '', maxResults), activeIndex: 0, activeId: items[0]?.id ?? null, resultCount: Math.min(items.length, maxResults) });

  const publish = (open: boolean, query: string, preferredId: string | null = state.activeId): CommandPaletteState => {
    const matches = rank(items, query, maxResults);
    const preferredIndex = preferredId ? matches.findIndex((match) => match.item.id === preferredId) : -1;
    const activeIndex = matches.length ? Math.max(0, preferredIndex) : -1;
    state = freezeState({ open, query, matches, activeIndex, activeId: activeIndex >= 0 ? matches[activeIndex]?.item.id ?? null : null, resultCount: matches.length });
    return state;
  };

  const moveTo = (index: number): CommandPaletteState => {
    if (!state.matches.length) return state;
    const next = (index + state.matches.length) % state.matches.length;
    state = freezeState({ ...state, activeIndex: next, activeId: state.matches[next]?.item.id ?? null });
    return state;
  };

  return Object.freeze({
    open: () => publish(true, state.query),
    close: () => publish(false, ''),
    setQuery: (query: string) => publish(state.open, normalizeQuery(query), null),
    move: (direction: 1 | -1) => moveTo(state.activeIndex + direction),
    home: () => moveTo(0),
    end: () => moveTo(state.matches.length - 1),
    getActive: () => state.activeIndex >= 0 ? state.matches[state.activeIndex]?.item ?? null : null,
    getState: () => state,
    replaceItems: (nextItems: readonly CommandPaletteItem[]) => {
      items = normalizeItems(nextItems);
      return publish(state.open, state.query, state.activeId);
    },
  });
};
