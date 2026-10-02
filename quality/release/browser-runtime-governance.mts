import { builtinModules } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export type RuntimeFindingCode =
  | 'browser-node-builtin'
  | 'browser-remote-executable-import'
  | 'browser-dynamic-code'
  | 'browser-commonjs'
  | 'browser-process-env'
  | 'browser-dev-dependency'
  | 'browser-undeclared-dependency';

export interface RuntimeFinding {
  readonly code: RuntimeFindingCode;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface RuntimeManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

export interface RuntimeAuditReport {
  readonly filesScanned: number;
  readonly importsScanned: number;
  readonly findings: readonly RuntimeFinding[];
  readonly passed: boolean;
}

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/iu;
const REMOTE_SCHEME = /^(?:https?:|data:|blob:|file:)/iu;
const DYNAMIC_CODE = /\b(?:eval\s*\(|new\s+Function\s*\()/gu;
const COMMONJS = /\b(?:require\s*\(|module\.exports\b|exports\.[A-Za-z_$])/gu;
const PROCESS_ENV = /\bprocess\.env\.([A-Z0-9_]+)\b/gu;
const ALLOWED_BROWSER_ENV = new Set(['PUBLIC_URL']);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith('node:') ? name : `node:${name}`),
]);
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'";()]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
] as const;

interface ImportReference {
  readonly specifier: string;
  readonly offset: number;
  readonly line: number;
}

const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
};

const normalize = (value: string): string => value.split(path.sep).join('/');

const packageName = (specifier: string): string | null => {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (REMOTE_SCHEME.test(specifier)) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? null;
};

export const extractRuntimeImports = (source: string): readonly ImportReference[] => {
  const references: ImportReference[] = [];
  const seen = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    const expression = new RegExp(pattern.source, pattern.flags);
    for (const match of source.matchAll(expression)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const offset = match.index ?? 0;
      const key = `${offset}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(Object.freeze({ specifier, offset, line: lineAt(source, offset) }));
    }
  }
  return Object.freeze(references.sort((left, right) => left.offset - right.offset || left.specifier.localeCompare(right.specifier)));
};

const finding = (code: RuntimeFindingCode, file: string, line: number, detail: string): RuntimeFinding =>
  Object.freeze({ code, file, line, detail });

export const auditRuntimeSource = (
  file: string,
  source: string,
  manifest: RuntimeManifest,
): readonly RuntimeFinding[] => {
  const findings: RuntimeFinding[] = [];

  for (const match of source.matchAll(PROCESS_ENV)) {
    const variable = match[1];
    if (variable !== undefined && !ALLOWED_BROWSER_ENV.has(variable)) {
      findings.push(finding('browser-process-env', file, lineAt(source, match.index ?? 0), variable));
    }
  }

  for (const match of source.matchAll(DYNAMIC_CODE)) {
    findings.push(finding('browser-dynamic-code', file, lineAt(source, match.index ?? 0), match[0]));
  }

  for (const match of source.matchAll(COMMONJS)) {
    findings.push(finding('browser-commonjs', file, lineAt(source, match.index ?? 0), match[0]));
  }

  for (const reference of extractRuntimeImports(source)) {
    if (REMOTE_SCHEME.test(reference.specifier)) {
      findings.push(finding('browser-remote-executable-import', file, reference.line, reference.specifier));
      continue;
    }
    const name = packageName(reference.specifier);
    if (name === null) continue;
    if (NODE_BUILTINS.has(name) || NODE_BUILTINS.has(reference.specifier)) {
      findings.push(finding('browser-node-builtin', file, reference.line, reference.specifier));
      continue;
    }
    if (Object.hasOwn(manifest.dependencies, name)) continue;
    if (Object.hasOwn(manifest.devDependencies, name)) {
      findings.push(finding('browser-dev-dependency', file, reference.line, name));
      continue;
    }
    findings.push(finding('browser-undeclared-dependency', file, reference.line, name));
  }

  return Object.freeze(findings.sort((left, right) =>
    left.line - right.line || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)));
};

const walk = async (directory: string, output: string[] = []): Promise<string[]> => {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, output);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(absolute);
  }
  return output;
};

export const readRuntimeManifest = async (root: string): Promise<RuntimeManifest> => {
  const manifestPath = path.join(root, 'Webclient.app', 'package.json');
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.freeze({
    dependencies: Object.freeze({ ...(parsed.dependencies ?? {}) }),
    devDependencies: Object.freeze({ ...(parsed.devDependencies ?? {}) }),
  });
};

export const auditBrowserRuntimeGovernance = async (root: string): Promise<RuntimeAuditReport> => {
  const manifest = await readRuntimeManifest(root);
  const sourceRoot = path.join(root, 'Webclient.app', 'src');
  const files = (await walk(sourceRoot)).sort();
  const findings: RuntimeFinding[] = [];
  let filesScanned = 0;
  let importsScanned = 0;

  for (const absolute of files) {
    const relative = normalize(path.relative(root, absolute));
    if (TEST_PATH.test(relative)) continue;
    const source = await readFile(absolute, 'utf8');
    filesScanned += 1;
    importsScanned += extractRuntimeImports(source).length;
    findings.push(...auditRuntimeSource(relative, source, manifest));
  }

  const ordered = Object.freeze(findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.code.localeCompare(right.code)));
  return Object.freeze({ filesScanned, importsScanned, findings: ordered, passed: ordered.length === 0 });
};
