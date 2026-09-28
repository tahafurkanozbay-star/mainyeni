export type ArcGisFieldType =
  | 'esriFieldTypeBigInt'
  | 'esriFieldTypeBigInteger'
  | 'esriFieldTypeBlob'
  | 'esriFieldTypeDate'
  | 'esriFieldTypeDateOnly'
  | 'esriFieldTypeDouble'
  | 'esriFieldTypeGUID'
  | 'esriFieldTypeGeometry'
  | 'esriFieldTypeGlobalID'
  | 'esriFieldTypeInteger'
  | 'esriFieldTypeOID'
  | 'esriFieldTypeRaster'
  | 'esriFieldTypeSingle'
  | 'esriFieldTypeSmallInteger'
  | 'esriFieldTypeString'
  | 'esriFieldTypeTimeOnly'
  | 'esriFieldTypeTimestampOffset'
  | 'esriFieldTypeXML';

export type ArcGisDomainScalar = number | string;

export interface ArcGisInheritedDomainSnapshot {
  readonly type: 'inherited';
}

export interface ArcGisRangeDomainSnapshot {
  readonly type: 'range';
  readonly name: string;
  readonly min: ArcGisDomainScalar;
  readonly max: ArcGisDomainScalar;
}

export interface ArcGisCodedValueSnapshot {
  readonly name: string;
  readonly code: ArcGisDomainScalar;
}

export interface ArcGisCodedValueDomainSnapshot {
  readonly type: 'codedValue';
  readonly name: string;
  readonly codedValues: readonly ArcGisCodedValueSnapshot[];
}

export type ArcGisFieldDomainSnapshot = ArcGisInheritedDomainSnapshot | ArcGisRangeDomainSnapshot | ArcGisCodedValueDomainSnapshot | null;

export interface ArcGisFeatureFieldSnapshot {
  readonly name: string;
  readonly alias: string;
  readonly type: ArcGisFieldType;
  readonly length: number | null;
  readonly editable: boolean;
  readonly nullable: boolean;
  readonly domain: ArcGisFieldDomainSnapshot;
}

export interface ArcGisSubtypeDomainSnapshot {
  readonly fieldName: string;
  readonly domain: ArcGisFieldDomainSnapshot;
}

export interface ArcGisSubtypeSnapshot {
  readonly id: ArcGisDomainScalar;
  readonly name: string;
  readonly domains: readonly ArcGisSubtypeDomainSnapshot[];
}

export interface ArcGisFeatureSchemaSnapshot {
  readonly serviceKey: string;
  readonly layerId: number;
  readonly revision: string;
  readonly observedAtMs: number;
  readonly objectIdField: string;
  readonly globalIdField: string | null;
  readonly typeIdField: string | null;
  readonly fields: readonly ArcGisFeatureFieldSnapshot[];
  readonly subtypes: readonly ArcGisSubtypeSnapshot[];
}

