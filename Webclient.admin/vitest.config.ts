import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import {
  legacyJestCompatibilityPlugin,
  legacyJavascriptJsxPlugin,
} from './tooling/sourceTransforms.ts';

export default defineConfig({
  plugins: [
    legacyJestCompatibilityPlugin(),
    legacyJavascriptJsxPlugin(),
    react({ include: /\.[jt]sx?$/u }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{js,jsx,ts,tsx}', 'tooling/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    pool: 'vmThreads',
    maxWorkers: 4,
    fileParallelism: true,
  },
});
