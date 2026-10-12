import type { UnknownRecord } from '../../../Business/contracts';
import {
  hashFingerprint,
  normalizeInteger,
  stableSerialize,
} from '../../../data-search/normalization';

export interface GeneralSearchResponseIntegrityPolicyV11 {
  readonly maximumKeysPerRecord?: number;
  readonly maximumStringCharacters?: number;
  readonly maximumArrayItems?: number;
  readonly maximumAggregateStringCharacters?: number;
  readonly maximumAggregateArrayItems?: number;
  readonly maximumViolations?: number;
}

export type GeneralSearchResponseIntegrityViolationCodeV11 =
  | 'record-key-budget'
  | 'string-size-budget'
  | 'array-size-budget'
  | 'aggregate-string-budget'
  | 'aggregate-array-budget';

export interface GeneralSearchResponseIntegrityViolationV11 {
  readonly recordIndex: number;
  readonly field: string;
  readonly code: GeneralSearchResponseIntegrityViolationCodeV11;
  readonly observed: number;
  readonly maximum: number;
}

export interface GeneralSearchRecordSurfaceV11 {
  readonly recordIndex: number;
  readonly keyCount: number;
  readonly stringCharacters: number;
  readonly arrayItems: number;
  readonly oversizedStrings: number;
  readonly oversizedArrays: number;
}

export interface GeneralSearchResponseIntegrityReportV11 {
  readonly accepted: boolean;
  readonly recordCount: number;
  readonly inspectedRecords: number;
  readonly totalKeys: number;
  readonly totalStringCharacters: number;
  readonly totalArrayItems: number;
  readonly violations: readonly GeneralSearchResponseIntegrityViolationV11[];
  readonly violationCount: number;
  readonly violationOverflow: boolean;
  readonly fingerprint: string;
}

interface NormalizedIntegrityPolicyV11 {
  readonly maximumKeysPerRecord: number;
  readonly maximumStringCharacters: number;
  readonly maximumArrayItems: number;
  readonly maximumAggregateStringCharacters: number;
  readonly maximumAggregateArrayItems: number;
  readonly maximumViolations: number;
}

interface MutableIntegrityTotalsV11 {
  totalKeys: number;
  totalStringCharacters: number;
  totalArrayItems: number;
  inspectedRecords: number;
}

const normalizePolicy = (
  input: GeneralSearchResponseIntegrityPolicyV11 = {},
): NormalizedIntegrityPolicyV11 => Object.freeze({
  maximumKeysPerRecord: normalizeInteger(input.maximumKeysPerRecord, {
    min: 8,
    max: 4_096,
    fallback: 512,
  }),
  maximumStringCharacters: normalizeInteger(input.maximumStringCharacters, {
    min: 256,
    max: 1_000_000,
    fallback: 65_536,
  }),
  maximumArrayItems: normalizeInteger(input.maximumArrayItems, {
    min: 1,
    max: 100_000,
    fallback: 10_000,
  }),
  maximumAggregateStringCharacters: normalizeInteger(
    input.maximumAggregateStringCharacters,
    {
      min: 1_024,
      max: 128_000_000,
      fallback: 16_000_000,
    },
  ),
  maximumAggregateArrayItems: normalizeInteger(
    input.maximumAggregateArrayItems,
    {
      min: 1,
      max: 10_000_000,
      fallback: 500_000,
    },
  ),
  maximumViolations: normalizeInteger(input.maximumViolations, {
    min: 1,
    max: 10_000,
    fallback: 128,
  }),
});

const appendViolation = (
  target: GeneralSearchResponseIntegrityViolationV11[],
  maximumCount: number,
  violation: GeneralSearchResponseIntegrityViolationV11,
): boolean => {
  if (target.length >= maximumCount) return false;
  target.push(Object.freeze(violation));
  return true;
};

const inspectField = (
  recordIndex: number,
  field: string,
  value: unknown,
  policy: NormalizedIntegrityPolicyV11,
  violations: GeneralSearchResponseIntegrityViolationV11[],
): Readonly<{
  stringCharacters: number;
  arrayItems: number;
  oversizedString: boolean;
  oversizedArray: boolean;
  overflowedViolationBudget: boolean;
}> => {
  if (typeof value === 'string') {
    const length = value.length;
    const oversized = length > policy.maximumStringCharacters;
    const recorded = !oversized || appendViolation(
      violations,
      policy.maximumViolations,
      {
        recordIndex,
        field,
        code: 'string-size-budget',
        observed: length,
        maximum: policy.maximumStringCharacters,
      },
    );
    return Object.freeze({
      stringCharacters: length,
      arrayItems: 0,
      oversizedString: oversized,
      oversizedArray: false,
      overflowedViolationBudget: oversized && !recorded,
    });
  }

  if (Array.isArray(value)) {
    const length = value.length;
    const oversized = length > policy.maximumArrayItems;
    const recorded = !oversized || appendViolation(
      violations,
      policy.maximumViolations,
      {
        recordIndex,
        field,
        code: 'array-size-budget',
        observed: length,
        maximum: policy.maximumArrayItems,
      },
    );
    return Object.freeze({
      stringCharacters: 0,
      arrayItems: length,
      oversizedString: false,
      oversizedArray: oversized,
      overflowedViolationBudget: oversized && !recorded,
    });
  }

  return Object.freeze({
    stringCharacters: 0,
    arrayItems: 0,
    oversizedString: false,
    oversizedArray: false,
    overflowedViolationBudget: false,
  });
};