export interface ArcGisFeatureSchemaRegistryPolicy {
  readonly maxLayers: number;
  readonly maxFieldsPerLayer: number;
  readonly maxSubtypesPerLayer: number;
  readonly maxSubtypeDomains: number;
  readonly maxCodedValues: number;
  readonly maxServiceKeyLength: number;
  readonly maxRevisionLength: number;
  readonly maxFieldNameLength: number;
  readonly maxAliasLength: number;
  readonly maxDomainNameLength: number;
  readonly maxDomainValueLength: number;
  readonly maxStringFieldLength: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export type ArcGisFeatureSchemaBreakingChange =
  | 'global-id-field-changed'
  | 'object-id-field-changed'
  | 'type-id-field-changed'
  | `domain-changed:${string}`
  | `editable-disabled:${string}`
  | `field-length-decreased:${string}`
  | `field-removed:${string}`
  | `field-type-changed:${string}`
  | `nullable-tightened:${string}`
  | `subtype-removed:${string}`;

export interface ArcGisFeatureSchemaRegistryEntry {
  readonly sequence: number;
  readonly lastAccessedAtMs: number;
  readonly schema: ArcGisFeatureSchemaSnapshot;
}

export interface ArcGisFeatureSchemaObservationResult {
  readonly status: 'inserted' | 'unchanged' | 'updated';
  readonly compatible: boolean;
  readonly breakingChanges: readonly ArcGisFeatureSchemaBreakingChange[];
  readonly generation: number;
  readonly entry: ArcGisFeatureSchemaRegistryEntry;
}

export interface ArcGisFeatureSchemaRegistrySnapshot {
  readonly generation: number;
  readonly entries: readonly ArcGisFeatureSchemaRegistryEntry[];
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const compareText = (left: string, right: string): number => left.localeCompare(right);

const scalarKey = (value: ArcGisDomainScalar): string => typeof value === 'number' ? `n:${value}` : `s:${value}`;

const freezeDomain = (domain: ArcGisFieldDomainSnapshot): ArcGisFieldDomainSnapshot => {
  if (domain === null) return null;
  if (domain.type === 'inherited') return Object.freeze({ type: 'inherited' });
  if (domain.type === 'range') return Object.freeze({ type: 'range', name: domain.name, min: domain.min, max: domain.max });
  return Object.freeze({
    type: 'codedValue',
    name: domain.name,
    codedValues: Object.freeze(domain.codedValues.map((value) => Object.freeze({ name: value.name, code: value.code }))),
  });
};

const freezeField = (field: ArcGisFeatureFieldSnapshot): ArcGisFeatureFieldSnapshot => Object.freeze({
  name: field.name,
  alias: field.alias,
  type: field.type,
  length: field.length,
  editable: field.editable,
  nullable: field.nullable,
  domain: freezeDomain(field.domain),
});

const freezeSubtype = (subtype: ArcGisSubtypeSnapshot): ArcGisSubtypeSnapshot => Object.freeze({
  id: subtype.id,
  name: subtype.name,
  domains: Object.freeze(subtype.domains.map((entry) => Object.freeze({ fieldName: entry.fieldName, domain: freezeDomain(entry.domain) }))),
});

const freezeSchema = (schema: ArcGisFeatureSchemaSnapshot): ArcGisFeatureSchemaSnapshot => Object.freeze({
  serviceKey: schema.serviceKey,
  layerId: schema.layerId,
  revision: schema.revision,
  observedAtMs: schema.observedAtMs,
  objectIdField: schema.objectIdField,
  globalIdField: schema.globalIdField,
  typeIdField: schema.typeIdField,
  fields: Object.freeze(schema.fields.map(freezeField)),
  subtypes: Object.freeze(schema.subtypes.map(freezeSubtype)),
});

const freezeEntry = (entry: ArcGisFeatureSchemaRegistryEntry): ArcGisFeatureSchemaRegistryEntry => Object.freeze({
  sequence: entry.sequence,
  lastAccessedAtMs: entry.lastAccessedAtMs,
  schema: freezeSchema(entry.schema),
});

/**
 * Bounded field/domain/subtype contract authority for metadata returned by verified ArcGIS
 * FeatureServer layer adapters. It never owns feature payloads, URLs, credentials, requests,
 * Layer/LayerView instances, Geometry objects or edit handles.
 */
export class ArcGisFeatureSchemaRegistry {
  private readonly policy: Readonly<ArcGisFeatureSchemaRegistryPolicy>;
  private readonly entries = new Map<string, ArcGisFeatureSchemaRegistryEntry>();
  private generation = 0;
  private lastObservedAtMs = 0;
  private disposed = false;

