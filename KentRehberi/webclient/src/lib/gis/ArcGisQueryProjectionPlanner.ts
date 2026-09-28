import type { ArcGisFeatureFieldSnapshot } from './ArcGisFeatureSchemaRegistry';

export type ArcGisQuerySortDirection = 'ASC' | 'DESC';
export type ArcGisQueryStatisticType = 'count' | 'sum' | 'min' | 'max' | 'avg' | 'stddev' | 'var';

export interface ArcGisQuerySortField {
  readonly fieldName: string;
  readonly direction: ArcGisQuerySortDirection;
}

export interface ArcGisQueryStatisticProjection {
  readonly fieldName: string;
  readonly statisticType: ArcGisQueryStatisticType;
  readonly outputFieldName: string;
}

export interface ArcGisQueryProjectionRequest {
  readonly objectIdField: string;
  readonly availableFields: readonly ArcGisFeatureFieldSnapshot[];
  readonly requestedFields: readonly string[];
  readonly popupFields: readonly string[];
  readonly sortFields: readonly ArcGisQuerySortField[];
  readonly statistics: readonly ArcGisQueryStatisticProjection[];
  readonly groupByFields: readonly string[];
  readonly returnGeometry: boolean;
  readonly estimatedRecordCount: number;
}

export interface ArcGisQueryProjectionPolicy {
  readonly maxFields: number;
  readonly maxPopupFields: number;
  readonly maxSortFields: number;
  readonly maxStatistics: number;
  readonly maxGroupByFields: number;
  readonly maxFieldNameLength: number;
  readonly maxOutputFieldNameLength: number;
  readonly maxEstimatedAttributeBytes: number;
  readonly maxEstimatedGeometryBytes: number;
  readonly maxEstimatedTotalBytes: number;
  readonly defaultVariableFieldBytes: number;
  readonly defaultGeometryBytesPerFeature: number;
}