export const inspectGeneralSearchRecordSurfaceV11 = (
  record: UnknownRecord,
  recordIndex: number,
  policyInput: GeneralSearchResponseIntegrityPolicyV11 = {},
  existingViolations: GeneralSearchResponseIntegrityViolationV11[] = [],
): Readonly<{
  surface: GeneralSearchRecordSurfaceV11;
  overflowedViolationBudget: boolean;
}> => {
  const policy = normalizePolicy(policyInput);
  const entries = Object.entries(record);
  let stringCharacters = 0;
  let arrayItems = 0;
  let oversizedStrings = 0;
  let oversizedArrays = 0;
  let overflowedViolationBudget = false;

  if (entries.length > policy.maximumKeysPerRecord) {
    const recorded = appendViolation(
      existingViolations,
      policy.maximumViolations,
      {
        recordIndex,
        field: '*',
        code: 'record-key-budget',
        observed: entries.length,
        maximum: policy.maximumKeysPerRecord,
      },
    );
    overflowedViolationBudget ||= !recorded;
  }

  for (const [field, value] of entries) {
    const fieldResult = inspectField(
      recordIndex,
      field.slice(0, 160),
      value,
      policy,
      existingViolations,
    );
    stringCharacters += fieldResult.stringCharacters;
    arrayItems += fieldResult.arrayItems;
    if (fieldResult.oversizedString) oversizedStrings += 1;
    if (fieldResult.oversizedArray) oversizedArrays += 1;
    overflowedViolationBudget ||= fieldResult.overflowedViolationBudget;
  }

  return Object.freeze({
    surface: Object.freeze({
      recordIndex,
      keyCount: entries.length,
      stringCharacters,
      arrayItems,
      oversizedStrings,
      oversizedArrays,
    }),
    overflowedViolationBudget,
  });
};

const addAggregateViolation = (
  violations: GeneralSearchResponseIntegrityViolationV11[],
  policy: NormalizedIntegrityPolicyV11,
  code: 'aggregate-string-budget' | 'aggregate-array-budget',
  observed: number,
  maximum: number,
): boolean => appendViolation(
  violations,
  policy.maximumViolations,
  {
    recordIndex: -1,
    field: '*',
    code,
    observed,
    maximum,
  },
);

export const auditGeneralSearchResponseIntegrityV11 = (
  records: readonly UnknownRecord[],
  policyInput: GeneralSearchResponseIntegrityPolicyV11 = {},
): GeneralSearchResponseIntegrityReportV11 => {
  const policy = normalizePolicy(policyInput);
  const violations: GeneralSearchResponseIntegrityViolationV11[] = [];
  const totals: MutableIntegrityTotalsV11 = {
    totalKeys: 0,
    totalStringCharacters: 0,
    totalArrayItems: 0,
    inspectedRecords: 0,
  };
  let violationOverflow = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const inspection = inspectGeneralSearchRecordSurfaceV11(
      record,
      index,
      policy,
      violations,
    );
    totals.inspectedRecords += 1;
    totals.totalKeys += inspection.surface.keyCount;
    totals.totalStringCharacters += inspection.surface.stringCharacters;
    totals.totalArrayItems += inspection.surface.arrayItems;
    violationOverflow ||= inspection.overflowedViolationBudget;
  }

  if (totals.totalStringCharacters > policy.maximumAggregateStringCharacters) {
    const recorded = addAggregateViolation(
      violations,
      policy,
      'aggregate-string-budget',
      totals.totalStringCharacters,
      policy.maximumAggregateStringCharacters,
    );
    violationOverflow ||= !recorded;
  }

  if (totals.totalArrayItems > policy.maximumAggregateArrayItems) {
    const recorded = addAggregateViolation(
      violations,
      policy,
      'aggregate-array-budget',
      totals.totalArrayItems,
      policy.maximumAggregateArrayItems,
    );
    violationOverflow ||= !recorded;
  }

  const frozenViolations = Object.freeze(violations);
  const accepted = frozenViolations.length === 0 && !violationOverflow;
  const fingerprint = hashFingerprint(stableSerialize({
    recordCount: records.length,
    inspectedRecords: totals.inspectedRecords,
    totalKeys: totals.totalKeys,
    totalStringCharacters: totals.totalStringCharacters,
    totalArrayItems: totals.totalArrayItems,
    violations: frozenViolations,
    violationOverflow,
  }));

  return Object.freeze({
    accepted,
    recordCount: records.length,
    inspectedRecords: totals.inspectedRecords,
    totalKeys: totals.totalKeys,
    totalStringCharacters: totals.totalStringCharacters,
    totalArrayItems: totals.totalArrayItems,
    violations: frozenViolations,
    violationCount: frozenViolations.length,
    violationOverflow,
    fingerprint,
  });
};

export const summarizeGeneralSearchIntegrityV11 = (
  report: GeneralSearchResponseIntegrityReportV11,
): string => {
  if (report.accepted) return 'response-integrity-ok';
  const codes = Array.from(new Set(report.violations.map(item => item.code)));
  return [
    'response-integrity-blocked',
    ...codes.sort((left, right) => left.localeCompare(right, 'en')),
    report.violationOverflow ? 'violation-overflow' : '',
  ].filter(Boolean).join(':');
};
