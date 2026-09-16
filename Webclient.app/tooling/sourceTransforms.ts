import { transformWithOxc, type Plugin } from 'vite';

const SOURCE_FILE = /\/src\/.*\.[cm]?[jt]sx?$/;
const LEGACY_JAVASCRIPT_FILE = /\/src\/.*\.js$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const LEGACY_PUBLIC_URL_REFERENCE = 'process.env.PUBLIC_URL';

/** Vite/Rolldown plugin ids may include ?query or #fragment suffixes. */
export const cleanModuleId = (id: string): string => {
  const queryIndex = id.indexOf('?');
  const hashIndex = id.indexOf('#');
  const candidates = [queryIndex, hashIndex].filter((index) => index >= 0);
  return candidates.length === 0 ? id : id.slice(0, Math.min(...candidates));
};

export const isLegacyJavascriptSource = (id: string): boolean =>
  LEGACY_JAVASCRIPT_FILE.test(cleanModuleId(id));

export const legacyJsxPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-jsx',
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

export const findLegacyBrowserEnvironmentReferences = (code: string): readonly string[] => {
  const references = code.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
  return Object.freeze([
    ...new Set(references.filter((reference) => reference !== LEGACY_PUBLIC_URL_REFERENCE)),
  ]);
};

export const legacyEnvironmentGuardPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-environment-guard',
  enforce: 'pre',
  transform(code, id) {
    if (!SOURCE_FILE.test(cleanModuleId(id)) || !code.includes('process.env')) return null;
    const disallowed = findLegacyBrowserEnvironmentReferences(code);
    if (disallowed.length > 0) {
      throw new Error(
        `Legacy browser environment access is forbidden in ${cleanModuleId(id)}: ${disallowed.join(', ')}. `
        + 'Use the typed runtimeConfig/import.meta.env boundary instead.',
      );
    }
    return null;
  },
});

/**
 * Temporary bounded bridge while historical Jest suites move to Vitest. It only
 * rewrites the `jest.` namespace in test modules; production modules and string
 * literals are not globally transformed.
 */
export const legacyJestCompatibilityPlugin = (): Plugin => ({
  name: 'kent-rehberi-jest-to-vitest-compatibility',
  enforce: 'pre',
  transform(code, id) {
    if (!TEST_FILE.test(cleanModuleId(id)) || !code.includes('jest.')) return null;
    return { code: code.replace(/\bjest\./g, 'vi.'), map: null };
  },
});
