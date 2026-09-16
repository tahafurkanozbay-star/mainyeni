import { assertAllowedArcGisResourceUrl } from './serviceCapabilityRuntime';
import {
  clampNumber,
  finiteNumber,
  normalizeIdentifier,
  positiveInteger,
  type GisRenderBudget,
  type GisStreamingCandidate,
  type GisStreamingDecision,
  type GisViewSnapshot,
} from './runtimeContracts';

export interface GisSceneStreamingSettings {
  readonly maxCandidateCount?: number;
  readonly maxLoadsPerPlan?: number;
  readonly maxPrefetchPerPlan?: number;
  readonly minResidentAgeMs?: number;
  readonly staleResidentAgeMs?: number;
  readonly maxSingleResourceBytes?: number;
  readonly visibleWeight?: number;
  readonly distanceWeight?: number;
  readonly screenAreaWeight?: number;
  readonly importanceWeight?: number;
  readonly loadedWeight?: number;
}

export interface GisSceneStreamingPlanInput {
  readonly candidates: readonly GisStreamingCandidate[];
  readonly view: GisViewSnapshot;
  readonly budget: GisRenderBudget;
  readonly residentIds?: readonly string[];
  readonly residentBytes?: number | null;
  readonly inFlightIds?: readonly string[];
  readonly now?: number | null;
  readonly forceRetainIds?: readonly string[];
  readonly forceLoadIds?: readonly string[];
}

export interface GisStreamingCandidateScore {
  readonly id: string;
  readonly score: number;
  readonly visible: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly estimatedBytes: number;
  readonly reason: string;
}

interface NormalizedCandidate extends GisStreamingCandidate {
  readonly id: string;
  readonly layerId: string;
  readonly estimatedBytes: number;
  readonly distance: number | null;
  readonly screenArea: number | null;
  readonly importance: number;
  readonly visible: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly lastUsedAt: number | null;
  readonly resourceUrl?: string | null;
}

const DEFAULT_SETTINGS: Required<GisSceneStreamingSettings> = Object.freeze({
  maxCandidateCount: 5000,
  maxLoadsPerPlan: 12,
  maxPrefetchPerPlan: 8,
  minResidentAgeMs: 8000,
  staleResidentAgeMs: 120000,
  maxSingleResourceBytes: 96 * 1024 * 1024,
  visibleWeight: 520,
  distanceWeight: 220,
  screenAreaWeight: 180,
  importanceWeight: 160,
  loadedWeight: 80,
});

const normalizeSettings = (input: GisSceneStreamingSettings = {}): Required<GisSceneStreamingSettings> => Object.freeze({
  maxCandidateCount: positiveInteger(input.maxCandidateCount, DEFAULT_SETTINGS.maxCandidateCount, 50000),
  maxLoadsPerPlan: positiveInteger(input.maxLoadsPerPlan, DEFAULT_SETTINGS.maxLoadsPerPlan, 256),
  maxPrefetchPerPlan: positiveInteger(input.maxPrefetchPerPlan, DEFAULT_SETTINGS.maxPrefetchPerPlan, 256),
  minResidentAgeMs: positiveInteger(input.minResidentAgeMs, DEFAULT_SETTINGS.minResidentAgeMs, 600000),
  staleResidentAgeMs: positiveInteger(input.staleResidentAgeMs, DEFAULT_SETTINGS.staleResidentAgeMs, 3600000),
  maxSingleResourceBytes: positiveInteger(
    input.maxSingleResourceBytes,
    DEFAULT_SETTINGS.maxSingleResourceBytes,
    1024 * 1024 * 1024,
  ),
  visibleWeight: clampNumber(input.visibleWeight, 0, 5000, DEFAULT_SETTINGS.visibleWeight),
  distanceWeight: clampNumber(input.distanceWeight, 0, 5000, DEFAULT_SETTINGS.distanceWeight),
  screenAreaWeight: clampNumber(input.screenAreaWeight, 0, 5000, DEFAULT_SETTINGS.screenAreaWeight),
  importanceWeight: clampNumber(input.importanceWeight, 0, 5000, DEFAULT_SETTINGS.importanceWeight),
  loadedWeight: clampNumber(input.loadedWeight, -5000, 5000, DEFAULT_SETTINGS.loadedWeight),
});

