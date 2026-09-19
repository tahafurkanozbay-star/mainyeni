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
    // vmThreads is the repository-proven configuration for this mixed legacy/jsdom
    // suite. Exact-head successful Webclient Quality runs complete the full
    // diagnostic in seconds with four bounded workers; process forks can leave
    // the coordinator waiting indefinitely on child-process teardown.
    pool: 'vmThreads',
    maxWorkers: 4,
    fileParallelism: true,
    isolate: true,
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: { concurrent: false },
  },
});
