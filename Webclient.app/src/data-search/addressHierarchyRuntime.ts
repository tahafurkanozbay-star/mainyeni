import type { AddressLevel, Coordinate, NormalizedRecord } from './contracts';
import {
  canonicalizeAddressText,
  canonicalizeAddressTokens,
  normalizeDoorToken,
} from './addressSemantics';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import { haversineDistanceMeters } from './spatialIndex';

export const ADDRESS_HIERARCHY_VERSION = '2026-09-24.v3';

export type AddressHierarchyLevel = Exclude<AddressLevel, 'address'>;
export type AddressHierarchyDiagnosticSeverity = 'info' | 'warning' | 'error';
export type AddressHierarchyDiagnosticCode =
  | 'empty-record'
  | 'missing-parent-level'
  | 'duplicate-path'
  | 'coordinate-divergence'
  | 'record-budget-exceeded'
  | 'node-budget-exceeded'
  | 'child-budget-exceeded'
  | 'alias-budget-exceeded';

export interface AddressHierarchyDiagnostic {
  readonly code: AddressHierarchyDiagnosticCode;
  readonly severity: AddressHierarchyDiagnosticSeverity;
  readonly recordKey: string | null;
  readonly nodeKey: string | null;
  readonly detail: string;
}

export interface AddressHierarchyNode {
  readonly key: string;
  readonly level: AddressHierarchyLevel;
  readonly name: string;
  readonly canonicalName: string;
  readonly pathKey: string;
  readonly parentKey: string | null;
  readonly childKeys: readonly string[];
  readonly recordKeys: readonly string[];
  readonly aliases: readonly string[];
  readonly searchTokens: readonly string[];
  readonly depth: number;
  readonly coordinates: Coordinate | null;
  readonly coordinateSampleCount: number;
  readonly coordinateSpreadMeters: number;
  readonly sourceCount: number;
  readonly fingerprint: string;
}

export interface AddressHierarchyRecordBinding {
  readonly recordKey: string;
  readonly districtKey: string | null;
  readonly neighborhoodKey: string | null;
  readonly streetKey: string | null;
  readonly buildingKey: string | null;
  readonly doorKey: string | null;
  readonly deepestKey: string | null;
  readonly pathKeys: readonly string[];
  readonly fingerprint: string;
}

export interface AddressHierarchyBuildOptions {
  readonly maxRecords?: number;
  readonly maxNodes?: number;
  readonly maxChildrenPerNode?: number;
  readonly maxAliasesPerNode?: number;
  readonly maxDiagnostics?: number;
  readonly coordinateDivergenceMeters?: number;
  readonly buildingFieldAliases?: readonly string[];
}

export interface AddressHierarchyResolveOptions {
  readonly level?: AddressHierarchyLevel | null;
  readonly district?: string | null;
  readonly neighborhood?: string | null;
  readonly street?: string | null;
  readonly center?: Coordinate | readonly [number, number] | null;
  readonly radiusMeters?: number | null;
  readonly limit?: number;
  readonly minimumScore?: number;
  readonly requireHierarchyMatch?: boolean;
}

export interface AddressHierarchyMatch {
  readonly node: AddressHierarchyNode;
  readonly score: number;
  readonly textScore: number;
  readonly hierarchyScore: number;
  readonly distanceScore: number;
  readonly distanceMeters: number | null;
  readonly exact: boolean;
  readonly prefix: boolean;
  readonly reasons: readonly string[];
}

export interface AddressHierarchySnapshot {
  readonly version: string;
  readonly recordCount: number;
  readonly nodeCount: number;
  readonly rootCount: number;
  readonly districtCount: number;
  readonly neighborhoodCount: number;
  readonly streetCount: number;
  readonly buildingCount: number;
  readonly doorCount: number;
  readonly diagnostics: readonly AddressHierarchyDiagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly fingerprint: string;
}

