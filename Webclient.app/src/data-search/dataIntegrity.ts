import type {
  DataQualityIssue,
  NormalizedRecord,
  RecordNormalizationOptions,
} from './contracts';
import {
  normalizeInteger,
  normalizeRecordCollection,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
  hashFingerprint,
} from './normalization';

export type IntegritySeverity = 'info' | 'warning' | 'error' | 'critical';
export type IntegrityDisposition = 'accept' | 'quarantine' | 'reject';

export interface IntegrityPolicy {
  readonly rejectMissingTitle?: boolean;
  readonly rejectMissingId?: boolean;
  readonly rejectInvalidCoordinate?: boolean;
  readonly quarantineDuplicateIds?: boolean;
  readonly quarantineSemanticDuplicates?: boolean;
  readonly quarantineEncodingAnomalies?: boolean;
  readonly maxIssueDetails?: number;
  readonly maxDuplicateExamples?: number;
  readonly maxErrorRatio?: number;
  readonly maxQuarantineRatio?: number;
}

export interface IntegrityRecordIssue {
  readonly code: string;
  readonly severity: IntegritySeverity;
  readonly disposition: IntegrityDisposition;
  readonly recordKey: string;
  readonly sourceIndex: number;
  readonly field: string | null;
  readonly detail: string;
}

export interface DuplicateGroup {
  readonly key: string;
  readonly kind: 'id' | 'semantic';
  readonly positions: readonly number[];
  readonly recordKeys: readonly string[];
  readonly conflicting: boolean;
}

export interface EncodingAnomaly {
  readonly recordKey: string;
  readonly sourceIndex: number;
  readonly field: string;
  readonly code: 'replacement-character' | 'null-byte' | 'control-character' | 'excessive-whitespace';
  readonly excerpt: string;
}

export interface IntegrityRecordDecision {
  readonly record: NormalizedRecord;
  readonly recordKey: string;
  readonly disposition: IntegrityDisposition;
  readonly issues: readonly IntegrityRecordIssue[];
}

export interface IntegrityReport {
  readonly inputCount: number;
  readonly normalizedCount: number;
  readonly acceptedCount: number;
  readonly quarantinedCount: number;
  readonly rejectedCount: number;
  readonly acceptedRatio: number;
  readonly quarantineRatio: number;
  readonly errorRatio: number;
  readonly duplicateIdGroups: readonly DuplicateGroup[];
  readonly semanticDuplicateGroups: readonly DuplicateGroup[];
  readonly encodingAnomalies: readonly EncodingAnomaly[];
  readonly issueCounts: Readonly<Record<string, number>>;
  readonly severityCounts: Readonly<Record<IntegritySeverity, number>>;
  readonly decisions: readonly IntegrityRecordDecision[];
  readonly normalizationIssues: readonly DataQualityIssue[];
  readonly releaseReady: boolean;
  readonly fingerprint: string;
}

export interface IntegrityResult {
  readonly accepted: readonly NormalizedRecord[];
  readonly quarantined: readonly NormalizedRecord[];
  readonly rejected: readonly NormalizedRecord[];
  readonly report: IntegrityReport;
}

const DEFAULT_POLICY: Required<IntegrityPolicy> = Object.freeze({
  rejectMissingTitle: true,
  rejectMissingId: false,
  rejectInvalidCoordinate: false,
  quarantineDuplicateIds: true,
  quarantineSemanticDuplicates: false,
  quarantineEncodingAnomalies: true,
  maxIssueDetails: 1_000,
  maxDuplicateExamples: 200,
  maxErrorRatio: 0.05,
  maxQuarantineRatio: 0.1,
});

const normalizeRatio = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
};