const normalizeCandidate = (input: GisStreamingCandidate): NormalizedCandidate => {
  if (!input || typeof input !== 'object') throw new TypeError('Scene streaming candidates must be objects.');
  const id = normalizeIdentifier(input.id, 'candidateId');
  const layerId = normalizeIdentifier(input.layerId, 'layerId');
  const estimatedBytes = Math.max(1, Math.floor(finiteNumber(input.estimatedBytes, 1) ?? 1));
  let resourceUrl: string | null | undefined = input.resourceUrl;
  if (resourceUrl) resourceUrl = assertAllowedArcGisResourceUrl(resourceUrl);
  return Object.freeze({
    ...input,
    id,
    layerId,
    resourceUrl,
    estimatedBytes,
    distance: finiteNumber(input.distance),
    screenArea: finiteNumber(input.screenArea),
    importance: clampNumber(input.importance, 0, 100, 50),
    visible: input.visible !== false,
    loaded: input.loaded === true,
    loading: input.loading === true,
    lastUsedAt: finiteNumber(input.lastUsedAt),
  });
};

const normalizeSet = (values: readonly string[] | undefined): Set<string> => new Set(
  (values || []).map((value) => normalizeIdentifier(value, 'candidateId')),
);

const scoreDistance = (distance: number | null): number => {
  if (distance === null || distance < 0) return 0.4;
  if (distance === 0) return 1;
  const logarithmic = Math.log10(1 + distance);
  return clampNumber(1 - (logarithmic / 7), 0, 1, 0);
};

const scoreScreenArea = (screenArea: number | null): number => {
  if (screenArea === null || screenArea < 0) return 0.2;
  return clampNumber(Math.sqrt(screenArea), 0, 1, 0);
};

const candidateScore = (
  candidate: NormalizedCandidate,
  settings: Required<GisSceneStreamingSettings>,
  forceLoad: boolean,
  forceRetain: boolean,
): number => {
  if (forceLoad) return 100000;
  let score = 0;
  if (candidate.visible) score += settings.visibleWeight;
  score += scoreDistance(candidate.distance) * settings.distanceWeight;
  score += scoreScreenArea(candidate.screenArea) * settings.screenAreaWeight;
  score += (candidate.importance / 100) * settings.importanceWeight;
  if (candidate.loaded) score += settings.loadedWeight;
  if (candidate.loading) score += settings.loadedWeight * 0.5;
  if (forceRetain) score += 50000;
  if (!candidate.visible) score -= 120;
  return score;
};

const sortCandidates = (
  candidates: readonly NormalizedCandidate[],
  settings: Required<GisSceneStreamingSettings>,
  forceLoadIds: Set<string>,
  forceRetainIds: Set<string>,
): Array<{ candidate: NormalizedCandidate; score: number }> => candidates
  .map((candidate) => ({
    candidate,
    score: candidateScore(candidate, settings, forceLoadIds.has(candidate.id), forceRetainIds.has(candidate.id)),
  }))
  .sort((left, right) => (
    right.score - left.score
    || left.candidate.estimatedBytes - right.candidate.estimatedBytes
    || left.candidate.id.localeCompare(right.candidate.id)
  ));

const visibleCandidateLimit = (budget: GisRenderBudget, settings: Required<GisSceneStreamingSettings>): number => {
  const byNodes = Math.max(1, Math.ceil(budget.maxSceneNodes / 64));
  return Math.min(settings.maxCandidateCount, Math.max(settings.maxLoadsPerPlan, byNodes));
};

