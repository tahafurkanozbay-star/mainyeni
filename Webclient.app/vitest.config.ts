import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import {
  legacyJestCompatibilityPlugin,
  legacyJsxPlugin,
} from './tooling/sourceTransforms.ts';

export default defineConfig({
  plugins: [legacyJestCompatibilityPlugin(), legacyJsxPlugin(), react({ include: /\.[jt]sx?$/ })],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.fixture.js'],
    include: [
      'src/**/*.test.{js,jsx,ts,tsx}',
      'tooling/**/*.test.{js,ts}',
    ],
    // The full suite is intentionally process-isolated. vmThreads shares a single
    // process memory ceiling across long-lived VM contexts; on Node 24 the GIS
    // lifecycle suite can terminate that worker after the legacy/jsdom suites
    // have accumulated state. Forks give every worker an independent heap and
    // make an unexpected test-process failure attributable to one file instead
    // of taking down Vitest's worker-thread coordinator.
    pool: 'forks',
    maxWorkers: 2,
    fileParallelism: true,
    isolate: true,
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: { concurrent: false },
  },
});
