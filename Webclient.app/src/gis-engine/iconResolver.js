/** Deterministic JSON-driven icon matching shared by table, 2D and 3D views. */

const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('tr-TR');

const asAliases = (entry) => [entry.id, entry.key, entry.type, entry.category, ...(entry.aliases || [])].filter(Boolean).map(normalize);

export const buildIconRegistry = (entries = []) => {
  const registry = new Map();
  entries.forEach((entry) => {
    if (!entry || !entry.icon) return;
    asAliases(entry).forEach((alias) => {
      if (!registry.has(alias)) registry.set(alias, { ...entry, aliases: asAliases(entry) });
    });
  });
  return registry;
};

export const resolveIcon = (record, registry, options = {}) => {
  const fallback = options.fallback || 'default';
  const candidates = [record?.type, record?.category, record?.kind, record?.className, record?.iconKey, record?.id]
    .filter(Boolean)
    .map(normalize);
  for (const candidate of candidates) {
    const match = registry.get(candidate);
    if (match) return { ...match, matchedBy: candidate, isFallback: false };
  }
  const fallbackEntry = registry.get(normalize(fallback));
  return fallbackEntry
    ? { ...fallbackEntry, matchedBy: null, isFallback: true }
    : { icon: fallback, matchedBy: null, isFallback: true };
};

export const resolveIconUrl = (record, registry, options = {}) => {
  const resolved = resolveIcon(record, registry, options);
  return resolved.url || resolved.src || resolved.icon;
};
