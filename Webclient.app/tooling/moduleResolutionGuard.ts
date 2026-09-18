import { existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const RELATIVE_IMPORT = /^\.{1,2}(?:\/|$)/u;
const SOURCE_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.jsx',
  '.mjs',
] as const);

export interface ModuleResolutionCandidate {
  readonly path: string;
  readonly extension: string;
  readonly indexModule: boolean;
  readonly typed: boolean;
}

export interface ModuleResolutionGuardOptions {
  readonly extensions?: readonly string[];
  readonly exists?: (path: string) => boolean;
  readonly include?: (importer: string) => boolean;
}

const normalizedId = (value: string): string => {
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  const indexes = [query, hash].filter((index) => index >= 0);
  return (indexes.length === 0 ? value : value.slice(0, Math.min(...indexes)))
    .replaceAll('\\', '/');
};

const isFile = (path: string): boolean => {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isTypedExtension = (extension: string): boolean =>
  extension === '.ts' || extension === '.tsx' || extension === '.mts';

export const isRelativeModuleSpecifier = (source: string): boolean =>
  RELATIVE_IMPORT.test(source);

export const hasExplicitModuleExtension = (source: string): boolean => {
  const clean = normalizedId(source);
  return extname(clean) !== '';
};

export const moduleCandidatePaths = (
  source: string,
  importer: string,
  extensions: readonly string[] = SOURCE_EXTENSIONS,
): readonly ModuleResolutionCandidate[] => {
  if (!isRelativeModuleSpecifier(source) || hasExplicitModuleExtension(source)) {
    return Object.freeze([]);
  }

  const cleanImporter = normalizedId(importer);
  const cleanSource = normalizedId(source);
  const base = resolve(dirname(cleanImporter), cleanSource);
  const candidates: ModuleResolutionCandidate[] = [];

  for (const extension of extensions) {
    candidates.push(Object.freeze({
      path: base + extension,
      extension,
      indexModule: false,
      typed: isTypedExtension(extension),
    }));
  }
  for (const extension of extensions) {
    candidates.push(Object.freeze({
      path: resolve(base, 'index' + extension),
      extension,
      indexModule: true,
      typed: isTypedExtension(extension),
    }));
  }
  return Object.freeze(candidates);
};

export const findExistingRelativeImportCandidates = (
  source: string,
  importer: string,
  options: Pick<ModuleResolutionGuardOptions, 'extensions' | 'exists'> = {},
): readonly ModuleResolutionCandidate[] => {
  const exists = options.exists ?? isFile;
  const candidates = moduleCandidatePaths(
    source,
    importer,
    options.extensions ?? SOURCE_EXTENSIONS,
  );
  return Object.freeze(candidates.filter((candidate) => exists(candidate.path)));
};

export const hasTypedJavascriptCollision = (
  candidates: readonly ModuleResolutionCandidate[],
): boolean => {
  const typed = candidates.some((candidate) => candidate.typed);
  const javascript = candidates.some((candidate) => !candidate.typed);
  return typed && javascript;
};

export const describeModuleResolutionAmbiguity = (
  source: string,
  importer: string,
  candidates: readonly ModuleResolutionCandidate[],
): string => {
  const relativeCandidates = candidates
    .map((candidate) => normalizedId(candidate.path))
    .sort()
    .join(', ');
  const typedCollision = hasTypedJavascriptCollision(candidates)
    ? ' A JavaScript/TypeScript shadow pair is present.'
    : '';
  return [
    'Ambiguous extensionless module resolution is forbidden.',
    'Importer: ' + normalizedId(importer) + '.',
    'Specifier: ' + source + '.',
    'Candidates: ' + relativeCandidates + '.',
    typedCollision,
    'Remove the duplicate source or use one canonical typed module.',
  ].filter(Boolean).join(' ');
};

const defaultInclude = (importer: string): boolean => {
  const clean = normalizedId(importer);
  return clean.includes('/Webclient.app/src/')
    || clean.includes('/Webclient.app/tooling/')
    || clean.endsWith('/Webclient.app/vite.config.ts')
    || clean.endsWith('/Webclient.app/vitest.config.ts');
};

export const moduleResolutionGuardPlugin = (
  options: ModuleResolutionGuardOptions = {},
): Plugin => ({
  name: 'kent-rehberi-module-resolution-guard',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !isRelativeModuleSpecifier(source) || hasExplicitModuleExtension(source)) {
      return null;
    }
    const include = options.include ?? defaultInclude;
    if (!include(importer)) return null;

    const candidates = findExistingRelativeImportCandidates(source, importer, options);
    if (candidates.length <= 1) return null;

    this.error(describeModuleResolutionAmbiguity(source, importer, candidates));
    return null;
  },
});

export const MODULE_RESOLUTION_GUARD_EXTENSIONS = SOURCE_EXTENSIONS;
