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
