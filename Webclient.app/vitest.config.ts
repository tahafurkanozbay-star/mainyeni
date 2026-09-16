import { transformAsync } from '@babel/core';
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

const constructibleLegacyMocksPlugin = (): Plugin => ({
  name: 'kent-rehberi-vitest-constructible-legacy-mocks',
  enforce: 'pre',
  async transform(code, id) {
    if (!/\.test\.js$/.test(id)) return null;
    if (!code.includes('vi.fn') && !code.includes('.mockImplementation')) return null;

    const result = await transformAsync(code, {
      filename: id,
      babelrc: false,
      configFile: false,
      sourceMaps: true,
      sourceType: 'module',
      parserOpts: { plugins: ['jsx'] },
      plugins: [({ types: t }) => ({
        name: 'constructible-vitest-mock-implementations',
        visitor: {
          CallExpression(path: any) {
            const callee = path.node.callee;
            let methodName: string | null = null;

            if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
              methodName = callee.property.name;
            }

            if (!['fn', 'mockImplementation', 'mockImplementationOnce'].includes(methodName || '')) {
              return;
            }

            const implementation = path.node.arguments[0];
            if (!t.isArrowFunctionExpression(implementation)) return;

            const body = t.isBlockStatement(implementation.body)
              ? implementation.body
              : t.blockStatement([t.returnStatement(implementation.body)]);
            const constructible = t.functionExpression(
              null,
              implementation.params,
              body,
              false,
              implementation.async,
            );
            path.node.arguments[0] = constructible;
          },
        },
      })],
    });

    if (!result?.code) return null;
    return result.map
      ? { code: result.code, map: result.map }
      : { code: result.code };
  },
});

export default defineConfig({
  plugins: [
    legacyJestCompatibilityPlugin(),
    constructibleLegacyMocksPlugin(),
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
