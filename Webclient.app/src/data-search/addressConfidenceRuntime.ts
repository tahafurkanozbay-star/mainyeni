import type { Coordinate, GeocodeCandidate } from './contracts';
import type {
  AddressHierarchyLevel,
  AddressHierarchyMatch,
  AddressHierarchyNode,
  AddressHierarchyRuntime,
} from './addressHierarchyRuntime';
import { canonicalizeAddressText, normalizeDoorToken } from './addressSemantics';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import { haversineDistanceMeters } from './spatialIndex';

export const ADDRESS_CONFIDENCE_VERSION = '2026-09-24.v3';

export type AddressConfidenceStatus = 'trusted' | 'ambiguous' | 'rejected';

export interface AddressConfidencePolicy {
  readonly trustedThreshold?: number;
  readonly ambiguousThreshold?: number;
  readonly coordinateToleranceMeters?: number;
  readonly maxCoordinateDistanceMeters?: number;
  readonly maxCandidates?: number;
  readonly requireHierarchyForTrusted?: boolean;
  readonly providerWeight?: number;
  readonly hierarchyWeight?: number;
  readonly fieldWeight?: number;
  readonly coordinateWeight?: number;
}

export interface AddressCandidateFields {
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly building: string;
  readonly door: string;
}

export interface AddressFieldEvidence {
  readonly field: keyof AddressCandidateFields;
  readonly candidateValue: string;
  readonly hierarchyValue: string;
  readonly matched: boolean;
}

export interface AddressConfidenceEvaluation {
  readonly version: string;
  readonly candidate: GeocodeCandidate;
  readonly status: AddressConfidenceStatus;
  readonly confidence: number;
  readonly providerScore: number;
  readonly hierarchyScore: number;
  readonly fieldScore: number;
  readonly coordinateScore: number;
  readonly hierarchyMatch: AddressHierarchyMatch | null;
  readonly hierarchyPath: readonly AddressHierarchyNode[];
  readonly candidateFields: AddressCandidateFields;
  readonly fieldEvidence: readonly AddressFieldEvidence[];
  readonly matchedFieldCount: number;
  readonly mismatchedFieldCount: number;
  readonly distanceMeters: number | null;
  readonly coordinateConflict: boolean;
  readonly reasons: readonly string[];
  readonly fingerprint: string;
}

export interface AddressConfidenceBatch {
  readonly version: string;
  readonly evaluations: readonly AddressConfidenceEvaluation[];
  readonly trustedCount: number;
  readonly ambiguousCount: number;
  readonly rejectedCount: number;
  readonly coordinateConflictCount: number;
  readonly hierarchyMissCount: number;
  readonly truncated: boolean;
  readonly fingerprint: string;
}

interface NormalizedConfidencePolicy {
  readonly trustedThreshold: number;
  readonly ambiguousThreshold: number;
  readonly coordinateToleranceMeters: number;
  readonly maxCoordinateDistanceMeters: number;
  readonly maxCandidates: number;
  readonly requireHierarchyForTrusted: boolean;
  readonly providerWeight: number;
  readonly hierarchyWeight: number;
  readonly fieldWeight: number;
  readonly coordinateWeight: number;
}

const DISTRICT_ALIASES = Object.freeze([
  'district', 'District', 'DISTRICT', 'ilce', 'Ilce', 'ILCE', 'ilceAdi', 'ILCE_ADI',
] as const);
const NEIGHBORHOOD_ALIASES = Object.freeze([
  'neighborhood', 'Neighborhood', 'NEIGHBORHOOD', 'mahalle', 'Mahalle', 'MAHALLE',
  'mahalleAdi', 'MAHALLE_ADI', 'Nbrhd',
] as const);
const STREET_ALIASES = Object.freeze([
  'street', 'Street', 'STREET', 'yol', 'YOL', 'yolAdi', 'YOL_ADI', 'cadde', 'CADDE',
  'StAddr', 'StreetName',
] as const);
const BUILDING_ALIASES = Object.freeze([
  'building', 'Building', 'BUILDING', 'bina', 'BINA', 'apartman', 'APARTMAN', 'site', 'SITE',
  'blok', 'BLOK', 'BuildingName', 'BUILDING_NAME',
] as const);
const DOOR_ALIASES = Object.freeze([
  'door', 'Door', 'DOOR', 'kapi', 'KAPI', 'kapiNo', 'KAPI_NO', 'AddNum', 'HouseNumber',
] as const);

