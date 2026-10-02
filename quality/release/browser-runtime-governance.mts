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

export interface ImportReference {
  readonly specifier: string;
  readonly offset: number;
  readonly line: number;
}

const REMOTE_SCHEME = /^(?:https?:|data:|blob:|file:)/iu;
const DYNAMIC_CODE = /\b(?:eval\s*\(|new\s+Function\s*\()/gu;
const COMMONJS = /\b(?:require\s*\(|module\.exports\b|exports\.[A-Za-z_$])/gu;
const PROCESS_ENV = /\bprocess\.env\.([A-Z0-9_]+)\b/gu;
const ALLOWED_BROWSER_ENV = new Set(['PUBLIC_URL']);
const NODE_BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs',
  'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib', 'test',
]);
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'";()]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
] as const;

const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
};

const packageName = (specifier: string): string | null => {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (REMOTE_SCHEME.test(specifier)) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? null;
};

const nodeBuiltinName = (specifier: string): string | null => {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const root = bare.split('/')[0] ?? bare;
  return NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(root) ? bare : null;
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
    const builtin = nodeBuiltinName(reference.specifier);
    if (builtin !== null) {
      findings.push(finding('browser-node-builtin', file, reference.line, builtin));
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
