import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type Matcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toMatchObject(expected: Record<string, unknown>): void;
};

function contains(received: unknown, expected: unknown): boolean {
  if (typeof received === 'string') return received.includes(String(expected));
  if (Array.isArray(received)) return received.includes(expected);
  return false;
}

function matchObject(received: unknown, expected: Record<string, unknown>): void {
  assert.ok(received !== null && typeof received === 'object', 'Expected an object value');
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual((received as Record<string, unknown>)[key], value, `Property ${key} did not match`);
  }
}

export function expect(received: unknown): Matcher {
  return {
    toBe(expected: unknown): void {
      assert.equal(received, expected);
    },
    toEqual(expected: unknown): void {
      assert.deepEqual(received, expected);
    },
    toContain(expected: unknown): void {
      assert.ok(contains(received, expected), `Expected value to contain ${String(expected)}`);
    },
    toHaveLength(expected: number): void {
      assert.ok(received !== null && received !== undefined && 'length' in Object(received), 'Expected a value with length');
      assert.equal((received as { readonly length: number }).length, expected);
    },
    toBeGreaterThanOrEqual(expected: number): void {
      assert.equal(typeof received, 'number', true, 'Expected a numeric value');
      assert.ok((received as number) >= expected, `Expected ${String(received)} to be >= ${expected}`);
    },
    toMatchObject(expected: Record<string, unknown>): void {
      matchObject(received, expected);
    },
  };
}

export { describe, it };
