import {
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type Severity,
  type SourceFile,
} from './contracts.mts';

type RuleKinds = 'javascript' | 'typescript' | 'both';

interface LanguageRule {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly pattern: RegExp;
  readonly kinds: RuleKinds;
  readonly tag: string;
}

export interface DuplicateModuleStem {
  readonly stem: string;
  readonly files: readonly string[];
}

export interface CompilerContract {
  readonly path: string;
  readonly strict: boolean | null;
  readonly noUncheckedIndexedAccess: boolean | null;
  readonly exactOptionalPropertyTypes: boolean | null;
  readonly useUnknownInCatchVariables: boolean | null;
  readonly verbatimModuleSyntax: boolean | null;
  readonly allowJs: boolean | null;
  readonly checkJs: boolean | null;
}

export interface LanguageModernizationSummary {
  readonly scannedFiles: number;
  readonly frontendScriptFiles: number;
  readonly javascriptFiles: number;
  readonly typescriptFiles: number;
  readonly typedRatio: number;
  readonly jsxInJavaScriptFiles: readonly string[];
  readonly commonJsFiles: readonly string[];
  readonly suppressionFiles: readonly string[];
  readonly duplicateModuleStems: readonly DuplicateModuleStem[];
  readonly compilerContracts: readonly CompilerContract[];
  readonly findingsByRule: Readonly<Record<string, number>>;
}

const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts)(?:\/|$)/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|\.|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const FRONTEND_SOURCE = /^Webclient\.app\/src\//;
const MODERN_TYPED_BOUNDARY = /^Webclient\.app\/src\/(?:platform|gis-engine|Business|Core|Store|Toolbox)\//;
const SCRIPT_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const LEGACY_EXT = /\.(?:js|jsx|mjs|cjs)$/i;
const TYPED_EXT = /\.(?:ts|tsx|mts|cts)$/i;
const JSX_PATTERN = /<(?:[A-Z][A-Za-z0-9_.]*|div|span|button|input|section|main|aside|header|footer|form|label|svg|path|article|nav)\b/;