interface NormalizedHierarchyOptions {
  readonly maxRecords: number;
  readonly maxNodes: number;
  readonly maxChildrenPerNode: number;
  readonly maxAliasesPerNode: number;
  readonly maxDiagnostics: number;
  readonly coordinateDivergenceMeters: number;
  readonly buildingFieldAliases: readonly string[];
}

interface MutableNode {
  readonly key: string;
  readonly level: AddressHierarchyLevel;
  readonly name: string;
  readonly canonicalName: string;
  readonly pathKey: string;
  readonly parentKey: string | null;
  readonly childKeys: Set<string>;
  readonly recordKeys: Set<string>;
  readonly aliases: Set<string>;
  readonly searchTokens: Set<string>;
  readonly depth: number;
  readonly coordinateSamples: Coordinate[];
  sourceCount: number;
}

interface AddressSegments {
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly building: string;
  readonly door: string;
}

interface HierarchyFilter {
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
}

interface BuildResult {
  readonly nodes: Map<string, AddressHierarchyNode>;
  readonly pathToKey: Map<string, string>;
  readonly recordBindings: Map<string, AddressHierarchyRecordBinding>;
  readonly tokenIndex: Map<string, Set<string>>;
  readonly prefixIndex: Map<string, Set<string>>;
  readonly snapshot: AddressHierarchySnapshot;
}

const DEFAULT_BUILDING_ALIASES = Object.freeze([
  'building', 'Building', 'bina', 'BINA', 'apartman', 'APARTMAN',
  'site', 'SITE', 'blok', 'BLOK', 'buildingName', 'BUILDING_NAME',
] as const);

const LEVEL_ORDER: readonly AddressHierarchyLevel[] = Object.freeze([
  'district', 'neighborhood', 'street', 'building', 'door',
]);

const LEVEL_DEPTH: Readonly<Record<AddressHierarchyLevel, number>> = Object.freeze({
  district: 0,
  neighborhood: 1,
  street: 2,
  building: 3,
  door: 4,
});

const normalizeOptions = (options: AddressHierarchyBuildOptions = {}): NormalizedHierarchyOptions =>
  Object.freeze({
    maxRecords: normalizeInteger(options.maxRecords, { min: 1, max: 1_000_000, fallback: 100_000 }),
    maxNodes: normalizeInteger(options.maxNodes, { min: 1, max: 2_000_000, fallback: 250_000 }),
    maxChildrenPerNode: normalizeInteger(options.maxChildrenPerNode, { min: 1, max: 100_000, fallback: 20_000 }),
    maxAliasesPerNode: normalizeInteger(options.maxAliasesPerNode, { min: 1, max: 1_000, fallback: 64 }),
    maxDiagnostics: normalizeInteger(options.maxDiagnostics, { min: 0, max: 100_000, fallback: 2_000 }),
    coordinateDivergenceMeters: normalizeInteger(options.coordinateDivergenceMeters, {
      min: 0,
      max: 1_000_000,
      fallback: 150,
    }),
    buildingFieldAliases: Object.freeze(Array.from(new Set(
      (options.buildingFieldAliases ?? DEFAULT_BUILDING_ALIASES).map(normalizeText).filter(Boolean),
    ))),
  });

const recordKey = (record: NormalizedRecord): string =>
  record.id ? `id:${normalizeSearchText(record.id)}` : `fp:${record.fingerprint}`;

const readBuildingField = (record: NormalizedRecord, aliases: readonly string[]): string =>
  aliases.map(alias => normalizeText(record.fields[alias])).find(Boolean) ?? '';

const normalizeSegment = (level: AddressHierarchyLevel, value: unknown): string =>
  level === 'door' ? normalizeDoorToken(value) : normalizeText(value);

const canonicalSegment = (level: AddressHierarchyLevel, value: unknown): string => {
  const normalized = normalizeSegment(level, value);
  return level === 'door'
    ? normalizeSearchText(normalized).replace(/[^a-z0-9/-]+/g, '')
    : canonicalizeAddressText(normalized);
};