  constructor(policy: ArcGisFeatureSchemaRegistryPolicy) {
    this.policy = Object.freeze({
      maxLayers: integer(policy.maxLayers, 'maxLayers'),
      maxFieldsPerLayer: integer(policy.maxFieldsPerLayer, 'maxFieldsPerLayer'),
      maxSubtypesPerLayer: integer(policy.maxSubtypesPerLayer, 'maxSubtypesPerLayer', true),
      maxSubtypeDomains: integer(policy.maxSubtypeDomains, 'maxSubtypeDomains', true),
      maxCodedValues: integer(policy.maxCodedValues, 'maxCodedValues', true),
      maxServiceKeyLength: integer(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxRevisionLength: integer(policy.maxRevisionLength, 'maxRevisionLength'),
      maxFieldNameLength: integer(policy.maxFieldNameLength, 'maxFieldNameLength'),
      maxAliasLength: integer(policy.maxAliasLength, 'maxAliasLength'),
      maxDomainNameLength: integer(policy.maxDomainNameLength, 'maxDomainNameLength'),
      maxDomainValueLength: integer(policy.maxDomainValueLength, 'maxDomainValueLength'),
      maxStringFieldLength: integer(policy.maxStringFieldLength, 'maxStringFieldLength'),
      retentionMs: integer(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: integer(policy.maxClockSkewMs, 'maxClockSkewMs', true),
    });
  }

  observe(input: ArcGisFeatureSchemaSnapshot): ArcGisFeatureSchemaObservationResult {
    this.assertUsable();
    const schema = this.normalizeSchema(input);
    const now = this.time(schema.observedAtMs);
    const key = this.key(schema.serviceKey, schema.layerId);
    const previous = this.entries.get(key);
    if (previous && schema.observedAtMs < previous.schema.observedAtMs) throw new Error('stale feature schema observation');

    const breakingChanges = previous ? this.breakingChanges(previous.schema, schema) : Object.freeze([] as ArcGisFeatureSchemaBreakingChange[]);
    if (previous && this.sameSchema(previous.schema, schema)) {
      const touched = freezeEntry({ sequence: previous.sequence, lastAccessedAtMs: now, schema });
      this.entries.set(key, touched);
      return Object.freeze({ status: 'unchanged', compatible: true, breakingChanges: Object.freeze([]), generation: this.generation, entry: touched });
    }

    if (!previous) this.ensureCapacity();
    const sequence = previous ? previous.sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('feature schema sequence overflow');
    const entry = freezeEntry({ sequence, lastAccessedAtMs: now, schema });
    this.entries.set(key, entry);
    this.generation += 1;
    return Object.freeze({
      status: previous ? 'updated' : 'inserted',
      compatible: breakingChanges.length === 0,
      breakingChanges,
      generation: this.generation,
      entry,
    });
  }

  get(serviceKeyValue: string, layerIdValue: number, timestampMs: number): ArcGisFeatureSchemaRegistryEntry | null {
    this.assertUsable();
    const now = this.time(timestampMs);
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const layerId = integer(layerIdValue, 'layerId', true);
    const key = this.key(serviceKey, layerId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.schema.observedAtMs > this.policy.retentionMs) {
      this.entries.delete(key);
      this.generation += 1;
      return null;
    }
    if (entry.lastAccessedAtMs === now) return entry;
    const touched = freezeEntry({ sequence: entry.sequence, lastAccessedAtMs: now, schema: entry.schema });
    this.entries.set(key, touched);
    return touched;
  }

  invalidate(serviceKeyValue: string, layerIdValue?: number): number {
    this.assertUsable();
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const layerId = layerIdValue === undefined ? null : integer(layerIdValue, 'layerId', true);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.schema.serviceKey === serviceKey && (layerId === null || entry.schema.layerId === layerId)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.time(timestampMs);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.schema.observedAtMs > this.policy.retentionMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisFeatureSchemaRegistrySnapshot {
    this.assertUsable();
    this.time(timestampMs);
    const entries = [...this.entries.values()]
      .sort((left, right) => compareText(left.schema.serviceKey, right.schema.serviceKey) || left.schema.layerId - right.schema.layerId)
      .map(freezeEntry);
    return Object.freeze({ generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisFeatureSchemaRegistrySnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxLayers) throw new Error('invalid feature schema capacity');
    const next = new Map<string, ArcGisFeatureSchemaRegistryEntry>();
    for (const raw of snapshot.entries) {
      const sequence = integer(raw.sequence, 'sequence');
      const lastAccessedAtMs = integer(raw.lastAccessedAtMs, 'lastAccessedAtMs', true);
      const schema = this.normalizeSchema(raw.schema);
      if (schema.observedAtMs > now + this.policy.maxClockSkewMs || lastAccessedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future feature schema timestamp');
      if (lastAccessedAtMs < schema.observedAtMs) throw new Error('invalid feature schema chronology');
      const key = this.key(schema.serviceKey, schema.layerId);
      if (next.has(key)) throw new Error('duplicate feature schema entry');
      next.set(key, freezeEntry({ sequence, lastAccessedAtMs, schema }));
    }
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
    this.lastObservedAtMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.generation += 1;
  }

  private normalizeSchema(input: ArcGisFeatureSchemaSnapshot): ArcGisFeatureSchemaSnapshot {
    const serviceKey = boundedText(input.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const layerId = integer(input.layerId, 'layerId', true);
    const revision = boundedText(input.revision, this.policy.maxRevisionLength, 'revision');
    const observedAtMs = integer(input.observedAtMs, 'observedAtMs', true);
    if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > this.policy.maxFieldsPerLayer) throw new Error('field count outside registry policy');
    if (!Array.isArray(input.subtypes) || input.subtypes.length > this.policy.maxSubtypesPerLayer) throw new Error('subtype count outside registry policy');

    const fields = input.fields.map((field) => this.normalizeField(field)).sort((left, right) => compareText(left.name, right.name));
    const fieldNames = new Set<string>();
    for (const field of fields) {
      if (fieldNames.has(field.name)) throw new Error('duplicate feature field');
      fieldNames.add(field.name);
    }

    const objectIdField = boundedText(input.objectIdField, this.policy.maxFieldNameLength, 'objectIdField');
    const globalIdField = input.globalIdField === null ? null : boundedText(input.globalIdField, this.policy.maxFieldNameLength, 'globalIdField');
    const typeIdField = input.typeIdField === null ? null : boundedText(input.typeIdField, this.policy.maxFieldNameLength, 'typeIdField');
    this.assertSpecialField(fields, objectIdField, 'esriFieldTypeOID', 'object ID');
    if (globalIdField !== null) this.assertSpecialField(fields, globalIdField, 'esriFieldTypeGlobalID', 'global ID');
    if (typeIdField !== null && !fieldNames.has(typeIdField)) throw new Error('type ID field is missing from schema');
    if (input.subtypes.length > 0 && typeIdField === null) throw new Error('subtypes require type ID field');

    const subtypes = input.subtypes.map((subtype) => this.normalizeSubtype(subtype, fieldNames)).sort((left, right) => scalarKey(left.id).localeCompare(scalarKey(right.id)));
    const subtypeIds = new Set<string>();
    for (const subtype of subtypes) {
      const key = scalarKey(subtype.id);
      if (subtypeIds.has(key)) throw new Error('duplicate subtype ID');
      subtypeIds.add(key);
    }

    return freezeSchema({ serviceKey, layerId, revision, observedAtMs, objectIdField, globalIdField, typeIdField, fields, subtypes });
  }

  private normalizeField(input: ArcGisFeatureFieldSnapshot): ArcGisFeatureFieldSnapshot {
    const name = boundedText(input.name, this.policy.maxFieldNameLength, 'field name');
    const alias = boundedText(input.alias, this.policy.maxAliasLength, 'field alias');
    this.assertFieldType(input.type);
    if (typeof input.editable !== 'boolean' || typeof input.nullable !== 'boolean') throw new Error('field editable/nullable flags must be boolean');
    const length = input.length === null ? null : integer(input.length, 'field length');
    if (input.type === 'esriFieldTypeString') {
      if (length === null || length > this.policy.maxStringFieldLength) throw new Error('string field length outside registry policy');
    } else if (length !== null && length > this.policy.maxStringFieldLength) {
      throw new Error('field length outside registry policy');
    }
    const domain = this.normalizeDomain(input.domain);
    return freezeField({ name, alias, type: input.type, length, editable: input.editable, nullable: input.nullable, domain });
  }

  private normalizeSubtype(input: ArcGisSubtypeSnapshot, fields: ReadonlySet<string>): ArcGisSubtypeSnapshot {
    const id = this.normalizeScalar(input.id, 'subtype ID');
    const name = boundedText(input.name, this.policy.maxAliasLength, 'subtype name');
    if (!Array.isArray(input.domains) || input.domains.length > this.policy.maxSubtypeDomains) throw new Error('subtype domain count outside registry policy');
    const domains = input.domains.map((entry) => {
      const fieldName = boundedText(entry.fieldName, this.policy.maxFieldNameLength, 'subtype field name');
      if (!fields.has(fieldName)) throw new Error('subtype domain references unknown field');
      return Object.freeze({ fieldName, domain: this.normalizeDomain(entry.domain) });
    }).sort((left, right) => compareText(left.fieldName, right.fieldName));
    const names = new Set<string>();
    for (const entry of domains) {
      if (names.has(entry.fieldName)) throw new Error('duplicate subtype field domain');
      names.add(entry.fieldName);
    }
    return freezeSubtype({ id, name, domains });
  }

  private normalizeDomain(domain: ArcGisFieldDomainSnapshot): ArcGisFieldDomainSnapshot {
    if (domain === null) return null;
    if (!domain || typeof domain !== 'object') throw new Error('invalid field domain');
    if (domain.type === 'inherited') return Object.freeze({ type: 'inherited' });
    if (domain.type === 'range') {
      const name = boundedText(domain.name, this.policy.maxDomainNameLength, 'domain name');
      const min = this.normalizeScalar(domain.min, 'range minimum');
      const max = this.normalizeScalar(domain.max, 'range maximum');
      if (typeof min !== typeof max) throw new Error('range domain value types must match');
      if (typeof min === 'number' && typeof max === 'number' && min > max) throw new Error('range domain minimum exceeds maximum');
      if (typeof min === 'string' && typeof max === 'string' && min.localeCompare(max) > 0) throw new Error('range domain minimum exceeds maximum');
      return Object.freeze({ type: 'range', name, min, max });
    }
    if (domain.type === 'codedValue') {
      const name = boundedText(domain.name, this.policy.maxDomainNameLength, 'domain name');
      if (!Array.isArray(domain.codedValues) || domain.codedValues.length > this.policy.maxCodedValues) throw new Error('coded value count outside registry policy');
      const seenCodes = new Set<string>();
      const codedValues = domain.codedValues.map((value) => {
        const code = this.normalizeScalar(value.code, 'coded value');
        const codeKey = scalarKey(code);
        if (seenCodes.has(codeKey)) throw new Error('duplicate coded domain value');
        seenCodes.add(codeKey);
        return Object.freeze({ name: boundedText(value.name, this.policy.maxAliasLength, 'coded value name'), code });
      }).sort((left, right) => scalarKey(left.code).localeCompare(scalarKey(right.code)));
      return Object.freeze({ type: 'codedValue', name, codedValues: Object.freeze(codedValues) });
    }
    throw new Error('unsupported ArcGIS field domain');
  }

  private normalizeScalar(value: ArcGisDomainScalar, name: string): ArcGisDomainScalar {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error(`${name} outside configured bounds`);
      return value;
    }
    return boundedText(value, this.policy.maxDomainValueLength, name);
  }

  private breakingChanges(previous: ArcGisFeatureSchemaSnapshot, next: ArcGisFeatureSchemaSnapshot): readonly ArcGisFeatureSchemaBreakingChange[] {
    const changes: ArcGisFeatureSchemaBreakingChange[] = [];
    if (previous.objectIdField !== next.objectIdField) changes.push('object-id-field-changed');
    if (previous.globalIdField !== next.globalIdField) changes.push('global-id-field-changed');
    if (previous.typeIdField !== next.typeIdField) changes.push('type-id-field-changed');
    const nextFields = new Map(next.fields.map((field) => [field.name, field] as const));
    for (const field of previous.fields) {
      const candidate = nextFields.get(field.name);
      if (!candidate) {
        changes.push(`field-removed:${field.name}`);
        continue;
      }
      if (field.type !== candidate.type) changes.push(`field-type-changed:${field.name}`);
      if (field.nullable && !candidate.nullable) changes.push(`nullable-tightened:${field.name}`);
      if (field.editable && !candidate.editable) changes.push(`editable-disabled:${field.name}`);
      if (field.length !== null && candidate.length !== null && candidate.length < field.length) changes.push(`field-length-decreased:${field.name}`);
      if (!this.sameDomain(field.domain, candidate.domain)) changes.push(`domain-changed:${field.name}`);
    }
    const nextSubtypeIds = new Set(next.subtypes.map((subtype) => scalarKey(subtype.id)));
    for (const subtype of previous.subtypes) if (!nextSubtypeIds.has(scalarKey(subtype.id))) changes.push(`subtype-removed:${scalarKey(subtype.id)}`);
    return Object.freeze(changes.sort(compareText));
  }

  private sameSchema(left: ArcGisFeatureSchemaSnapshot, right: ArcGisFeatureSchemaSnapshot): boolean {
    if (left.serviceKey !== right.serviceKey || left.layerId !== right.layerId || left.revision !== right.revision) return false;
    if (left.objectIdField !== right.objectIdField || left.globalIdField !== right.globalIdField || left.typeIdField !== right.typeIdField) return false;
    if (left.fields.length !== right.fields.length || left.subtypes.length !== right.subtypes.length) return false;
    for (let index = 0; index < left.fields.length; index += 1) {
      const a = left.fields[index]!;
      const b = right.fields[index]!;
      if (a.name !== b.name || a.alias !== b.alias || a.type !== b.type || a.length !== b.length || a.editable !== b.editable || a.nullable !== b.nullable || !this.sameDomain(a.domain, b.domain)) return false;
    }
    for (let index = 0; index < left.subtypes.length; index += 1) {
      const a = left.subtypes[index]!;
      const b = right.subtypes[index]!;
      if (scalarKey(a.id) !== scalarKey(b.id) || a.name !== b.name || a.domains.length !== b.domains.length) return false;
      for (let domainIndex = 0; domainIndex < a.domains.length; domainIndex += 1) {
        const leftDomain = a.domains[domainIndex]!;
        const rightDomain = b.domains[domainIndex]!;
        if (leftDomain.fieldName !== rightDomain.fieldName || !this.sameDomain(leftDomain.domain, rightDomain.domain)) return false;
      }
    }
    return true;
  }

  private sameDomain(left: ArcGisFieldDomainSnapshot, right: ArcGisFieldDomainSnapshot): boolean {
    if (left === null || right === null) return left === right;
    if (left.type !== right.type) return false;
    if (left.type === 'inherited' && right.type === 'inherited') return true;
    if (left.type === 'range' && right.type === 'range') return left.name === right.name && scalarKey(left.min) === scalarKey(right.min) && scalarKey(left.max) === scalarKey(right.max);
    if (left.type !== 'codedValue' || right.type !== 'codedValue' || left.name !== right.name || left.codedValues.length !== right.codedValues.length) return false;
    return left.codedValues.every((value, index) => {
      const candidate = right.codedValues[index]!;
      return value.name === candidate.name && scalarKey(value.code) === scalarKey(candidate.code);
    });
  }

  private ensureCapacity(): void {
    while (this.entries.size >= this.policy.maxLayers) {
      const candidate = [...this.entries.values()].sort((left, right) =>
        left.lastAccessedAtMs - right.lastAccessedAtMs
        || left.schema.observedAtMs - right.schema.observedAtMs
        || compareText(left.schema.serviceKey, right.schema.serviceKey)
        || left.schema.layerId - right.schema.layerId,
      )[0];
      if (!candidate) throw new Error('feature schema capacity invariant failed');
      this.entries.delete(this.key(candidate.schema.serviceKey, candidate.schema.layerId));
      this.generation += 1;
    }
  }

  private assertSpecialField(fields: readonly ArcGisFeatureFieldSnapshot[], name: string, type: ArcGisFieldType, label: string): void {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field || field.type !== type) throw new Error(`${label} field is missing or has wrong type`);
  }

  private assertFieldType(value: string): asserts value is ArcGisFieldType {
    if (value !== 'esriFieldTypeBigInt'
      && value !== 'esriFieldTypeBigInteger'
      && value !== 'esriFieldTypeBlob'
      && value !== 'esriFieldTypeDate'
      && value !== 'esriFieldTypeDateOnly'
      && value !== 'esriFieldTypeDouble'
      && value !== 'esriFieldTypeGUID'
      && value !== 'esriFieldTypeGeometry'
      && value !== 'esriFieldTypeGlobalID'
      && value !== 'esriFieldTypeInteger'
      && value !== 'esriFieldTypeOID'
      && value !== 'esriFieldTypeRaster'
      && value !== 'esriFieldTypeSingle'
      && value !== 'esriFieldTypeSmallInteger'
      && value !== 'esriFieldTypeString'
      && value !== 'esriFieldTypeTimeOnly'
      && value !== 'esriFieldTypeTimestampOffset'
      && value !== 'esriFieldTypeXML') throw new Error('unsupported ArcGIS field type');
  }

  private key(serviceKey: string, layerId: number): string {
    return `${serviceKey}\u0001${layerId}`;
  }

  private time(value: number): number {
    const now = integer(value, 'timestampMs', true);
    if (now + this.policy.maxClockSkewMs < this.lastObservedAtMs) throw new Error('stale feature schema clock');
    this.lastObservedAtMs = Math.max(this.lastObservedAtMs, now);
    return now;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisFeatureSchemaRegistry is disposed');
  }
}
