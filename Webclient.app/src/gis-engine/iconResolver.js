/** Deterministic, diacritic-tolerant JSON-driven icon matching shared by table, 2D and 3D views. */

const normalize = (value) => {
  const text = String(value ?? '').trim().toLocaleLowerCase('tr-TR');
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[._/\\-]+/g, ' ').replace(/\s+/g, ' ');
};

const asAliases = (entry) => [entry.id, entry.key, entry.type, entry.category, ...(entry.aliases || [])].filter(Boolean).map(normalize).filter(Boolean);

export const buildIconRegistry = (entries = []) => {
  const registry = new Map();
  entries.forEach((entry) => {
    if (!entry || !(entry.icon || entry.url || entry.src)) return;
    const aliases = asAliases(entry);
    aliases.forEach((alias) => {
      if (!registry.has(alias)) registry.set(alias, { ...entry, aliases });
    });
  });
  return registry;
};

export const resolveIcon = (record = {}, registry = new Map(), options = {}) => {
  const fallback = options.fallback || 'default';
  const candidates = [record.type, record.category, record.kind, record.className, record.iconKey, record.id]
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(normalize);
  for (const candidate of candidates) {
    const match = registry.get(candidate);
    if (match) return { ...match, matchedBy: candidate, isFallback: false };
  }
  const fallbackEntry = registry.get(normalize(fallback));
  const resolved = fallbackEntry ? { ...fallbackEntry, matchedBy: null, isFallback: true } : { id: fallback, icon: fallback, matchedBy: null, isFallback: true };
  if (typeof options.onFallback === 'function') options.onFallback({ record, candidates, fallback: resolved.id || fallback });
  return resolved;
};

export const resolveIconUrl = (record, registry, options = {}) => {
  const resolved = resolveIcon(record, registry, options);
  return resolved.url || resolved.src || resolved.icon;
};

export const normalizeIconKey = normalize;
