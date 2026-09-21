import type { Plugin } from 'vite';

const SOURCE_FILE = /\/src\/.*\.[cm]?[jt]sx?$/;
const LEGACY_JEST_TEST_FILE = /\.test\.js$/;
const LEGACY_PUBLIC_URL_REFERENCE = 'process.env.PUBLIC_URL';
const LEGACY_REMOTE_MUKTA_IMPORT = /@import\s+url\(["']https:\/\/fonts\.googleapis\.com\/css\?family=Mukta["']\);?\s*/gi;

/** Vite/Rolldown plugin ids may include ?query or #fragment suffixes. */
export const cleanModuleId = (id: string): string => {
  const queryIndex = id.indexOf('?');
  const hashIndex = id.indexOf('#');
  const candidates = [queryIndex, hashIndex].filter((index) => index >= 0);
  return candidates.length === 0 ? id : id.slice(0, Math.min(...candidates));
};

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
 * Remove the historical remote Mukta stylesheet import from the compiled CSS.
 * The font is not referenced by the application font stack and retaining the
 * import causes an unnecessary third-party request. The transform is exact and
 * intentionally narrow so no arbitrary CSS is rewritten.
 */
export const stripLegacyRemotePresentationImports = (code: string): string =>
  code.replace(LEGACY_REMOTE_MUKTA_IMPORT, '');

export const legacyPresentationCleanupPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-presentation-cleanup',
  enforce: 'pre',
  transform(code, id) {
    const sourceId = cleanModuleId(id).replaceAll('\\', '/');
    if (!sourceId.endsWith('/src/styles.css')) return null;
    const cleaned = stripLegacyRemotePresentationImports(code);
    return cleaned === code ? null : { code: cleaned, map: null };
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
    if (!LEGACY_JEST_TEST_FILE.test(cleanModuleId(id))) return null;
    const transformed = code.replace(/\bjest\./g, 'vi.');
    // Vitest applies this plugin to its own transform tests too, so an already
    // normalized `vi.` input still needs to remain an explicit test transform.
    if (transformed === code && !code.includes('vi.')) return null;
    return { code: transformed, map: null };
  },
});
