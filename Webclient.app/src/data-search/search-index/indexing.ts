import {
  normalizeCategoryKey,
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  isRecord,
  type IndexedSearchDocument,
  type InvertedSearchIndex,
  type InvertedSearchIndexOptions,
  type UnknownRecord,
} from './contracts';
import {
  DEFAULT_PREFIX_LENGTH,
  createTokenPrefixes,
  tokenizeSearchText,
  uniqueSearchTokens,
} from './tokenization';

const fieldText = (source: UnknownRecord, key: string): string =>
  normalizeText(source[key]);

export const normalizeSearchDocument = (
  document: unknown,
  index = 0,
): IndexedSearchDocument => {
  const source = isRecord(document) ? document : {};
  const id = normalizeText(source.id ?? source.key ?? `document-${index}`);
  const title = fieldText(source, 'title');
  const address = fieldText(source, 'address');
  const category = fieldText(source, 'category');
  const type = fieldText(source, 'type');
  const district = fieldText(source, 'district');
  const neighborhood = fieldText(source, 'neighborhood');
  const street = fieldText(source, 'street');
  const searchText = normalizeSearchText([
    title,
    address,
    category,
    type,
    district,
    neighborhood,
    street,
    source.searchText,
  ].filter(Boolean).join(' '));
  const tokens = tokenizeSearchText(searchText);
  const sourceIndex =
    typeof source.sourceIndex === 'number' && Number.isInteger(source.sourceIndex)
      ? source.sourceIndex
      : index;

  return {
    ...source,
    id: id || `document-${index}`,
    title,
    address,
    category,
    categoryKey: normalizeCategoryKey(source.categoryKey ?? category),
    type,
    typeKey: normalizeCategoryKey(type),
    district,
    districtKey: normalizeCategoryKey(district),
    neighborhood,
    neighborhoodKey: normalizeCategoryKey(neighborhood),
    street,
    streetKey: normalizeCategoryKey(street),
    searchText,
    tokens,
    sourceIndex,
  };
};

const addPosition = (
  map: Map<string, Set<number>>,
  key: string,
  position: number,
): void => {
  if (!key) return;
  const positions = map.get(key) ?? new Set<number>();
  positions.add(position);
  map.set(key, positions);
};

export const createInvertedSearchIndex = (
  documents: unknown,
  options: InvertedSearchIndexOptions = {},
): InvertedSearchIndex => {
  const input = Array.isArray(documents) ? documents : [];
  const requestedPrefixLength = normalizeFiniteNumber(options.prefixLength, null);
  const prefixLength = requestedPrefixLength === null || requestedPrefixLength <= 0
    ? DEFAULT_PREFIX_LENGTH
    : normalizeInteger(requestedPrefixLength, {
      min: 1,
      max: 20,
      fallback: DEFAULT_PREFIX_LENGTH,
    }) ?? DEFAULT_PREFIX_LENGTH;
  const normalized = input.map((document, index) =>
    normalizeSearchDocument(document, index));

  const byId = new Map<string, number>();
  const tokenPostings = new Map<string, Set<number>>();
  const prefixPostings = new Map<string, Set<number>>();
  const categoryPostings = new Map<string, Set<number>>();
  const typePostings = new Map<string, Set<number>>();
  const districtPostings = new Map<string, Set<number>>();
  const neighborhoodPostings = new Map<string, Set<number>>();
  const streetPostings = new Map<string, Set<number>>();
  const duplicateIds: string[] = [];

  normalized.forEach((document, position) => {
    if (byId.has(document.id)) duplicateIds.push(document.id);
    else byId.set(document.id, position);

    for (const token of document.tokens) {
      addPosition(tokenPostings, token, position);
      for (const prefix of createTokenPrefixes(token, prefixLength)) {
        addPosition(prefixPostings, prefix, position);
      }
    }

    addPosition(categoryPostings, document.categoryKey, position);
    addPosition(typePostings, document.typeKey, position);
    addPosition(districtPostings, document.districtKey, position);
    addPosition(neighborhoodPostings, document.neighborhoodKey, position);
    addPosition(streetPostings, document.streetKey, position);
  });

  return {
    documents: normalized,
    byId,
    tokenPostings,
    prefixPostings,
    categoryPostings,
    typePostings,
    districtPostings,
    neighborhoodPostings,
    streetPostings,
    prefixLength,
    diagnostics: {
      inputCount: input.length,
      indexedCount: normalized.length,
      uniqueIdCount: byId.size,
      duplicateIds: uniqueSearchTokens(duplicateIds),
      tokenCount: tokenPostings.size,
      prefixCount: prefixPostings.size,
      categoryCount: categoryPostings.size,
      typeCount: typePostings.size,
      districtCount: districtPostings.size,
      neighborhoodCount: neighborhoodPostings.size,
      streetCount: streetPostings.size,
    },
  };
};

export const intersectPostings = (
  postingSets: readonly (Set<number> | null | undefined)[],
): Set<number> | null => {
  const sets = postingSets.filter(
    (set): set is Set<number> => set instanceof Set,
  );
  if (!sets.length) return null;

  const ordered = [...sets].sort((left, right) => left.size - right.size);
  const first = ordered[0];
  if (!first) return null;
  const result = new Set(first);

  for (const set of ordered.slice(1)) {
    for (const value of Array.from(result)) {
      if (!set.has(value)) result.delete(value);
    }
  }

  return result;
};

export const unionPostings = (
  postingSets: readonly (Set<number> | null | undefined)[],
): Set<number> => {
  const result = new Set<number>();
  for (const set of postingSets) {
    if (!(set instanceof Set)) continue;
    for (const value of set) result.add(value);
  }
  return result;
};
