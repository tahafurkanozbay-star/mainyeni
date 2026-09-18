import type {
  GuardrailReadinessPolicy,
  LifecycleGuardPolicy,
  PayloadBudget,
  TextBoundaryLimits,
  UrlBoundaryPolicy,
  WorkBudgetPolicy,
} from './contracts';
import type { BoundedCachePolicy } from './boundedCache';
import { normalizeBoundedCachePolicy } from './boundedCache';
import type { DeadlinePolicy } from './deadlineRegistry';
import { normalizeDeadlinePolicy } from './deadlineRegistry';
import { normalizeLifecycleGuardPolicy } from './lifecycleGuard';
import { normalizePayloadBudget } from './payloadBoundary';
import { normalizeGuardrailReadinessPolicy } from './readiness';
import { normalizeTextBoundaryLimits } from './textBoundary';
import { normalizeUrlBoundaryPolicy } from './urlBoundary';
import { normalizeWorkBudgetPolicy } from './workBudget';

export type GuardrailProfileName = 'interactive' | 'bulk' | 'background';

export interface PlatformGuardrailProfile {
  readonly name: GuardrailProfileName;
  readonly text: TextBoundaryLimits;
  readonly url: UrlBoundaryPolicy;
  readonly payload: PayloadBudget;
  readonly work: WorkBudgetPolicy;
  readonly lifecycle: LifecycleGuardPolicy;
  readonly cache: BoundedCachePolicy;
  readonly deadline: DeadlinePolicy;
  readonly readiness: GuardrailReadinessPolicy;
}

export interface PlatformGuardrailProfileInput {
  readonly name?: GuardrailProfileName;
  readonly text?: Partial<TextBoundaryLimits>;
  readonly url?: Partial<UrlBoundaryPolicy>;
  readonly payload?: Partial<PayloadBudget>;
  readonly work?: Partial<WorkBudgetPolicy>;
  readonly lifecycle?: Partial<LifecycleGuardPolicy>;
  readonly cache?: Partial<BoundedCachePolicy>;
  readonly deadline?: Partial<DeadlinePolicy>;
  readonly readiness?: Partial<GuardrailReadinessPolicy>;
}

const INTERACTIVE_OVERRIDES: PlatformGuardrailProfileInput = Object.freeze({
  name: 'interactive',
  work: Object.freeze({
    maxConcurrent: 8,
    maxQueued: 96,
    maxPerKey: 2,
    maxWaitMs: 8_000,
    maxRunMs: 45_000,
    maxCompletedHistory: 192,
  }),
  cache: Object.freeze({
    capacity: 256,
    ttlMs: 60_000,
    maxKeyLength: 256,
    maxEstimatedWeight: 8 * 1024 * 1024,
    maxEntryWeight: 512 * 1024,
  }),
  deadline: Object.freeze({
    defaultTimeoutMs: 20_000,
    minimumTimeoutMs: 50,
    maximumTimeoutMs: 60_000,
    maxTracked: 512,
  }),
});

const BULK_OVERRIDES: PlatformGuardrailProfileInput = Object.freeze({
  name: 'bulk',
  payload: Object.freeze({
    maxDepth: 16,
    maxObjectKeys: 512,
    maxArrayItems: 4_096,
    maxStringLength: 131_072,
    maxUtf8Bytes: 8 * 1024 * 1024,
    maxTotalNodes: 32_768,
  }),
  work: Object.freeze({
    maxConcurrent: 4,
    maxQueued: 32,
    maxPerKey: 1,
    maxWaitMs: 30_000,
    maxRunMs: 120_000,
    maxCompletedHistory: 128,
  }),
  cache: Object.freeze({
    capacity: 64,
    ttlMs: 30_000,
    maxKeyLength: 256,
    maxEstimatedWeight: 16 * 1024 * 1024,
    maxEntryWeight: 2 * 1024 * 1024,
  }),
  deadline: Object.freeze({
    defaultTimeoutMs: 90_000,
    minimumTimeoutMs: 100,
    maximumTimeoutMs: 180_000,
    maxTracked: 128,
  }),
});