export const normalizeIntegrityPolicy = (policy: IntegrityPolicy = {}): Required<IntegrityPolicy> => Object.freeze({
  rejectMissingTitle: policy.rejectMissingTitle ?? DEFAULT_POLICY.rejectMissingTitle,
  rejectMissingId: policy.rejectMissingId ?? DEFAULT_POLICY.rejectMissingId,
  rejectInvalidCoordinate: policy.rejectInvalidCoordinate ?? DEFAULT_POLICY.rejectInvalidCoordinate,
  quarantineDuplicateIds: policy.quarantineDuplicateIds ?? DEFAULT_POLICY.quarantineDuplicateIds,
  quarantineSemanticDuplicates: policy.quarantineSemanticDuplicates ?? DEFAULT_POLICY.quarantineSemanticDuplicates,
  quarantineEncodingAnomalies: policy.quarantineEncodingAnomalies ?? DEFAULT_POLICY.quarantineEncodingAnomalies,
  maxIssueDetails: normalizeInteger(policy.maxIssueDetails, { min: 0, max: 100_000, fallback: DEFAULT_POLICY.maxIssueDetails }),
  maxDuplicateExamples: normalizeInteger(policy.maxDuplicateExamples, { min: 0, max: 10_000, fallback: DEFAULT_POLICY.maxDuplicateExamples }),
  maxErrorRatio: normalizeRatio(policy.maxErrorRatio, DEFAULT_POLICY.maxErrorRatio),
  maxQuarantineRatio: normalizeRatio(policy.maxQuarantineRatio, DEFAULT_POLICY.maxQuarantineRatio),
});

export const createIntegrityRecordKey = (record: NormalizedRecord): string =>
  record.id ? `id:${record.id}` : `fingerprint:${record.fingerprint}`;

export const createSemanticIdentityKey = (record: NormalizedRecord): string => {
  const parts = [
    record.categoryKey,
    normalizeSearchText(record.title),
    normalizeSearchText(record.district),
    normalizeSearchText(record.neighborhood),
    normalizeSearchText(record.street),
    normalizeSearchText(record.door),
    record.coordinates
      ? `${record.coordinates.latitude.toFixed(6)},${record.coordinates.longitude.toFixed(6)}`
      : '',
  ];
  return parts.join('|');
};

const inspectString = (
  record: NormalizedRecord,
  field: string,
  value: unknown,
): readonly EncodingAnomaly[] => {
  if (typeof value !== 'string' || !value) return Object.freeze([]);
  const anomalies: EncodingAnomaly[] = [];
  const recordKey = createIntegrityRecordKey(record);
  const excerpt = value.replace(/\s+/g, ' ').slice(0, 80);
  if (value.includes('\uFFFD')) {
    anomalies.push(Object.freeze({ recordKey, sourceIndex: record.sourceIndex, field, code: 'replacement-character', excerpt }));
  }
  if (value.includes('\u0000')) {
    anomalies.push(Object.freeze({ recordKey, sourceIndex: record.sourceIndex, field, code: 'null-byte', excerpt }));
  }
  let hasControl = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 1 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
      hasControl = true;
      break;
    }
  }
  if (hasControl) {
    anomalies.push(Object.freeze({ recordKey, sourceIndex: record.sourceIndex, field, code: 'control-character', excerpt }));
  }
  if (/\s{8,}/.test(value)) {
    anomalies.push(Object.freeze({ recordKey, sourceIndex: record.sourceIndex, field, code: 'excessive-whitespace', excerpt }));
  }
  return Object.freeze(anomalies);
};

const isObjectRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const collectRawStringFields = (
  source: unknown,
  maxDepth = 2,
  maxFields = 128,
): Readonly<Record<string, string>> => {
  if (!isObjectRecord(source)) return Object.freeze({});
  const output: Record<string, string> = {};
  const visited = new Set<object>();
  const visit = (value: Readonly<Record<string, unknown>>, prefix: string, depth: number): void => {
    if (visited.has(value as object) || Object.keys(output).length >= maxFields) return;
    visited.add(value as object);
    for (const [key, fieldValue] of Object.entries(value)) {
      if (Object.keys(output).length >= maxFields) break;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof fieldValue === 'string') {
        output[path] = fieldValue;
      } else if (depth < maxDepth && isObjectRecord(fieldValue)) {
        visit(fieldValue, path, depth + 1);
      } else if (depth < maxDepth && Array.isArray(fieldValue)) {
        for (let index = 0; index < Math.min(fieldValue.length, 16); index += 1) {
          const item = fieldValue[index];
          if (typeof item === 'string') output[`${path}[${index}]`] = item;
          else if (isObjectRecord(item)) visit(item, `${path}[${index}]`, depth + 1);
          if (Object.keys(output).length >= maxFields) break;
        }
      }
    }
  };
  visit(source, '', 0);
  return Object.freeze(output);
};

const normalizedStringFields = (record: NormalizedRecord): Readonly<Record<string, unknown>> => Object.freeze({
  title: record.title,
  category: record.category,
  type: record.type,
  address: record.address,
  district: record.district,
  neighborhood: record.neighborhood,
  street: record.street,
  door: record.door,
  phone: record.phone,
  url: record.url,
  ...record.fields,
});