const clamp = (value: number, minimum = 0, maximum = 100): number =>
  Math.max(minimum, Math.min(maximum, value));

const normalizeWeight = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(10, parsed) : fallback;
};

const normalizePolicy = (policy: AddressConfidencePolicy = {}): NormalizedConfidencePolicy => {
  const trustedThreshold = normalizeInteger(policy.trustedThreshold, { min: 1, max: 100, fallback: 80 });
  const ambiguousThreshold = normalizeInteger(policy.ambiguousThreshold, {
    min: 0,
    max: trustedThreshold,
    fallback: Math.min(55, trustedThreshold),
  });
  const coordinateToleranceMeters = normalizeInteger(policy.coordinateToleranceMeters, {
    min: 1,
    max: 100_000,
    fallback: 100,
  });
  return Object.freeze({
    trustedThreshold,
    ambiguousThreshold,
    coordinateToleranceMeters,
    maxCoordinateDistanceMeters: normalizeInteger(policy.maxCoordinateDistanceMeters, {
      min: coordinateToleranceMeters,
      max: 1_000_000,
      fallback: Math.max(5_000, coordinateToleranceMeters * 10),
    }),
    maxCandidates: normalizeInteger(policy.maxCandidates, { min: 1, max: 10_000, fallback: 250 }),
    requireHierarchyForTrusted: policy.requireHierarchyForTrusted !== false,
    providerWeight: normalizeWeight(policy.providerWeight, 0.25),
    hierarchyWeight: normalizeWeight(policy.hierarchyWeight, 0.30),
    fieldWeight: normalizeWeight(policy.fieldWeight, 0.25),
    coordinateWeight: normalizeWeight(policy.coordinateWeight, 0.20),
  });
};

