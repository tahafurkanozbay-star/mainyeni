import { transformWithOxc, type Plugin } from 'vite';

const SOURCE_FILE = /\/src\/.*\.[cm]?[jt]sx?$/u;
const LEGACY_JAVASCRIPT_FILE = /\/src\/.*\.js$/u;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;

export const cleanModuleId = (id: string): string => {
  const queryIndex = id.indexOf('?');
  const hashIndex = id.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  return indexes.length === 0 ? id : id.slice(0, Math.min(...indexes));
};

export const isLegacyJavascriptSource = (id: string): boolean =>
  LEGACY_JAVASCRIPT_FILE.test(cleanModuleId(id));

export const legacyJavascriptJsxPlugin = (): Plugin => ({
  name: 'kent-rehberi-admin-legacy-jsx',
  enforce: 'pre',
  async transform(code, id) {
    const sourceId = cleanModuleId(id);
    if (!isLegacyJavascriptSource(sourceId)) return null;

    const result = await transformWithOxc(code, sourceId, {
      lang: 'jsx',
      jsx: { runtime: 'automatic' },
    });
    return result.map ? { code: result.code, map: result.map } : { code: result.code };
  },
});

export const findLegacyBrowserEnvironmentReferences = (code: string): readonly string[] =>
  Object.freeze([...new Set(code.match(/process\.env\.[A-Z0-9_]+/gu) ?? [])]);

export const legacyEnvironmentGuardPlugin = (): Plugin => ({
  name: 'kent-rehberi-admin-environment-guard',
  enforce: 'pre',
  transform(code, id) {
    const sourceId = cleanModuleId(id);
    if (!SOURCE_FILE.test(sourceId) || !code.includes('process.env')) return null;
    const references = findLegacyBrowserEnvironmentReferences(code);
    if (references.length === 0) return null;
    throw new Error(
      `Legacy browser environment access is forbidden in ${sourceId}: ${references.join(', ')}. `
      + 'Use src/platform/config/runtimeConfig.ts and import.meta.env.',
    );
  },
});

export const legacyJestCompatibilityPlugin = (): Plugin => ({
  name: 'kent-rehberi-admin-jest-vitest-compatibility',
  enforce: 'pre',
  transform(code, id) {
    if (!TEST_FILE.test(cleanModuleId(id))) return null;
    const transformed = code
      .replace(/\bjest\./gu, 'vi.')
      .replace(/\bjest\.mocked\b/gu, 'vi.mocked');
    if (transformed === code && !code.includes('vi.')) return null;
    return { code: transformed, map: null };
  },
});
