import type { Coordinate, GeocodeCandidate, GeocodePage } from './contracts';
import { createAbortError, throwIfAborted } from './contracts';
import { adaptGeocodingPayload } from './geocodingAdapter';
import type {
  ForwardGeocodeRequest,
  GeocodingOperation,
  GeocodingProvider,
  GeocodingProviderContext,
  ReverseGeocodeRequest,
} from './geocodingRuntime';
import { canonicalizeAddressText } from './addressSemantics';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import { haversineDistanceMeters } from './spatialIndex';

export const GEOCODING_CONSENSUS_VERSION = '2026-09-24.v1';

export type GeocodingConsensusFailureKind =
  | 'unsupported'
  | 'timeout'
  | 'aborted'
  | 'provider-error'
  | 'empty-result';

export interface GeocodingConsensusProvider extends GeocodingProvider {
  readonly weight?: number;
  readonly timeoutMs?: number;
}

export interface GeocodingConsensusOptions {
  readonly maxProviders?: number;
  readonly maxConcurrentProviders?: number;
  readonly providerTimeoutMs?: number;
  readonly maxCandidatesPerProvider?: number;
  readonly maxConsensusCandidates?: number;
  readonly maxEvidenceItems?: number;
  readonly coordinateToleranceMeters?: number;
  readonly minimumSuccessfulProviders?: number;
  readonly minimumAgreementProviders?: number;
  readonly allowPartial?: boolean;
}

export interface GeocodingConsensusExecutionOptions {
  readonly signal?: AbortSignal | null;
  readonly providerIds?: readonly string[];
}

export interface GeocodingConsensusProviderFailure {
  readonly providerId: string;
  readonly kind: GeocodingConsensusFailureKind;
}

export interface GeocodingConsensusEvidence {
  readonly providerId: string;
  readonly providerWeight: number;
  readonly candidate: GeocodeCandidate;
}

export interface GeocodingConsensusCandidate {
  readonly key: string;
  readonly label: string;
  readonly canonicalLabel: string;
  readonly representative: GeocodeCandidate;
  readonly providerIds: readonly string[];
  readonly providerCount: number;
  readonly agreementCount: number;
  readonly weightedProviderScore: number;
  readonly agreementScore: number;
  readonly coordinateScore: number;
  readonly confidence: number;
  readonly coordinates: Coordinate | null;
  readonly coordinateSpreadMeters: number;
  readonly coordinateConflict: boolean;
  readonly evidence: readonly GeocodingConsensusEvidence[];
  readonly fingerprint: string;
}

export interface GeocodingConsensusDiagnostics {
  readonly requestedProviders: number;
  readonly eligibleProviders: number;
  readonly successfulProviders: number;
  readonly failedProviders: number;
  readonly timedOutProviders: number;
  readonly abortedProviders: number;
  readonly inputCandidates: number;
  readonly outputCandidates: number;
  readonly evidenceTruncated: boolean;
  readonly candidateTruncated: boolean;
  readonly failures: readonly GeocodingConsensusProviderFailure[];
}

export interface GeocodingConsensusResult {
  readonly version: string;
  readonly operation: GeocodingOperation;
  readonly requestFingerprint: string;
  readonly candidates: readonly GeocodingConsensusCandidate[];
  readonly diagnostics: GeocodingConsensusDiagnostics;
  readonly partial: boolean;
  readonly fingerprint: string;
}

interface NormalizedConsensusOptions {
  readonly maxProviders: number;
  readonly maxConcurrentProviders: number;
  readonly providerTimeoutMs: number;
  readonly maxCandidatesPerProvider: number;
  readonly maxConsensusCandidates: number;
  readonly maxEvidenceItems: number;
  readonly coordinateToleranceMeters: number;
  readonly minimumSuccessfulProviders: number;
  readonly minimumAgreementProviders: number;
  readonly allowPartial: boolean;
}

interface ProviderExecutionSuccess {
  readonly ok: true;
  readonly providerId: string;
  readonly providerWeight: number;
  readonly page: GeocodePage;
}

interface ProviderExecutionFailure {
  readonly ok: false;
  readonly providerId: string;
  readonly kind: GeocodingConsensusFailureKind;
}

type ProviderExecutionResult = ProviderExecutionSuccess | ProviderExecutionFailure;

interface CandidateGroup {
  readonly key: string;
  readonly canonicalLabel: string;
  readonly label: string;
  readonly byProvider: Map<string, GeocodingConsensusEvidence>;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const normalizeProviderId = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const normalizeProviderWeight = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return clamp(parsed, 0.05, 100);
};

