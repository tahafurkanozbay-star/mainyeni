import { describe, expect, it } from 'vitest';
import {
  estimateUtf8Bytes,
  evaluateHeaderBoundary,
  evaluateTextBoundary,
  hasSensitiveUnicodeFormatting,
  sanitizeFileName,
  truncateUtf8,
} from './textBoundary';

describe('textBoundary', () => {
  it('normalizes unicode, invisible formatting and outer whitespace', () => {
    const result = evaluateTextBoundary('  A\u200BＢ  ');
    expect(result.accepted).toBe(true);
    expect(result.value).toBe('AB');
    expect(result.changed).toBe(true);
    expect(result.originalLength).toBeGreaterThan(result.value.length);
  });

  it('rejects control characters while retaining normalized evidence', () => {
    const result = evaluateTextBoundary('ankara\u0000kent');
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('control-character');
    expect(result.value).toContain('\u0000');
  });

  it('rejects bidirectional formatting controls', () => {
    const result = evaluateTextBoundary('abc\u202Etxt');
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('bidi-control');
    expect(hasSensitiveUnicodeFormatting(result.value)).toBe(true);
  });

  it('enforces code-unit and UTF-8 budgets independently', () => {
    const byLength = evaluateTextBoundary('12345', {
      maxCodeUnits: 4,
      maxUtf8Bytes: 100,
    });
    expect(byLength.accepted).toBe(false);
    expect(byLength.reasons.map((entry) => entry.code)).toContain('input-too-long');

    const byBytes = evaluateTextBoundary('şşş', {
      maxCodeUnits: 10,
      maxUtf8Bytes: 5,
    });
    expect(byBytes.accepted).toBe(false);
    expect(byBytes.utf8Bytes).toBe(6);
    expect(byBytes.reasons.map((entry) => entry.code)).toContain('input-too-large');
  });

  it('fails closed for non-string inputs', () => {
    const result = evaluateTextBoundary({ value: 'x' });
    expect(result.accepted).toBe(false);
    expect(result.value).toBe('');
    expect(result.reasons).toHaveLength(1);
  });

  it('normalizes invalid numeric limits to safe defaults', () => {
    const result = evaluateTextBoundary('abc', {
      maxCodeUnits: Number.NaN,
      maxUtf8Bytes: -1,
    });
    expect(result.accepted).toBe(true);
  });

  it('accepts valid header names and canonicalizes case', () => {
    const result = evaluateHeaderBoundary(' X-Request-ID ', ' abc ');
    expect(result.accepted).toBe(true);
    expect(result.name).toBe('x-request-id');
    expect(result.value).toBe('abc');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('rejects header names with separators', () => {
    const result = evaluateHeaderBoundary('bad header', 'value');
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('invalid-header-name');
  });

  it('rejects newline-bearing header values', () => {
    const result = evaluateHeaderBoundary('x-value', 'first\r\nsecond');
    expect(result.accepted).toBe(false);
    expect(result.reasons.map((entry) => entry.code)).toContain('invalid-header-value');
  });

  it('sanitizes reserved and path-like file names deterministically', () => {
    expect(sanitizeFileName('../report?.csv').value).not.toContain('/');
    expect(sanitizeFileName('CON').value).not.toBe('CON');
    expect(sanitizeFileName('  ').value).toBe('unnamed');
  });

  it('preserves ordinary Turkish file names', () => {
    const result = sanitizeFileName('Ankara Kent Rehberi.csv');
    expect(result.accepted).toBe(true);
    expect(result.value).toBe('Ankara Kent Rehberi.csv');
  });

  it('truncates by UTF-8 bytes without cutting the budget', () => {
    const result = truncateUtf8('aşbşc', 5);
    expect(estimateUtf8Bytes(result)).toBeLessThanOrEqual(5);
    expect('aşbşc'.startsWith(result)).toBe(true);
  });

  it('returns input unchanged when it already fits the byte budget', () => {
    expect(truncateUtf8('ankara', 32)).toBe('ankara');
  });

  it('detects sensitive formatting but not ordinary Unicode letters', () => {
    expect(hasSensitiveUnicodeFormatting('Ankara')).toBe(false);
    expect(hasSensitiveUnicodeFormatting('A\u200BB')).toBe(true);
  });
});
