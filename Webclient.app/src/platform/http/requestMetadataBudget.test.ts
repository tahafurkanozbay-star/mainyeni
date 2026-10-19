import { describe, expect, test } from 'vitest';
import {
  DEFAULT_REQUEST_METADATA_BUDGET,
  assertHeaderCollectionBudget,
  assertQueryArrayBudget,
  assertQueryKeyBudget,
  assertQueryKeyCount,
  assertQueryStringBudget,
  createRequestMetadataBudget,
  requestMetadataSnapshot,
} from './requestMetadataBudget';
import {
  sanitizeRequestHeaders,
  serializeQueryParams,
} from './requestPolicy';

describe('request metadata budget defaults', () => {
  test('exposes a bounded immutable policy', () => {
    expect(DEFAULT_REQUEST_METADATA_BUDGET).toMatchObject({
      maxHeaderCount: 64,
      maxHeaderNameBytes: 128,
      maxHeaderValueBytes: 8 * 1024,
      maxHeaderBytes: 32 * 1024,
      maxQueryKeys: 128,
      maxQueryArrayItems: 256,
      maxQueryKeyBytes: 256,
      maxQueryBytes: 16 * 1024,
    });
    expect(Object.isFrozen(DEFAULT_REQUEST_METADATA_BUDGET)).toBe(true);
  });

  test('allows narrower caller-owned policies', () => {
    const budget = createRequestMetadataBudget({
      maxHeaderCount: 4,
      maxHeaderNameBytes: 32,
      maxHeaderValueBytes: 512,
      maxHeaderBytes: 2048,
      maxQueryKeys: 8,
      maxQueryArrayItems: 16,
      maxQueryKeyBytes: 64,
      maxQueryBytes: 4096,
    });
    expect(budget).toMatchObject({
      maxHeaderCount: 4,
      maxQueryKeys: 8,
      maxQueryArrayItems: 16,
      maxQueryBytes: 4096,
    });
  });

  test.each([
    [{ maxHeaderCount: 0 }, 'maxHeaderCount'],
    [{ maxHeaderCount: 257 }, 'maxHeaderCount'],
    [{ maxHeaderNameBytes: 8 }, 'maxHeaderNameBytes'],
    [{ maxHeaderValueBytes: 1 }, 'minimum'],
    [{ maxHeaderBytes: 999 }, 'minimum'],
    [{ maxQueryKeys: 0 }, 'maxQueryKeys'],
    [{ maxQueryArrayItems: 0 }, 'maxQueryArrayItems'],
    [{ maxQueryKeyBytes: 1 }, 'maxQueryKeyBytes'],
    [{ maxQueryBytes: 1 }, 'minimum'],
  ] as const)('rejects unsafe budget overrides %#', (options, expected) => {
    expect(() => createRequestMetadataBudget(options)).toThrow(expected);
  });
});

describe('header collection budget', () => {
  test('accepts a small ordinary header set', () => {
    expect(assertHeaderCollectionBudget([
      ['Accept', 'application/json'],
      ['X-Request-Mode', 'compact'],
    ])).toBeGreaterThan(0);
  });

  test('rejects too many headers before sanitization', () => {
    const entries = Array.from(
      { length: 65 },
      (_, index) => ['X-Test-' + index, 'value'] as const,
    );
    expect(() => assertHeaderCollectionBudget(entries))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
      }));
  });

  test('rejects oversized header names', () => {
    const budget = createRequestMetadataBudget({
      maxHeaderNameBytes: 16,
    });
    expect(() => assertHeaderCollectionBudget([
      ['X-' + 'a'.repeat(20), 'value'],
    ], budget)).toThrowError(expect.objectContaining({
      code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
    }));
  });

  test('rejects oversized header values', () => {
    const budget = createRequestMetadataBudget({
      maxHeaderValueBytes: 128,
    });
    expect(() => assertHeaderCollectionBudget([
      ['X-Test', 'x'.repeat(129)],
    ], budget)).toThrowError(expect.objectContaining({
      code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
    }));
  });

  test('counts UTF-8 bytes rather than JavaScript code units', () => {
    const budget = createRequestMetadataBudget({
      maxHeaderValueBytes: 128,
    });
    expect(() => assertHeaderCollectionBudget([
      ['X-Test', 'ü'.repeat(65)],
    ], budget)).toThrowError(expect.objectContaining({
      code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
    }));
  });

  test('rejects total header bytes beyond the aggregate limit', () => {
    const budget = createRequestMetadataBudget({
      maxHeaderValueBytes: 1024,
      maxHeaderBytes: 1024,
    });
    expect(() => assertHeaderCollectionBudget([
      ['X-One', 'a'.repeat(600)],
      ['X-Two', 'b'.repeat(600)],
    ], budget)).toThrowError(expect.objectContaining({
      code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
    }));
  });

  test('ignores nullish values when charging value bytes', () => {
    expect(assertHeaderCollectionBudget([
      ['X-Optional', null],
      ['X-Undefined', undefined],
    ])).toBeGreaterThan(0);
  });

  test('sanitizeRequestHeaders enforces header cardinality', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => ['X-' + index, 'value']),
    );
    expect(() => sanitizeRequestHeaders(headers))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
      }));
  });

  test('sanitizeRequestHeaders enforces aggregate byte budget', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => ['X-' + index, 'x'.repeat(5000)]),
    );
    expect(() => sanitizeRequestHeaders(headers))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_HEADER_BUDGET_EXCEEDED',
      }));
  });

  test('sanitization still blocks privileged headers before transport', () => {
    expect(() => sanitizeRequestHeaders({
      Authorization: 'Bearer secret',
    })).toThrowError(expect.objectContaining({
      code: 'PRIVILEGED_HEADER_BLOCKED',
    }));
  });

  test('sanitization still blocks control characters', () => {
    expect(() => sanitizeRequestHeaders({
      'X-Test': 'safe\r\nInjected: yes',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_REQUEST_HEADER',
    }));
  });
});

