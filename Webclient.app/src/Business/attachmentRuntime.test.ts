import { describe, expect, it } from 'vitest';
import { attachmentIdentifierFromAttributes } from './attachmentRuntime';

describe('attachmentIdentifierFromAttributes', () => {
  it.each([
    [{ attachmentid: 12 }, 12],
    [{ attachmentId: 34 }, 34],
    [{ attachmentid: '  56  ' }, '56'],
    [{ attachmentId: 'abc-123' }, 'abc-123'],
  ])('returns a bounded identifier from %j', (value, expected) => {
    expect(attachmentIdentifierFromAttributes(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    true,
    12,
    '12',
    [],
    new Date(),
    {},
    { attachmentid: '' },
    { attachmentid: '   ' },
    { attachmentid: Number.NaN },
    { attachmentid: Number.POSITIVE_INFINITY },
    { attachmentid: -1 },
    { attachmentid: {} },
    { attachmentid: [] },
    { attachmentid: 'x'.repeat(129) },
  ])('rejects malformed attachment attributes %#', (value) => {
    expect(attachmentIdentifierFromAttributes(value)).toBeUndefined();
  });

  it('prefers the canonical lower-case ArcGIS field when both forms exist', () => {
    expect(attachmentIdentifierFromAttributes({
      attachmentid: 7,
      attachmentId: 8,
    })).toBe(7);
  });

  it('does not accept inherited attachment identifiers', () => {
    const value = Object.create({ attachmentid: 99 }) as Record<string, unknown>;
    expect(attachmentIdentifierFromAttributes(value)).toBeUndefined();
  });

  it('accepts zero as a valid numeric identifier', () => {
    expect(attachmentIdentifierFromAttributes({ attachmentid: 0 })).toBe(0);
  });
});
