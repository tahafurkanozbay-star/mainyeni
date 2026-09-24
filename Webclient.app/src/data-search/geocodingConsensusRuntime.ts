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

export const GEOCODING_CONSENSUS_VERSION = '2026-09-24.v3';

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

interface NormalizedOptions {
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

interface ProviderSuccess {
  readonly ok: true;
  readonly providerId: string;
  readonly providerWeight: number;
  readonly page: GeocodePage;
}

interface ProviderFailure {
  readonly ok: false;
  readonly providerId: string;
  readonly kind: GeocodingConsensusFailureKind;
}

type ProviderResult = ProviderSuccess | ProviderFailure;
type Request = ForwardGeocodeRequest | ReverseGeocodeRequest;

interface CandidateGroup {
  readonly key: string;
  readonly canonicalLabel: string;
  readonly label: string;
  readonly byProvider: Map<string, GeocodingConsensusEvidence>;
}

interface GroupingState {
  readonly groups: Map<string, CandidateGroup>;
  readonly inputCandidates: number;
  readonly evidenceItems: number;
  readonly evidenceTruncated: boolean;
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const providerId = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
const providerWeight = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.05, 100) : 1;
};

const normalizeOptions = (input: GeocodingConsensusOptions = {}): NormalizedOptions => {
  const maxProviders = normalizeInteger(input.maxProviders, { min: 1, max: 64, fallback: 8 });
  return Object.freeze({
    maxProviders,
    maxConcurrentProviders: normalizeInteger(input.maxConcurrentProviders, {
      min: 1,
      max: maxProviders,
      fallback: Math.min(4, maxProviders),
    }),
    providerTimeoutMs: normalizeInteger(input.providerTimeoutMs, {
      min: 100,
      max: 120_000,
      fallback: 8_000,
    }),
    maxCandidatesPerProvider: normalizeInteger(input.maxCandidatesPerProvider, {
      min: 1,
      max: 1_000,
      fallback: 50,
    }),
    maxConsensusCandidates: normalizeInteger(input.maxConsensusCandidates, {
      min: 1,
      max: 5_000,
      fallback: 100,
    }),
    maxEvidenceItems: normalizeInteger(input.maxEvidenceItems, {
      min: 1,
      max: 50_000,
      fallback: 2_000,
    }),
    coordinateToleranceMeters: normalizeInteger(input.coordinateToleranceMeters, {
      min: 1,
      max: 100_000,
      fallback: 75,
    }),
    minimumSuccessfulProviders: normalizeInteger(input.minimumSuccessfulProviders, {
      min: 1,
      max: maxProviders,
      fallback: 1,
    }),
    minimumAgreementProviders: normalizeInteger(input.minimumAgreementProviders, {
      min: 1,
      max: maxProviders,
      fallback: 1,
    }),
    allowPartial: input.allowPartial !== false,
  });
};

const supports = (provider: GeocodingConsensusProvider, operation: GeocodingOperation): boolean =>
  operation === 'forward'
    ? typeof provider.forward === 'function'
    : typeof provider.reverse === 'function';

const selectProviders = (
  input: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  execution: GeocodingConsensusExecutionOptions,
  options: NormalizedOptions,
): readonly GeocodingConsensusProvider[] => {
  const requested = execution.providerIds
    ? new Set(execution.providerIds.map(providerId).filter(Boolean))
    : null;
  const seen = new Set<string>();
  const eligible: GeocodingConsensusProvider[] = [];
  for (const candidate of input) {
    const id = providerId(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (requested && !requested.has(id)) continue;
    if (!supports(candidate, operation)) continue;
    eligible.push(Object.freeze({ ...candidate, id }));
  }
  eligible.sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0)
    || left.id.localeCompare(right.id, 'en'));
  return Object.freeze(eligible.slice(0, options.maxProviders));
};

const createRequestFingerprint = (
  operation: GeocodingOperation,
  request: Request,
  providers: readonly GeocodingConsensusProvider[],
): string => hashFingerprint(stableSerialize({
  version: GEOCODING_CONSENSUS_VERSION,
  operation,
  request,
  providerIds: providers.map(provider => provider.id),
}));