describe('query key budget', () => {
  test('accepts ordinary Unicode query keys', () => {
    expect(() => assertQueryKeyBudget('ilçe')).not.toThrow();
  });

  test('rejects blank keys', () => {
    expect(() => assertQueryKeyBudget(''))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('rejects oversized UTF-8 keys', () => {
    const budget = createRequestMetadataBudget({
      maxQueryKeyBytes: 16,
    });
    expect(() => assertQueryKeyBudget('ü'.repeat(9), budget))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test.each(['line\nbreak', 'tab\tkey', 'null\0key'])(
    'rejects control characters in key %p',
    (key) => {
      expect(() => assertQueryKeyBudget(key))
        .toThrowError(expect.objectContaining({
          code: 'INVALID_QUERY_PARAMS',
        }));
    },
  );
});

describe('query cardinality budget', () => {
  test('accepts key count at the exact boundary', () => {
    expect(() => assertQueryKeyCount(128)).not.toThrow();
  });

  test('rejects key count above the boundary', () => {
    expect(() => assertQueryKeyCount(129))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('rejects invalid negative counts', () => {
    expect(() => assertQueryKeyCount(-1))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('accepts arrays at the exact item boundary', () => {
    expect(() => assertQueryArrayBudget(Array.from({ length: 256 })))
      .not.toThrow();
  });

  test('rejects arrays above the item boundary', () => {
    expect(() => assertQueryArrayBudget(Array.from({ length: 257 })))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });
});

describe('query byte budget', () => {
  test('accepts compact query strings', () => {
    expect(assertQueryStringBudget('page=1&limit=20')).toBe(15);
  });

  test('rejects oversized serialized query strings', () => {
    const budget = createRequestMetadataBudget({
      maxQueryBytes: 1024,
    });
    expect(() => assertQueryStringBudget(
      'q=' + 'x'.repeat(1024),
      budget,
    )).toThrowError(expect.objectContaining({
      code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
    }));
  });

  test('charges encoded Unicode by UTF-8 bytes after serialization', () => {
    const serialized = new URLSearchParams({ q: 'Çankaya' }).toString();
    expect(assertQueryStringBudget(serialized)).toBeGreaterThan('q=Çankaya'.length);
  });
});

describe('serializeQueryParams governance', () => {
  test('keeps deterministic object key ordering', () => {
    expect(serializeQueryParams({
      z: 1,
      a: 2,
      m: 3,
    })).toBe('a=2&m=3&z=1');
  });

  test('preserves repeated array values', () => {
    expect(serializeQueryParams({
      category: ['park', 'library'],
    })).toBe('category=park&category=library');
  });

  test('rejects object query arrays above bounded cardinality', () => {
    expect(() => serializeQueryParams({
      id: Array.from({ length: 257 }, (_, index) => index),
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
    }));
  });

  test('rejects too many object query keys', () => {
    const query = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => ['k' + index, index]),
    );
    expect(() => serializeQueryParams(query))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('rejects oversized object query strings', () => {
    expect(() => serializeQueryParams({
      q: 'x'.repeat(20_000),
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
    }));
  });

  test('rejects control characters in object query keys', () => {
    expect(() => serializeQueryParams({
      'bad\nkey': 'value',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_QUERY_PARAMS',
    }));
  });

  test('governs URLSearchParams key cardinality', () => {
    const params = new URLSearchParams();
    for (let index = 0; index < 129; index += 1) {
      params.append('k' + index, String(index));
    }
    expect(() => serializeQueryParams(params))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('governs URLSearchParams repeated-item cardinality', () => {
    const params = new URLSearchParams();
    for (let index = 0; index < 257; index += 1) {
      params.append('id', String(index));
    }
    expect(() => serializeQueryParams(params))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('governs URLSearchParams serialized bytes', () => {
    const params = new URLSearchParams({
      q: 'x'.repeat(20_000),
    });
    expect(() => serializeQueryParams(params))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_QUERY_BUDGET_EXCEEDED',
      }));
  });

  test('rejects URLSearchParams control characters in keys', () => {
    const params = new URLSearchParams();
    params.append('bad\nkey', 'value');
    expect(() => serializeQueryParams(params))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_QUERY_PARAMS',
      }));
  });
});

describe('request metadata snapshots', () => {
  test('normalizes a compact immutable snapshot', () => {
    const snapshot = requestMetadataSnapshot({
      headerCount: 2,
      headerBytes: 128,
      queryKeys: 3,
      queryItems: 5,
      queryBytes: 256,
    });
    expect(snapshot).toEqual({
      headerCount: 2,
      headerBytes: 128,
      queryKeys: 3,
      queryItems: 5,
      queryBytes: 256,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('clamps invalid snapshot counters to zero', () => {
    expect(requestMetadataSnapshot({
      headerCount: -1,
      headerBytes: Number.NaN,
      queryKeys: -5,
      queryItems: Number.NEGATIVE_INFINITY,
      queryBytes: -10,
    })).toEqual({
      headerCount: 0,
      headerBytes: 0,
      queryKeys: 0,
      queryItems: 0,
      queryBytes: 0,
    });
  });
});