const normalizeOptions = (
  options: GeocodingConsensusOptions = {},
): NormalizedConsensusOptions => {
  const maxProviders = normalizeInteger(options.maxProviders, { min: 1, max: 64, fallback: 8 });
  const maxConcurrentProviders = normalizeInteger(options.maxConcurrentProviders, {
    min: 1,
    max: maxProviders,
    fallback: Math.min(4, maxProviders),
  });
  const minimumSuccessfulProviders = normalizeInteger(options.minimumSuccessfulProviders, {
    min: 1,
    max: maxProviders,
    fallback: 1,
  });
  return Object.freeze({
    maxProviders,
    maxConcurrentProviders,
    providerTimeoutMs: normalizeInteger(options.providerTimeoutMs, {
      min: 100,
      max: 120_000,
      fallback: 8_000,
    }),
    maxCandidatesPerProvider: normalizeInteger(options.maxCandidatesPerProvider, {
      min: 1,
      max: 1_000,
      fallback: 50,
    }),
    maxConsensusCandidates: normalizeInteger(options.maxConsensusCandidates, {
      min: 1,
      max: 5_000,
      fallback: 100,
    }),
    maxEvidenceItems: normalizeInteger(options.maxEvidenceItems, {
      min: 1,
      max: 50_000,
      fallback: 2_000,
    }),
    coordinateToleranceMeters: normalizeInteger(options.coordinateToleranceMeters, {
      min: 1,
      max: 100_000,
      fallback: 75,
    }),
    minimumSuccessfulProviders,
    minimumAgreementProviders: normalizeInteger(options.minimumAgreementProviders, {
      min: 1,
      max: maxProviders,
      fallback: 1,
    }),
    allowPartial: options.allowPartial !== false,
  });
};

const supportsOperation = (
  provider: GeocodingConsensusProvider,
  operation: GeocodingOperation,
): boolean => operation === 'forward'
  ? typeof provider.forward === 'function'
  : typeof provider.reverse === 'function';

const normalizedProviders = (
  providers: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  execution: GeocodingConsensusExecutionOptions,
  options: NormalizedConsensusOptions,
): readonly GeocodingConsensusProvider[] => {
  const requested = execution.providerIds
    ? new Set(execution.providerIds.map(normalizeProviderId).filter(Boolean))
    : null;
  const seen = new Set<string>();
  const result: GeocodingConsensusProvider[] = [];
  for (const provider of providers) {
    const id = normalizeProviderId(provider.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (requested && !requested.has(id)) continue;
    if (!supportsOperation(provider, operation)) continue;
    result.push(Object.freeze({ ...provider, id }));
    if (result.length >= options.maxProviders) break;
  }
  return Object.freeze(result.sort((left, right) =>
    (Number(right.priority) || 0) - (Number(left.priority) || 0)
    || left.id.localeCompare(right.id, 'en')));
};

const requestFingerprint = (
  operation: GeocodingOperation,
  request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  providerIds: readonly string[],
): string => hashFingerprint(stableSerialize({
  version: GEOCODING_CONSENSUS_VERSION,
  operation,
  request,
  providerIds,
}));

const timeoutError = (): Error => {
  const error = new Error('Geocoding consensus provider timed out');
  error.name = 'TimeoutError';
  return error;
};

const abortPromise = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  if (signal.aborted) {
    reject(createAbortError('Geocoding consensus provider aborted'));
    return;
  }
  signal.addEventListener('abort', () => {
    reject(createAbortError('Geocoding consensus provider aborted'));
  }, { once: true });
});

const adaptProviderPayload = (
  payload: unknown,
  request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  options: NormalizedConsensusOptions,
): GeocodePage => adaptGeocodingPayload(payload, {
  offset: 'offset' in request ? request.offset : 0,
  limit: Math.min(Number(request.limit) || options.maxCandidatesPerProvider, options.maxCandidatesPerProvider),
  minimumScore: request.minimumScore,
  dedupe: true,
});

