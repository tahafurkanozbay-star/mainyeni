import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface ModuleImportSignal {
  readonly source: string;
  readonly line: number;
  readonly specifier: string;
  readonly kind: 'static' | 'export' | 'dynamic' | 'side-effect';
  readonly literal: boolean;
  readonly relative: boolean;
  readonly resolved: string | null;
  readonly depth: number;
  readonly excerpt: string;
}

export interface ModuleCycle {
  readonly nodes: readonly string[];
  readonly edgeCount: number;
}

export interface ModuleGraphModernizationSummary {
  readonly files: number;
  readonly typedFiles: number;
  readonly legacyFiles: number;
  readonly imports: readonly ModuleImportSignal[];
  readonly resolvedRelativeImports: number;
  readonly unresolvedRelativeImports: number;
  readonly dynamicImports: number;
  readonly nonLiteralDynamicImports: number;
  readonly legacyTargets: readonly string[];
  readonly caseCollisions: readonly (readonly string[])[];
  readonly cycles: readonly ModuleCycle[];
  readonly findings: readonly Finding[];
}

interface RawImport {
  readonly index: number;
  readonly specifier: string;
  readonly kind: ModuleImportSignal['kind'];
  readonly literal: boolean;
}

const PRODUCT_PATH = /^(?:Webclient\.app|Webclient\.admin)\/src\//i;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?|stories)(?:\/|$)|\.(?:test|spec|fixture|mock|stories)\.[cm]?[jt]sx?$/i;
const GENERATED_PATH = /(?:^|\/)(?:generated|dist|build|coverage|vendor)(?:\/|$)/i;
const SCRIPT_EXTENSION = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const TYPED_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;
const LEGACY_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const IMPORT_FROM = /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*(['"])([^'"]+)\1/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s*(['"])([^'"]+)\1/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*(['"])([^'"]+)\1/g;
const DYNAMIC_LITERAL = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const DYNAMIC_ANY = /\bimport\s*\(\s*([^\n\r)]{1,240})\s*\)/g;
const NODE_BUILTIN = /^node:/i;
const URL_IMPORT = /^(?:https?:)?\/\//i;
const NON_SCRIPT_ASSET = /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|json)(?:[?#].*)?$/i;
const SOURCE_CANDIDATES = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.js', '/index.jsx', '/index.mjs',
] as const;
const MAX_CYCLES = 32;
const MAX_CYCLE_DEPTH = 24;

function productFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file =>
    PRODUCT_PATH.test(file.repositoryPath)
    && SCRIPT_EXTENSION.test(file.repositoryPath)
    && !TEST_PATH.test(file.repositoryPath)
    && !GENERATED_PATH.test(file.repositoryPath),
  );
}

function rawImports(file: SourceFile): RawImport[] {
  const result: RawImport[] = [];
  const claimed = new Set<number>();

  const collect = (pattern: RegExp, kind: ModuleImportSignal['kind']): void => {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(file.text)) !== null) {
      const specifier = match[2] ?? '';
      if (!specifier || claimed.has(match.index)) continue;
      claimed.add(match.index);
      result.push({ index: match.index, specifier, kind, literal: true });
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  };

  collect(IMPORT_FROM, 'static');
  collect(EXPORT_FROM, 'export');
  collect(SIDE_EFFECT_IMPORT, 'side-effect');
  collect(DYNAMIC_LITERAL, 'dynamic');

  const dynamicMatcher = new RegExp(DYNAMIC_ANY.source, DYNAMIC_ANY.flags);
  let dynamic: RegExpExecArray | null;
  while ((dynamic = dynamicMatcher.exec(file.text)) !== null) {
    if (claimed.has(dynamic.index)) continue;
    const expression = (dynamic[1] ?? '').trim();
    result.push({
      index: dynamic.index,
      specifier: expression,
      kind: 'dynamic',
      literal: false,
    });
    if (dynamic[0].length === 0) dynamicMatcher.lastIndex += 1;
  }

  return result.sort((left, right) => left.index - right.index || left.specifier.localeCompare(right.specifier, 'en'));
}

