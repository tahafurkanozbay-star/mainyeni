import { TextHelper } from '../../Toolbox/TextHelper';
import type {
  BusinessRuntimePolicy,
  SqlPredicatePlan,
} from './contracts';
import { BusinessQueryPlanError } from './contracts';
import {
  normalizeIdentifierList,
  normalizeLegacyIdentifier,
  normalizeNullableText,
} from './input';
import { DEFAULT_BUSINESS_RUNTIME_POLICY } from './policy';

export const escapeSqlLiteral = (value: unknown): string =>
  String(value ?? '').replace(/'/gu, "''");

export const quoteSqlLiteral = (value: unknown): string =>
  `'${escapeSqlLiteral(value)}'`;

const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const assertSqlField = (field: string): string => {
  if (!fieldPattern.test(field)) {
    throw new BusinessQueryPlanError(
      'BUSINESS_SQL_FIELD_INVALID',
      'SQL alan adı güvenli değil.',
      Object.freeze({ field }),
    );
  }
  return field;
};

export const equalsPredicate = (
  field: string,
  value: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): string | null => {
  const normalized = normalizeLegacyIdentifier(value, policy);
  if (!normalized) return null;
  return `${assertSqlField(field)}=${quoteSqlLiteral(normalized.value)}`;
};

export const numericEqualsPredicate = (
  field: string,
  value: unknown,
): string | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return `${assertSqlField(field)}=${numeric}`;
};

export const inPredicate = (
  field: string,
  values: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): string | null => {
  const normalized = normalizeIdentifierList(values, policy);
  if (normalized.values.length === 0) return null;
  return `${assertSqlField(field)} IN (${normalized.values.map(quoteSqlLiteral).join(',')})`;
};

export const upperContainsPredicate = (
  field: string,
  value: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): string | null => {
  const normalized = normalizeNullableText(value, policy.maxTextLength);
  if (!normalized) return null;
  const upper = TextHelper.TurkishToUpper(normalized) ?? normalized.toUpperCase();
  return `UPPER(${assertSqlField(field)}) LIKE '%${escapeSqlLiteral(upper)}%'`;
};

export const asciiUpperContainsPredicate = (
  field: string,
  value: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): string | null => {
  const normalized = normalizeNullableText(value, policy.maxTextLength);
  if (!normalized) return null;
  const upper = TextHelper.TurkishToUpper(normalized) ?? normalized.toUpperCase();
  const ascii = TextHelper.RemoveTurkishChars(upper);
  return `UPPER(${assertSqlField(field)}) LIKE '%${escapeSqlLiteral(ascii)}%'`;
};

export const compilePredicatePlan = (
  predicates: readonly (string | null | undefined | false)[],
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
  fallback = '1=1',
): SqlPredicatePlan => {
  const accepted: string[] = [];
  let currentLength = 0;
  let truncated = false;

  for (const predicate of predicates) {
    if (!predicate) continue;
    const normalized = String(predicate).trim();
    if (!normalized) continue;
    const separatorLength = accepted.length === 0 ? 0 : 5;
    if (currentLength + separatorLength + normalized.length > policy.maxWhereLength) {
      truncated = true;
      break;
    }
    accepted.push(normalized);
    currentLength += separatorLength + normalized.length;
  }

  const where = accepted.length > 0 ? accepted.join(' AND ') : fallback;
  return Object.freeze({
    predicates: Object.freeze(accepted),
    where,
    truncated,
  });
};

export const compileRequiredPredicatePlan = (
  predicates: readonly (string | null | undefined | false)[],
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
  fallback = '1=1',
): SqlPredicatePlan => {
  const plan = compilePredicatePlan(predicates, policy, fallback);
  if (plan.truncated) {
    throw new BusinessQueryPlanError(
      'BUSINESS_WHERE_LIMIT_EXCEEDED',
      'Sorgu filtresi güvenli uzunluk sınırını aştı.',
      Object.freeze({ maxWhereLength: policy.maxWhereLength }),
    );
  }
  return plan;
};

export const routeTypePredicate = (
  showCultureWalkingRoute: boolean,
  showNatureWalkingRoute: boolean,
  hasObjectId: boolean,
): readonly string[] => {
  if (hasObjectId) return Object.freeze([]);
  const predicates: string[] = [];
  if (!showCultureWalkingRoute) predicates.push('tip <> 1');
  if (!showNatureWalkingRoute) predicates.push('tip <> 2');
  return Object.freeze(predicates);
};