const firstAttributeText = (
  candidate: GeocodeCandidate,
  aliases: readonly string[],
): string => {
  for (const alias of aliases) {
    const value = candidate.attributes[alias];
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
};

export const extractAddressCandidateFields = (
  candidate: GeocodeCandidate,
): AddressCandidateFields => Object.freeze({
  district: firstAttributeText(candidate, DISTRICT_ALIASES),
  neighborhood: firstAttributeText(candidate, NEIGHBORHOOD_ALIASES),
  street: firstAttributeText(candidate, STREET_ALIASES),
  building: firstAttributeText(candidate, BUILDING_ALIASES),
  door: normalizeDoorToken(firstAttributeText(candidate, DOOR_ALIASES)),
});

const deepestTarget = (
  fields: AddressCandidateFields,
  label: string,
): Readonly<{ level: AddressHierarchyLevel | null; value: string }> => {
  if (fields.door) return Object.freeze({ level: 'door', value: fields.door });
  if (fields.building) return Object.freeze({ level: 'building', value: fields.building });
  if (fields.street) return Object.freeze({ level: 'street', value: fields.street });
  if (fields.neighborhood) return Object.freeze({ level: 'neighborhood', value: fields.neighborhood });
  if (fields.district) return Object.freeze({ level: 'district', value: fields.district });
  return Object.freeze({ level: null, value: normalizeText(label) });
};

const pathValue = (
  path: readonly AddressHierarchyNode[],
  level: AddressHierarchyLevel,
): string => path.find(node => node.level === level)?.name ?? '';

const canonicalField = (
  field: keyof AddressCandidateFields,
  value: string,
): string => field === 'door'
  ? normalizeSearchText(normalizeDoorToken(value)).replace(/[^a-z0-9/-]+/g, '')
  : canonicalizeAddressText(value);

const compareFields = (
  fields: AddressCandidateFields,
  path: readonly AddressHierarchyNode[],
): readonly AddressFieldEvidence[] => {
  const result: AddressFieldEvidence[] = [];
  const keys: readonly (keyof AddressCandidateFields)[] = [
    'district', 'neighborhood', 'street', 'building', 'door',
  ];
  for (const field of keys) {
    const candidateValue = fields[field];
    if (!candidateValue) continue;
    const hierarchyValue = pathValue(path, field);
    const candidateCanonical = canonicalField(field, candidateValue);
    const hierarchyCanonical = canonicalField(field, hierarchyValue);
    result.push(Object.freeze({
      field,
      candidateValue,
      hierarchyValue,
      matched: Boolean(candidateCanonical) && candidateCanonical === hierarchyCanonical,
    }));
  }
  return Object.freeze(result);
};

const findHierarchyMatch = (
  candidate: GeocodeCandidate,
  fields: AddressCandidateFields,
  hierarchy: AddressHierarchyRuntime,
): AddressHierarchyMatch | null => {
  const target = deepestTarget(fields, candidate.label);
  if (!target.value) return null;
  const matches = hierarchy.resolve(target.value, {
    level: target.level,
    district: fields.district || null,
    neighborhood: fields.neighborhood || null,
    street: fields.street || null,
    center: candidate.coordinates,
    limit: 8,
    minimumScore: 1,
    requireHierarchyMatch: false,
  });
  return matches[0] ?? null;
};

const hierarchyComponent = (match: AddressHierarchyMatch | null): number => {
  if (!match) return 0;
  let score = 0;
  if (match.exact) score += 55;
  else if (match.prefix) score += 40;
  score += clamp(match.textScore / 12, 0, 30);
  score += clamp(match.hierarchyScore / 8, 0, 15);
  return Math.round(clamp(score));
};

const fieldComponent = (
  evidence: readonly AddressFieldEvidence[],
): Readonly<{ score: number; matched: number; mismatched: number }> => {
  if (evidence.length === 0) return Object.freeze({ score: 35, matched: 0, mismatched: 0 });
  const matched = evidence.filter(item => item.matched).length;
  const mismatched = evidence.length - matched;
  const score = Math.round((matched / evidence.length) * 100);
  return Object.freeze({ score, matched, mismatched });
};

const coordinateComponent = (
  candidateCoordinates: Coordinate | null,
  nodeCoordinates: Coordinate | null,
  policy: NormalizedConfidencePolicy,
): Readonly<{ score: number; distanceMeters: number | null; conflict: boolean }> => {
  if (!candidateCoordinates && !nodeCoordinates) {
    return Object.freeze({ score: 50, distanceMeters: null, conflict: false });
  }
  if (!candidateCoordinates || !nodeCoordinates) {
    return Object.freeze({ score: 40, distanceMeters: null, conflict: false });
  }
  const distance = haversineDistanceMeters(candidateCoordinates, nodeCoordinates);
  if (distance === null) return Object.freeze({ score: 0, distanceMeters: null, conflict: true });
  if (distance <= policy.coordinateToleranceMeters) {
    const ratio = distance / Math.max(1, policy.coordinateToleranceMeters);
    return Object.freeze({ score: Math.round(100 - ratio * 20), distanceMeters: distance, conflict: false });
  }
  const conflict = distance > policy.maxCoordinateDistanceMeters;
  const span = Math.max(1, policy.maxCoordinateDistanceMeters - policy.coordinateToleranceMeters);
  const ratio = clamp((distance - policy.coordinateToleranceMeters) / span, 0, 1);
  return Object.freeze({
    score: Math.round(80 * (1 - ratio)),
    distanceMeters: distance,
    conflict,
  });
};

const weightedConfidence = (
  providerScore: number,
  hierarchyScore: number,
  fieldScore: number,
  coordinateScore: number,
  policy: NormalizedConfidencePolicy,
): number => {
  const weights = [
    policy.providerWeight,
    policy.hierarchyWeight,
    policy.fieldWeight,
    policy.coordinateWeight,
  ];
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) return 0;
  return Math.round(clamp((
    providerScore * policy.providerWeight
    + hierarchyScore * policy.hierarchyWeight
    + fieldScore * policy.fieldWeight
    + coordinateScore * policy.coordinateWeight
  ) / totalWeight));
};