const BACKGROUND_OVERRIDES: PlatformGuardrailProfileInput = Object.freeze({
  name: 'background',
  work: Object.freeze({
    maxConcurrent: 2,
    maxQueued: 48,
    maxPerKey: 1,
    maxWaitMs: 60_000,
    maxRunMs: 180_000,
    maxCompletedHistory: 96,
  }),
  lifecycle: Object.freeze({
    maxTrackedResources: 512,
    maxOwnersPerResource: 4,
    staleAfterMs: 10 * 60_000,
    maxHistory: 256,
  }),
  cache: Object.freeze({
    capacity: 128,
    ttlMs: 5 * 60_000,
    maxKeyLength: 256,
    maxEstimatedWeight: 8 * 1024 * 1024,
    maxEntryWeight: 512 * 1024,
  }),
  deadline: Object.freeze({
    defaultTimeoutMs: 120_000,
    minimumTimeoutMs: 100,
    maximumTimeoutMs: 5 * 60_000,
    maxTracked: 256,
  }),
});

const baseForName = (
  name: GuardrailProfileName,
): PlatformGuardrailProfileInput => {
  if (name === 'bulk') return BULK_OVERRIDES;
  if (name === 'background') return BACKGROUND_OVERRIDES;
  return INTERACTIVE_OVERRIDES;
};

const mergePartial = <T extends object>(
  base: Partial<T> | undefined,
  override: Partial<T> | undefined,
): Partial<T> => {
  const merged: Partial<T> = {};
  if (base) Object.assign(merged, base);
  if (override) Object.assign(merged, override);
  return merged;
};

export const createPlatformGuardrailProfile = (
  input: PlatformGuardrailProfileInput = {},
): PlatformGuardrailProfile => {
  const name = input.name ?? 'interactive';
  const preset = baseForName(name);

  return Object.freeze({
    name,
    text: normalizeTextBoundaryLimits(
      mergePartial(preset.text, input.text),
    ),
    url: normalizeUrlBoundaryPolicy(
      mergePartial(preset.url, input.url),
    ),
    payload: normalizePayloadBudget(
      mergePartial(preset.payload, input.payload),
    ),
    work: normalizeWorkBudgetPolicy(
      mergePartial(preset.work, input.work),
    ),
    lifecycle: normalizeLifecycleGuardPolicy(
      mergePartial(preset.lifecycle, input.lifecycle),
    ),
    cache: normalizeBoundedCachePolicy(
      mergePartial(preset.cache, input.cache),
    ),
    deadline: normalizeDeadlinePolicy(
      mergePartial(preset.deadline, input.deadline),
    ),
    readiness: normalizeGuardrailReadinessPolicy(
      mergePartial(preset.readiness, input.readiness),
    ),
  });
};

export const createInteractiveGuardrailProfile = (
  input: Omit<PlatformGuardrailProfileInput, 'name'> = {},
): PlatformGuardrailProfile => createPlatformGuardrailProfile({
  ...input,
  name: 'interactive',
});

export const createBulkGuardrailProfile = (
  input: Omit<PlatformGuardrailProfileInput, 'name'> = {},
): PlatformGuardrailProfile => createPlatformGuardrailProfile({
  ...input,
  name: 'bulk',
});

export const createBackgroundGuardrailProfile = (
  input: Omit<PlatformGuardrailProfileInput, 'name'> = {},
): PlatformGuardrailProfile => createPlatformGuardrailProfile({
  ...input,
  name: 'background',
});

export const profileSupportsPayloadBytes = (
  profile: PlatformGuardrailProfile,
  requiredBytes: number,
): boolean =>
  Number.isFinite(requiredBytes) &&
  requiredBytes >= 0 &&
  requiredBytes <= profile.payload.maxUtf8Bytes;

export const profileSupportsConcurrentWork = (
  profile: PlatformGuardrailProfile,
  requiredConcurrent: number,
): boolean =>
  Number.isFinite(requiredConcurrent) &&
  requiredConcurrent >= 0 &&
  requiredConcurrent <= profile.work.maxConcurrent;

export const profileCapacitySummary = (
  profile: PlatformGuardrailProfile,
): Readonly<{
  name: GuardrailProfileName;
  maxConcurrent: number;
  maxQueued: number;
  maxPayloadBytes: number;
  cacheEntries: number;
  cacheWeight: number;
  defaultDeadlineMs: number;
  trackedResources: number;
}> => Object.freeze({
  name: profile.name,
  maxConcurrent: profile.work.maxConcurrent,
  maxQueued: profile.work.maxQueued,
  maxPayloadBytes: profile.payload.maxUtf8Bytes,
  cacheEntries: profile.cache.capacity,
  cacheWeight: profile.cache.maxEstimatedWeight,
  defaultDeadlineMs: profile.deadline.defaultTimeoutMs,
  trackedResources: profile.lifecycle.maxTrackedResources,
});