const segmentTokens = (level: AddressHierarchyLevel, value: string): readonly string[] => {
  if (level === 'door') {
    const token = canonicalSegment(level, value);
    return Object.freeze(token ? [token] : []);
  }
  return Object.freeze(canonicalizeAddressTokens(value));
};

const extractSegments = (
  record: NormalizedRecord,
  options: NormalizedHierarchyOptions,
): AddressSegments => Object.freeze({
  district: normalizeSegment('district', record.district),
  neighborhood: normalizeSegment('neighborhood', record.neighborhood),
  street: normalizeSegment('street', record.street),
  building: normalizeSegment('building', readBuildingField(record, options.buildingFieldAliases)),
  door: normalizeSegment('door', record.door),
});

const isEmpty = (segments: AddressSegments): boolean => LEVEL_ORDER.every(level => !segments[level]);
const pathPart = (level: AddressHierarchyLevel, canonicalName: string): string => `${level}:${canonicalName || '_'}`;
const appendPath = (parentPath: string, level: AddressHierarchyLevel, canonicalName: string): string =>
  parentPath ? `${parentPath}/${pathPart(level, canonicalName)}` : pathPart(level, canonicalName);
const createNodeKey = (pathKey: string): string => `addr:${hashFingerprint(pathKey)}`;

