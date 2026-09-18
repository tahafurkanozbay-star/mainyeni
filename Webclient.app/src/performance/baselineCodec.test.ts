import { describe, expect, it } from 'vitest';
import {
  decodePerformanceBaseline,
  encodePerformanceBaseline,
} from './baselineCodec';

const baseline = {
  schemaVersion: 1 as const,
  label: 'known-good',
  fingerprint: 'abc123',
  capturedAt: 123,
  metrics: {
    lcp: 1200,
    cls: 0.03,
    inp: null,
  },
};

describe('performance baseline codec', () => {
  it('round-trips a valid baseline with stable metric ordering', () => {
    const encoded = encodePerformanceBaseline({
      ...baseline,
      metrics: { lcp: 1200, inp: null, cls: 0.03 },
    });
    expect(encoded.indexOf('"cls"')).toBeLessThan(encoded.indexOf('"inp"'));
    expect(encoded.indexOf('"inp"')).toBeLessThan(encoded.indexOf('"lcp"'));

    const decoded = decodePerformanceBaseline(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.baseline).toEqual(baseline);
  });

  it('rejects unsupported schemas and malformed identity fields', () => {
    const decoded = decodePerformanceBaseline({
      ...baseline,
      schemaVersion: 2,
      label: '',
      fingerprint: 'bad fingerprint with spaces',
    });
    expect(decoded.ok).toBe(false);
    expect(decoded.errors).toContain('baseline-schema-unsupported');
    expect(decoded.errors).toContain('baseline-label-invalid');
    expect(decoded.errors).toContain('baseline-fingerprint-invalid');
  });

  it('rejects invalid metric keys and values', () => {
    const decoded = decodePerformanceBaseline({
      ...baseline,
      metrics: {
        'bad key': 1,
        valid: Number.NaN,
      },
    });
    expect(decoded.ok).toBe(false);
    expect(decoded.errors).toContain('baseline-metric-key-invalid');
    expect(decoded.errors).toContain('baseline-metric-value-invalid');
  });

  it('bounds metric cardinality', () => {
    const metrics = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`metric${index}`, index]),
    );
    const decoded = decodePerformanceBaseline({
      ...baseline,
      metrics,
    }, { maxMetrics: 3 });
    expect(decoded.ok).toBe(false);
    expect(decoded.errors).toContain('baseline-metrics-too-many');
  });

  it('bounds encoded input size before parsing', () => {
    const input = JSON.stringify({
      ...baseline,
      padding: 'x'.repeat(10_000),
    });
    const decoded = decodePerformanceBaseline(input, { maxInputBytes: 512 });
    expect(decoded.ok).toBe(false);
    expect(decoded.errors).toContain('baseline-input-too-large');
  });

  it('throws instead of serializing an invalid baseline', () => {
    expect(() => encodePerformanceBaseline({
      ...baseline,
      fingerprint: 'not valid!',
    })).toThrow(/Invalid performance baseline/u);
  });
});