const adapt = (
  payload: unknown,
  request: Request,
  options: NormalizedOptions,
): GeocodePage => adaptGeocodingPayload(payload, {
  offset: 'offset' in request ? request.offset : 0,
  limit: Math.min(Number(request.limit) || options.maxCandidatesPerProvider, options.maxCandidatesPerProvider),
  minimumScore: request.minimumScore,
  // Consensus owns per-provider canonical deduplication so it can retain the
  // strongest evidence row instead of whichever duplicate the payload listed first.
  dedupe: false,
});

const executeProvider = async (
  provider: GeocodingConsensusProvider,
  operation: GeocodingOperation,
  request: Request,
  requestId: string,
  externalSignal: AbortSignal | null | undefined,
  options: NormalizedOptions,
): Promise<ProviderResult> => {
  if (externalSignal?.aborted) {
    return Object.freeze({ ok: false, providerId: provider.id, kind: 'aborted' });
  }
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const forwardAbort = (): void => controller.abort();
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const context: GeocodingProviderContext = Object.freeze({
    signal: controller.signal,
    requestId,
    providerId: provider.id,
    operation,
  });
  try {
    const call = operation === 'forward'
      ? provider.forward?.(request as ForwardGeocodeRequest, context)
      : provider.reverse?.(request as ReverseGeocodeRequest, context);
    if (call === undefined) {
      return Object.freeze({ ok: false, providerId: provider.id, kind: 'unsupported' });
    }
    const timeoutMs = normalizeInteger(provider.timeoutMs, {
      min: 100,
      max: 120_000,
      fallback: options.providerTimeoutMs,
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        const error = new Error('Geocoding consensus provider timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
    });
    const abort = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(createAbortError('Geocoding consensus provider aborted'));
      }, { once: true });
    });
    const payload = await Promise.race([Promise.resolve(call), timeout, abort]);
    throwIfAborted(externalSignal);
    const page = adapt(payload, request, options);
    return page.candidates.length === 0
      ? Object.freeze({ ok: false, providerId: provider.id, kind: 'empty-result' })
      : Object.freeze({
        ok: true,
        providerId: provider.id,
        providerWeight: providerWeight(provider.weight),
        page,
      });
  } catch {
    if (timedOut) return Object.freeze({ ok: false, providerId: provider.id, kind: 'timeout' });
    if (controller.signal.aborted || externalSignal?.aborted) {
      return Object.freeze({ ok: false, providerId: provider.id, kind: 'aborted' });
    }
    return Object.freeze({ ok: false, providerId: provider.id, kind: 'provider-error' });
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
};

const runBounded = async (
  providers: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  request: Request,
  fingerprint: string,
  execution: GeocodingConsensusExecutionOptions,
  options: NormalizedOptions,
): Promise<readonly ProviderResult[]> => {
  const results: Array<ProviderResult | undefined> = Array.from({ length: providers.length });
  let cursor = 0;
  const workerCount = Math.min(options.maxConcurrentProviders, providers.length);
  const workers = Array.from({ length: workerCount }, (_, worker) => (async (): Promise<void> => {
    while (true) {
      throwIfAborted(execution.signal);
      const index = cursor;
      cursor += 1;
      if (index >= providers.length) return;
      const provider = providers[index];
      if (!provider) return;
      results[index] = await executeProvider(
        provider,
        operation,
        request,
        `geocode-consensus-${fingerprint}-${worker}-${index}`,
        execution.signal,
        options,
      );
    }
  })());
  await Promise.all(workers);
  throwIfAborted(execution.signal);
  return Object.freeze(results.filter((result): result is ProviderResult => result !== undefined));
};

const groupKey = (candidate: GeocodeCandidate): string => {
  const label = canonicalizeAddressText(candidate.label);
  if (label) return `label:${label}`;
  if (candidate.id) return `id:${normalizeSearchText(candidate.id)}`;
  return `fp:${candidate.fingerprint}`;
};

