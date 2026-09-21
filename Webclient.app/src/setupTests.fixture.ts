import '@testing-library/jest-dom';
import { vi } from 'vitest';

type UnknownImplementation = (...args: unknown[]) => unknown;

const isClassImplementation = (implementation: unknown): boolean => {
  if (typeof implementation !== 'function') return false;
  return /^class\s/u.test(Function.prototype.toString.call(implementation));
};

const makeLegacyConstructible = (implementation: unknown): unknown => {
  if (typeof implementation !== 'function' || isClassImplementation(implementation)) {
    return implementation;
  }

  const callable = implementation as UnknownImplementation;
  function LegacyConstructibleMock(this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(callable, this, args);
  }

  return LegacyConstructibleMock;
};

const originalFn = vi.fn.bind(vi) as typeof vi.fn;
const legacyCompatibleFn = ((implementation?: unknown) => {
  const mock = originalFn();
  const originalImplementation = mock.mockImplementation.bind(mock);
  const originalImplementationOnce = mock.mockImplementationOnce.bind(mock);

  mock.mockImplementation = ((nextImplementation: UnknownImplementation) =>
    originalImplementation(makeLegacyConstructible(nextImplementation) as UnknownImplementation))
    as typeof mock.mockImplementation;

  mock.mockImplementationOnce = ((nextImplementation: UnknownImplementation) =>
    originalImplementationOnce(makeLegacyConstructible(nextImplementation) as UnknownImplementation))
    as typeof mock.mockImplementationOnce;

  if (implementation !== undefined) {
    mock.mockImplementation(implementation as UnknownImplementation);
  }

  return mock;
}) as typeof vi.fn;

// Keep the constructor-compatibility shim inside the test runtime only. This is
// intentionally not a production transform and can be removed when all ArcGIS
// constructor mocks use constructible implementations natively.
vi.fn = legacyCompatibleFn;