const confidenceStatus = (
  confidence: number,
  providerScore: number,
  hierarchyMatch: AddressHierarchyMatch | null,
  coordinateConflict: boolean,
  mismatchedFields: number,
  policy: NormalizedConfidencePolicy,
): AddressConfidenceStatus => {
  const hierarchyAllowed = !policy.requireHierarchyForTrusted || hierarchyMatch !== null;
  const providerEvidenceTrusted = providerScore >= policy.trustedThreshold;
  if (confidence >= policy.trustedThreshold
    && providerEvidenceTrusted
    && hierarchyAllowed
    && !coordinateConflict
    && mismatchedFields === 0) return 'trusted';
  if (confidence >= policy.ambiguousThreshold && !coordinateConflict) return 'ambiguous';
  return 'rejected';
};

const buildReasons = (
  status: AddressConfidenceStatus,
  match: AddressHierarchyMatch | null,
  fieldEvidence: readonly AddressFieldEvidence[],
  coordinateConflict: boolean,
  distanceMeters: number | null,
): readonly string[] => {
  const reasons: string[] = [`status:${status}`];
  if (match) {
    reasons.push(`hierarchy:${match.node.level}`);
    if (match.exact) reasons.push('hierarchy-exact');
    if (match.prefix) reasons.push('hierarchy-prefix');
  } else {
    reasons.push('hierarchy-miss');
  }
  const matched = fieldEvidence.filter(item => item.matched).length;
  const mismatched = fieldEvidence.length - matched;
  if (matched > 0) reasons.push(`field-match:${matched}`);
  if (mismatched > 0) reasons.push(`field-mismatch:${mismatched}`);
  if (coordinateConflict) reasons.push('coordinate-conflict');
  else if (distanceMeters !== null) reasons.push('coordinate-consistent');
  return Object.freeze(reasons);
};

export const evaluateAddressCandidateConfidence = (
  candidate: GeocodeCandidate,
  hierarchy: AddressHierarchyRuntime,
  policyInput: AddressConfidencePolicy = {},
): AddressConfidenceEvaluation => {
  const policy = normalizePolicy(policyInput);
  const candidateFields = extractAddressCandidateFields(candidate);
  const hierarchyMatch = findHierarchyMatch(candidate, candidateFields, hierarchy);
  const hierarchyPath = hierarchyMatch
    ? Object.freeze(hierarchy.getPath(hierarchyMatch.node.key))
    : Object.freeze([] as AddressHierarchyNode[]);
  const fieldEvidence = compareFields(candidateFields, hierarchyPath);
  const fields = fieldComponent(fieldEvidence);
  const coordinates = coordinateComponent(
    candidate.coordinates,
    hierarchyMatch?.node.coordinates ?? null,
    policy,
  );
  const providerScore = Math.round(clamp(candidate.score));
  const hierarchyScore = hierarchyComponent(hierarchyMatch);
  const confidence = weightedConfidence(
    providerScore,
    hierarchyScore,
    fields.score,
    coordinates.score,
    policy,
  );
  const status = confidenceStatus(
    confidence,
    providerScore,
    hierarchyMatch,
    coordinates.conflict,
    fields.mismatched,
    policy,
  );
  const reasons = buildReasons(
    status,
    hierarchyMatch,
    fieldEvidence,
    coordinates.conflict,
    coordinates.distanceMeters,
  );
  const fingerprint = hashFingerprint(stableSerialize({
    version: ADDRESS_CONFIDENCE_VERSION,
    candidate: candidate.fingerprint,
    status,
    confidence,
    hierarchy: hierarchyMatch?.node.fingerprint ?? null,
    fieldEvidence: fieldEvidence.map(item => ({ field: item.field, matched: item.matched })),
    distanceMeters: coordinates.distanceMeters === null ? null : Math.round(coordinates.distanceMeters),
  }));
  return Object.freeze({
    version: ADDRESS_CONFIDENCE_VERSION,
    candidate,
    status,
    confidence,
    providerScore,
    hierarchyScore,
    fieldScore: fields.score,
    coordinateScore: coordinates.score,
    hierarchyMatch,
    hierarchyPath,
    candidateFields,
    fieldEvidence,
    matchedFieldCount: fields.matched,
    mismatchedFieldCount: fields.mismatched,
    distanceMeters: coordinates.distanceMeters,
    coordinateConflict: coordinates.conflict,
    reasons,
    fingerprint,
  });
};