const centroid = (coordinates: readonly Coordinate[]): Coordinate | null => {
  if (coordinates.length === 0) return null;
  const totals = coordinates.reduce(
    (result, coordinate) => ({
      latitude: result.latitude + coordinate.latitude,
      longitude: result.longitude + coordinate.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return Object.freeze({
    latitude: totals.latitude / coordinates.length,
    longitude: totals.longitude / coordinates.length,
  });
};

const spreadMeters = (coordinates: readonly Coordinate[], center: Coordinate | null): number => {
  if (!center || coordinates.length <= 1) return 0;
  return Math.round(coordinates.reduce((maximum, coordinate) => {
    const distance = haversineDistanceMeters(center, coordinate);
    return distance === null ? maximum : Math.max(maximum, distance);
  }, 0));
};

const freezeNode = (node: MutableNode): AddressHierarchyNode => {
  const coordinates = centroid(node.coordinateSamples);
  const coordinateSpreadMeters = spreadMeters(node.coordinateSamples, coordinates);
  const childKeys = Object.freeze([...node.childKeys].sort((a, b) => a.localeCompare(b, 'en')));
  const recordKeys = Object.freeze([...node.recordKeys].sort((a, b) => a.localeCompare(b, 'en')));
  const aliases = Object.freeze([...node.aliases].sort((a, b) => a.localeCompare(b, 'tr-TR')));
  const searchTokens = Object.freeze([...node.searchTokens].sort((a, b) => a.localeCompare(b, 'en')));
  const fingerprint = hashFingerprint(stableSerialize({
    level: node.level,
    canonicalName: node.canonicalName,
    pathKey: node.pathKey,
    parentKey: node.parentKey,
    childKeys,
    recordKeys,
    coordinates,
    coordinateSpreadMeters,
  }));
  return Object.freeze({
    key: node.key,
    level: node.level,
    name: node.name,
    canonicalName: node.canonicalName,
    pathKey: node.pathKey,
    parentKey: node.parentKey,
    childKeys,
    recordKeys,
    aliases,
    searchTokens,
    depth: node.depth,
    coordinates,
    coordinateSampleCount: node.coordinateSamples.length,
    coordinateSpreadMeters,
    sourceCount: node.sourceCount,
    fingerprint,
  });
};

const normalizeFilter = (options: AddressHierarchyResolveOptions): HierarchyFilter => Object.freeze({
  district: canonicalizeAddressText(options.district),
  neighborhood: canonicalizeAddressText(options.neighborhood),
  street: canonicalizeAddressText(options.street),
});

const normalizeLevel = (value: unknown): AddressHierarchyLevel | null => {
  const normalized = normalizeSearchText(value);
  return LEVEL_ORDER.includes(normalized as AddressHierarchyLevel)
    ? normalized as AddressHierarchyLevel
    : null;
};

const normalizeRadius = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(500_000, parsed) : 0;
};

const normalizeLimit = (value: unknown): number => normalizeInteger(value, { min: 1, max: 1_000, fallback: 25 });

const textScore = (
  node: AddressHierarchyNode,
  canonicalQuery: string,
  queryTokens: readonly string[],
): Readonly<{ score: number; exact: boolean; prefix: boolean; reasons: readonly string[] }> => {
  const exact = node.canonicalName === canonicalQuery;
  const prefix = !exact && node.canonicalName.startsWith(canonicalQuery);
  const baseReason = exact
    ? 'exact-name'
    : prefix
      ? 'prefix-name'
      : canonicalQuery && node.canonicalName.includes(canonicalQuery)
        ? 'substring-name'
        : '';
  const baseScore = exact ? 700 : prefix ? 500 : baseReason ? 300 : 0;
  const nodeTokens = new Set(node.searchTokens);
  const exactTokens = queryTokens.filter(token => nodeTokens.has(token)).length;
  const prefixTokens = queryTokens.filter(token =>
    !nodeTokens.has(token)
    && token.length >= 2
    && node.searchTokens.some(candidate => candidate.startsWith(token))).length;
  const fullCoverage = queryTokens.length > 0 && exactTokens + prefixTokens === queryTokens.length;
  const aliasExact = node.aliases.some(alias => canonicalizeAddressText(alias) === canonicalQuery);
  if (baseScore === 0 && !fullCoverage && !aliasExact) {
    return Object.freeze({ score: 0, exact, prefix, reasons: Object.freeze([]) });
  }
  const reasons = Object.freeze([
    ...(baseReason ? [baseReason] : []),
    ...(exactTokens ? [`token:${exactTokens}`] : []),
    ...(prefixTokens ? [`token-prefix:${prefixTokens}`] : []),
    ...(fullCoverage ? ['full-token-coverage'] : []),
    ...(aliasExact ? ['exact-alias'] : []),
  ]);
  return Object.freeze({
    score: baseScore
      + exactTokens * 120
      + prefixTokens * 60
      + (fullCoverage ? 140 : 0)
      + (aliasExact ? 220 : 0),
    exact,
    prefix,
    reasons,
  });
};

const addPosting = (index: Map<string, Set<string>>, token: string, nodeKey: string): void => {
  const posting = index.get(token) ?? new Set<string>();
  posting.add(nodeKey);
  index.set(token, posting);
};

const tokenPrefixes = (token: string): readonly string[] =>
  Object.freeze(Array.from(
    { length: Math.max(0, token.length - 1) },
    (_value, index) => token.slice(0, index + 2),
  ));

const buildSearchIndexes = (
  nodes: readonly AddressHierarchyNode[],
): Readonly<{ tokenIndex: Map<string, Set<string>>; prefixIndex: Map<string, Set<string>> }> => {
  const tokenIndex = new Map<string, Set<string>>();
  const prefixIndex = new Map<string, Set<string>>();
  nodes.map(node => node.searchTokens.map(token => {
    addPosting(tokenIndex, token, node.key);
    tokenPrefixes(token).map(prefix => addPosting(prefixIndex, prefix, node.key));
    return token;
  }));
  return Object.freeze({ tokenIndex, prefixIndex });
};

const buildHierarchy = (
  records: readonly NormalizedRecord[],
  options: NormalizedHierarchyOptions,
): BuildResult => {
  const mutableNodes = new Map<string, MutableNode>();
  const pathToKey = new Map<string, string>();
  const bindings = new Map<string, AddressHierarchyRecordBinding>();
  const diagnostics: AddressHierarchyDiagnostic[] = [];
  let diagnosticsTruncated = false;
  let acceptedRecordCount = 0;

  const addDiagnostic = (diagnostic: AddressHierarchyDiagnostic): void => {
    if (diagnostics.length >= options.maxDiagnostics) {
      diagnosticsTruncated = true;
      return;
    }
    diagnostics.push(Object.freeze(diagnostic));
  };

  const ensureNode = (
    level: AddressHierarchyLevel,
    displayName: string,
    parent: MutableNode | null,
    sourceRecordKey: string,
    coordinate: Coordinate | null,
  ): MutableNode | null => {
    const canonicalName = canonicalSegment(level, displayName);
    if (!canonicalName) return null;
    const pathKey = appendPath(parent?.pathKey ?? '', level, canonicalName);
    const existingKey = pathToKey.get(pathKey);
    let node = existingKey ? mutableNodes.get(existingKey) ?? null : null;
    if (!node) {
      if (mutableNodes.size >= options.maxNodes) {
        addDiagnostic({
          code: 'node-budget-exceeded',
          severity: 'error',
          recordKey: sourceRecordKey,
          nodeKey: null,
          detail: `Address hierarchy node budget ${options.maxNodes} exceeded.`,
        });
        return null;
      }
      const key = createNodeKey(pathKey);
      node = {
        key,
        level,
        name: displayName,
        canonicalName,
        pathKey,
        parentKey: parent?.key ?? null,
        childKeys: new Set<string>(),
        recordKeys: new Set<string>(),
        aliases: new Set<string>(),
        searchTokens: new Set<string>(segmentTokens(level, displayName)),
        depth: LEVEL_DEPTH[level],
        coordinateSamples: [],
        sourceCount: 0,
      };
      mutableNodes.set(key, node);
      pathToKey.set(pathKey, key);
      if (parent && !parent.childKeys.has(key)) {
        if (parent.childKeys.size < options.maxChildrenPerNode) {
          parent.childKeys.add(key);
        } else {
          addDiagnostic({
            code: 'child-budget-exceeded',
            severity: 'error',
            recordKey: sourceRecordKey,
            nodeKey: parent.key,
            detail: `Address hierarchy child budget ${options.maxChildrenPerNode} exceeded.`,
          });
        }
      }
    }
    node.sourceCount += 1;
    node.recordKeys.add(sourceRecordKey);
    if (!node.aliases.has(displayName)) {
      if (node.aliases.size < options.maxAliasesPerNode) {
        node.aliases.add(displayName);
      } else {
        addDiagnostic({
          code: 'alias-budget-exceeded',
          severity: 'warning',
          recordKey: sourceRecordKey,
          nodeKey: node.key,
          detail: `Address hierarchy alias budget ${options.maxAliasesPerNode} exceeded.`,
        });
      }
    }
    segmentTokens(level, displayName).map(token => node?.searchTokens.add(token));
    if (coordinate) node.coordinateSamples.push(coordinate);
    return node;
  };

  const limited = records.slice(0, options.maxRecords);
  if (records.length > limited.length) {
    addDiagnostic({
      code: 'record-budget-exceeded',
      severity: 'error',
      recordKey: null,
      nodeKey: null,
      detail: `Address hierarchy record budget ${options.maxRecords} exceeded.`,
    });
  }

  limited.map(record => {
    const key = recordKey(record);
    const segments = extractSegments(record, options);
    if (isEmpty(segments)) {
      addDiagnostic({
        code: 'empty-record',
        severity: 'info',
        recordKey: key,
        nodeKey: null,
        detail: 'Record contains no verified address hierarchy segment.',
      });
      return null;
    }
    acceptedRecordCount += 1;
    const coordinate = normalizeCoordinates(record.coordinates);
    const state = LEVEL_ORDER.reduce<{
      parent: MutableNode | null;
      seenGap: boolean;
      keys: Partial<Record<AddressHierarchyLevel, string>>;
      pathKeys: string[];
    }>((current, level) => {
      const value = segments[level];
      if (!value) return { ...current, seenGap: true };
      if (current.seenGap) {
        addDiagnostic({
          code: 'missing-parent-level',
          severity: 'warning',
          recordKey: key,
          nodeKey: current.parent?.key ?? null,
          detail: `Address hierarchy has a gap before ${level}.`,
        });
      }
      const node = ensureNode(level, value, current.parent, key, coordinate);
      if (!node) return { ...current, seenGap: true };
      return {
        parent: node,
        seenGap: false,
        keys: { ...current.keys, [level]: node.key },
        pathKeys: [...current.pathKeys, node.key],
      };
    }, { parent: null, seenGap: false, keys: {}, pathKeys: [] });
    const binding: AddressHierarchyRecordBinding = Object.freeze({
      recordKey: key,
      districtKey: state.keys.district ?? null,
      neighborhoodKey: state.keys.neighborhood ?? null,
      streetKey: state.keys.street ?? null,
      buildingKey: state.keys.building ?? null,
      doorKey: state.keys.door ?? null,
      deepestKey: state.pathKeys.at(-1) ?? null,
      pathKeys: Object.freeze(state.pathKeys),
      fingerprint: hashFingerprint(stableSerialize({ key, pathKeys: state.pathKeys })),
    });
    bindings.set(key, binding);
    return binding;
  });

  const frozenNodes = [...mutableNodes.values()].map(freezeNode);
  frozenNodes
    .filter(node => node.coordinateSpreadMeters > options.coordinateDivergenceMeters)
    .map(node => addDiagnostic({
      code: 'coordinate-divergence',
      severity: 'warning',
      recordKey: null,
      nodeKey: node.key,
      detail: `Address hierarchy coordinate spread ${node.coordinateSpreadMeters}m exceeds policy.`,
    }));
  const nodeMap = new Map(frozenNodes.map(node => [node.key, node] as const));
  const indexes = buildSearchIndexes(frozenNodes);
  const counts = (level: AddressHierarchyLevel): number =>
    frozenNodes.filter(node => node.level === level).length;
  const fingerprint = hashFingerprint(stableSerialize({
    version: ADDRESS_HIERARCHY_VERSION,
    records: [...bindings.values()]
      .map(binding => ({ recordKey: binding.recordKey, pathKeys: binding.pathKeys }))
      .sort((left, right) => left.recordKey.localeCompare(right.recordKey, 'en')),
    nodes: frozenNodes
      .map(node => ({
        key: node.key,
        level: node.level,
        canonicalName: node.canonicalName,
        parentKey: node.parentKey,
        coordinates: node.coordinates,
      }))
      .sort((left, right) => left.key.localeCompare(right.key, 'en')),
  }));
  return Object.freeze({
    nodes: nodeMap,
    pathToKey,
    recordBindings: bindings,
    tokenIndex: indexes.tokenIndex,
    prefixIndex: indexes.prefixIndex,
    snapshot: Object.freeze({
      version: ADDRESS_HIERARCHY_VERSION,
      recordCount: acceptedRecordCount,
      nodeCount: frozenNodes.length,
      rootCount: frozenNodes.filter(node => node.parentKey === null).length,
      districtCount: counts('district'),
      neighborhoodCount: counts('neighborhood'),
      streetCount: counts('street'),
      buildingCount: counts('building'),
      doorCount: counts('door'),
      diagnostics: Object.freeze(diagnostics),
      diagnosticsTruncated,
      fingerprint,
    }),
  });
};

const emptySnapshot = (): AddressHierarchySnapshot => Object.freeze({
  version: ADDRESS_HIERARCHY_VERSION,
  recordCount: 0,
  nodeCount: 0,
  rootCount: 0,
  districtCount: 0,
  neighborhoodCount: 0,
  streetCount: 0,
  buildingCount: 0,
  doorCount: 0,
  diagnostics: Object.freeze([]),
  diagnosticsTruncated: false,
  fingerprint: hashFingerprint('empty-address-hierarchy'),
});

export class AddressHierarchyRuntime {
  private readonly options: NormalizedHierarchyOptions;
  private nodes = new Map<string, AddressHierarchyNode>();
  private pathToKey = new Map<string, string>();
  private recordBindings = new Map<string, AddressHierarchyRecordBinding>();
  private tokenIndex = new Map<string, Set<string>>();
  private prefixIndex = new Map<string, Set<string>>();
  private snapshotValue: AddressHierarchySnapshot = emptySnapshot();

  constructor(records: readonly NormalizedRecord[] = [], options: AddressHierarchyBuildOptions = {}) {
    this.options = normalizeOptions(options);
    this.rebuild(records);
  }

  rebuild(records: readonly NormalizedRecord[]): AddressHierarchySnapshot {
    try {
      const built = buildHierarchy(records, this.options);
      this.nodes = built.nodes;
      this.pathToKey = built.pathToKey;
      this.recordBindings = built.recordBindings;
      this.tokenIndex = built.tokenIndex;
      this.prefixIndex = built.prefixIndex;
      this.snapshotValue = built.snapshot;
      return built.snapshot;
    } catch (error) {
      throw error instanceof Error ? error : new Error('Address hierarchy rebuild failed');
    }
  }

  private bindingKey(value: string | NormalizedRecord): string {
    return typeof value === 'string' ? normalizeText(value) : recordKey(value);
  }

  private candidateKeys(
    queryTokens: readonly string[],
    level: AddressHierarchyLevel | null,
  ): readonly string[] {
    const keys = new Set(queryTokens.flatMap(token => [
      ...this.tokenIndex.get(token) ?? [],
      ...this.prefixIndex.get(token) ?? [],
    ]));
    const candidates = keys.size > 0
      ? [...keys]
        .map(key => this.nodes.get(key))
        .filter((node): node is AddressHierarchyNode => node !== undefined)
      : [...this.nodes.values()];
    return Object.freeze(
      candidates.filter(node => !level || node.level === level).map(node => node.key),
    );
  }

  private collectPath(
    node: AddressHierarchyNode | null,
    seen: ReadonlySet<string>,
  ): readonly AddressHierarchyNode[] {
    if (!node || seen.has(node.key)) return Object.freeze([]);
    const nextSeen = new Set(seen);
    nextSeen.add(node.key);
    const parent = node.parentKey ? this.nodes.get(node.parentKey) ?? null : null;
    return Object.freeze([...this.collectPath(parent, nextSeen), node]);
  }

  resolve(
    query: unknown,
    options: AddressHierarchyResolveOptions = {},
  ): readonly AddressHierarchyMatch[] {
    const queryText = normalizeText(query);
    const canonicalQuery = canonicalizeAddressText(queryText);
    if (!canonicalQuery) return Object.freeze([]);
    const queryTokens = canonicalizeAddressTokens(queryText);
    const level = normalizeLevel(options.level);
    const filter = normalizeFilter(options);
    const center = options.center ? normalizeCoordinates(options.center) : null;
    const radiusMeters = normalizeRadius(options.radiusMeters);
    const minimumScore = Number.isFinite(Number(options.minimumScore))
      ? Number(options.minimumScore)
      : 1;
    const limit = normalizeLimit(options.limit);
    const requireHierarchyMatch = options.requireHierarchyMatch !== false;
    const checks = Object.freeze([
      ['district', 'district'],
      ['neighborhood', 'neighborhood'],
      ['street', 'street'],
    ] as const);
    const matches = this.candidateKeys(queryTokens, level)
      .map(key => this.nodes.get(key))
      .filter((node): node is AddressHierarchyNode => node !== undefined)
      .map(node => {
        const text = textScore(node, canonicalQuery, queryTokens);
        if (text.score <= 0) return null;
        const path = this.getPath(node.key);
        const hierarchy = checks.reduce((result, [field, filterLevel]) => {
          const expected = filter[field];
          if (!expected) return result;
          const actual = path.find(item => item.level === filterLevel)?.canonicalName ?? '';
          const matched = actual === expected;
          return {
            score: result.score + (matched ? 120 : -300),
            mismatch: result.mismatch || !matched,
            reasons: [...result.reasons, `hierarchy-${matched ? 'match' : 'mismatch'}:${field}`],
          };
        }, { score: 0, mismatch: false, reasons: [] as string[] });
        if (hierarchy.mismatch && requireHierarchyMatch) return null;
        const distanceMeters = center && node.coordinates
          ? haversineDistanceMeters(center, node.coordinates)
          : null;
        if (distanceMeters !== null && radiusMeters > 0 && distanceMeters > radiusMeters) {
          return null;
        }
        const reference = radiusMeters > 0 ? radiusMeters : 25_000;
        const distanceScore = distanceMeters === null
          ? 0
          : Math.round(Math.max(0, 1 - distanceMeters / Math.max(1, reference)) * 180);
        const score = text.score + hierarchy.score + distanceScore;
        if (score < minimumScore) return null;
        return Object.freeze({
          node,
          score,
          textScore: text.score,
          hierarchyScore: hierarchy.score,
          distanceScore,
          distanceMeters,
          exact: text.exact,
          prefix: text.prefix,
          reasons: Object.freeze([
            ...text.reasons,
            ...hierarchy.reasons,
            ...(distanceMeters !== null ? ['distance-bias'] : []),
          ]),
        });
      })
      .filter((match): match is AddressHierarchyMatch => match !== null)
      .sort((left, right) => right.score - left.score
        || right.hierarchyScore - left.hierarchyScore
        || (left.distanceMeters ?? Number.POSITIVE_INFINITY)
          - (right.distanceMeters ?? Number.POSITIVE_INFINITY)
        || left.node.canonicalName.localeCompare(
          right.node.canonicalName,
          'tr-TR',
          { sensitivity: 'base', numeric: true },
        )
        || left.node.key.localeCompare(right.node.key, 'en'));
    return Object.freeze(matches.slice(0, limit));
  }

  suggest(
    query: unknown,
    options: AddressHierarchyResolveOptions = {},
  ): readonly AddressHierarchyMatch[] {
    return this.resolve(query, options);
  }

  getNode(key: string): AddressHierarchyNode | null {
    return this.nodes.get(normalizeText(key)) ?? null;
  }

  getBinding(value: string | NormalizedRecord): AddressHierarchyRecordBinding | null {
    return this.recordBindings.get(this.bindingKey(value)) ?? null;
  }

  getPath(key: string): readonly AddressHierarchyNode[] {
    return this.collectPath(this.getNode(key), new Set<string>());
  }

  getChildren(key: string): readonly AddressHierarchyNode[] {
    const node = this.getNode(key);
    if (!node) return Object.freeze([]);
    return Object.freeze(node.childKeys
      .map(childKey => this.nodes.get(childKey))
      .filter((child): child is AddressHierarchyNode => child !== undefined)
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'tr-TR')));
  }

  findByPath(
    pathInput: Readonly<Partial<Record<AddressHierarchyLevel, string>>>,
  ): AddressHierarchyNode | null {
    const result = LEVEL_ORDER.reduce<{
      path: string;
      node: AddressHierarchyNode | null;
      failed: boolean;
    }>((current, level) => {
      if (current.failed) return current;
      const value = pathInput[level];
      if (!value) return current;
      const canonical = canonicalSegment(level, value);
      if (!canonical) return current;
      const path = appendPath(current.path, level, canonical);
      const key = this.pathToKey.get(path);
      const node = key ? this.nodes.get(key) ?? null : null;
      return { path, node, failed: node === null };
    }, { path: '', node: null, failed: false });
    return result.failed ? null : result.node;
  }

  snapshot(): AddressHierarchySnapshot {
    return this.snapshotValue;
  }

  toSerializableSnapshot(): AddressHierarchySnapshot {
    return this.snapshotValue;
  }
}

export const createAddressHierarchyRuntime = (
  records: readonly NormalizedRecord[] = [],
  options: AddressHierarchyBuildOptions = {},
): AddressHierarchyRuntime => new AddressHierarchyRuntime(records, options);
