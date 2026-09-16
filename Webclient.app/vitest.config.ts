import { defineConfig } from 'vitest/config';
import { transformWithOxc, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const legacyJsxPlugin = (): Plugin => ({
  name: 'kent-rehberi-test-legacy-jsx',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.includes('/src/') || !id.endsWith('.js')) return null;
    const result = await transformWithOxc(code, id, {
      lang: 'jsx',
      jsx: {
        runtime: 'automatic',
      },
    });
    return result.map
      ? { code: result.code, map: result.map }
      : { code: result.code };
  },
});

const legacyJestCompatibilityPlugin = (): Plugin => ({
  name: 'kent-rehberi-jest-to-vitest-compatibility',
  enforce: 'pre',
  transform(code, id) {
    if (!/\.test\.[cm]?[jt]sx?$/.test(id)) return null;
    if (!code.includes('jest.')) return null;
    return {
      code: code.replace(/\bjest\./g, 'vi.'),
      map: null,
    };
  },
});

export default defineConfig({
  plugins: [
    legacyJestCompatibilityPlugin(),
    legacyJsxPlugin(),
    react({ include: /\.[jt]sx?$/ }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.js'],
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    pool: 'vmThreads',
    maxWorkers: 4,
    fileParallelism: true,
    isolate: true,
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: {
      concurrent: false,
    },
  },
});