const invokeProvider = async (
  provider: GeocodingConsensusProvider,
  operation: GeocodingOperation,
  request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  requestId: string,
  externalSignal: AbortSignal | null | undefined,
  options: NormalizedConsensusOptions,
): Promise<ProviderExecutionResult> => {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) return Object.freeze({ ok: false, providerId: provider.id, kind: 'aborted' });
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeoutMs = normalizeInteger(provider.timeoutMs, {
    min: 100,
    max: 120_000,
    fallback: options.providerTimeoutMs,
  });
  const context: GeocodingProviderContext = Object.freeze({
    signal: controller.signal,
    requestId,
    providerId: provider.id,
    operation,
  });
  try {
    const providerCall = operation === 'forward'
      ? provider.forward?.(request as ForwardGeocodeRequest, context)
      : provider.reverse?.(request as ReverseGeocodeRequest, context);
    if (providerCall === undefined) {
      return Object.freeze({ ok: false, providerId: provider.id, kind: 'unsupported' });
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    const payload = await Promise.race([
      Promise.resolve(providerCall),
      timeout,
      abortPromise(controller.signal),
    ]);
    throwIfAborted(externalSignal);
    const page = adaptProviderPayload(payload, request, options);
    if (page.candidates.length === 0) {
      return Object.freeze({ ok: false, providerId: provider.id, kind: 'empty-result' });
    }
    return Object.freeze({
      ok: true,
      providerId: provider.id,
      providerWeight: normalizeProviderWeight(provider.weight),
      page,
    });
  } catch (_error) {
    if (timedOut) return Object.freeze({ ok: false, providerId: provider.id, kind: 'timeout' });
    if (controller.signal.aborted || externalSignal?.aborted) {
      return Object.freeze({ ok: false, providerId: provider.id, kind: 'aborted' });
    }
    return Object.freeze({ ok: false, providerId: provider.id, kind: 'provider-error' });
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
};

const runBounded = async (
  providers: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  fingerprint: string,
  execution: GeocodingConsensusExecutionOptions,
  options: NormalizedConsensusOptions,
): Promise<readonly ProviderExecutionResult[]> => {
  const results: ProviderExecutionResult[] = new Array(providers.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(options.maxConcurrentProviders, providers.length) }, (_, worker) =>
    (async (): Promise<void> => {
      while (true) {
        throwIfAborted(execution.signal);
        const index = cursor;
        cursor += 1;
        if (index >= providers.length) return;
        const provider = providers[index];
        if (!provider) return;
        const result = await invokeProvider(
          provider,
          operation,
          request,
          `geocode-consensus-${fingerprint}-${worker}-${index}`,
          execution.signal,
          options,
        );
        results[index] = result;
      }
    })());
  await Promise.all(workers);
  throwIfAborted(execution.signal);
  return Object.freeze(results.filter((value): value is ProviderExecutionResult => value !== undefined));
};

const candidateGroupKey = (candidate: GeocodeCandidate): string => {
  const canonical = canonicalizeAddressText(candidate.label);
  if (canonical) return `label:${canonical}`;
  if (candidate.id) return `id:${normalizeSearchText(candidate.id)}`;
  return `fp:${candidate.fingerprint}`;
};

const betterEvidence = (
  left: GeocodingConsensusEvidence,
  right: GeocodingConsensusEvidence,
): GeocodingConsensusEvidence => {
  const leftWeighted = left.candidate.score * left.providerWeight;
  const rightWeighted = right.candidate.score * right.providerWeight;
  if (leftWeighted !== rightWeighted) return leftWeighted > rightWeighted ? left : right;
  if (left.candidate.score !== right.candidate.score) return left.candidate.score > right.candidate.score ? left : right;
  return left.candidate.fingerprint.localeCompare(right.candidate.fingerprint, 'en') <= 0 ? left : right;
};

const buildGroups = (
  successes: readonly ProviderExecutionSuccess[],
  options: NormalizedConsensusOptions,
): Readonly<{ groups: readonly CandidateGroup[]; inputCandidates: number; evidenceTruncated: boolean }> => {
  const groups = new Map<string, CandidateGroup>();
  let inputCandidates = 0;
  let evidenceCount = 0;
  let evidenceTruncated = false;
  for (const success of successes) {
    for (const candidate of success.page.candidates.slice(0, options.maxCandidatesPerProvider)) {
      inputCandidates += 1;
      if (evidenceCount >= options.maxEvidenceItems) {
        evidenceTruncated = true;
        continue;
      }
      evidenceCount += 1;
      const key = candidateGroupKey(candidate);
      const canonicalLabel = canonicalizeAddressText(candidate.label);
      const existing = groups.get(key);
      const group = existing ?? {
        key,
        canonicalLabel,
        label: normalizeText(candidate.label),
        byProvider: new Map<string, GeocodingConsensusEvidence>(),
      };
      const evidence: GeocodingConsensusEvidence = Object.freeze({
        providerId: success.providerId,
        providerWeight: success.providerWeight,
        candidate,
      });
      const current = group.byProvider.get(success.providerId);
      group.byProvider.set(success.providerId, current ? betterEvidence(current, evidence) : evidence);
      if (!existing) groups.set(key, group);
    }
  }
  return Object.freeze({ groups: Object.freeze([...groups.values()]), inputCandidates, evidenceTruncated });
};

