import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Keep the existing Jest-flavoured test suite operational during the Vitest
// migration. Calls written as `jest.*` are rewritten to `vi.*` by the Vitest
// compatibility plugin before Vitest performs mock hoisting. This global is
// retained only for the rare standalone `jest` reference.
Object.defineProperty(globalThis, 'jest', {
  configurable: true,
  value: vi,
  writable: false,
});

// React 19 uses this flag to distinguish a configured test environment from
// accidental `act()` usage outside a test runner.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
