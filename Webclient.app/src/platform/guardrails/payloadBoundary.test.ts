import { describe, expect, it } from 'vitest';
import {
  estimatePayloadBytes,
  evaluatePayloadBoundary,
  isPayloadWithinBudget,
  normalizePayloadBudget,
} from './payloadBoundary';

describe('payloadBoundary', () => {
  it('accepts bounded JSON-like records', () => {
    const input = {
      id: 7,
      name: 'Ankara',
      active: true,
      tags: ['kent', 'harita'],
      location: { x: 32.8, y: 39.9 },
    };
    const result = evaluatePayloadBoundary(input);
    expect(result.accepted).toBe(true);
    expect(result.value).toEqual(input);
    expect(result.stats.nodes).toBeGreaterThan(5);
    expect(result.stats.utf8Bytes).toBeGreaterThan(0);
  });

  it('normalizes undefined fields without failing the entire payload', () => {
    const result = evaluatePayloadBoundary({ optional: undefined });
    expect(result.accepted).toBe(true);
    expect(result.value).toEqual({ optional: null });
    expect(result.reasons.map((entry) => entry.code)).toContain('undefined-normalized');
  });

  it('rejects non-finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = evaluatePayloadBoundary({ value });
      expect(result.accepted).toBe(false);
      expect(result.value).toBeNull();
    }
  });

  it('normalizes Date and URL values to deterministic strings', () => {
    const result = evaluatePayloadBoundary({
      at: new Date('2026-09-18T12:00:00.000Z'),
      url: new URL('https://example.test/path'),
    });
    expect(result.accepted).toBe(true);
    expect(result.value).toEqual({
      at: '2026-09-18T12:00:00.000Z',
      url: 'https://example.test/path',
    });
  });

  it('rejects cyclic references', () => {
    const input: { self?: unknown } = {};
    input.self = input;
    const result = evaluatePayloadBoundary(input);
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('cycle-detected');
  });

  it('enforces maximum nesting depth', () => {
    const result = evaluatePayloadBoundary(
      { a: { b: { c: { d: 1 } } } },
      { maxDepth: 2 },
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('payload-too-deep');
  });

  it('enforces per-object key budgets', () => {
    const result = evaluatePayloadBoundary(
      { a: 1, b: 2, c: 3 },
      { maxObjectKeys: 2 },
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('payload-too-wide');
  });

  it('enforces array cardinality budgets', () => {
    const result = evaluatePayloadBoundary([1, 2, 3, 4], {
      maxArrayItems: 3,
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('array-too-large');
  });

  it('enforces string length budgets', () => {
    const result = evaluatePayloadBoundary({ text: '123456' }, {
      maxStringLength: 5,
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('string-too-large');
  });

  it('enforces aggregate UTF-8 budgets', () => {
    const result = evaluatePayloadBoundary({ text: 'şşşş' }, {
      maxUtf8Bytes: 7,
    });
    expect(result.accepted).toBe(false);
    expect(result.stats.utf8Bytes).toBeGreaterThan(7);
  });

  it('enforces total node budgets', () => {
    const result = evaluatePayloadBoundary(
      { a: [1, 2, 3], b: [4, 5, 6] },
      { maxTotalNodes: 4 },
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('payload-too-large');
  });

  it('rejects non-plain objects', () => {
    const result = evaluatePayloadBoundary({ value: new Map([['a', 1]]) });
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('unsupported-object');
  });

  it('rejects unsupported primitive runtime values', () => {
    const result = evaluatePayloadBoundary({ value: 3n });
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('unsupported-value');
  });

  it('estimates payload bytes consistently with evaluation stats', () => {
    const input = { city: 'Ankara', district: 'Çankaya' };
    const result = evaluatePayloadBoundary(input);
    expect(estimatePayloadBytes(input)).toBe(result.stats.utf8Bytes);
  });

  it('provides a simple boolean budget predicate', () => {
    expect(isPayloadWithinBudget({ ok: true })).toBe(true);
    expect(isPayloadWithinBudget({ text: '1234' }, { maxStringLength: 3 })).toBe(false);
  });

  it('normalizes invalid policy numbers to bounded defaults', () => {
    const normalized = normalizePayloadBudget({
      maxDepth: Number.NaN,
      maxUtf8Bytes: -5,
    });
    expect(normalized.maxDepth).toBeGreaterThan(1);
    expect(normalized.maxUtf8Bytes).toBeGreaterThan(1_000);
  });
});