function relativeDepth(specifier: string): number {
  if (!specifier.startsWith('.')) return 0;
  return specifier.split('/').filter(part => part === '..').length;
}

function withoutQuery(specifier: string): string {
  return specifier.split(/[?#]/, 1)[0] ?? specifier;
}

function normalizeRepositoryRelative(source: string, specifier: string): string {
  const stack = source.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function resolveRelative(
  source: string,
  specifier: string,
  byPath: ReadonlyMap<string, SourceFile>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const clean = withoutQuery(specifier);
  const base = normalizeRepositoryRelative(source, clean);
  if (byPath.has(base)) return base;
  if (SCRIPT_EXTENSION.test(base)) return byPath.has(base) ? base : null;
  for (const suffix of SOURCE_CANDIDATES) {
    const candidate = suffix.startsWith('/') ? `${base}${suffix}` : `${base}${suffix}`;
    if (byPath.has(candidate)) return candidate;
  }
  return null;
}

function signalsFor(file: SourceFile, byPath: ReadonlyMap<string, SourceFile>): ModuleImportSignal[] {
  const lineIndex = createLineIndex(file.text);
  return rawImports(file).map(item => {
    const relative = item.literal && item.specifier.startsWith('.');
    return {
      source: file.repositoryPath,
      line: lineIndex.lineAt(item.index),
      specifier: item.specifier,
      kind: item.kind,
      literal: item.literal,
      relative,
      resolved: relative ? resolveRelative(file.repositoryPath, item.specifier, byPath) : null,
      depth: relative ? relativeDepth(item.specifier) : 0,
      excerpt: snippetAround(file.text, item.index, 110),
    };
  });
}

function caseCollisions(files: readonly SourceFile[]): readonly (readonly string[])[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = file.repositoryPath.toLocaleLowerCase('en');
    const list = groups.get(key) ?? [];
    list.push(file.repositoryPath);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => [...group].sort((a, b) => a.localeCompare(b, 'en')))
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? '', 'en'));
}

function adjacency(
  files: readonly SourceFile[],
  signals: readonly ModuleImportSignal[],
): Map<string, string[]> {
  const product = new Set(files.map(file => file.repositoryPath));
  const graph = new Map<string, string[]>();
  for (const file of files) graph.set(file.repositoryPath, []);
  for (const signal of signals) {
    if (!signal.resolved || !product.has(signal.resolved)) continue;
    const edges = graph.get(signal.source);
    if (!edges || edges.includes(signal.resolved)) continue;
    edges.push(signal.resolved);
    edges.sort((a, b) => a.localeCompare(b, 'en'));
  }
  return graph;
}

function canonicalCycle(nodes: readonly string[]): string {
  if (nodes.length === 0) return '';
  const ring = nodes.slice(0, -1);
  if (ring.length === 0) return '';
  const rotations = ring.map((_, index) => [...ring.slice(index), ...ring.slice(0, index)]);
  rotations.sort((a, b) => a.join('\0').localeCompare(b.join('\0'), 'en'));
  return rotations[0]?.join(' -> ') ?? '';
}

function detectCycles(graph: ReadonlyMap<string, readonly string[]>): ModuleCycle[] {
  const found = new Map<string, ModuleCycle>();
  const nodes = [...graph.keys()].sort((a, b) => a.localeCompare(b, 'en'));

  const visit = (start: string, current: string, pathStack: string[], active: Set<string>): void => {
    if (found.size >= MAX_CYCLES || pathStack.length > MAX_CYCLE_DEPTH) return;
    const neighbors = graph.get(current) ?? [];
    for (const next of neighbors) {
      if (next === start && pathStack.length > 1) {
        const closed = [...pathStack, start];
        const key = canonicalCycle(closed);
        if (key && !found.has(key)) {
          found.set(key, { nodes: Object.freeze(closed), edgeCount: pathStack.length });
        }
        continue;
      }
      if (active.has(next)) continue;
      active.add(next);
      visit(start, next, [...pathStack, next], active);
      active.delete(next);
      if (found.size >= MAX_CYCLES) return;
    }
  };

  for (const start of nodes) {
    visit(start, start, [start], new Set([start]));
    if (found.size >= MAX_CYCLES) break;
  }
  return [...found.values()].sort((a, b) => (a.nodes[0] ?? '').localeCompare(b.nodes[0] ?? '', 'en'));
}

