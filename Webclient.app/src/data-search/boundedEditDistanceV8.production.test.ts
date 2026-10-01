import { describe, expect, it } from 'vitest';
import {
  BoundedEditDistanceRuntimeV8,
  boundedEditDistanceV8,
} from './boundedEditDistanceRuntimeV8';

describe('BoundedEditDistanceRuntimeV8 canonical behavior', () => {
  it('treats Turkish case variants as exact after canonical normalization', () => {
    const result = boundedEditDistanceV8('ÇANKAYA', 'çankaya', 2);
    expect(result.distance).toBe(0);
    expect(result.exact).toBe(true);
    expect(result.withinThreshold).toBe(true);
    expect(result.similarity).toBe(1);
  });

  it('accepts one substitution within threshold', () => {
    const result = boundedEditDistanceV8('hastane', 'hastene', 1);
    expect(result.distance).toBe(1);
    expect(result.withinThreshold).toBe(true);
  });

  it('accepts one insertion within threshold', () => {
    const result = boundedEditDistanceV8('kultur', 'kultuur', 1);
    expect(result.distance).toBe(1);
    expect(result.withinThreshold).toBe(true);
  });

  it('accepts one deletion within threshold', () => {
    const result = boundedEditDistanceV8('belediye', 'beledye', 1);
    expect(result.distance).toBe(1);
    expect(result.withinThreshold).toBe(true);
  });

  it('treats adjacent transposition as one edit by default', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('parki', 'pakri', 1);
    expect(result.distance).toBe(1);
    expect(result.withinThreshold).toBe(true);
  });

  it('can disable adjacent-transposition handling', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({
      maximumDistance: 2,
      allowAdjacentTransposition: false,
    });
    const result = runtime.evaluate('parki', 'pakri', 1);
    expect(result.withinThreshold).toBe(false);
  });

  it('rejects values whose length delta already exceeds threshold', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('park', 'parklarimiz', 2);
    expect(result.withinThreshold).toBe(false);
    expect(result.comparisons).toBe(0);
  });

  it('rejects distant terms without returning an unbounded distance', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('hastane', 'otopark', 2);
    expect(result.withinThreshold).toBe(false);
    expect(result.distance).toBe(3);
  });

  it('uses threshold plus one as the bounded rejection sentinel', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 4 });
    const result = runtime.evaluate('ankara', 'istanbul', 1);
    expect(result.withinThreshold).toBe(false);
    expect(result.distance).toBe(2);
  });

  it('reports prefix relationships independently from edit acceptance', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('kultur', 'kulturmerkezi', 2);
    expect(result.prefixRelated).toBe(true);
    expect(result.withinThreshold).toBe(false);
  });

  it('handles empty canonical input deterministically', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('', 'ab', 2);
    expect(result.distance).toBe(2);
    expect(result.withinThreshold).toBe(true);
    expect(result.similarity).toBe(0);
  });

  it('rejects empty input when the other token exceeds threshold', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    const result = runtime.evaluate('', 'ankara', 2);
    expect(result.withinThreshold).toBe(false);
  });

  it('bounds token length before computation', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({
      maximumTokenLength: 8,
      maximumDistance: 2,
    });
    const result = runtime.evaluate('ankarabuyuksehir', 'ankarabuyuksehir', 2);
    expect(result.left).toBe('ankarabuy');
    expect(result.right).toBe('ankarabuy');
    expect(result.truncated).toBe(true);
    expect(result.exact).toBe(true);
  });

  it('never compares more than bounded token matrix cells', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({
      maximumTokenLength: 16,
      maximumDistance: 4,
    });
    const result = runtime.evaluate('abcdefghijklmnop', 'abcxefghijklmnop', 4);
    expect(result.comparisons).toBeLessThanOrEqual(16 * 16);
  });

  it('normalizes punctuation-only tokens to empty values', () => {
    const result = boundedEditDistanceV8('---', '...', 1);
    expect(result.exact).toBe(true);
    expect(result.left).toBe('');
    expect(result.right).toBe('');
  });
});

describe('BoundedEditDistanceRuntimeV8 policy and diagnostics', () => {
  it('rejects policy distance above the hard bound', () => {
    expect(() => new BoundedEditDistanceRuntimeV8({ maximumDistance: 9 })).toThrow(RangeError);
  });

  it('rejects zero maximum token length', () => {
    expect(() => new BoundedEditDistanceRuntimeV8({ maximumTokenLength: 0 })).toThrow(RangeError);
  });

  it('rejects per-call threshold above configured maximum', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 1 });
    expect(() => runtime.evaluate('ankara', 'ankarra', 2)).toThrow(RangeError);
  });

  it('exposes immutable normalized policy facts', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({
      maximumTokenLength: 40,
      maximumDistance: 3,
      allowAdjacentTransposition: false,
    });
    expect(runtime.policy()).toEqual({
      maximumTokenLength: 40,
      maximumDistance: 3,
      allowAdjacentTransposition: false,
    });
    expect(Object.isFrozen(runtime.policy())).toBe(true);
  });

  it('tracks exact and threshold matches separately', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    runtime.evaluate('park', 'park');
    runtime.evaluate('park', 'parkk');
    runtime.evaluate('park', 'hastane');
    const snapshot = runtime.snapshot();
    expect(snapshot.evaluations).toBe(3);
    expect(snapshot.exactMatches).toBe(1);
    expect(snapshot.thresholdMatches).toBe(2);
    expect(snapshot.rejectedByThreshold + snapshot.rejectedByLength).toBe(1);
  });

  it('tracks truncated inputs', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({
      maximumTokenLength: 4,
      maximumDistance: 1,
    });
    runtime.evaluate('ankara', 'ankara');
    expect(runtime.snapshot().truncatedInputs).toBe(1);
  });

  it('accumulates comparison count across evaluations', () => {
    const runtime = new BoundedEditDistanceRuntimeV8({ maximumDistance: 2 });
    runtime.evaluate('ankara', 'ankraa');
    const first = runtime.snapshot().comparisons;
    runtime.evaluate('cankaya', 'cankyaa');
    expect(runtime.snapshot().comparisons).toBeGreaterThan(first);
  });

  it('returns a frozen snapshot with version 8', () => {
    const runtime = new BoundedEditDistanceRuntimeV8();
    const snapshot = runtime.snapshot();
    expect(snapshot.version).toBe(8);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
