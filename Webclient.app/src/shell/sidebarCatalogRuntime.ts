export interface ShellSidebarGroup {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly logo?: string;
}

export interface ShellSidebarItem {
  readonly group: string;
  readonly label: string;
  readonly windowId: string;
  readonly iconType?: string;
}

export interface SidebarSearchOptions {
  readonly groupId?: string;
  readonly limit?: number;
}

export interface SidebarCatalogSnapshot {
  readonly groupCount: number;
  readonly itemCount: number;
  readonly groups: readonly ShellSidebarGroup[];
  readonly items: readonly ShellSidebarItem[];
  readonly orphanGroups: readonly string[];
}

export interface SidebarCatalogRuntime {
  readonly getGroup: (groupId: string) => ShellSidebarGroup | null;
  readonly getItem: (windowId: string) => ShellSidebarItem | null;
  readonly itemsForGroup: (groupId: string) => readonly ShellSidebarItem[];
  readonly search: (query: string, options?: SidebarSearchOptions) => readonly ShellSidebarItem[];
  readonly snapshot: () => SidebarCatalogSnapshot;
}

export interface SidebarCatalogInput {
  readonly groups: readonly ShellSidebarGroup[];
  readonly items: readonly ShellSidebarItem[];
}

const normalizeId = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (normalized.length > 160) throw new RangeError(`${label} exceeds 160 characters.`);
  return normalized;
};

const normalizeLabel = (value: unknown, label: string): string => {
  const normalized = normalizeId(value, label);
  if (normalized.length > 240) throw new RangeError(`${label} exceeds 240 characters.`);
  return normalized;
};

export const normalizeSidebarSearchText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('tr-TR')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/[^a-z0-9çğıöşü\s-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const cloneGroup = (group: ShellSidebarGroup): ShellSidebarGroup => Object.freeze({
  id: normalizeId(group.id, 'Sidebar group id'),
  label: normalizeLabel(group.label, 'Sidebar group label'),
  ...(typeof group.shortLabel === 'string' && group.shortLabel.trim()
    ? { shortLabel: group.shortLabel.trim().slice(0, 80) }
    : {}),
  ...(typeof group.logo === 'string' && group.logo.trim()
    ? { logo: group.logo.trim().slice(0, 500) }
    : {}),
});

const cloneItem = (item: ShellSidebarItem): ShellSidebarItem => Object.freeze({
  group: normalizeId(item.group, 'Sidebar item group'),
  label: normalizeLabel(item.label, 'Sidebar item label'),
  windowId: normalizeId(item.windowId, 'Sidebar item window id'),
  ...(typeof item.iconType === 'string' && item.iconType.trim()
    ? { iconType: item.iconType.trim().slice(0, 160) }
    : {}),
});

const limitOf = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
};

export const createSidebarCatalogRuntime = (
  input: SidebarCatalogInput,
): SidebarCatalogRuntime => {
  if (!input || !Array.isArray(input.groups) || !Array.isArray(input.items)) {
    throw new TypeError('Sidebar catalog requires group and item arrays.');
  }

  const groups = Object.freeze(input.groups.map(cloneGroup));
  const items = Object.freeze(input.items.map(cloneItem));
  const groupMap = new Map<string, ShellSidebarGroup>();
  const itemMap = new Map<string, ShellSidebarItem>();
  const groupItems = new Map<string, ShellSidebarItem[]>();

  for (const group of groups) {
    if (groupMap.has(group.id)) throw new Error(`Duplicate sidebar group id: ${group.id}`);
    groupMap.set(group.id, group);
    groupItems.set(group.id, []);
  }

  for (const item of items) {
    if (itemMap.has(item.windowId)) throw new Error(`Duplicate sidebar window id: ${item.windowId}`);
    itemMap.set(item.windowId, item);
    const bucket = groupItems.get(item.group);
    if (!bucket) throw new Error(`Sidebar item references unknown group: ${item.group}`);
    bucket.push(item);
  }

  for (const [groupId, bucket] of groupItems) {
    groupItems.set(groupId, [...bucket].sort((left, right) =>
      left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base' })));
  }

  const searchable = items.map((item) => ({
    item,
    text: normalizeSidebarSearchText([
      item.label,
      item.iconType ?? '',
      item.group,
      item.windowId,
    ].join(' ')),
  }));

  const getGroup = (groupId: string): ShellSidebarGroup | null =>
    groupMap.get(normalizeId(groupId, 'Sidebar group id')) ?? null;

  const getItem = (windowId: string): ShellSidebarItem | null =>
    itemMap.get(normalizeId(windowId, 'Sidebar window id')) ?? null;

  const itemsForGroup = (groupId: string): readonly ShellSidebarItem[] => {
    const normalized = normalizeId(groupId, 'Sidebar group id');
    return Object.freeze([...(groupItems.get(normalized) ?? [])]);
  };

  const search = (
    queryInput: string,
    options: SidebarSearchOptions = {},
  ): readonly ShellSidebarItem[] => {
    const query = normalizeSidebarSearchText(queryInput);
    if (!query) return Object.freeze([]);
    const tokens = query.split(' ').filter(Boolean);
    const groupId = typeof options.groupId === 'string' && options.groupId.trim()
      ? normalizeId(options.groupId, 'Sidebar group filter')
      : null;
    if (groupId && !groupMap.has(groupId)) return Object.freeze([]);
    const limit = limitOf(options.limit, 30);

    const ranked = searchable
      .filter(({ item, text }) =>
        (!groupId || item.group === groupId)
        && tokens.every((token) => text.includes(token)))
      .map(({ item, text }) => {
        const label = normalizeSidebarSearchText(item.label);
        const exact = label === query ? 0 : 1;
        const prefix = label.startsWith(query) ? 0 : 1;
        const position = Math.max(0, text.indexOf(query));
        return { item, exact, prefix, position };
      })
      .sort((left, right) =>
        left.exact - right.exact
        || left.prefix - right.prefix
        || left.position - right.position
        || left.item.label.localeCompare(right.item.label, 'tr-TR', { sensitivity: 'base' }));

    return Object.freeze(ranked.slice(0, limit).map(({ item }) => item));
  };

  const snapshot = (): SidebarCatalogSnapshot => Object.freeze({
    groupCount: groups.length,
    itemCount: items.length,
    groups: Object.freeze([...groups]),
    items: Object.freeze([...items]),
    orphanGroups: Object.freeze([]),
  });

  return Object.freeze({ getGroup, getItem, itemsForGroup, search, snapshot });
};