const betterEvidence = (
  left: GeocodingConsensusEvidence,
  right: GeocodingConsensusEvidence,
): GeocodingConsensusEvidence => {
  const leftWeighted = left.candidate.score * left.providerWeight;
  const rightWeighted = right.candidate.score * right.providerWeight;
  if (leftWeighted !== rightWeighted) return rightWeighted > leftWeighted ? right : left;
  if (left.candidate.score !== right.candidate.score) {
    return right.candidate.score > left.candidate.score ? right : left;
  }
  return right.candidate.fingerprint.localeCompare(left.candidate.fingerprint, 'en') < 0
    ? right
    : left;
};

const addEvidence = (
  state: GroupingState,
  success: ProviderSuccess,
  candidate: GeocodeCandidate,
  options: NormalizedOptions,
): GroupingState => {
  const inputCandidates = state.inputCandidates + 1;
  if (state.evidenceItems >= options.maxEvidenceItems) {
    return { ...state, inputCandidates, evidenceTruncated: true };
  }
  const key = groupKey(candidate);
  const existing = state.groups.get(key);
  const group = existing ?? {
    key,
    canonicalLabel: canonicalizeAddressText(candidate.label),
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
  if (!existing) state.groups.set(key, group);
  return { ...state, inputCandidates, evidenceItems: state.evidenceItems + 1 };
};

const groupCandidates = (
  successes: readonly ProviderSuccess[],
  options: NormalizedOptions,
): Readonly<{
  groups: readonly CandidateGroup[];
  inputCandidates: number;
  evidenceTruncated: boolean;
}> => {
  const initial: GroupingState = {
    groups: new Map<string, CandidateGroup>(),
    inputCandidates: 0,
    evidenceItems: 0,
    evidenceTruncated: false,
  };
  const state = successes.reduce((grouping, success) => success.page.candidates
    .slice(0, options.maxCandidatesPerProvider)
    .reduce((next, candidate) => addEvidence(next, success, candidate, options), grouping), initial);
  return Object.freeze({
    groups: Object.freeze([...state.groups.values()]),
    inputCandidates: state.inputCandidates,
    evidenceTruncated: state.evidenceTruncated,
  });
};

const centroid = (evidence: readonly GeocodingConsensusEvidence[]): Coordinate | null => {
  const coordinates = evidence
    .map(item => item.candidate.coordinates)
    .filter((value): value is Coordinate => value !== null);
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

const coordinateSpread = (
  evidence: readonly GeocodingConsensusEvidence[],
  center: Coordinate | null,
): number => {
  if (!center) return 0;
  return Math.round(evidence.reduce((maximum, item) => {
    if (!item.candidate.coordinates) return maximum;
    const distance = haversineDistanceMeters(center, item.candidate.coordinates);
    return distance === null ? maximum : Math.max(maximum, distance);
  }, 0));
};

const representative = (
  evidence: readonly GeocodingConsensusEvidence[],
): GeocodingConsensusEvidence => {
  const first = [...evidence].sort((left, right) =>
    right.candidate.score * right.providerWeight - left.candidate.score * left.providerWeight
    || right.candidate.score - left.candidate.score
    || left.providerId.localeCompare(right.providerId, 'en'))[0];
  if (!first) throw new Error('Geocoding consensus candidate requires evidence');
  return first;
};

const freezeCandidate = (
  group: CandidateGroup,
  successfulProviders: number,
  options: NormalizedOptions,
): GeocodingConsensusCandidate => {
  const evidence = Object.freeze([...group.byProvider.values()]
    .sort((left, right) => left.providerId.localeCompare(right.providerId, 'en')));
  const selected = representative(evidence);
  const providerIds = Object.freeze(evidence.map(item => item.providerId));
  const coordinates = centroid(evidence);
  const coordinateSpreadMeters = coordinateSpread(evidence, coordinates);
  const totalWeight = evidence.reduce((sum, item) => sum + item.providerWeight, 0);
  const weightedProviderScore = totalWeight > 0
    ? Math.round(evidence.reduce(
      (sum, item) => sum + clamp(item.candidate.score) * item.providerWeight,
      0,
    ) / totalWeight)
    : 0;
  const agreementCount = providerIds.length;
  const agreementScore = successfulProviders > 0
    ? Math.round(agreementCount / successfulProviders * 100)
    : 0;
  const coordinateConflict = coordinateSpreadMeters > options.coordinateToleranceMeters;
  const coordinateScore = coordinates === null
    ? 50
    : coordinateConflict
      ? Math.max(0, Math.round(100 * (
        1 - coordinateSpreadMeters / Math.max(1, options.coordinateToleranceMeters * 4)
      )))
      : Math.max(60, Math.round(100 * (
        1 - coordinateSpreadMeters / Math.max(1, options.coordinateToleranceMeters)
      )));
  const confidence = clamp(Math.round(
    weightedProviderScore * 0.55 + agreementScore * 0.30 + coordinateScore * 0.15,
  ));
  const fingerprint = hashFingerprint(stableSerialize({
    key: group.key,
    providerIds,
    weightedProviderScore,
    agreementScore,
    coordinates,
    coordinateSpreadMeters,
    confidence,
  }));
  return Object.freeze({
    key: group.key,
    label: selected.candidate.label || group.label,
    canonicalLabel: group.canonicalLabel,
    representative: selected.candidate,
    providerIds,
    providerCount: providerIds.length,
    agreementCount,
    weightedProviderScore,
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

const diagnostics = (
  providers: readonly GeocodingConsensusProvider[],
  results: readonly ProviderResult[],
  inputCandidates: number,
  outputCandidates: number,
  evidenceTruncated: boolean,
  candidateTruncated: boolean,
): GeocodingConsensusDiagnostics => {
  const failures = Object.freeze(results
    .filter((result): result is ProviderFailure => !result.ok)
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
  providerInput: readonly GeocodingConsensusProvider[],
  operation: GeocodingOperation,
  request: Request,
  optionsInput: GeocodingConsensusOptions = {},
  execution: GeocodingConsensusExecutionOptions = {},
): Promise<GeocodingConsensusResult> => {
  throwIfAborted(execution.signal);
  const options = normalizeOptions(optionsInput);
  const providers = selectProviders(providerInput, operation, execution, options);
  if (providers.length === 0) {
    throw new Error(`No geocoding consensus provider supports ${operation}`);
  }
  const requestFingerprint = createRequestFingerprint(operation, request, providers);
  const results = await runBounded(
    providers,
    operation,
    request,
    requestFingerprint,
    execution,
    options,
  );
  throwIfAborted(execution.signal);
  const successes = results.filter((result): result is ProviderSuccess => result.ok);
  if (successes.length < options.minimumSuccessfulProviders) {
    throw new Error(
      `Geocoding consensus requires ${options.minimumSuccessfulProviders} successful provider(s); received ${successes.length}.`,
    );
  }
  const grouped = groupCandidates(successes, options);
  let candidates = grouped.groups
    .map(group => freezeCandidate(group, successes.length, options))
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
  const resultDiagnostics = diagnostics(
    providers,
    results,
    grouped.inputCandidates,
    frozenCandidates.length,
    grouped.evidenceTruncated,
    candidateTruncated,
  );
  const fingerprint = hashFingerprint(stableSerialize({
    version: GEOCODING_CONSENSUS_VERSION,
    operation,
    requestFingerprint,
    candidates: frozenCandidates.map(candidate => ({
      fingerprint: candidate.fingerprint,
      confidence: candidate.confidence,
      providerIds: candidate.providerIds,
    })),
    diagnostics: resultDiagnostics,
  }));
  return Object.freeze({
    version: GEOCODING_CONSENSUS_VERSION,
    operation,
    requestFingerprint,
    candidates: frozenCandidates,
    diagnostics: resultDiagnostics,
    partial,
    fingerprint,
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
