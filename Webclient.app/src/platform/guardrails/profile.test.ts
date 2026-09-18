import { describe, expect, it } from 'vitest';
import {
  createBackgroundGuardrailProfile,
  createBulkGuardrailProfile,
  createInteractiveGuardrailProfile,
  createPlatformGuardrailProfile,
  profileCapacitySummary,
  profileSupportsConcurrentWork,
  profileSupportsPayloadBytes,
} from './profile';

describe('platform guardrail profiles', () => {
  it('creates the interactive profile by default', () => {
    const profile = createPlatformGuardrailProfile();
    expect(profile.name).toBe('interactive');
    expect(profile.work.maxConcurrent).toBe(8);
    expect(profile.deadline.defaultTimeoutMs).toBe(20_000);
  });

  it('creates a bulk profile with larger payload capacity', () => {
    const interactive = createInteractiveGuardrailProfile();
    const bulk = createBulkGuardrailProfile();
    expect(bulk.name).toBe('bulk');
    expect(bulk.payload.maxUtf8Bytes).toBeGreaterThan(
      interactive.payload.maxUtf8Bytes,
    );
    expect(bulk.work.maxConcurrent).toBeLessThan(
      interactive.work.maxConcurrent,
    );
  });

  it('creates a background profile with conservative concurrency', () => {
    const profile = createBackgroundGuardrailProfile();
    expect(profile.name).toBe('background');
    expect(profile.work.maxConcurrent).toBe(2);
    expect(profile.deadline.defaultTimeoutMs).toBeGreaterThan(60_000);
  });

  it('allows callers to narrow preset limits', () => {
    const profile = createBulkGuardrailProfile({
      work: { maxConcurrent: 1 },
      payload: { maxUtf8Bytes: 1_024 },
    });
    expect(profile.work.maxConcurrent).toBe(1);
    expect(profile.payload.maxUtf8Bytes).toBe(1_024);
  });

  it('normalizes invalid overrides through subsystem policies', () => {
    const profile = createInteractiveGuardrailProfile({
      work: { maxConcurrent: 0 },
      cache: { capacity: Number.NaN },
      deadline: { defaultTimeoutMs: -1 },
      payload: { maxDepth: 0 },
    });
    expect(profile.work.maxConcurrent).toBeGreaterThan(0);
    expect(profile.cache.capacity).toBeGreaterThan(0);
    expect(profile.deadline.defaultTimeoutMs).toBeGreaterThan(0);
    expect(profile.payload.maxDepth).toBeGreaterThan(0);
  });

  it('checks payload capacity without allocating payloads', () => {
    const profile = createInteractiveGuardrailProfile({
      payload: { maxUtf8Bytes: 100 },
    });
    expect(profileSupportsPayloadBytes(profile, 100)).toBe(true);
    expect(profileSupportsPayloadBytes(profile, 101)).toBe(false);
    expect(profileSupportsPayloadBytes(profile, -1)).toBe(false);
    expect(profileSupportsPayloadBytes(profile, Number.NaN)).toBe(false);
  });

  it('checks concurrency capacity deterministically', () => {
    const profile = createInteractiveGuardrailProfile({
      work: { maxConcurrent: 3 },
    });
    expect(profileSupportsConcurrentWork(profile, 3)).toBe(true);
    expect(profileSupportsConcurrentWork(profile, 4)).toBe(false);
    expect(profileSupportsConcurrentWork(profile, -1)).toBe(false);
  });

  it('emits a stable capacity summary for diagnostics', () => {
    const profile = createBackgroundGuardrailProfile();
    expect(profileCapacitySummary(profile)).toEqual({
      name: 'background',
      maxConcurrent: profile.work.maxConcurrent,
      maxQueued: profile.work.maxQueued,
      maxPayloadBytes: profile.payload.maxUtf8Bytes,
      cacheEntries: profile.cache.capacity,
      cacheWeight: profile.cache.maxEstimatedWeight,
      defaultDeadlineMs: profile.deadline.defaultTimeoutMs,
    });
  });

  it('keeps preset objects independent from caller overrides', () => {
    const narrowed = createInteractiveGuardrailProfile({
      work: { maxConcurrent: 1 },
    });
    const fresh = createInteractiveGuardrailProfile();
    expect(narrowed.work.maxConcurrent).toBe(1);
    expect(fresh.work.maxConcurrent).toBe(8);
  });
});