export const scoreSceneStreamingCandidates = (
  input: GisSceneStreamingPlanInput,
  configuration: GisSceneStreamingSettings = {},
): readonly GisStreamingCandidateScore[] => {
  const settings = normalizeSettings(configuration);
  const forceLoad = normalizeSet(input.forceLoadIds);
  const forceRetain = normalizeSet(input.forceRetainIds);
  const normalized = input.candidates.slice(0, settings.maxCandidateCount).map(normalizeCandidate);
  return Object.freeze(sortCandidates(normalized, settings, forceLoad, forceRetain).map(({ candidate, score }) => Object.freeze({
    id: candidate.id,
    score: Math.round(score * 100) / 100,
    visible: candidate.visible,
    loaded: candidate.loaded,
    loading: candidate.loading,
    estimatedBytes: candidate.estimatedBytes,
    reason: forceLoad.has(candidate.id)
      ? 'force-load'
      : forceRetain.has(candidate.id)
        ? 'force-retain'
        : candidate.visible
          ? 'visible-priority'
          : 'background-priority',
  })));
};

export const planSceneStreaming = (
  input: GisSceneStreamingPlanInput,
  configuration: GisSceneStreamingSettings = {},
): GisStreamingDecision => {
  if (!input?.budget) throw new TypeError('A render budget is required for scene streaming planning.');
  if (!input?.view) throw new TypeError('A view snapshot is required for scene streaming planning.');
  const settings = normalizeSettings(configuration);
  const now = finiteNumber(input.now, Date.now()) ?? Date.now();
  const residentIds = normalizeSet(input.residentIds);
  const inFlightIds = normalizeSet(input.inFlightIds);
  const forceRetainIds = normalizeSet(input.forceRetainIds);
  const forceLoadIds = normalizeSet(input.forceLoadIds);
  const maxResidentBytes = Math.max(1, input.budget.maxResidentBytes);
  const normalized = input.candidates.slice(0, settings.maxCandidateCount).map(normalizeCandidate);
  const byId = new Map(normalized.map((candidate) => [candidate.id, candidate]));
  for (const forcedId of [...forceLoadIds, ...forceRetainIds]) {
    if (!byId.has(forcedId)) throw new Error(`Forced scene candidate is not present in the candidate set: ${forcedId}`);
  }

  const sorted = sortCandidates(normalized, settings, forceLoadIds, forceRetainIds);
  const load: string[] = [];
  const prefetch: string[] = [];
  const retain = new Set<string>();
  const evict: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const maxLoads = Math.max(
    1,
    Math.min(settings.maxLoadsPerPlan, input.budget.maxConcurrentRequests, visibleCandidateLimit(input.budget, settings)),
  );
  const maxPrefetch = input.budget.allowPrefetch && input.view.stationary !== false
    ? Math.min(settings.maxPrefetchPerPlan, Math.max(1, Math.floor(maxLoads / 2)))
    : 0;
  let projectedResidentBytes = Math.max(0, finiteNumber(input.residentBytes, 0) ?? 0);
  let estimatedLoadBytes = 0;

  for (const { candidate } of sorted) {
    const resident = residentIds.has(candidate.id) || candidate.loaded;
    const inFlight = inFlightIds.has(candidate.id) || candidate.loading;
    const forcedRetain = forceRetainIds.has(candidate.id);
    const forcedLoad = forceLoadIds.has(candidate.id);
    if (resident || inFlight || forcedRetain) retain.add(candidate.id);
    if (candidate.estimatedBytes > settings.maxSingleResourceBytes && !forcedLoad && !forcedRetain) {
      skipped.push({ id: candidate.id, reason: 'resource-exceeds-single-resource-budget' });
      continue;
    }
    if (resident || inFlight) continue;
    if (!candidate.visible && !forcedLoad) {
      if (prefetch.length >= maxPrefetch) {
        skipped.push({ id: candidate.id, reason: 'prefetch-budget-exhausted' });
        continue;
      }
      if (!input.budget.allowPrefetch || input.view.stationary === false) {
        skipped.push({ id: candidate.id, reason: 'prefetch-disabled' });
        continue;
      }
      if (projectedResidentBytes + candidate.estimatedBytes > maxResidentBytes) {
        skipped.push({ id: candidate.id, reason: 'resident-memory-budget' });
        continue;
      }
      prefetch.push(candidate.id);
      projectedResidentBytes += candidate.estimatedBytes;
      estimatedLoadBytes += candidate.estimatedBytes;
      continue;
    }
    if (load.length >= maxLoads && !forcedLoad) {
      skipped.push({ id: candidate.id, reason: 'load-concurrency-budget' });
      continue;
    }
    if (projectedResidentBytes + candidate.estimatedBytes > maxResidentBytes && !forcedLoad) {
      skipped.push({ id: candidate.id, reason: 'resident-memory-budget' });
      continue;
    }
    load.push(candidate.id);
    projectedResidentBytes += candidate.estimatedBytes;
    estimatedLoadBytes += candidate.estimatedBytes;
  }

  const evictionCandidates = normalized
    .filter((candidate) => residentIds.has(candidate.id) || candidate.loaded)
    .filter((candidate) => !forceRetainIds.has(candidate.id))
    .filter((candidate) => !candidate.visible)
    .map((candidate) => {
      const age = candidate.lastUsedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - candidate.lastUsedAt);
      const stale = age >= settings.staleResidentAgeMs;
      const protectedByAge = age < settings.minResidentAgeMs;
      return { candidate, age, stale, protectedByAge };
    })
    .sort((left, right) => (
      Number(right.stale) - Number(left.stale)
      || right.age - left.age
      || right.candidate.estimatedBytes - left.candidate.estimatedBytes
      || left.candidate.id.localeCompare(right.candidate.id)
    ));

  let residentAfterEviction = projectedResidentBytes;
  for (const entry of evictionCandidates) {
    const mustEvictForBudget = residentAfterEviction > maxResidentBytes;
    if (!mustEvictForBudget && !entry.stale) {
      retain.add(entry.candidate.id);
      continue;
    }
    if (entry.protectedByAge && !mustEvictForBudget) {
      retain.add(entry.candidate.id);
      continue;
    }
    retain.delete(entry.candidate.id);
    evict.push(entry.candidate.id);
    residentAfterEviction = Math.max(0, residentAfterEviction - entry.candidate.estimatedBytes);
  }

  return Object.freeze({
    load: Object.freeze(load),
    prefetch: Object.freeze(prefetch),
    retain: Object.freeze([...retain].sort()),
    evict: Object.freeze(evict),
    skipped: Object.freeze(skipped.map((item) => Object.freeze(item))),
    estimatedLoadBytes,
    estimatedResidentBytes: residentAfterEviction,
    maxResidentBytes,
    maxLoads,
  });
};

