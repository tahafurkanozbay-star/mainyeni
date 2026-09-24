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

export const ADDRESS_HIERARCHY_VERSION = '2026-09-24.v1';

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

const DEFAULT_BUILDING_ALIASES = Object.freeze([
  'building',
  'Building',
  'bina',
  'BINA',
  'apartman',
  'APARTMAN',
  'site',
  'SITE',
  'blok',
  'BLOK',
  'buildingName',
  'BUILDING_NAME',
] as const);

const LEVEL_ORDER: readonly AddressHierarchyLevel[] = Object.freeze([
  'district',
  'neighborhood',
  'street',
  'building',
  'door',
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

const readBuildingField = (record: NormalizedRecord, aliases: readonly string[]): string => {
  for (const alias of aliases) {
    const text = normalizeText(record.fields[alias]);
    if (text) return text;
  }
  return '';
};

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

const isEmpty = (segments: AddressSegments): boolean =>
  LEVEL_ORDER.every(level => !segments[level]);

const pathPart = (level: AddressHierarchyLevel, canonicalName: string): string =>
  `${level}:${canonicalName || '_'}`;

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
  let maximum = 0;
  for (const coordinate of coordinates) {
    const distance = haversineDistanceMeters(center, coordinate);
    if (distance !== null) maximum = Math.max(maximum, distance);
  }
  return Math.round(maximum);
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

const normalizeLimit = (value: unknown): number =>
  normalizeInteger(value, { min: 1, max: 1_000, fallback: 25 });

const textScore = (
  node: AddressHierarchyNode,
  canonicalQuery: string,
  queryTokens: readonly string[],
): Readonly<{ score: number; exact: boolean; prefix: boolean; reasons: readonly string[] }> => {
  const reasons: string[] = [];
  let score = 0;
  const exact = node.canonicalName === canonicalQuery;
  const prefix = !exact && node.canonicalName.startsWith(canonicalQuery);
  if (exact) {
    score += 700;
    reasons.push('exact-name');
  } else if (prefix) {
    score += 500;
    reasons.push('prefix-name');
  } else if (canonicalQuery && node.canonicalName.includes(canonicalQuery)) {
    score += 300;
    reasons.push('substring-name');
  }
  const nodeTokens = new Set(node.searchTokens);
  let exactTokens = 0;
  let prefixTokens = 0;
  for (const token of queryTokens) {
    if (nodeTokens.has(token)) {
      exactTokens += 1;
    } else if (token.length >= 2 && [...nodeTokens].some(candidate => candidate.startsWith(token))) {
      prefixTokens += 1;
    }
  }
  if (exactTokens) {
    score += exactTokens * 120;
    reasons.push(`token:${exactTokens}`);
  }
  if (prefixTokens) {
    score += prefixTokens * 60;
    reasons.push(`token-prefix:${prefixTokens}`);
  }
  if (queryTokens.length > 0 && exactTokens + prefixTokens === queryTokens.length) {
    score += 140;
    reasons.push('full-token-coverage');
  }
  if (node.aliases.some(alias => canonicalizeAddressText(alias) === canonicalQuery)) {
    score += 220;
    reasons.push('exact-alias');
  }
  return Object.freeze({ score, exact, prefix, reasons: Object.freeze(reasons) });
};

export class AddressHierarchyRuntime {
  private readonly options: NormalizedHierarchyOptions;
  private nodes = new Map<string, AddressHierarchyNode>();
  private pathToKey = new Map<string, string>();
  private recordBindings = new Map<string, AddressHierarchyRecordBinding>();
  private tokenIndex = new Map<string, Set<string>>();
  private diagnostics: AddressHierarchyDiagnostic[] = [];
  private diagnosticsTruncated = false;
  private acceptedRecordCount = 0;
  private snapshotValue: AddressHierarchySnapshot;

  constructor(records: readonly NormalizedRecord[] = [], options: AddressHierarchyBuildOptions = {}) {
    this.options = normalizeOptions(options);
    this.snapshotValue = Object.freeze({
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
    this.rebuild(records);
  }

  private addDiagnostic(diagnostic: AddressHierarchyDiagnostic): void {
    if (this.diagnostics.length >= this.options.maxDiagnostics) {
      this.diagnosticsTruncated = true;
      return;
    }
    this.diagnostics.push(Object.freeze(diagnostic));
  }

  private bindingKey(value: string | NormalizedRecord): string {
    return typeof value === 'string' ? normalizeText(value) : recordKey(value);
  }

  rebuild(records: readonly NormalizedRecord[]): AddressHierarchySnapshot {
    const mutableNodes = new Map<string, MutableNode>();
    const nextPathToKey = new Map<string, string>();
    const nextBindings = new Map<string, AddressHierarchyRecordBinding>();
    const nextDiagnostics: AddressHierarchyDiagnostic[] = [];
    this.diagnostics = nextDiagnostics;
    this.diagnosticsTruncated = false;
    this.acceptedRecordCount = 0;

    const limitedRecords = records.slice(0, this.options.maxRecords);
    if (records.length > limitedRecords.length) {
      this.addDiagnostic({
        code: 'record-budget-exceeded',
        severity: 'error',
        recordKey: null,
        nodeKey: null,
        detail: `Address hierarchy record budget ${this.options.maxRecords} exceeded.`,
      });
    }

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
      const existingKey = nextPathToKey.get(pathKey);
      let node = existingKey ? mutableNodes.get(existingKey) ?? null : null;
      if (!node) {
        if (mutableNodes.size >= this.options.maxNodes) {
          this.addDiagnostic({
            code: 'node-budget-exceeded',
            severity: 'error',
            recordKey: sourceRecordKey,
            nodeKey: null,
            detail: `Address hierarchy node budget ${this.options.maxNodes} exceeded.`,
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
          searchTokens: new Set(segmentTokens(level, displayName)),
          depth: LEVEL_DEPTH[level],
          coordinateSamples: [],
          sourceCount: 0,
        };
        mutableNodes.set(key, node);
        nextPathToKey.set(pathKey, key);
        if (parent && !parent.childKeys.has(key)) {
          if (parent.childKeys.size < this.options.maxChildrenPerNode) {
            parent.childKeys.add(key);
          } else {
            this.addDiagnostic({
              code: 'child-budget-exceeded',
              severity: 'error',
              recordKey: sourceRecordKey,
              nodeKey: parent.key,
              detail: `Address hierarchy child budget ${this.options.maxChildrenPerNode} exceeded.`,
            });
          }
        }
      }
      node.sourceCount += 1;
      node.recordKeys.add(sourceRecordKey);
      if (!node.aliases.has(displayName)) {
        if (node.aliases.size < this.options.maxAliasesPerNode) node.aliases.add(displayName);
        else this.addDiagnostic({
          code: 'alias-budget-exceeded',
          severity: 'warning',
          recordKey: sourceRecordKey,
          nodeKey: node.key,
          detail: `Address hierarchy alias budget ${this.options.maxAliasesPerNode} exceeded.`,
        });
      }
      for (const token of segmentTokens(level, displayName)) node.searchTokens.add(token);
      if (coordinate) node.coordinateSamples.push(coordinate);
      return node;
    };

    for (const record of limitedRecords) {
      const key = recordKey(record);
      const segments = extractSegments(record, this.options);
      if (isEmpty(segments)) {
        this.addDiagnostic({
          code: 'empty-record',
          severity: 'info',
          recordKey: key,
          nodeKey: null,
          detail: 'Record contains no verified address hierarchy segment.',
        });
        continue;
      }
      this.acceptedRecordCount += 1;
      const coordinate = normalizeCoordinates(record.coordinates);
      let parent: MutableNode | null = null;
      let seenGap = false;
      const keys: Partial<Record<AddressHierarchyLevel, string>> = {};
      const pathKeys: string[] = [];
      for (const level of LEVEL_ORDER) {
        const value = segments[level];
        if (!value) {
          if (parent) seenGap = true;
          continue;
        }
        if (seenGap) {
          this.addDiagnostic({
            code: 'missing-parent-level',
            severity: 'warning',
            recordKey: key,
            nodeKey: parent?.key ?? null,
            detail: `Address hierarchy has a gap before ${level}.`,
          });
          seenGap = false;
        }
        const node = ensureNode(level, value, parent, key, coordinate);
        if (!node) continue;
        keys[level] = node.key;
        pathKeys.push(node.key);
        parent = node;
      }
      const deepestKey = pathKeys.at(-1) ?? null;
      const binding: AddressHierarchyRecordBinding = Object.freeze({
        recordKey: key,
        districtKey: keys.district ?? null,
        neighborhoodKey: keys.neighborhood ?? null,
        streetKey: keys.street ?? null,
        buildingKey: keys.building ?? null,
        doorKey: keys.door ?? null,
        deepestKey,
        pathKeys: Object.freeze(pathKeys),
        fingerprint: hashFingerprint(stableSerialize({ key, pathKeys })),
      });
      nextBindings.set(key, binding);
    }

    const frozenNodes = new Map<string, AddressHierarchyNode>();
    for (const mutable of mutableNodes.values()) {
      const node = freezeNode(mutable);
      frozenNodes.set(node.key, node);
      if (node.coordinateSpreadMeters > this.options.coordinateDivergenceMeters) {
        this.addDiagnostic({
          code: 'coordinate-divergence',
          severity: 'warning',
          recordKey: null,
          nodeKey: node.key,
          detail: `Address hierarchy coordinate spread ${node.coordinateSpreadMeters}m exceeds policy.`,
        });
      }
    }

    const nextTokenIndex = new Map<string, Set<string>>();
    for (const node of frozenNodes.values()) {
      for (const token of node.searchTokens) {
        const posting = nextTokenIndex.get(token) ?? new Set<string>();
        posting.add(node.key);
        nextTokenIndex.set(token, posting);
      }
    }

    this.nodes = frozenNodes;
    this.pathToKey = nextPathToKey;
    this.recordBindings = nextBindings;
    this.tokenIndex = nextTokenIndex;
    const nodes = [...frozenNodes.values()];
    const counts = (level: AddressHierarchyLevel): number => nodes.filter(node => node.level === level).length;
    const fingerprint = hashFingerprint(stableSerialize({
      version: ADDRESS_HIERARCHY_VERSION,
      records: [...nextBindings.values()].map(binding => ({
        recordKey: binding.recordKey,
        pathKeys: binding.pathKeys,
      })).sort((left, right) => left.recordKey.localeCompare(right.recordKey, 'en')),
      nodes: nodes.map(node => ({
        key: node.key,
        level: node.level,
        canonicalName: node.canonicalName,
        parentKey: node.parentKey,
        coordinates: node.coordinates,
      })).sort((left, right) => left.key.localeCompare(right.key, 'en')),
    }));
    this.snapshotValue = Object.freeze({
      version: ADDRESS_HIERARCHY_VERSION,
      recordCount: this.acceptedRecordCount,
      nodeCount: nodes.length,
      rootCount: nodes.filter(node => node.parentKey === null).length,
      districtCount: counts('district'),
      neighborhoodCount: counts('neighborhood'),
      streetCount: counts('street'),
      buildingCount: counts('building'),
      doorCount: counts('door'),
      diagnostics: Object.freeze([...this.diagnostics]),
      diagnosticsTruncated: this.diagnosticsTruncated,
      fingerprint,
    });
    return this.snapshotValue;
  }

  private candidateKeys(queryTokens: readonly string[], level: AddressHierarchyLevel | null): readonly string[] {
    const keys = new Set<string>();
    for (const queryToken of queryTokens) {
      for (const [token, postings] of this.tokenIndex) {
        if (token === queryToken || (queryToken.length >= 2 && token.startsWith(queryToken))) {
          for (const key of postings) {
            const node = this.nodes.get(key);
            if (!level || node?.level === level) keys.add(key);
          }
        }
      }
    }
    if (keys.size > 0) return Object.freeze([...keys]);
    return Object.freeze([...this.nodes.values()]
      .filter(node => !level || node.level === level)
      .map(node => node.key));
  }

  resolve(query: unknown, options: AddressHierarchyResolveOptions = {}): readonly AddressHierarchyMatch[] {
    const queryText = normalizeText(query);
    const canonicalQuery = canonicalizeAddressText(queryText);
    if (!canonicalQuery) return Object.freeze([]);
    const queryTokens = canonicalizeAddressTokens(queryText);
    const level = normalizeLevel(options.level);
    const filter = normalizeFilter(options);
    const center = options.center ? normalizeCoordinates(options.center) : null;
    const radiusMeters = normalizeRadius(options.radiusMeters);
    const minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 1;
    const limit = normalizeLimit(options.limit);
    const requireHierarchyMatch = options.requireHierarchyMatch !== false;
    const matches: AddressHierarchyMatch[] = [];

    for (const key of this.candidateKeys(queryTokens, level)) {
      const node = this.nodes.get(key);
      if (!node) continue;
      const text = textScore(node, canonicalQuery, queryTokens);
      if (text.score <= 0) continue;
      const path = this.getPath(node.key);
      const reasons = [...text.reasons];
      let hierarchyScore = 0;
      let hierarchyMismatch = false;
      const checks: readonly [keyof HierarchyFilter, AddressHierarchyLevel][] = [
        ['district', 'district'],
        ['neighborhood', 'neighborhood'],
        ['street', 'street'],
      ];
      for (const [field, filterLevel] of checks) {
        const expected = filter[field];
        if (!expected) continue;
        const actualNode = path.find(item => item.level === filterLevel);
        const actual = actualNode?.canonicalName ?? '';
        if (actual === expected) {
          hierarchyScore += 120;
          reasons.push(`hierarchy-match:${field}`);
        } else {
          hierarchyMismatch = true;
          hierarchyScore -= 300;
          reasons.push(`hierarchy-mismatch:${field}`);
        }
      }
      if (hierarchyMismatch && requireHierarchyMatch) continue;

      let distanceScore = 0;
      let distanceMeters: number | null = null;
      if (center && node.coordinates) {
        distanceMeters = haversineDistanceMeters(center, node.coordinates);
        if (distanceMeters !== null) {
          if (radiusMeters > 0 && distanceMeters > radiusMeters) continue;
          const reference = radiusMeters > 0 ? radiusMeters : 25_000;
          distanceScore = Math.round(Math.max(0, 1 - distanceMeters / Math.max(1, reference)) * 180);
          reasons.push('distance-bias');
        }
      }
      const score = text.score + hierarchyScore + distanceScore;
      if (score < minimumScore) continue;
      matches.push(Object.freeze({
        node,
        score,
        textScore: text.score,
        hierarchyScore,
        distanceScore,
        distanceMeters,
        exact: text.exact,
        prefix: text.prefix,
        reasons: Object.freeze(reasons),
      }));
    }

    matches.sort((left, right) =>
      right.score - left.score
      || right.hierarchyScore - left.hierarchyScore
      || (left.distanceMeters ?? Number.POSITIVE_INFINITY) - (right.distanceMeters ?? Number.POSITIVE_INFINITY)
      || left.node.canonicalName.localeCompare(right.node.canonicalName, 'tr-TR', { sensitivity: 'base', numeric: true })
      || left.node.key.localeCompare(right.node.key, 'en'));
    return Object.freeze(matches.slice(0, limit));
  }

  suggest(query: unknown, options: AddressHierarchyResolveOptions = {}): readonly AddressHierarchyMatch[] {
    return this.resolve(query, options);
  }

  getNode(key: string): AddressHierarchyNode | null {
    return this.nodes.get(normalizeText(key)) ?? null;
  }

  getBinding(value: string | NormalizedRecord): AddressHierarchyRecordBinding | null {
    return this.recordBindings.get(this.bindingKey(value)) ?? null;
  }

  getPath(key: string): readonly AddressHierarchyNode[] {
    const start = this.getNode(key);
    if (!start) return Object.freeze([]);
    const path: AddressHierarchyNode[] = [];
    const seen = new Set<string>();
    let current: AddressHierarchyNode | null = start;
    while (current && !seen.has(current.key)) {
      seen.add(current.key);
      path.push(current);
      current = current.parentKey ? this.nodes.get(current.parentKey) ?? null : null;
    }
    return Object.freeze(path.reverse());
  }

  getChildren(key: string): readonly AddressHierarchyNode[] {
    const node = this.getNode(key);
    if (!node) return Object.freeze([]);
    return Object.freeze(node.childKeys
      .map(childKey => this.nodes.get(childKey))
      .filter((child): child is AddressHierarchyNode => child !== undefined)
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'tr-TR')));
  }

  findByPath(pathInput: Readonly<Partial<Record<AddressHierarchyLevel, string>>>): AddressHierarchyNode | null {
    let path = '';
    let last: AddressHierarchyNode | null = null;
    for (const level of LEVEL_ORDER) {
      const value = pathInput[level];
      if (!value) continue;
      const canonical = canonicalSegment(level, value);
      if (!canonical) continue;
      path = appendPath(path, level, canonical);
      const key = this.pathToKey.get(path);
      if (!key) return null;
      last = this.nodes.get(key) ?? null;
      if (!last) return null;
    }
    return last;
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
