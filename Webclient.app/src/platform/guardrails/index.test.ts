import { describe, expect, it } from 'vitest';
import {
  createBackgroundGuardrailProfile,
  createBulkGuardrailProfile,
  createInteractiveGuardrailProfile,
  createPlatformGuardrailProfile,
  estimateUtf8Bytes,
  evaluatePayloadBoundary,
  normalizeBoundedCachePolicy,
  normalizeDeadlinePolicy,
  normalizeGuardrailReadinessPolicy,
  normalizePayloadBudget,
  normalizeTextBoundaryLimits,
  normalizeUrlBoundaryPolicy,
  normalizeWorkBudgetPolicy,
  profileCapacitySummary,
  profileSupportsConcurrentWork,
  profileSupportsPayloadBytes,
} from './index';

describe('guardrail public boundary', () => {
  it('constructs every supported profile through the public module', () => {
    const interactive = createInteractiveGuardrailProfile();
    const bulk = createBulkGuardrailProfile();
    const background = createBackgroundGuardrailProfile();

    expect(interactive.name).toBe('interactive');
    expect(bulk.name).toBe('bulk');
    expect(background.name).toBe('background');
    expect(interactive.work.maxConcurrent).toBeGreaterThan(background.work.maxConcurrent);
    expect(bulk.payload.maxUtf8Bytes).toBeGreaterThan(interactive.payload.maxUtf8Bytes);
  });

  it('keeps profile overrides normalized and bounded', () => {
    const profile = createPlatformGuardrailProfile({
      name: 'interactive',
      work: { maxConcurrent: 3, maxQueued: 12 },
      cache: { capacity: 32, ttlMs: 5_000 },
      deadline: { defaultTimeoutMs: 2_000 },
    });

    expect(profile.work.maxConcurrent).toBe(3);
    expect(profile.work.maxQueued).toBe(12);
    expect(profile.cache.capacity).toBe(32);
    expect(profile.cache.ttlMs).toBe(5_000);
    expect(profile.deadline.defaultTimeoutMs).toBe(2_000);
  });

  it('exposes stable capacity decisions without implementation imports', () => {
    const profile = createInteractiveGuardrailProfile();
    const summary = profileCapacitySummary(profile);

    expect(summary.name).toBe('interactive');
    expect(summary.maxConcurrent).toBe(profile.work.maxConcurrent);
    expect(summary.maxQueued).toBe(profile.work.maxQueued);
    expect(summary.maxPayloadBytes).toBe(profile.payload.maxUtf8Bytes);
    expect(summary.cacheEntries).toBe(profile.cache.capacity);
    expect(summary.defaultDeadlineMs).toBe(profile.deadline.defaultTimeoutMs);

    expect(profileSupportsConcurrentWork(profile, profile.work.maxConcurrent)).toBe(true);
    expect(profileSupportsConcurrentWork(profile, profile.work.maxConcurrent + 1)).toBe(false);
    expect(profileSupportsConcurrentWork(profile, Number.NaN)).toBe(false);
    expect(profileSupportsPayloadBytes(profile, profile.payload.maxUtf8Bytes)).toBe(true);
    expect(profileSupportsPayloadBytes(profile, profile.payload.maxUtf8Bytes + 1)).toBe(false);
    expect(profileSupportsPayloadBytes(profile, -1)).toBe(false);
  });

  it('exposes payload evaluation with deterministic byte accounting', () => {
    const value = { id: 7, label: 'Ankara', tags: ['kent', 'rehberi'] };
    const result = evaluatePayloadBoundary(value, { maxUtf8Bytes: 1_024 });

    expect(result.accepted).toBe(true);
    expect(result.value).toBe(value);
    expect(result.stats.nodes).toBeGreaterThan(0);
    expect(result.stats.utf8Bytes).toBeGreaterThanOrEqual(estimateUtf8Bytes('Ankara'));
  });

  it('keeps all policy normalizers reachable from one reviewed boundary', () => {
    expect(normalizeTextBoundaryLimits({ maxCodeUnits: 128 }).maxCodeUnits).toBe(128);
    expect(normalizePayloadBudget({ maxTotalNodes: 512 }).maxTotalNodes).toBe(512);
    expect(normalizeWorkBudgetPolicy({ maxConcurrent: 2 }).maxConcurrent).toBe(2);
    expect(normalizeBoundedCachePolicy({ capacity: 16 }).capacity).toBe(16);
    expect(normalizeDeadlinePolicy({ defaultTimeoutMs: 1_500 }).defaultTimeoutMs).toBe(1_500);

    const readiness = normalizeGuardrailReadinessPolicy();
    expect(readiness).toBeDefined();

    const url = normalizeUrlBoundaryPolicy();
    expect(url).toBeDefined();
  });

  it('does not share mutable profile objects between consumers', () => {
    const first = createInteractiveGuardrailProfile();
    const second = createInteractiveGuardrailProfile();

    expect(first).not.toBe(second);
    expect(first.work).not.toBe(second.work);
    expect(first.cache).not.toBe(second.cache);
    expect(first.deadline).not.toBe(second.deadline);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.work)).toBe(true);
  });
});