export const detectEncodingAnomalies = (records: readonly NormalizedRecord[]): readonly EncodingAnomaly[] => {
  const anomalies: EncodingAnomaly[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const rawFields = collectRawStringFields(record.source);
    const values = Object.keys(rawFields).length ? rawFields : normalizedStringFields(record);
    for (const [field, value] of Object.entries(values)) {
      for (const anomaly of inspectString(record, field, value)) {
        const key = `${anomaly.recordKey}|${anomaly.field}|${anomaly.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        anomalies.push(anomaly);
      }
    }
  }
  return Object.freeze(anomalies);
};

const buildDuplicateGroups = (
  records: readonly NormalizedRecord[],
  kind: DuplicateGroup['kind'],
  keySelector: (record: NormalizedRecord) => string,
  maxGroups: number,
): readonly DuplicateGroup[] => {
  const positions = new Map<string, number[]>();
  records.forEach((record, index) => {
    const key = keySelector(record);
    if (!key) return;
    const list = positions.get(key) ?? [];
    list.push(index);
    positions.set(key, list);
  });
  const groups: DuplicateGroup[] = [];
  for (const [key, groupPositions] of positions) {
    if (groupPositions.length < 2) continue;
    const groupRecords = groupPositions.map(position => records[position]).filter((value): value is NormalizedRecord => Boolean(value));
    const fingerprints = new Set(groupRecords.map(record => record.fingerprint));
    groups.push(Object.freeze({
      key,
      kind,
      positions: Object.freeze(groupPositions),
      recordKeys: Object.freeze(groupRecords.map(createIntegrityRecordKey)),
      conflicting: fingerprints.size > 1,
    }));
    if (groups.length >= maxGroups) break;
  }
  groups.sort((left, right) => Number(right.conflicting) - Number(left.conflicting)
    || right.positions.length - left.positions.length
    || left.key.localeCompare(right.key));
  return Object.freeze(groups);
};

export const detectDuplicateIds = (
  records: readonly NormalizedRecord[],
  maxGroups = DEFAULT_POLICY.maxDuplicateExamples,
): readonly DuplicateGroup[] => buildDuplicateGroups(
  records,
  'id',
  record => record.id ? normalizeSearchText(record.id) : '',
  maxGroups,
);

export const detectSemanticDuplicates = (
  records: readonly NormalizedRecord[],
  maxGroups = DEFAULT_POLICY.maxDuplicateExamples,
): readonly DuplicateGroup[] => buildDuplicateGroups(
  records,
  'semantic',
  createSemanticIdentityKey,
  maxGroups,
);

const issue = (
  record: NormalizedRecord,
  code: string,
  severity: IntegritySeverity,
  disposition: IntegrityDisposition,
  detail: string,
  field: string | null = null,
): IntegrityRecordIssue => Object.freeze({
  code,
  severity,
  disposition,
  recordKey: createIntegrityRecordKey(record),
  sourceIndex: record.sourceIndex,
  field,
  detail,
});

const worseDisposition = (left: IntegrityDisposition, right: IntegrityDisposition): IntegrityDisposition => {
  const rank: Readonly<Record<IntegrityDisposition, number>> = { accept: 0, quarantine: 1, reject: 2 };
  return rank[right] > rank[left] ? right : left;
};

const decideRecord = (
  record: NormalizedRecord,
  policy: Required<IntegrityPolicy>,
  duplicateIdKeys: ReadonlySet<string>,
  duplicateSemanticKeys: ReadonlySet<string>,
  encodingKeys: ReadonlySet<string>,
): IntegrityRecordDecision => {
  const issues: IntegrityRecordIssue[] = [];
  if (!normalizeText(record.title)) {
    issues.push(issue(
      record,
      'missing-title',
      'error',
      policy.rejectMissingTitle ? 'reject' : 'quarantine',
      'Record has no usable title',
      'title',
    ));
  }
  if (!record.id) {
    issues.push(issue(
      record,
      'missing-id',
      policy.rejectMissingId ? 'error' : 'warning',
      policy.rejectMissingId ? 'reject' : 'accept',
      'Record has no stable source id and relies on fingerprint identity',
      'id',
    ));
  }
  if (duplicateIdKeys.has(normalizeSearchText(record.id))) {
    issues.push(issue(
      record,
      'duplicate-id',
      'error',
      policy.quarantineDuplicateIds ? 'quarantine' : 'accept',
      'Multiple normalized records share the same source id',
      'id',
    ));
  }
  if (duplicateSemanticKeys.has(createSemanticIdentityKey(record))) {
    issues.push(issue(
      record,
      'semantic-duplicate',
      'warning',
      policy.quarantineSemanticDuplicates ? 'quarantine' : 'accept',
      'Record has a duplicate canonical semantic identity',
    ));
  }
  const recordKey = createIntegrityRecordKey(record);
  if (encodingKeys.has(recordKey)) {
    issues.push(issue(
      record,
      'encoding-anomaly',
      'warning',
      policy.quarantineEncodingAnomalies ? 'quarantine' : 'accept',
      'One or more raw text fields contain suspicious encoding/control characters',
    ));
  }
  if (policy.rejectInvalidCoordinate && record.coordinates === null) {
    const hasCoordinateHints = ['latitude', 'longitude', 'lat', 'lng', 'x', 'y']
      .some(key => record.fields[key] !== null && record.fields[key] !== undefined && record.fields[key] !== '');
    if (hasCoordinateHints) {
      issues.push(issue(
        record,
        'invalid-coordinate',
        'error',
        'reject',
        'Record contains coordinate-like fields but no valid normalized coordinate pair',
      ));
    }
  }
  let disposition: IntegrityDisposition = 'accept';
  for (const item of issues) disposition = worseDisposition(disposition, item.disposition);
  return Object.freeze({
    record,
    recordKey,
    disposition,
    issues: Object.freeze(issues),
  });
};

const increment = (target: Record<string, number>, key: string): void => {
  target[key] = (target[key] ?? 0) + 1;
};

export const evaluateDataIntegrity = (
  input: unknown,
  options: RecordNormalizationOptions & { readonly policy?: IntegrityPolicy } = {},
): IntegrityResult => {
  const policy = normalizeIntegrityPolicy(options.policy);
  const normalized = normalizeRecordCollection(input, options);
  const records = normalized.records;
  const duplicateIdGroups = detectDuplicateIds(records, policy.maxDuplicateExamples);
  const semanticDuplicateGroups = detectSemanticDuplicates(records, policy.maxDuplicateExamples);
  const encodingAnomalies = detectEncodingAnomalies(records);
  const duplicateIdKeys = new Set(duplicateIdGroups.map(group => group.key));
  const duplicateSemanticKeys = new Set(semanticDuplicateGroups.map(group => group.key));
  const encodingKeys = new Set(encodingAnomalies.map(anomaly => anomaly.recordKey));
  const decisions = records.map(record => decideRecord(
    record,
    policy,
    duplicateIdKeys,
    duplicateSemanticKeys,
    encodingKeys,
  ));
  const accepted = decisions.filter(item => item.disposition === 'accept').map(item => item.record);
  const quarantined = decisions.filter(item => item.disposition === 'quarantine').map(item => item.record);
  const rejected = decisions.filter(item => item.disposition === 'reject').map(item => item.record);
  const issueCounts: Record<string, number> = {};
  const severityCounts: Record<IntegritySeverity, number> = { info: 0, warning: 0, error: 0, critical: 0 };
  let errorIssues = 0;
  for (const decision of decisions) {
    for (const item of decision.issues) {
      increment(issueCounts, item.code);
      severityCounts[item.severity] += 1;
      if (item.severity === 'error' || item.severity === 'critical') errorIssues += 1;
    }
  }
  const inputCount = Array.isArray(input) ? input.length : 0;
  const quarantineRatio = records.length ? quarantined.length / records.length : 0;
  const errorRatio = records.length ? Math.min(1, errorIssues / records.length) : 0;
  const releaseReady = rejected.length === 0
    && errorRatio <= policy.maxErrorRatio
    && quarantineRatio <= policy.maxQuarantineRatio;
  const fingerprint = hashFingerprint(stableSerialize({
    inputCount,
    normalizedCount: records.length,
    accepted: accepted.map(createIntegrityRecordKey),
    quarantined: quarantined.map(createIntegrityRecordKey),
    rejected: rejected.map(createIntegrityRecordKey),
    issueCounts,
    releaseReady,
  }));
  const maxDetails = policy.maxIssueDetails;
  const limitedDecisions = maxDetails === 0
    ? decisions.map(decision => Object.freeze({ ...decision, issues: Object.freeze([]) }))
    : decisions.map(decision => Object.freeze({
      ...decision,
      issues: Object.freeze(decision.issues.slice(0, maxDetails)),
    }));
  const report: IntegrityReport = Object.freeze({
    inputCount,
    normalizedCount: records.length,
    acceptedCount: accepted.length,
    quarantinedCount: quarantined.length,
    rejectedCount: rejected.length,
    acceptedRatio: records.length ? accepted.length / records.length : 1,
    quarantineRatio,
    errorRatio,
    duplicateIdGroups,
    semanticDuplicateGroups,
    encodingAnomalies,
    issueCounts: Object.freeze(issueCounts),
    severityCounts: Object.freeze(severityCounts),
    decisions: Object.freeze(limitedDecisions),
    normalizationIssues: Object.freeze(normalized.quality.issues),
    releaseReady,
    fingerprint,
  });
  return Object.freeze({
    accepted: Object.freeze(accepted),
    quarantined: Object.freeze(quarantined),
    rejected: Object.freeze(rejected),
    report,
  });
};

export const summarizeIntegrityForRelease = (report: IntegrityReport): Readonly<Record<string, unknown>> => Object.freeze({
  fingerprint: report.fingerprint,
  releaseReady: report.releaseReady,
  inputCount: report.inputCount,
  normalizedCount: report.normalizedCount,
  acceptedCount: report.acceptedCount,
  quarantinedCount: report.quarantinedCount,
  rejectedCount: report.rejectedCount,
  quarantineRatio: report.quarantineRatio,
  errorRatio: report.errorRatio,
  duplicateIdGroupCount: report.duplicateIdGroups.length,
  semanticDuplicateGroupCount: report.semanticDuplicateGroups.length,
  encodingAnomalyCount: report.encodingAnomalies.length,
  severityCounts: report.severityCounts,
});
