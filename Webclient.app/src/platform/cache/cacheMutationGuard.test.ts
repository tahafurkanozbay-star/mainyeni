import { describe, expect, it } from 'vitest';
import { CacheMutationGuard } from './cacheMutationGuard';

describe('CacheMutationGuard', () => {
  it('keeps untouched tokens current', () => {
    const guard = new CacheMutationGuard();
    const token = guard.capture('catalog|GET|/places', 'catalog', ['places']);
    expect(guard.isCurrent(token)).toBe(true);
    expect(guard.snapshot()).toMatchObject({
      globalGeneration: 0,
      invalidations: 0,
      trackedKeys: 0,
      trackedNamespaces: 0,
      trackedTags: 0,
    });
  });

  it('invalidates only the targeted exact key', () => {
    const guard = new CacheMutationGuard();
    const first = guard.capture('catalog|GET|/places/1', 'catalog', ['places']);
    const second = guard.capture('catalog|GET|/places/2', 'catalog', ['places']);

    guard.invalidateKey('catalog|GET|/places/1');

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.snapshot()).toMatchObject({ trackedKeys: 1, invalidations: 1 });
  });

  it('invalidates all tokens within a namespace', () => {
    const guard = new CacheMutationGuard();
    const catalog = guard.capture('catalog|GET|/places', 'catalog', ['places']);
    const search = guard.capture('search|GET|/query', 'search', ['places']);

    guard.invalidateNamespace('catalog');

    expect(guard.isCurrent(catalog)).toBe(false);
    expect(guard.isCurrent(search)).toBe(true);
  });

  it('invalidates tokens whose captured tag changed', () => {
    const guard = new CacheMutationGuard();
    const place = guard.capture('catalog|GET|/places/1', 'catalog', ['places', 'district:1']);
    const road = guard.capture('catalog|GET|/roads/1', 'catalog', ['roads']);

    guard.invalidateTags(['district:1']);

    expect(guard.isCurrent(place)).toBe(false);
    expect(guard.isCurrent(road)).toBe(true);
  });

  it('deduplicates invalidation tags before changing generations', () => {
    const guard = new CacheMutationGuard();
    const token = guard.capture('catalog|GET|/places', 'catalog', ['places']);

    guard.invalidateTags(['places', 'places']);

    expect(guard.isCurrent(token)).toBe(false);
    expect(guard.snapshot().trackedTags).toBe(1);
  });

  it('invalidates every token after a global invalidation', () => {
    const guard = new CacheMutationGuard();
    const catalog = guard.capture('catalog|GET|/places', 'catalog', ['places']);
    const search = guard.capture('search|GET|/query', 'search', ['query']);

    guard.invalidateAll();

    expect(guard.isCurrent(catalog)).toBe(false);
    expect(guard.isCurrent(search)).toBe(false);
    expect(guard.snapshot()).toMatchObject({
      globalGeneration: 1,
      trackedKeys: 0,
      trackedNamespaces: 0,
      trackedTags: 0,
      invalidations: 1,
    });
  });

  it('falls back to global invalidation when key tracking is exhausted', () => {
    const guard = new CacheMutationGuard({ maxTrackedKeys: 1 });
    const before = guard.capture('catalog|GET|/places', 'catalog');

    guard.invalidateKey('catalog|GET|/first');
    guard.invalidateKey('catalog|GET|/second');

    expect(guard.isCurrent(before)).toBe(false);
    expect(guard.snapshot()).toMatchObject({
      globalGeneration: 1,
      trackedKeys: 0,
      fallbackGlobalInvalidations: 1,
      invalidations: 2,
    });
  });

  it('falls back to global invalidation when namespace tracking is exhausted', () => {
    const guard = new CacheMutationGuard({ maxTrackedNamespaces: 1 });
    const before = guard.capture('catalog|GET|/places', 'catalog');

    guard.invalidateNamespace('one');
    guard.invalidateNamespace('two');

    expect(guard.isCurrent(before)).toBe(false);
    expect(guard.snapshot().fallbackGlobalInvalidations).toBe(1);
  });

  it('falls back to global invalidation when tag tracking is exhausted', () => {
    const guard = new CacheMutationGuard({ maxTrackedTags: 1 });
    const before = guard.capture('catalog|GET|/places', 'catalog', ['places']);

    guard.invalidateTags(['first']);
    guard.invalidateTags(['second']);

    expect(guard.isCurrent(before)).toBe(false);
    expect(guard.snapshot()).toMatchObject({
      globalGeneration: 1,
      trackedTags: 0,
      fallbackGlobalInvalidations: 1,
    });
  });

  it('keeps invalidation generations monotonic for the guard lifetime', () => {
    const guard = new CacheMutationGuard();
    const token = guard.capture('catalog|GET|/places', 'catalog', ['places']);
    guard.invalidateKey('catalog|GET|/places');
    guard.invalidateNamespace('catalog');
    guard.invalidateTags(['places']);

    expect(guard.isCurrent(token)).toBe(false);
    expect(guard.snapshot()).toMatchObject({
      trackedKeys: 1,
      trackedNamespaces: 1,
      trackedTags: 1,
      invalidations: 3,
    });
  });

  it('captures immutable token metadata', () => {
    const guard = new CacheMutationGuard();
    const token = guard.capture('catalog|GET|/places', 'catalog', ['places']);

    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.tags)).toBe(true);
    expect(Object.isFrozen(token.tagGenerations)).toBe(true);
    expect(Object.isFrozen(token.tagGenerations[0])).toBe(true);
  });

  it('rejects unsafe tracking configuration', () => {
    expect(() => new CacheMutationGuard({ maxTrackedKeys: 0 })).toThrow(RangeError);
    expect(() => new CacheMutationGuard({ maxTrackedNamespaces: 0 })).toThrow(RangeError);
    expect(() => new CacheMutationGuard({ maxTrackedTags: 0 })).toThrow(RangeError);
    expect(() => new CacheMutationGuard({ maxTagsPerToken: 129 })).toThrow(RangeError);
  });

  it('rejects excessive token tags instead of silently truncating them', () => {
    const guard = new CacheMutationGuard({ maxTagsPerToken: 1 });
    expect(() => guard.capture('catalog|GET|/places', 'catalog', ['a', 'b']))
      .toThrow(RangeError);
  });

  it('rejects excessive invalidation batches', () => {
    const guard = new CacheMutationGuard();
    const tags = Array.from({ length: 65 }, (_, index) => 'tag:' + index);
    expect(() => guard.invalidateTags(tags)).toThrow(RangeError);
  });
});
