import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Legacy Jest tests frequently use arrow functions as mock implementations for SDK
// constructors. Jest's mock wrapper tolerated that pattern when the mock itself was
// called with `new`; Vitest intentionally requires the implementation to be
// constructible. Keep this compatibility strictly inside the test harness so the
// production ArcGIS runtime remains unchanged while the suite migrates incrementally.
const isClassImplementation = (implementation) => {
  if (typeof implementation !== 'function') return false;
  return /^class\s/.test(Function.prototype.toString.call(implementation));
};

const makeLegacyConstructible = (implementation) => {
  if (typeof implementation !== 'function' || isClassImplementation(implementation)) {
    return implementation;
  }

  function LegacyConstructibleMock(...args) {
    return Reflect.apply(implementation, this, args);
  }

  return LegacyConstructibleMock;
};

const originalFn = vi.fn.bind(vi);

vi.fn = (implementation) => {
  const mock = originalFn();
  const originalImplementation = mock.mockImplementation.bind(mock);
  const originalImplementationOnce = mock.mockImplementationOnce.bind(mock);

  mock.mockImplementation = (nextImplementation) =>
    originalImplementation(makeLegacyConstructible(nextImplementation));
  mock.mockImplementationOnce = (nextImplementation) =>
    originalImplementationOnce(makeLegacyConstructible(nextImplementation));

  if (implementation !== undefined) {
    mock.mockImplementation(implementation);
  }

  return mock;
};
