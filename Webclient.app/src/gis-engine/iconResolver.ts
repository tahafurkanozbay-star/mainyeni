import type {
  IconEntry,
  IconRecord,
  IconResolveOptions,
  ResolvedIconEntry,
} from './contracts';

/** Deterministic, diacritic-tolerant JSON-driven icon matching shared by table, 2D and 3D views. */

export type IconRegistry = Map<string, IconEntry & { aliases: string[] }>;

const normalize = (value: unknown): string => {
  const text = String(value ?? '').trim().toLocaleLowerCase('tr-TR');
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[._/\\-]+/g, ' ')
    .replace(/\s+/g, ' ');
};

const isIconEntry = (entry: unknown): entry is IconEntry => {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<IconEntry>;
  return typeof candidate.id === 'string' && Boolean(candidate.icon || candidate.url || candidate.src);
};

const asAliases = (entry: IconEntry): string[] => [
  entry.id,
  entry.key,
  entry.type,
  entry.category,
  ...(entry.aliases || []),
]
  .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  .map(normalize)
  .filter(Boolean);

export const buildIconRegistry = (entries: readonly unknown[] = []): IconRegistry => {
  const registry: IconRegistry = new Map();
  entries.forEach((candidate) => {
    if (!isIconEntry(candidate)) return;
    const aliases = asAliases(candidate);
    aliases.forEach((alias) => {
      if (!registry.has(alias)) registry.set(alias, { ...candidate, aliases });
    });
  });
  return registry;
};

const fallbackIcon = (fallback: string): ResolvedIconEntry => ({
  id: fallback,
  icon: fallback,
  aliases: [normalize(fallback)],
  matchedBy: null,
  isFallback: true,
});

export const resolveIcon = (
  record: IconRecord = {},
  registry: IconRegistry = new Map(),
  options: IconResolveOptions = {},
): ResolvedIconEntry => {
  const fallback = options.fallback || 'default';
  const candidates = [
    record.type,
    record.category,
    record.kind,
    record.className,
    record.iconKey,
    record.id,
  ]
    .filter((value): value is string | number => value !== null && value !== undefined && value !== '')
    .map(normalize);

  for (const candidate of candidates) {
    const match = registry.get(candidate);
    if (match) return { ...match, matchedBy: candidate, isFallback: false };
  }

  const fallbackEntry = registry.get(normalize(fallback));
  const resolved: ResolvedIconEntry = fallbackEntry
    ? { ...fallbackEntry, matchedBy: null, isFallback: true }
    : fallbackIcon(fallback);

  if (typeof options.onFallback === 'function') {
    options.onFallback({ record, candidates, fallback: resolved.id || fallback });
  }
  return resolved;
};

export const resolveIconUrl = (
  record: IconRecord,
  registry: IconRegistry,
  options: IconResolveOptions = {},
): string => {
  const resolved = resolveIcon(record, registry, options);
  return resolved.url || resolved.src || resolved.icon;
};

export const normalizeIconKey = normalize;