const candidateCentroid = (
  evidence: readonly GeocodingConsensusEvidence[],
): Coordinate | null => {
  const coordinates = evidence
    .map(item => item.candidate.coordinates)
    .filter((value): value is Coordinate => value !== null);
  if (coordinates.length === 0) return null;
  let latitude = 0;
  let longitude = 0;
  for (const coordinate of coordinates) {
    latitude += coordinate.latitude;
    longitude += coordinate.longitude;
  }
  return Object.freeze({ latitude: latitude / coordinates.length, longitude: longitude / coordinates.length });
};

const coordinateSpread = (
  evidence: readonly GeocodingConsensusEvidence[],
  center: Coordinate | null,
): number => {
  if (!center) return 0;
  let maximum = 0;
  for (const item of evidence) {
    const coordinate = item.candidate.coordinates;
    if (!coordinate) continue;
    const distance = haversineDistanceMeters(center, coordinate);
    if (distance !== null) maximum = Math.max(maximum, distance);
  }
  return Math.round(maximum);
};

const weightedProviderScore = (
  evidence: readonly GeocodingConsensusEvidence[],
): number => {
  let weighted = 0;
  let totalWeight = 0;
  for (const item of evidence) {
    weighted += clamp(item.candidate.score, 0, 100) * item.providerWeight;
    totalWeight += item.providerWeight;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
};

const representativeEvidence = (
  evidence: readonly GeocodingConsensusEvidence[],
): GeocodingConsensusEvidence => {
  const sorted = [...evidence].sort((left, right) => {
    const leftWeighted = left.candidate.score * left.providerWeight;
    const rightWeighted = right.candidate.score * right.providerWeight;
    return rightWeighted - leftWeighted
      || right.candidate.score - left.candidate.score
      || left.providerId.localeCompare(right.providerId, 'en');
  });
  const first = sorted[0];
  if (!first) throw new Error('Consensus candidate requires at least one evidence item');
  return first;
};

const freezeConsensusCandidate = (
  group: CandidateGroup,
  successfulProviderCount: number,
  options: NormalizedConsensusOptions,
): GeocodingConsensusCandidate => {
  const evidence = Object.freeze([...group.byProvider.values()]
    .sort((left, right) => left.providerId.localeCompare(right.providerId, 'en')));
  const representative = representativeEvidence(evidence);
  const providerIds = Object.freeze(evidence.map(item => item.providerId));
  const coordinates = candidateCentroid(evidence);
  const coordinateSpreadMeters = coordinateSpread(evidence, coordinates);
  const weightedScore = weightedProviderScore(evidence);
  const agreementCount = providerIds.length;
  const agreementRatio = successfulProviderCount > 0 ? agreementCount / successfulProviderCount : 0;
  const agreementScore = Math.round(agreementRatio * 100);
  const coordinateConflict = coordinateSpreadMeters > options.coordinateToleranceMeters;
  const coordinateScore = coordinates === null
    ? 50
    : coordinateConflict
      ? Math.max(0, Math.round(100 * (1 - coordinateSpreadMeters / Math.max(1, options.coordinateToleranceMeters * 4))))
      : Math.max(60, Math.round(100 * (1 - coordinateSpreadMeters / Math.max(1, options.coordinateToleranceMeters))));
  const confidence = clamp(Math.round(
    weightedScore * 0.55
    + agreementScore * 0.30
    + coordinateScore * 0.15,
  ), 0, 100);
  const fingerprint = hashFingerprint(stableSerialize({
    key: group.key,
    providerIds,
    weightedScore,
    coordinates,
    coordinateSpreadMeters,
    confidence,
  }));
  return Object.freeze({
    key: group.key,
    label: representative.candidate.label || group.label,
    canonicalLabel: group.canonicalLabel,
    representative: representative.candidate,
    providerIds,
    providerCount: providerIds.length,
    agreementCount,
    weightedProviderScore: weightedScore,
    agreementScore,
    coordinateScore,
    confidence,
    coordinates,
    coordinateSpreadMeters,
    coordinateConflict,
    evidence,
    fingerprint,
  });
};

const createDiagnostics = (
  providers: readonly GeocodingConsensusProvider[],
  results: readonly ProviderExecutionResult[],
  inputCandidates: number,
  outputCandidates: number,
  evidenceTruncated: boolean,
  candidateTruncated: boolean,
): GeocodingConsensusDiagnostics => {
  const failures = Object.freeze(results
    .filter((result): result is ProviderExecutionFailure => !result.ok)
    .map(result => Object.freeze({ providerId: result.providerId, kind: result.kind })));
  return Object.freeze({
    requestedProviders: providers.length,
    eligibleProviders: providers.length,
    successfulProviders: results.filter(result => result.ok).length,
    failedProviders: failures.length,
    timedOutProviders: failures.filter(item => item.kind === 'timeout').length,
    abortedProviders: failures.filter(item => item.kind === 'aborted').length,
    inputCandidates,
    outputCandidates,
    evidenceTruncated,
    candidateTruncated,
    failures,
  });
};

export const executeGeocodingConsensus = async (
  providersInput: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  optionsInput: GeocodingConsensusOptions = {},
  execution: GeocodingConsensusExecutionOptions = {},
): Promise<GeocodingConsensusResult> => {
  throwIfAborted(execution.signal);
  const options = normalizeOptions(optionsInput);
  const providers = normalizedProviders(providersInput, operation, execution, options);
  if (providers.length === 0) throw new Error(`No geocoding consensus provider supports ${operation}`);
  const fingerprint = requestFingerprint(operation, request, providers.map(provider => provider.id));
  const results = await runBounded(providers, operation, request, fingerprint, execution, options);
  throwIfAborted(execution.signal);
  const successes = results.filter((result): result is ProviderExecutionSuccess => result.ok);
  if (successes.length < options.minimumSuccessfulProviders) {
    throw new Error(
      `Geocoding consensus requires ${options.minimumSuccessfulProviders} successful provider(s); received ${successes.length}.`,
    );
  }
  const grouped = buildGroups(successes, options);
  let candidates = grouped.groups
    .map(group => freezeConsensusCandidate(group, successes.length, options))
    .filter(candidate => candidate.agreementCount >= options.minimumAgreementProviders)
    .sort((left, right) => right.confidence - left.confidence
      || right.agreementCount - left.agreementCount
      || right.weightedProviderScore - left.weightedProviderScore
      || left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base', numeric: true })
      || left.key.localeCompare(right.key, 'en'));
  const candidateTruncated = candidates.length > options.maxConsensusCandidates;
  if (candidateTruncated) candidates = candidates.slice(0, options.maxConsensusCandidates);
  const partial = successes.length < providers.length;
  if (partial && !options.allowPartial) {
    throw new Error('Geocoding consensus rejected partial provider results.');
  }
  const frozenCandidates = Object.freeze(candidates);
  const diagnostics = createDiagnostics(
    providers,
    results,
    grouped.inputCandidates,
    frozenCandidates.length,
    grouped.evidenceTruncated,
    candidateTruncated,
  );
  const resultFingerprint = hashFingerprint(stableSerialize({
    version: GEOCODING_CONSENSUS_VERSION,
    operation,
    requestFingerprint: fingerprint,
    candidates: frozenCandidates.map(candidate => ({
      fingerprint: candidate.fingerprint,
      confidence: candidate.confidence,
      providerIds: candidate.providerIds,
    })),
    diagnostics,
  }));
  return Object.freeze({
    version: GEOCODING_CONSENSUS_VERSION,
    operation,
    requestFingerprint: fingerprint,
    candidates: frozenCandidates,
    diagnostics,
    partial,
    fingerprint: resultFingerprint,
  });
};

export const executeForwardGeocodingConsensus = (
  providers: readonly GeocodingConsensusProvider[],
  request: ForwardGeocodeRequest,
  options: GeocodingConsensusOptions = {},
  execution: GeocodingConsensusExecutionOptions = {},
): Promise<GeocodingConsensusResult> => executeGeocodingConsensus(
  providers,
  'forward',
  request,
  options,
  execution,
);

export const executeReverseGeocodingConsensus = (
  providers: readonly GeocodingConsensusProvider[],
  request: ReverseGeocodeRequest,
  options: GeocodingConsensusOptions = {},
  execution: GeocodingConsensusExecutionOptions = {},
): Promise<GeocodingConsensusResult> => executeGeocodingConsensus(
  providers,
  'reverse',
  request,
  options,
  execution,
);