export interface GisSceneStreamingPlannerConfiguration extends GisSceneStreamingSettings {
  readonly now?: () => number;
}

export const createSceneStreamingPlanner = (configuration: GisSceneStreamingPlannerConfiguration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  let settings = normalizeSettings(configuration);
  let destroyed = false;
  const metrics = {
    plans: 0,
    loadDecisions: 0,
    prefetchDecisions: 0,
    evictions: 0,
    skipped: 0,
    estimatedLoadBytes: 0,
  };

  const plan = (input: Omit<GisSceneStreamingPlanInput, 'now'> & { now?: number | null }): GisStreamingDecision => {
    if (destroyed) throw new Error('GIS scene streaming planner has been destroyed.');
    const decision = planSceneStreaming({ ...input, now: input.now ?? clock() }, settings);
    metrics.plans += 1;
    metrics.loadDecisions += decision.load.length;
    metrics.prefetchDecisions += decision.prefetch.length;
    metrics.evictions += decision.evict.length;
    metrics.skipped += decision.skipped.length;
    metrics.estimatedLoadBytes += decision.estimatedLoadBytes;
    return decision;
  };

  const score = (input: Omit<GisSceneStreamingPlanInput, 'now'>): readonly GisStreamingCandidateScore[] => {
    if (destroyed) return Object.freeze([]);
    return scoreSceneStreamingCandidates({ ...input, now: clock() }, settings);
  };

  const configure = (next: GisSceneStreamingSettings = {}) => {
    if (destroyed) throw new Error('GIS scene streaming planner has been destroyed.');
    settings = normalizeSettings({ ...settings, ...next });
    return settings;
  };

  return Object.freeze({
    plan,
    score,
    configure,
    getSettings: () => settings,
    getMetrics: () => Object.freeze({ ...metrics }),
    destroy: () => { destroyed = true; },
    isDestroyed: () => destroyed,
  });
};
