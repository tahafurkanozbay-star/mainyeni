import { describe, expect, it } from 'vitest';
import {
  boundedInteger,
  boundedNumber,
  classifyResourceCategory,
  classifyResourceOrigin,
  finiteNumber,
  hashString,
  normalizeNavigationType,
  normalizeVitalName,
  normalizeVitalRating,
  nonNegativeNumber,
  roundMetric,
  safeRatio,
  safeText,
  stableObjectString,
  stableUnique,
} from './normalization';
import { createBoundedSampleWindow, percentile, summarizeNumbers } from './statistics';

describe('performance normalization', () => {
  it('normalizes finite values without coercing arbitrary objects', () => {
    expect(finiteNumber(12)).toBe(12);
    expect(finiteNumber('12.5')).toBe(12.5);
    expect(finiteNumber('')).toBeNull();
    expect(finiteNumber({ value: 1 })).toBeNull();
    expect(nonNegativeNumber(-10)).toBe(0);
    expect(nonNegativeNumber('5')).toBe(5);
  });

  it('bounds numeric and integer policy values deterministically', () => {
    expect(boundedNumber(200, 0, 100, 50)).toBe(100);
    expect(boundedNumber(-10, 0, 100, 50)).toBe(0);
    expect(boundedNumber('bad', 0, 100, 50)).toBe(50);
    expect(boundedInteger(9.9, 1, 10, 2)).toBe(9);
  });

  it('handles ratios and text safely', () => {
    expect(safeRatio(5, 10)).toBe(0.5);
    expect(safeRatio(5, 0)).toBe(0);
    expect(safeText('  a\u0000b  ')).toBe('ab');
    expect(safeText('abcdef', 3)).toBe('abc');
    expect(roundMetric(1.23456, 3)).toBe(1.235);
  });

  it('classifies resource categories and origins without retaining full URLs', () => {
    expect(classifyResourceCategory('script')).toBe('script');
    expect(classifyResourceCategory('link')).toBe('style');
    expect(classifyResourceCategory('xmlhttprequest')).toBe('xmlhttprequest');
    expect(classifyResourceCategory('unknown')).toBe('other');

    expect(classifyResourceOrigin(
      'https://app.example.com/assets/app.js?secret=value',
      'https://app.example.com',
    )).toEqual({ kind: 'same-origin', origin: 'https://app.example.com' });

    expect(classifyResourceOrigin(
      'https://cdn.example.net/font.woff2',
      'https://app.example.com',
    )).toEqual({ kind: 'cross-origin', origin: 'https://cdn.example.net' });

    expect(classifyResourceOrigin('blob:https://app.example.com/123', 'https://app.example.com'))
      .toEqual({ kind: 'opaque', origin: null });
  });

  it('normalizes web-vital metadata', () => {
    expect(normalizeVitalName('lcp')).toBe('LCP');
    expect(normalizeVitalName('unknown')).toBeNull();
    expect(normalizeVitalRating('needs-improvement')).toBe('needs-improvement');
    expect(normalizeVitalRating('invalid')).toBe('unknown');
    expect(normalizeNavigationType(' BACK-FORWARD ')).toBe('back-forward');
  });

  it('creates deterministic unique and hash identities', () => {
    expect(stableUnique(['b', 'a', 'b'])).toEqual(['a', 'b']);
    const first = stableObjectString({ b: 2, a: 1 });
    const second = stableObjectString({ a: 1, b: 2 });
    expect(first).toBe(second);
    expect(hashString(first)).toBe(hashString(second));
  });
});

describe('performance statistics', () => {
  it('interpolates percentiles and returns empty distributions safely', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([0, 10], 0.5)).toBe(5);

    expect(summarizeNumbers([])).toEqual({
      count: 0,
      minimum: null,
      maximum: null,
      sum: 0,
      average: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
      latest: null,
    });
  });

  it('summarizes numeric samples with bounded precision', () => {
    const summary = summarizeNumbers([1, 2, 3, 4, 5]);
    expect(summary.count).toBe(5);
    expect(summary.minimum).toBe(1);
    expect(summary.maximum).toBe(5);
    expect(summary.sum).toBe(15);
    expect(summary.average).toBe(3);
    expect(summary.p50).toBe(3);
    expect(summary.latest).toBe(5);
  });

  it('evicts oldest values from bounded windows', () => {
    const window = createBoundedSampleWindow(3);
    expect(window.addMany([1, 2, 3, 4])).toBe(4);
    expect(window.values()).toEqual([2, 3, 4]);
    expect(window.size()).toBe(3);
    expect(window.clear()).toBe(3);
    expect(window.size()).toBe(0);
  });
});