const RULES: readonly LanguageRule[] = [
  {
    id: 'language-jsx-in-js',
    severity: 'low',
    title: 'JavaScript file contains JSX syntax',
    message: 'JSX inside .js files is fragile under modern native parsing and obscures the TS/TSX migration boundary.',
    pattern: new RegExp('<(?:[A-Z][A-Za-z0-9_.]*|div|span|button|input|section|main|aside|header|footer|form|label|svg|path|article|nav)\\b', 'g'),
    kinds: 'javascript',
    tag: 'tsx-migration',
  },
  {
    id: 'language-commonjs-require',
    severity: 'low',
    title: 'CommonJS require remains in application source',
    message: 'Browser application source should converge on native ESM so Vite and TypeScript can analyze module boundaries deterministically.',
    pattern: new RegExp('\\brequire\\s*\\(', 'g'),
    kinds: 'javascript',
    tag: 'esm',
  },
  {
    id: 'language-commonjs-module-exports',
    severity: 'low',
    title: 'CommonJS module.exports remains in application source',
    message: 'CommonJS exports prevent a clean native-ESM-only frontend boundary.',
    pattern: new RegExp('\\bmodule\\.exports\\b', 'g'),
    kinds: 'javascript',
    tag: 'esm',
  },
  {
    id: 'language-commonjs-exports',
    severity: 'low',
    title: 'CommonJS exports assignment remains in application source',
    message: 'CommonJS exports should be migrated to named/default ESM exports.',
    pattern: new RegExp('\\bexports\\.[A-Za-z_$][\\w$]*\\s*=', 'g'),
    kinds: 'javascript',
    tag: 'esm',
  },
  {
    id: 'language-ts-nocheck',
    severity: 'high',
    title: 'TypeScript checking disabled for a source file',
    message: '@ts-nocheck defeats the strict TypeScript migration and can hide runtime-contract regressions.',
    pattern: new RegExp('@ts-nocheck\\b', 'g'),
    kinds: 'typescript',
    tag: 'strict-types',
  },
  {
    id: 'language-ts-ignore',
    severity: 'medium',
    title: 'TypeScript diagnostic is suppressed with @ts-ignore',
    message: 'Use a typed fix or a narrowly documented @ts-expect-error so compiler drift remains visible.',
    pattern: new RegExp('@ts-ignore\\b', 'g'),
    kinds: 'typescript',
    tag: 'strict-types',
  },
  {
    id: 'language-explicit-any',
    severity: 'low',
    title: 'Explicit any escape remains in typed source',
    message: 'Explicit any weakens contract checking; prefer unknown plus narrowing or a concrete domain type.',
    pattern: new RegExp('(?:\\bas\\s+any\\b|:\\s*any\\b|<any>)', 'g'),
    kinds: 'typescript',
    tag: 'strict-types',
  },
  {
    id: 'language-process-env-client',
    severity: 'medium',
    title: 'Legacy process.env access remains in Vite client source',
    message: 'Vite client code should use the approved import.meta.env/configuration boundary rather than webpack-era process.env.',
    pattern: new RegExp('\\bprocess\\.env\\.[A-Z0-9_]+', 'g'),
    kinds: 'both',
    tag: 'vite',
  },
  {
    id: 'language-public-url',
    severity: 'medium',
    title: 'Legacy PUBLIC_URL assumption remains',
    message: 'PUBLIC_URL is a CRA-era build assumption and should not leak into the Vite runtime contract.',
    pattern: new RegExp('\\bPUBLIC_URL\\b', 'g'),
    kinds: 'both',
    tag: 'vite',
  },
  {
    id: 'language-webpack-context',
    severity: 'medium',
    title: 'Webpack require.context remains',
    message: 'require.context couples code to webpack module discovery and is incompatible with a native Vite/Rolldown module graph.',
    pattern: new RegExp('\\brequire\\.context\\s*\\(', 'g'),
    kinds: 'javascript',
    tag: 'vite',
  },
  {
    id: 'language-webpack-runtime',
    severity: 'medium',
    title: 'Webpack runtime global remains',
    message: 'Webpack-specific globals should be removed from the Vite-first application path.',
    pattern: new RegExp('\\b(?:__webpack_require__|__webpack_public_path__|webpackChunk)\\b', 'g'),
    kinds: 'both',
    tag: 'vite',
  },
  {
    id: 'language-module-hot',
    severity: 'low',
    title: 'Legacy module.hot HMR contract remains',
    message: 'Use import.meta.hot under Vite when explicit HMR hooks are required.',
    pattern: new RegExp('\\bmodule\\.hot\\b', 'g'),
    kinds: 'both',
    tag: 'vite',
  },
  {
    id: 'language-reactdom-render',
    severity: 'medium',
    title: 'Legacy ReactDOM.render root API remains',
    message: 'React 19 application entrypoints should use createRoot/hydrateRoot rather than ReactDOM.render.',
    pattern: new RegExp('\\bReactDOM\\.render\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-reactdom-hydrate',
    severity: 'medium',
    title: 'Legacy ReactDOM.hydrate API remains',
    message: 'React 19 hydration should use hydrateRoot.',
    pattern: new RegExp('\\bReactDOM\\.hydrate\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-find-dom-node',
    severity: 'medium',
    title: 'findDOMNode remains in React source',
    message: 'findDOMNode is incompatible with modern strict/concurrent React patterns; use refs.',
    pattern: new RegExp('\\bfindDOMNode\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-string-ref',
    severity: 'low',
    title: 'Legacy string ref syntax remains',
    message: 'String refs should be replaced by createRef/useRef or callback refs.',
    pattern: new RegExp('\\bref\\s*=\\s*["\'][A-Za-z_$][\\w$.-]*["\']', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-unsafe-lifecycle',
    severity: 'medium',
    title: 'UNSAFE_ React lifecycle remains',
    message: 'Legacy lifecycles complicate concurrent rendering and should be replaced with modern effects/derived state.',
    pattern: new RegExp('\\bUNSAFE_(?:componentWillMount|componentWillReceiveProps|componentWillUpdate)\\b', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-component-will-mount',
    severity: 'low',
    title: 'componentWillMount remains',
    message: 'Migrate legacy lifecycle behavior to constructor/effects before strict concurrent behavior expands.',
    pattern: new RegExp('\\bcomponentWillMount\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-component-will-receive-props',
    severity: 'low',
    title: 'componentWillReceiveProps remains',
    message: 'Migrate prop synchronization to derived state or effects.',
    pattern: new RegExp('\\bcomponentWillReceiveProps\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-component-will-update',
    severity: 'low',
    title: 'componentWillUpdate remains',
    message: 'Migrate pre-update side effects to supported lifecycle/effect patterns.',
    pattern: new RegExp('\\bcomponentWillUpdate\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'react19',
  },
  {
    id: 'language-new-buffer',
    severity: 'medium',
    title: 'Deprecated Buffer constructor remains',
    message: 'Use Buffer.from/Buffer.alloc to avoid deprecated and unsafe constructor semantics.',
    pattern: new RegExp('\\bnew\\s+Buffer\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'node',
  },
  {
    id: 'language-substr',
    severity: 'low',
    title: 'Deprecated String.substr remains',
    message: 'Prefer slice/substring so future runtime cleanup does not depend on legacy Annex behavior.',
    pattern: new RegExp('\\.substr\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'ecmascript',
  },
  {
    id: 'language-document-exec-command',
    severity: 'low',
    title: 'Deprecated document.execCommand remains',
    message: 'Use the Clipboard API or explicit DOM editing primitives where supported.',
    pattern: new RegExp('\\bdocument\\.execCommand\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'browser',
  },
  {
    id: 'language-escape-api',
    severity: 'low',
    title: 'Deprecated escape/unescape API remains',
    message: 'Use URL/URI encoding primitives or TextEncoder/TextDecoder instead of legacy escape APIs.',
    pattern: new RegExp('\\b(?:escape|unescape)\\s*\\(', 'g'),
    kinds: 'both',
    tag: 'ecmascript',
  },
  {
    id: 'language-js-extension-import-from-ts',
    severity: 'low',
    title: 'Typed source imports an explicit .js application module',
    message: 'A typed module still depends on a legacy JavaScript implementation; migrate that boundary to TS/TSX when practical.',
    pattern: new RegExp('\\bfrom\\s+["\'][^"\']+\\.js["\']', 'g'),
    kinds: 'typescript',
    tag: 'tsx-migration',
  },
  {
    id: 'language-proptypes-in-ts',
    severity: 'info',
    title: 'PropTypes remains in TypeScript source',
    message: 'TypeScript already provides compile-time props contracts; retain PropTypes only when runtime validation is intentionally required.',
    pattern: new RegExp('\\bPropTypes\\.', 'g'),
    kinds: 'typescript',
    tag: 'react19',
  },
  {
    id: 'language-var-declaration',
    severity: 'info',
    title: 'var declaration remains in application source',
    message: 'Prefer const/let for block-scoped semantics and easier static reasoning.',
    pattern: new RegExp('\\bvar\\s+[A-Za-z_$]', 'g'),
    kinds: 'both',
    tag: 'ecmascript',
  },
  {
    id: 'language-ts-expect-error-undocumented',
    severity: 'low',
    title: '@ts-expect-error lacks an explanatory suffix',
    message: 'Document why the expected compiler error is safe so future maintainers can remove the escape when the dependency evolves.',
    pattern: new RegExp('@ts-expect-error\\s*(?:\\r?\\n|$)', 'g'),
    kinds: 'typescript',
    tag: 'strict-types',
  },
  {
    id: 'language-cjs-extension',
    severity: 'low',
    title: 'Explicit .cjs module remains in frontend source',
    message: 'Frontend source should converge on ESM; isolate unavoidable CommonJS to build tooling.',
    pattern: new RegExp('(?:from\\s+["\'][^"\']+\\.cjs["\']|require\\s*\\(\\s*["\'][^"\']+\\.cjs["\'])', 'g'),
    kinds: 'both',
    tag: 'esm',
  },
];

function isEligible(file: SourceFile): boolean {
  return FRONTEND_SOURCE.test(file.repositoryPath)
    && SCRIPT_EXT.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath)
    && !TEST_FILE.test(file.repositoryPath);
}

function supportsRule(file: SourceFile, kinds: RuleKinds): boolean {
  if (kinds === 'both') return file.kind === 'javascript' || file.kind === 'typescript';
  return file.kind === kinds;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
}

function remediationFor(id: string): string {
  if (id === 'language-jsx-in-js') return 'Rename JSX-bearing modules to .jsx or, preferably, migrate them to strict .tsx with explicit props/runtime contracts.';
  if (id.startsWith('language-commonjs') || id === 'language-cjs-extension') return 'Convert the application module to native ESM imports/exports and keep CommonJS isolated to tooling only when unavoidable.';
  if (id === 'language-ts-nocheck' || id === 'language-ts-ignore' || id === 'language-ts-expect-error-undocumented') return 'Fix the underlying type contract; if an expected error is unavoidable, document it narrowly with @ts-expect-error.';
  if (id.includes('webpack') || id === 'language-module-hot' || id === 'language-process-env-client' || id === 'language-public-url') return 'Use the repository Vite/native-ESM configuration and import.meta contracts instead of CRA/webpack globals.';
  if (id.includes('reactdom') || id.includes('lifecycle') || id === 'language-find-dom-node' || id === 'language-string-ref') return 'Migrate to React 19 supported root, ref, effect and lifecycle patterns and protect behavior with focused regression tests.';
  if (id === 'language-explicit-any') return 'Replace any with a concrete contract or unknown plus explicit narrowing at the boundary.';
  return 'Replace the legacy construct with the modern stable language/runtime equivalent while preserving behavior and tests.';
}

function ruleFindings(file: SourceFile, rule: LanguageRule): Finding[] {
  if (!supportsRule(file, rule.kinds)) return [];
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  const matches = [...file.text.matchAll(pattern)].slice(0, 3);
  return matches.map(match => {
    const strictBoundary = MODERN_TYPED_BOUNDARY.test(file.repositoryPath);
    const suppression = rule.id === 'language-ts-nocheck';
    const severity: Severity = suppression && strictBoundary ? 'critical' : rule.severity;
    const blocking = suppression && strictBoundary;
    return {
      id: rule.id,
      domain: rule.id.includes('vite') || rule.id.includes('webpack') || rule.id === 'language-module-hot' ? 'build' : 'architecture',
      severity,
      title: rule.title,
      message: rule.message,
      location: { file: file.repositoryPath, line: lineAt(file.text, match.index ?? 0) },
      evidence: { excerpt: compact(match[0]) },
      remediation: remediationFor(rule.id),
      tags: ['language-modernization', rule.tag],
      ...(blocking ? { blocking: true } : {}),
    };
  });
}

function moduleStem(path: string): string {
  return path.replace(/\.(?:jsx?|mjs|cjs|tsx?|mts|cts)$/i, '');
}

function duplicateStems(files: readonly SourceFile[]): DuplicateModuleStem[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const stem = moduleStem(file.repositoryPath);
    const list = groups.get(stem) ?? [];
    list.push(file.repositoryPath);
    groups.set(stem, list);
  }
  return [...groups.entries()]
    .filter(([, paths]) => paths.length > 1 && paths.some(path => LEGACY_EXT.test(path)) && paths.some(path => TYPED_EXT.test(path)))
    .map(([stem, paths]) => ({ stem, files: [...paths].sort((a, b) => a.localeCompare(b, 'en')) }))
    .sort((a, b) => a.stem.localeCompare(b.stem, 'en'));
}

function duplicateFindings(duplicates: readonly DuplicateModuleStem[]): Finding[] {
  return duplicates.map(duplicate => ({
    id: 'language-duplicate-js-ts-module',
    domain: 'architecture',
    severity: MODERN_TYPED_BOUNDARY.test(duplicate.stem) ? 'high' : 'low',
    title: 'Legacy and typed modules share the same stem',
    message: 'Parallel JS and TS implementations can create import ambiguity and silently preserve stale runtime behavior after a migration.',
    location: { file: duplicate.files[0] ?? duplicate.stem, line: 1 },
    evidence: { value: duplicate.files.join('\n') },
    remediation: 'Keep one canonical implementation. Migrate consumers, verify behavior, then remove the superseded legacy module.',
    tags: ['language-modernization', 'duplicate-module'],
  }));
}

function compilerBoolean(options: Record<string, unknown>, key: string): boolean | null {
  const value = options[key];
  return typeof value === 'boolean' ? value : null;
}

function compilerContracts(inventory: RepositoryInventory): CompilerContract[] {
  return inventory.files
    .filter(file => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(file.repositoryPath))
    .map(file => {
      const parsed = safeJsonParse<Record<string, unknown>>(file.text);
      const raw = parsed.ok && parsed.value?.compilerOptions;
      const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      return {
        path: file.repositoryPath,
        strict: compilerBoolean(options, 'strict'),
        noUncheckedIndexedAccess: compilerBoolean(options, 'noUncheckedIndexedAccess'),
        exactOptionalPropertyTypes: compilerBoolean(options, 'exactOptionalPropertyTypes'),
        useUnknownInCatchVariables: compilerBoolean(options, 'useUnknownInCatchVariables'),
        verbatimModuleSyntax: compilerBoolean(options, 'verbatimModuleSyntax'),
        allowJs: compilerBoolean(options, 'allowJs'),
        checkJs: compilerBoolean(options, 'checkJs'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function compilerFindings(contracts: readonly CompilerContract[]): Finding[] {
  const findings: Finding[] = [];
  for (const contract of contracts) {
    const primary = /Webclient\.app\/tsconfig|quality\/release\/tsconfig/i.test(contract.path);
    if (contract.strict === false) {
      findings.push({
        id: 'language-tsconfig-strict-disabled',
        domain: 'build',
        severity: primary ? 'critical' : 'high',
        title: 'Strict TypeScript is explicitly disabled',
        message: 'Disabling strict mode weakens the repository migration contract and can hide nullability and variance regressions.',
        location: { file: contract.path, line: 1 },
        remediation: 'Keep strict=true and fix the diagnostics rather than weakening compiler guarantees.',
        ...(primary ? { blocking: true } : {}),
        tags: ['language-modernization', 'typescript', 'compiler'],
      });
    }
    const hardened = [
      ['noUncheckedIndexedAccess', contract.noUncheckedIndexedAccess],
      ['exactOptionalPropertyTypes', contract.exactOptionalPropertyTypes],
      ['useUnknownInCatchVariables', contract.useUnknownInCatchVariables],
    ] as const;
    for (const [flag, enabled] of hardened) {
      if (primary && enabled === false) {
        findings.push({
          id: `language-tsconfig-${flag}-disabled`,
          domain: 'build',
          severity: 'medium',
          title: `TypeScript safety flag ${flag} is disabled`,
          message: `The primary typed boundary explicitly disables ${flag}, reducing compiler coverage compared with the repository hardening baseline.`,
          location: { file: contract.path, line: 1 },
          remediation: `Enable ${flag} and repair the resulting diagnostics at the actual contract boundaries.`,
          tags: ['language-modernization', 'typescript', 'compiler'],
        });
      }
    }
  }
  return findings;
}

function countByRule(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.id] = (counts[finding.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export function auditLanguageModernization(inventory: RepositoryInventory): AuditSection<LanguageModernizationSummary> {
  const started = performance.now();
  const scripts = inventory.files.filter(isEligible);
  const javascriptFiles = scripts.filter(file => file.kind === 'javascript');
  const typescriptFiles = scripts.filter(file => file.kind === 'typescript');
  const typedRatio = scripts.length === 0 ? 1 : typescriptFiles.length / scripts.length;
  const duplicates = duplicateStems(scripts);
  const compiler = compilerContracts(inventory);
  const findings = stableSortFindings([
    ...scripts.flatMap(file => RULES.flatMap(rule => ruleFindings(file, rule))),
    ...duplicateFindings(duplicates),
    ...compilerFindings(compiler),
  ]);
  return {
    domain: 'architecture',
    title: 'TypeScript, ESM, Vite and React language-modernization audit',
    summary: {
      scannedFiles: scripts.length,
      frontendScriptFiles: scripts.length,
      javascriptFiles: javascriptFiles.length,
      typescriptFiles: typescriptFiles.length,
      typedRatio,
      jsxInJavaScriptFiles: javascriptFiles.filter(file => JSX_PATTERN.test(file.text)).map(file => file.repositoryPath).sort((a, b) => a.localeCompare(b, 'en')),
      commonJsFiles: javascriptFiles.filter(file => /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(file.text)).map(file => file.repositoryPath).sort((a, b) => a.localeCompare(b, 'en')),
      suppressionFiles: scripts.filter(file => /@ts-(?:nocheck|ignore)\b/.test(file.text)).map(file => file.repositoryPath).sort((a, b) => a.localeCompare(b, 'en')),
      duplicateModuleStems: duplicates,
      compilerContracts: compiler,
      findingsByRule: countByRule(findings),
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