const evaluationIdentity = (evaluation: AddressConfidenceEvaluation): string => {
  const label = canonicalizeAddressText(evaluation.candidate.label);
  const node = evaluation.hierarchyMatch?.node.key ?? '';
  if (node) return `node:${node}`;
  if (label) return `label:${label}`;
  return `candidate:${evaluation.candidate.fingerprint}`;
};

const betterEvaluation = (
  left: AddressConfidenceEvaluation,
  right: AddressConfidenceEvaluation,
): AddressConfidenceEvaluation => {
  const statusRank: Readonly<Record<AddressConfidenceStatus, number>> = Object.freeze({
    trusted: 3,
    ambiguous: 2,
    rejected: 1,
  });
  const rightIsBetter = statusRank[right.status] > statusRank[left.status]
    || (right.status === left.status && right.confidence > left.confidence)
    || (right.status === left.status
      && right.confidence === left.confidence
      && right.providerScore > left.providerScore)
    || (right.status === left.status
      && right.confidence === left.confidence
      && right.providerScore === left.providerScore
      && right.fingerprint.localeCompare(left.fingerprint, 'en') < 0);
  return rightIsBetter ? right : left;
};

export const rankAddressCandidatesByConfidence = (
  candidates: readonly GeocodeCandidate[],
  hierarchy: AddressHierarchyRuntime,
  policyInput: AddressConfidencePolicy = {},
): AddressConfidenceBatch => {
  const policy = normalizePolicy(policyInput);
  const truncated = candidates.length > policy.maxCandidates;
  const limited = candidates.slice(0, policy.maxCandidates);
  const byIdentity = new Map<string, AddressConfidenceEvaluation>();
  for (const candidate of limited) {
    const evaluation = evaluateAddressCandidateConfidence(candidate, hierarchy, policy);
    const identity = evaluationIdentity(evaluation);
    const current = byIdentity.get(identity);
    byIdentity.set(identity, current ? betterEvaluation(current, evaluation) : evaluation);
  }
  const evaluations = Object.freeze([...byIdentity.values()].sort((left, right) => {
    const statusRank: Readonly<Record<AddressConfidenceStatus, number>> = Object.freeze({
      trusted: 3,
      ambiguous: 2,
      rejected: 1,
    });
    return statusRank[right.status] - statusRank[left.status]
      || right.confidence - left.confidence
      || right.providerScore - left.providerScore
      || left.candidate.label.localeCompare(right.candidate.label, 'tr-TR', { sensitivity: 'base', numeric: true })
      || left.fingerprint.localeCompare(right.fingerprint, 'en');
  }));
  const batchFingerprint = hashFingerprint(stableSerialize({
    version: ADDRESS_CONFIDENCE_VERSION,
    hierarchy: hierarchy.snapshot().fingerprint,
    evaluations: evaluations.map(item => ({ fingerprint: item.fingerprint, status: item.status })),
    truncated,
  }));
  return Object.freeze({
    version: ADDRESS_CONFIDENCE_VERSION,
    evaluations,
    trustedCount: evaluations.filter(item => item.status === 'trusted').length,
    ambiguousCount: evaluations.filter(item => item.status === 'ambiguous').length,
    rejectedCount: evaluations.filter(item => item.status === 'rejected').length,
    coordinateConflictCount: evaluations.filter(item => item.coordinateConflict).length,
    hierarchyMissCount: evaluations.filter(item => item.hierarchyMatch === null).length,
    truncated,
    fingerprint: batchFingerprint,
  });
};