function finding(
  signal: ModuleImportSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'architecture',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.source, line: signal.line },
    evidence: { excerpt: signal.excerpt, metadata: { specifier: signal.specifier } },
    remediation,
    tags: ['module-graph', 'typescript', 'modernization'],
  };
}

function importFindings(signal: ModuleImportSignal, byPath: ReadonlyMap<string, SourceFile>): Finding[] {
  const findings: Finding[] = [];
  const sourceTyped = TYPED_EXTENSION.test(signal.source);

  if (signal.kind === 'dynamic' && !signal.literal) {
    findings.push(finding(
      signal,
      'module-graph-dynamic-import-nonliteral',
      'high',
      'Production dynamic import is not statically bounded',
      'A non-literal import() expression weakens bundler chunk provenance and can turn runtime data into module-selection authority.',
      'Use a closed literal import map or an explicit switch over reviewed module identities.',
      true,
    ));
  }

  if (signal.literal && NODE_BUILTIN.test(signal.specifier)) {
    findings.push(finding(
      signal,
      'module-graph-browser-node-builtin',
      'critical',
      'Browser product source imports a Node.js builtin',
      'Node builtin modules are not part of the browser runtime contract and can trigger polyfill drift or production-only build failure.',
      'Move Node-only logic to tooling/server code or replace it with an explicit browser-native contract.',
      true,
    ));
  }

  if (signal.literal && URL_IMPORT.test(signal.specifier)) {
    findings.push(finding(
      signal,
      'module-graph-remote-module-import',
      'critical',
      'Runtime source imports code from a remote URL',
      'Remote module identity bypasses the repository lockfile, review and build provenance boundary.',
      'Install reviewed dependencies through the lockfile or vendor an approved local module with license/provenance documentation.',
      true,
    ));
  }

  if (signal.relative && signal.resolved === null && !NON_SCRIPT_ASSET.test(signal.specifier)) {
    findings.push(finding(
      signal,
      'module-graph-relative-import-unresolved',
      'medium',
      'Relative product import cannot be resolved from repository inventory',
      'An unresolved relative import can indicate case drift, stale migration paths or build-only aliases that are invisible to static review.',
      'Use an existing canonical module path with matching case and keep migration aliases explicit in typed configuration.',
    ));
  }

  if (signal.resolved && TEST_PATH.test(signal.resolved)) {
    findings.push(finding(
      signal,
      'module-graph-production-imports-test',
      'high',
      'Production source imports a test/fixture module',
      'Test and fixture modules are not production authorities and may contain mocks, synthetic data or dev-only dependencies.',
      'Move the shared contract into a production module and keep test-only helpers behind the test boundary.',
      true,
    ));
  }

  if (signal.resolved && sourceTyped && LEGACY_EXTENSION.test(signal.resolved)) {
    findings.push(finding(
      signal,
      'module-graph-typed-source-imports-legacy-js',
      'medium',
      'Typed production source depends on legacy JavaScript',
      'A strict TypeScript module crosses back into an untyped implementation, limiting compiler coverage at the runtime boundary.',
      'Migrate the target module to TypeScript or add a narrow typed adapter while preserving behavior and tests.',
    ));
  }

  if (signal.depth >= 4) {
    findings.push(finding(
      signal,
      'module-graph-deep-relative-import',
      'low',
      'Production import traverses multiple parent boundaries',
      `Relative import depth ${signal.depth} couples the module to directory layout and often signals a missing domain-level public API.`,
      'Prefer a stable domain barrel/public module or configured typed alias when it reduces cross-domain coupling without hiding ownership.',
    ));
  }

  if (signal.resolved) {
    const target = byPath.get(signal.resolved);
    if (target && target.repositoryPath.startsWith('Webclient.admin/') !== signal.source.startsWith('Webclient.admin/')) {
      findings.push(finding(
        signal,
        'module-graph-cross-app-import',
        'high',
        'Product source crosses application ownership boundary',
        'Webclient.app and Webclient.admin must not import each other by relative source path because their build, auth and deployment lifecycles differ.',
        'Extract a reviewed shared package/contract or duplicate only immutable schema data with explicit ownership.',
        true,
      ));
    }
  }
  return findings;
}