export interface ArcGisQueryProjectionPlan {
  readonly outFields: readonly string[];
  readonly orderByFields: readonly string[];
  readonly statistics: readonly ArcGisQueryStatisticProjection[];
  readonly groupByFields: readonly string[];
  readonly returnGeometry: boolean;
  readonly estimatedAttributeBytes: number;
  readonly estimatedGeometryBytes: number;
  readonly estimatedTotalBytes: number;
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized === '*' || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const safeMultiply = (left: number, right: number, name: string): number => {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} overflow`);
  return result;
};

/**
 * Bounded ArcGIS REST query projection planner.
 *
 * It deliberately rejects wildcard outFields and calculates a minimal deterministic field set
 * from display/popup/sort/statistics/grouping needs while always retaining the OBJECTID field.
 * Geometry is admitted only when explicitly requested. The planner owns no request, URL,
 * credential, feature payload, geometry or ArcGIS SDK object.
 */
export class ArcGisQueryProjectionPlanner {
  private readonly policy: Readonly<ArcGisQueryProjectionPolicy>;

  constructor(policy: ArcGisQueryProjectionPolicy) {
    this.policy = Object.freeze({
      maxFields: integer(policy.maxFields, 'maxFields'),
      maxPopupFields: integer(policy.maxPopupFields, 'maxPopupFields', true),
      maxSortFields: integer(policy.maxSortFields, 'maxSortFields', true),
      maxStatistics: integer(policy.maxStatistics, 'maxStatistics', true),
      maxGroupByFields: integer(policy.maxGroupByFields, 'maxGroupByFields', true),
      maxFieldNameLength: integer(policy.maxFieldNameLength, 'maxFieldNameLength'),
      maxOutputFieldNameLength: integer(policy.maxOutputFieldNameLength, 'maxOutputFieldNameLength'),
      maxEstimatedAttributeBytes: integer(policy.maxEstimatedAttributeBytes, 'maxEstimatedAttributeBytes'),
      maxEstimatedGeometryBytes: integer(policy.maxEstimatedGeometryBytes, 'maxEstimatedGeometryBytes'),
      maxEstimatedTotalBytes: integer(policy.maxEstimatedTotalBytes, 'maxEstimatedTotalBytes'),
      defaultVariableFieldBytes: integer(policy.defaultVariableFieldBytes, 'defaultVariableFieldBytes'),
      defaultGeometryBytesPerFeature: integer(policy.defaultGeometryBytesPerFeature, 'defaultGeometryBytesPerFeature'),
    });
  }

  plan(input: ArcGisQueryProjectionRequest): ArcGisQueryProjectionPlan {
    if (!input || typeof input !== 'object') throw new Error('query projection request is required');
    if (!Array.isArray(input.availableFields) || input.availableFields.length === 0 || input.availableFields.length > this.policy.maxFields) {
      throw new Error('available field count outside configured bounds');
    }
    if (!Array.isArray(input.requestedFields) || input.requestedFields.length > this.policy.maxFields) throw new Error('requested field count outside configured bounds');
    if (!Array.isArray(input.popupFields) || input.popupFields.length > this.policy.maxPopupFields) throw new Error('popup field count outside configured bounds');
    if (!Array.isArray(input.sortFields) || input.sortFields.length > this.policy.maxSortFields) throw new Error('sort field count outside configured bounds');
    if (!Array.isArray(input.statistics) || input.statistics.length > this.policy.maxStatistics) throw new Error('statistics count outside configured bounds');
    if (!Array.isArray(input.groupByFields) || input.groupByFields.length > this.policy.maxGroupByFields) throw new Error('groupBy field count outside configured bounds');
    if (typeof input.returnGeometry !== 'boolean') throw new Error('returnGeometry must be boolean');
    const estimatedRecordCount = integer(input.estimatedRecordCount, 'estimatedRecordCount', true);

    const fields = new Map<string, ArcGisFeatureFieldSnapshot>();
    for (const raw of input.availableFields) {
      const name = boundedText(raw.name, this.policy.maxFieldNameLength, 'available field name');
      if (fields.has(name)) throw new Error('duplicate available field');
      fields.set(name, raw);
    }

    const objectIdField = this.requireField(input.objectIdField, fields, 'objectIdField');
    if (objectIdField.type !== 'esriFieldTypeOID') throw new Error('objectIdField must reference an OID field');

    const selected = new Set<string>([objectIdField.name]);
    this.addFieldList(input.requestedFields, fields, selected, 'requested field');
    this.addFieldList(input.popupFields, fields, selected, 'popup field');

    const orderByFields = input.sortFields.map((sort) => {
      const field = this.requireField(sort.fieldName, fields, 'sort field');
      this.assertSortDirection(sort.direction);
      selected.add(field.name);
      return `${field.name} ${sort.direction}`;
    });
    this.rejectDuplicateSortFields(orderByFields);

    const statistics = input.statistics.map((statistic) => {
      const field = this.requireField(statistic.fieldName, fields, 'statistic field');
      this.assertStatisticType(statistic.statisticType);
      if (statistic.statisticType !== 'count' && !this.isNumeric(field.type)) throw new Error('numeric statistic requires numeric field');
      const outputFieldName = boundedText(statistic.outputFieldName, this.policy.maxOutputFieldNameLength, 'statistic output field');
      return Object.freeze({ fieldName: field.name, statisticType: statistic.statisticType, outputFieldName });
    });
    this.rejectDuplicateStatisticOutputs(statistics);

    const groupByFields = input.groupByFields.map((fieldName) => {
      const field = this.requireField(fieldName, fields, 'groupBy field');
      selected.add(field.name);
      return field.name;
    });
    if (new Set(groupByFields).size !== groupByFields.length) throw new Error('duplicate groupBy field');

    const outFields = [...selected].sort((left, right) => left.localeCompare(right));
    if (outFields.length > this.policy.maxFields) throw new Error('projected field count outside configured bounds');

    const bytesPerRecord = outFields.reduce((sum, fieldName) => {
      const field = fields.get(fieldName)!;
      const fieldBytes = this.estimateFieldBytes(field);
      const next = sum + fieldBytes;
      if (!Number.isSafeInteger(next)) throw new Error('attribute byte estimate overflow');
      return next;
    }, 0);
    const estimatedAttributeBytes = safeMultiply(bytesPerRecord, estimatedRecordCount, 'estimatedAttributeBytes');
    if (estimatedAttributeBytes > this.policy.maxEstimatedAttributeBytes) throw new Error('estimated attribute payload exceeds policy');
    const estimatedGeometryBytes = input.returnGeometry
      ? safeMultiply(this.policy.defaultGeometryBytesPerFeature, estimatedRecordCount, 'estimatedGeometryBytes')
      : 0;
    if (estimatedGeometryBytes > this.policy.maxEstimatedGeometryBytes) throw new Error('estimated geometry payload exceeds policy');
    const estimatedTotalBytes = estimatedAttributeBytes + estimatedGeometryBytes;
    if (!Number.isSafeInteger(estimatedTotalBytes) || estimatedTotalBytes > this.policy.maxEstimatedTotalBytes) throw new Error('estimated query payload exceeds policy');

    return Object.freeze({
      outFields: Object.freeze(outFields),
      orderByFields: Object.freeze(orderByFields),
      statistics: Object.freeze(statistics),
      groupByFields: Object.freeze(groupByFields),
      returnGeometry: input.returnGeometry,
      estimatedAttributeBytes,
      estimatedGeometryBytes,
      estimatedTotalBytes,
    });
  }

  private addFieldList(
    values: readonly string[],
    fields: ReadonlyMap<string, ArcGisFeatureFieldSnapshot>,
    selected: Set<string>,
    label: string,
  ): void {
    const seen = new Set<string>();
    for (const raw of values) {
      const field = this.requireField(raw, fields, label);
      if (seen.has(field.name)) throw new Error(`duplicate ${label}`);
      seen.add(field.name);
      selected.add(field.name);
    }
  }

  private requireField(
    value: string,
    fields: ReadonlyMap<string, ArcGisFeatureFieldSnapshot>,
    label: string,
  ): ArcGisFeatureFieldSnapshot {
    const name = boundedText(value, this.policy.maxFieldNameLength, label);
    const field = fields.get(name);
    if (!field) throw new Error(`${label} is not present in layer schema`);
    return field;
  }

  private rejectDuplicateSortFields(values: readonly string[]): void {
    const names = values.map((value) => value.slice(0, value.lastIndexOf(' ')));
    if (new Set(names).size !== names.length) throw new Error('duplicate sort field');
  }

  private rejectDuplicateStatisticOutputs(values: readonly ArcGisQueryStatisticProjection[]): void {
    const names = values.map((value) => value.outputFieldName);
    if (new Set(names).size !== names.length) throw new Error('duplicate statistic output field');
  }

  private estimateFieldBytes(field: ArcGisFeatureFieldSnapshot): number {
    if (field.type === 'esriFieldTypeString') return field.length ?? this.policy.defaultVariableFieldBytes;
    if (field.type === 'esriFieldTypeGUID' || field.type === 'esriFieldTypeGlobalID') return 38;
    if (field.type === 'esriFieldTypeSmallInteger') return 2;
    if (field.type === 'esriFieldTypeInteger' || field.type === 'esriFieldTypeSingle') return 4;
    if (field.type === 'esriFieldTypeOID' || field.type === 'esriFieldTypeBigInt' || field.type === 'esriFieldTypeBigInteger' || field.type === 'esriFieldTypeDouble') return 8;
    if (field.type === 'esriFieldTypeDate' || field.type === 'esriFieldTypeDateOnly' || field.type === 'esriFieldTypeTimeOnly' || field.type === 'esriFieldTypeTimestampOffset') return 16;
    if (field.type === 'esriFieldTypeBlob' || field.type === 'esriFieldTypeRaster' || field.type === 'esriFieldTypeXML' || field.type === 'esriFieldTypeGeometry') return this.policy.defaultVariableFieldBytes;
    return this.policy.defaultVariableFieldBytes;
  }

  private isNumeric(type: ArcGisFeatureFieldSnapshot['type']): boolean {
    return type === 'esriFieldTypeBigInt'
      || type === 'esriFieldTypeBigInteger'
      || type === 'esriFieldTypeDouble'
      || type === 'esriFieldTypeInteger'
      || type === 'esriFieldTypeOID'
      || type === 'esriFieldTypeSingle'
      || type === 'esriFieldTypeSmallInteger';
  }

  private assertSortDirection(value: string): asserts value is ArcGisQuerySortDirection {
    if (value !== 'ASC' && value !== 'DESC') throw new Error('invalid sort direction');
  }

  private assertStatisticType(value: string): asserts value is ArcGisQueryStatisticType {
    if (value !== 'count' && value !== 'sum' && value !== 'min' && value !== 'max' && value !== 'avg' && value !== 'stddev' && value !== 'var') {
      throw new Error('unsupported statistic type');
    }
  }
}
