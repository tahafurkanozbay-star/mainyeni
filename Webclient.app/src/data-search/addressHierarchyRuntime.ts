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
  key: string;
  level: AddressHierarchyLevel;
  name: string;
  canonicalName: string;
  pathKey: string;
  parentKey: string | null;
  childKeys: Set<string>;
  recordKeys: Set<string>;
  aliases: Set<string>;
  searchTokens: Set<string>;
  depth: number;
  coordinateSamples: Coordinate[];
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
    buildingFieldAliases: Object.freeze(
      Array.from(new Set((options.buildingFieldAliases ?? DEFAULT_BUILDING_ALIASES)
        .map(normalizeText)
        .filter(Boolean))),
    ),
  });

const recordKey = (record: NormalizedRecord): string =>
  record.id ? `id:${normalizeSearchText(record.id)}` : `fp:${record.fingerprint}`;

const readBuildingField = (
  record: NormalizedRecord,
  aliases: readonly string[],
): string => {
  for (const alias of aliases) {
    const value = record.fields[alias];
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
};

const normalizeSegment = (level: AddressHierarchyLevel, value: unknown): string => {
  if (level === 'door') return normalizeDoorToken(value);
  return normalizeText(value);
};

const canonicalSegment = (level: AddressHierarchyLevel, value: unknown): string => {
  const normalized = normalizeSegment(level, value);
  return level === 'door'
    ? normalizeSearchText(normalized).replace(/[^a-z0-9/-]+/g, '')
    : canonicalizeAddressText(normalized);
};

const segmentTokens = (level: AddressHierarchyLevel, value: string): readonly string[] => {
  if (level === 'door') {
    const token = canonicalSegment(level, value);
    return token ? Object.freeze([token]) : Object.freeze([]);
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

const segmentsEmpty = (segments: AddressSegments): boolean =>
  !segments.district && !segments.neighborhood && !segments.street && !segments.building && !segments.door;

const nodePathPart = (level: AddressHierarchyLevel, canonicalName: string): string =>
  `${level}:${canonicalName || '_'}`;

const buildPathKey = (
  parentPath: string,
  level: AddressHierarchyLevel,
  canonicalName: string,
): string => parentPath
  ? `${parentPath}/${nodePathPart(level, canonicalName)}`
  : nodePathPart(level, canonicalName);

const createNodeKey = (pathKey: string): string => `addr:${hashFingerprint(pathKey)}`;

const addBoundedDiagnostic = (
  diagnostics: AddressHierarchyDiagnostic[],
  options: NormalizedHierarchyOptions,
  diagnostic: AddressHierarchyDiagnostic,
): boolean => {
  if (diagnostics.length >= options.maxDiagnostics) return false;
  diagnostics.push(Object.freeze(diagnostic));
  return true;
};

const centroid = (coordinates: readonly Coordinate[]): Coordinate | null => {
  if (coordinates.length === 0) return null;
  let latitude = 0;
  let longitude = 0;
  for (const coordinate of coordinates) {
    latitude += coordinate.latitude;
    longitude += coordinate.longitude;
  }
  return Object.freeze({
    latitude: latitude / coordinates.length,
    longitude: longitude / coordinates.length,
  });
};

const coordinateSpread = (coordinates: readonly Coordinate[], center: Coordinate | null): number => {
  if (!center || coordinates.length <= 1) return 0;
  let maxDistance = 0;
  for (const coordinate of coordinates) {
    const distance = haversineDistanceMeters(center, coordinate);
    if (distance !== null) maxDistance = Math.max(maxDistance, distance);
  }
  return Math.round(maxDistance);
};

const freezeNode = (node: MutableNode): AddressHierarchyNode => {
  const coordinates = centroid(node.coordinateSamples);
  const coordinateSpreadMeters = coordinateSpread(node.coordinateSamples, coordinates);
  const childKeys = Object.freeze([...node.childKeys].sort((a, b) => a.localeCompare(b, 'en')));
  const recordKeys = Object.freeze([...node.recordKeys].sort((a, b) => a.localeCompare(b, 'en')));
  const aliases = Object.freeze([...node.aliases].sort((a, b) => a.localeCompare(b, 'tr-TR')));
  const searchTokens = Object.freeze([...node.searchTokens].sort((a, b) => a.localeCompare(b, 'en')));
  const fingerprint = hashFingerprint(stableSerialize({
    key: node.key,
    level: node.level,
    name: node.canonicalName,
    parentKey: node.parentKey,
    childKeys,
    recordKeys,
    aliases,
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

const normalizeResolveLevel = (value: unknown): AddressHierarchyLevel | null => {
  const normalized = normalizeSearchText(value);
  return normalized === 'district'
    || normalized === 'neighborhood'
    || normalized === 'street'
    || normalized === 'building'
    || normalized === 'door'
    ? normalized
    : null;
};

const normalizeRadius = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(500_000, parsed);
};

const textMatchScore = (
  node: AddressHierarchyNode,
  queryCanonical: string,
  queryTokens: readonly string[],
): Readonly<{ score: number; exact: boolean; prefix: boolean; reasons: readonly string[] }> => {
  if (!queryCanonical) return Object.freeze({ score: 0, exact: false, prefix: false, reasons: Object.freeze([]) });
  const reasons: string[] = [];
  let score = 0;
  const exact = node.canonicalName === queryCanonical;
  const prefix = !exact && node.canonicalName.startsWith(queryCanonical);
  if (exact) {
    score += 700;
    reasons.push('exact-name');
  } else if (prefix) {
    score += 500;
    reasons.push('prefix-name');
  } else if (node.canonicalName.includes(queryCanonical)) {
    score += 300;
    reasons.push('substring-name');
  }
  let matchedTokens = 0;
  let prefixTokens = 0;
  const nodeTokens = new Set(node.searchTokens);
  for (const token of queryTokens) {
    if (nodeTokens.has(token)) {
      matchedTokens += 1;
      continue;
    }
    if ([...nodeTokens].some(candidate => candidate.startsWith(token) && token.length >= 2)) {
      prefixTokens += 1;
    }
  }
  if (matchedTokens > 0) {
    score += matchedTokens * 120;
    reasons.push(`token:${matchedTokens}`);
  }
  if (prefixTokens > 0) {
    score += prefixTokens * 60;
    reasons.push(`token-prefix:${prefixTokens}`);
  }
  if (queryTokens.length > 0 && matchedTokens + prefixTokens === queryTokens.length) {
    score += 140;
    reasons.push('full-token-coverage');
  }
  if (node.aliases.some(alias => canonicalizeAddressText(alias) === queryCanonical)) {
    score += 220;
    reasons.push('exact-alias');
  }
  return Object.freeze({ score, exact, prefix, reasons: Object.freeze(reasons) });
};

const distanceMatchScore = (
  node: AddressHierarchyNode,
  center: Coordinate | null,
  radiusMeters: number,
): Readonly<{ score: number; distanceMeters: number | null; reason: string | null }> => {
  if (!center || !node.coordinates) return Object.freeze({ score: 0, distanceMeters: null, reason: null });
  const distance = haversineDistanceMeters(center, node.coordinates);
  if (distance === null) return Object.freeze({ score: 0, distanceMeters: null, reason: null });
  if (radiusMeters > 0 && distance > radiusMeters) {
    return Object.freeze({ score: -1_000, distanceMeters: distance, reason: 'outside-radius' });
  }
  const reference = radiusMeters > 0 ? radiusMeters : 25_000;
  const ratio = Math.max(0, 1 - distance / Math.max(1, reference));
  return Object.freeze({
    score: Math.round(ratio * 180),
    distanceMeters: distance,
    reason: 'distance-bias',
  });
};

export class AddressHierarchyRuntime {
  private readonly options: NormalizedHierarchyOptions;
  private readonly nodes = new Map<string, AddressHierarchyNode>();
  private readonly pathToKey = new Map<string, string>();
  private readonly recordBindings = new Map<string, AddressHierarchyRecordBinding>();
  private readonly tokenIndex = new Map<string, Set<string>>();
  private readonly diagnostics: AddressHierarchyDiagnostic[] = [];
  private diagnosticsTruncated = false;
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

  rebuild(records: readonly NormalizedRecord[]): AddressHierarchySnapshot {
    this.nodes.clear();
    this.pathToKey.clear();
    this.recordBindings.clear();
    this.tokenIndex.clear();
    this.diagnostics.splice(0, this.diagnostics.length);
    this.diagnosticsTruncated = false;

    const limitedRecords = records.slice(0, this.options.maxRecords);
    if (records.length > limitedRecords.length) {
      this.pushDiagnostic({
        code: 'record-budget-exceeded',
        severity: 'error',
        recordKey: null,
        nodeKey: null,
        detail: `Address hierarchy received ${records.length} records; bounded capacity is ${this.options.maxRecords}.`,
      });
    }

    const mutableNodes = new Map<string, MutableNode>();
    for (const record of limitedRecords) {
      this.ingestRecord(record, mutableNodes);
      if (mutableNodes.size > this.options.maxNodes) {
        this.pushDiagnostic({
          code: 'node-budget-exceeded',
          severity: 'error',
          recordKey: recordKey(record),
          nodeKey: null,
          detail: `Address hierarchy node capacity ${this.options.maxNodes} exceeded.`,
        });
        break;
      }
    }

    for (const mutable of mutableNodes.values()) {
      const node = freezeNode(mutable);
      this.nodes.set(node.key, node);
      this.pathToKey.set(node.pathKey, node.key);
      for (const token of node.searchTokens) {
        const keys = this.tokenIndex.get(token) ?? new Set<string>();
        keys.add(node.key);
        this.tokenIndex.set(token, keys);
      }
      if (node.coordinateSpreadMeters > this.options.coordinateDivergenceMeters) {
        this.pushDiagnostic({
          code: 'coordinate-divergence',
          severity: 'warning',
          recordKey: null,
          nodeKey: node.key,
          detail: `Address node coordinate spread ${node.coordinateSpreadMeters}m exceeds ${this.options.coordinateDivergenceMeters}m.`,
        });
      }
    }

    this.snapshotValue = this.createSnapshot();
    return this.snapshotValue;
  }

  private pushDiagnostic(diagnostic: AddressHierarchyDiagnostic): void {
    const added = addBoundedDiagnostic(this.diagnostics, this.options, diagnostic);
    if (!added) this.diagnosticsTruncated = true;
  }

  private ingestRecord(record: NormalizedRecord, mutableNodes: Map<string, MutableNode>): void {
    const key = recordKey(record);
    const segments = extractSegments(record, this.options);
    if (segmentsEmpty(segments)) {
      this.pushDiagnostic({
        code: 'empty-record',
        severity: 'info',
        recordKey: key,
        nodeKey: null,
        detail: 'Record contains no address hierarchy segments.',
      });
      return;
    }

    const values: Readonly<Record<AddressHierarchyLevel, string>> = Object.freeze({
      district: segments.district,
      neighborhood: segments.neighborhood,
      street: segments.street,
      building: segments.building,
      door: segments.door,
    });
    const bindingKeys: Partial<Record<AddressHierarchyLevel, string>> = {};
    const pathKeys: string[] = [];
    let parentKey: string | null = null;
    let parentPath = '';
    let seenGap = false;

    for (const level of LEVEL_ORDER) {
      const name = values[level];
      if (!name) {
        const deeperHasValue = LEVEL_ORDER.slice(LEVEL_DEPTH[level] + 1).some(item => Boolean(values[item]));
        if (deeperHasValue) seenGap = true;
        continue;
      }
      if (seenGap) {
        this.pushDiagnostic({
          code: 'missing-parent-level',
          severity: 'warning',
          recordKey: key,
          nodeKey: parentKey,
          detail: `Record has ${level} data after one or more missing parent address levels.`,
        });
        seenGap = false;
      }
      const canonicalName = canonicalSegment(level, name);
      if (!canonicalName) continue;
      const pathKey = buildPathKey(parentPath, level, canonicalName);
      const nodeKey = createNodeKey(pathKey);
      let node = mutableNodes.get(nodeKey);
      if (!node) {
        node = {
          key: nodeKey,
          level,
          name,
          canonicalName,
          pathKey,
          parentKey,
          childKeys: new Set<string>(),
          recordKeys: new Set<string>(),
          aliases: new Set<string>(),
          searchTokens: new Set<string>(),
          depth: LEVEL_DEPTH[level],
          coordinateSamples: [],
          sourceCount: 0,
        };
        mutableNodes.set(nodeKey, node);
      } else if (node.pathKey !== pathKey || node.level !== level) {
        this.pushDiagnostic({
          code: 'duplicate-path',
          severity: 'error',
          recordKey: key,
          nodeKey,
          detail: `Hierarchy key collision detected for ${pathKey}.`,
        });
      }
      node.recordKeys.add(key);
      node.sourceCount += 1;
      if (node.aliases.size < this.options.maxAliasesPerNode) {
        node.aliases.add(name);
      } else {
        this.pushDiagnostic({
          code: 'alias-budget-exceeded',
          severity: 'warning',
          recordKey: key,
          nodeKey,
          detail: `Alias budget ${this.options.maxAliasesPerNode} reached for ${pathKey}.`,
        });
      }
      for (const token of segmentTokens(level, name)) node.searchTokens.add(token);
      if (record.coordinates) node.coordinateSamples.push(record.coordinates);
      if (parentKey) {
        const parent = mutableNodes.get(parentKey);
        if (parent) {
          if (parent.childKeys.size < this.options.maxChildrenPerNode || parent.childKeys.has(nodeKey)) {
            parent.childKeys.add(nodeKey);
          } else {
            this.pushDiagnostic({
              code: 'child-budget-exceeded',
              severity: 'error',
              recordKey: key,
              nodeKey: parent.key,
              detail: `Child budget ${this.options.maxChildrenPerNode} reached for ${parent.pathKey}.`,
            });
          }
        }
      }
      bindingKeys[level] = nodeKey;
      pathKeys.push(nodeKey);
      parentKey = nodeKey;
      parentPath = pathKey;
    }

    const binding: AddressHierarchyRecordBinding = Object.freeze({
      recordKey: key,
      districtKey: bindingKeys.district ?? null,
      neighborhoodKey: bindingKeys.neighborhood ?? null,
      streetKey: bindingKeys.street ?? null,
      buildingKey: bindingKeys.building ?? null,
      doorKey: bindingKeys.door ?? null,
      deepestKey: pathKeys.at(-1) ?? null,
      pathKeys: Object.freeze(pathKeys),
      fingerprint: hashFingerprint(stableSerialize({ recordKey: key, pathKeys })),
    });
    this.recordBindings.set(key, binding);
  }

  private createSnapshot(): AddressHierarchySnapshot {
    const nodes = [...this.nodes.values()];
    const byLevel = (level: AddressHierarchyLevel): number => nodes.filter(node => node.level === level).length;
    const fingerprint = hashFingerprint(stableSerialize({
      version: ADDRESS_HIERARCHY_VERSION,
      nodes: nodes
        .map(node => [node.key, node.fingerprint] as const)
        .sort((left, right) => left[0].localeCompare(right[0], 'en')),
      bindings: [...this.recordBindings.values()]
        .map(binding => [binding.recordKey, binding.fingerprint] as const)
        .sort((left, right) => left[0].localeCompare(right[0], 'en')),
    }));
    return Object.freeze({
      version: ADDRESS_HIERARCHY_VERSION,
      recordCount: this.recordBindings.size,
      nodeCount: nodes.length,
      rootCount: nodes.filter(node => node.parentKey === null).length,
      districtCount: byLevel('district'),
      neighborhoodCount: byLevel('neighborhood'),
      streetCount: byLevel('street'),
      buildingCount: byLevel('building'),
      doorCount: byLevel('door'),
      diagnostics: Object.freeze([...this.diagnostics]),
      diagnosticsTruncated: this.diagnosticsTruncated,
      fingerprint,
    });
  }

  snapshot(): AddressHierarchySnapshot {
    return this.snapshotValue;
  }

  getNode(key: string): AddressHierarchyNode | null {
    return this.nodes.get(normalizeText(key)) ?? null;
  }

  getBinding(record: NormalizedRecord | string): AddressHierarchyRecordBinding | null {
    const key = typeof record === 'string' ? normalizeText(record) : recordKey(record);
    return this.recordBindings.get(key) ?? null;
  }

  getPath(key: string): readonly AddressHierarchyNode[] {
    const start = this.nodes.get(normalizeText(key));
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
    const node = this.nodes.get(normalizeText(key));
    if (!node) return Object.freeze([]);
    return Object.freeze(node.childKeys
      .map(childKey => this.nodes.get(childKey))
      .filter((child): child is AddressHierarchyNode => child !== undefined)
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'tr-TR')));
  }

  findByPath(pathInput: readonly Partial<Record<AddressHierarchyLevel, string>>): AddressHierarchyNode | null {
    let path = '';
    let last: AddressHierarchyNode | null = null;
    for (const level of LEVEL_ORDER) {
      const value = pathInput[level];
      if (!value) continue;
      const canonical = canonicalSegment(level, value);
      if (!canonical) continue;
      path = buildPathKey(path, level, canonical);
      const key = this.pathToKey.get(path);
      if (!key) return null;
      last = this.nodes.get(key) ?? null;
      if (!last) return null;
    }
    return last;
  }

  private hierarchyScore(node: AddressHierarchyNode, filter: HierarchyFilter): Readonly<{
    score: number;
    matched: boolean;
    reasons: readonly string[];
  }> {
    if (!filter.district && !filter.neighborhood && !filter.street) {
      return Object.freeze({ score: 0, matched: true, reasons: Object.freeze([]) });
    }
    const path = this.getPath(node.key);
    const values: Partial<Record<AddressHierarchyLevel, string>> = {};
    for (const item of path) values[item.level] = item.canonicalName;
    const reasons: string[] = [];
    let score = 0;
    let matched = true;
    const checks: readonly [AddressHierarchyLevel, string, number][] = [
      ['district', filter.district, 220],
      ['neighborhood', filter.neighborhood, 260],
      ['street', filter.street, 300],
    ];
    for (const [level, expected, weight] of checks) {
      if (!expected) continue;
      if (values[level] === expected) {
        score += weight;
        reasons.push(`hierarchy:${level}`);
      } else {
        matched = false;
        score -= weight;
        reasons.push(`hierarchy-mismatch:${level}`);
      }
    }
    return Object.freeze({ score, matched, reasons: Object.freeze(reasons) });
  }

  resolve(query: unknown, options: AddressHierarchyResolveOptions = {}): readonly AddressHierarchyMatch[] {
    const queryCanonical = canonicalizeAddressText(query);
    if (!queryCanonical) return Object.freeze([]);
    const queryTokens = Object.freeze(canonicalizeAddressTokens(query));
    const level = normalizeResolveLevel(options.level);
    const filter = normalizeFilter(options);
    const center = normalizeCoordinates(options.center);
    const radiusMeters = normalizeRadius(options.radiusMeters);
    const limit = normalizeInteger(options.limit, { min: 1, max: 1_000, fallback: 20 });
    const minimumScore = normalizeInteger(options.minimumScore, { min: -10_000, max: 10_000, fallback: 1 });
    const requireHierarchyMatch = options.requireHierarchyMatch !== false;

    const candidates = new Set<string>();
    for (const token of queryTokens) {
      const exactKeys = this.tokenIndex.get(token);
      if (exactKeys) for (const key of exactKeys) candidates.add(key);
      if (token.length >= 2) {
        for (const [indexedToken, keys] of this.tokenIndex) {
          if (!indexedToken.startsWith(token)) continue;
          for (const key of keys) candidates.add(key);
        }
      }
    }
    if (candidates.size === 0) {
      for (const node of this.nodes.values()) {
        if (node.canonicalName.includes(queryCanonical) || queryCanonical.includes(node.canonicalName)) {
          candidates.add(node.key);
        }
      }
    }

    const matches: AddressHierarchyMatch[] = [];
    for (const key of candidates) {
      const node = this.nodes.get(key);
      if (!node) continue;
      if (level && node.level !== level) continue;
      const text = textMatchScore(node, queryCanonical, queryTokens);
      const hierarchy = this.hierarchyScore(node, filter);
      if (requireHierarchyMatch && !hierarchy.matched) continue;
      const distance = distanceMatchScore(node, center, radiusMeters);
      if (distance.reason === 'outside-radius') continue;
      const depthBonus = node.depth * 15;
      const sourceBonus = Math.min(100, Math.max(0, node.sourceCount - 1) * 5);
      const score = text.score + hierarchy.score + distance.score + depthBonus + sourceBonus;
      if (score < minimumScore) continue;
      const reasons = [
        ...text.reasons,
        ...hierarchy.reasons,
        ...(distance.reason ? [distance.reason] : []),
        ...(depthBonus ? [`depth:${node.depth}`] : []),
        ...(sourceBonus ? [`sources:${node.sourceCount}`] : []),
      ];
      matches.push(Object.freeze({
        node,
        score,
        textScore: text.score,
        hierarchyScore: hierarchy.score,
        distanceScore: distance.score,
        distanceMeters: distance.distanceMeters,
        exact: text.exact,
        prefix: text.prefix,
        reasons: Object.freeze(reasons),
      }));
    }
    matches.sort((left, right) => right.score - left.score
      || Number(right.exact) - Number(left.exact)
      || Number(right.prefix) - Number(left.prefix)
      || left.node.canonicalName.localeCompare(right.node.canonicalName, 'tr-TR')
      || left.node.key.localeCompare(right.node.key, 'en'));
    return Object.freeze(matches.slice(0, limit));
  }

  suggest(prefix: unknown, options: Omit<AddressHierarchyResolveOptions, 'minimumScore'> = {}): readonly AddressHierarchyMatch[] {
    const canonical = canonicalizeAddressText(prefix);
    if (!canonical) return Object.freeze([]);
    return this.resolve(canonical, { ...options, minimumScore: 1 });
  }

  toSerializableSnapshot(): Readonly<Record<string, unknown>> {
    const nodes = [...this.nodes.values()]
      .sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en'))
      .map(node => Object.freeze({
        key: node.key,
        level: node.level,
        name: node.name,
        canonicalName: node.canonicalName,
        parentKey: node.parentKey,
        childKeys: node.childKeys,
        recordCount: node.recordKeys.length,
        aliases: node.aliases,
        coordinates: node.coordinates,
        coordinateSpreadMeters: node.coordinateSpreadMeters,
        fingerprint: node.fingerprint,
      }));
    return Object.freeze({
      ...this.snapshotValue,
      nodes: Object.freeze(nodes),
    });
  }
}

export const createAddressHierarchyRuntime = (
  records: readonly NormalizedRecord[] = [],
  options: AddressHierarchyBuildOptions = {},
): AddressHierarchyRuntime => new AddressHierarchyRuntime(records, options);

export const addressHierarchyRecordKey = recordKey;

export const addressHierarchyLevelDepth = (level: AddressHierarchyLevel): number => LEVEL_DEPTH[level];

export const addressHierarchyPathFingerprint = (
  path: readonly AddressHierarchyNode[],
): string => hashFingerprint(stableSerialize(path.map(node => ({
  key: node.key,
  level: node.level,
  canonicalName: node.canonicalName,
}))));