function collisionFindings(collisions: readonly (readonly string[])[]): Finding[] {
  return collisions.map(group => ({
    id: 'module-graph-case-collision',
    domain: 'build',
    severity: 'critical',
    blocking: true,
    title: 'Source paths collide under case-insensitive filesystems',
    message: 'Two production modules differ only by path casing, which can resolve differently across Linux, Windows and macOS agents.',
    location: { file: group[0] ?? 'repository', line: 1 },
    evidence: { value: group.join('\n') },
    remediation: 'Keep one canonical path casing and update all imports before deleting the duplicate.',
    tags: ['module-graph', 'portability', 'filesystem'],
  }));
}

function cycleFindings(cycles: readonly ModuleCycle[]): Finding[] {
  return cycles.slice(0, MAX_CYCLES).map(cycle => ({
    id: 'module-graph-cycle',
    domain: 'architecture',
    severity: cycle.edgeCount >= 6 ? 'medium' : 'low',
    title: 'Production module cycle detected',
    message: `A static import cycle with ${cycle.edgeCount} edges can create partial initialization, hidden side-effect ordering and difficult migration boundaries.`,
    location: { file: cycle.nodes[0] ?? 'repository', line: 1 },
    evidence: { value: cycle.nodes.join(' -> ') },
    remediation: 'Break the cycle by extracting pure contracts/state, reversing ownership, or introducing a narrow dependency-inversion boundary.',
    tags: ['module-graph', 'cycle', 'maintainability'],
  }));
}

export function auditModuleGraphModernization(
  inventory: RepositoryInventory,
): AuditSection<ModuleGraphModernizationSummary> {
  const started = performance.now();
  const files = productFiles(inventory);
  const byPath = new Map(files.map(file => [file.repositoryPath, file]));
  const imports = files.flatMap(file => signalsFor(file, byPath));
  const collisions = caseCollisions(files);
  const cycles = detectCycles(adjacency(files, imports));
  const findings = stableSortFindings([
    ...imports.flatMap(signal => importFindings(signal, byPath)),
    ...collisionFindings(collisions),
    ...cycleFindings(cycles),
  ]);
  const legacyTargets = [...new Set(
    imports
      .map(item => item.resolved)
      .filter((item): item is string => item !== null && LEGACY_EXTENSION.test(item)),
  )].sort((a, b) => a.localeCompare(b, 'en'));

  return {
    domain: 'architecture',
    title: 'Typed product module-graph modernization audit',
    summary: {
      files: files.length,
      typedFiles: files.filter(file => TYPED_EXTENSION.test(file.repositoryPath)).length,
      legacyFiles: files.filter(file => LEGACY_EXTENSION.test(file.repositoryPath)).length,
      imports,
      resolvedRelativeImports: imports.filter(item => item.relative && item.resolved !== null).length,
      unresolvedRelativeImports: imports.filter(item => item.relative && item.resolved === null).length,
      dynamicImports: imports.filter(item => item.kind === 'dynamic').length,
      nonLiteralDynamicImports: imports.filter(item => item.kind === 'dynamic' && !item.literal).length,
      legacyTargets,
      caseCollisions: collisions,
      cycles,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
