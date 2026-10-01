#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';

const DEFAULT_ROOT = path.resolve(process.cwd());
const WEB_ROOT = 'Webclient.app';
const SOURCE_ROOT = 'Webclient.app/src';
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/iu;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);
const BROWSER_ENV_ALLOWED = new Set(['process.env.PUBLIC_URL']);
const FORBIDDEN_SCHEMES = /^(?:https?:|data:|blob:|file:)/iu;
const COMMONJS_PATTERN = /\b(?:require\s*\(|module\.exports\b|exports\.[A-Za-z_$])/gu;
const DYNAMIC_CODE_PATTERN = /\b(?:eval\s*\(|new\s+Function\s*\()/gu;

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith('node:') ? name : 'node:' + name),
]);

const IMPORT_PATTERNS = Object.freeze([
  /\bimport\s+(?:type\s+)?(?:[^'";()]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
]);

const normalizePath = (value) => value.split(path.sep).join('/');
const relativePath = (root, value) => normalizePath(path.relative(root, value));
const isTestPath = (value) => TEST_PATH.test(normalizePath(value));
const isRelativeSpecifier = (value) => /^\.{1,2}(?:\/|$)/u.test(value);
const isAbsolutePathSpecifier = (value) => value.startsWith('/');

const walk = async (directory, files = []) => {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
};

const lineAt = (source, offset) => {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
};

const packageName = (specifier) => {
  if (!specifier || isRelativeSpecifier(specifier) || isAbsolutePathSpecifier(specifier)) return null;
  if (FORBIDDEN_SCHEMES.test(specifier)) return null;
  if (specifier.startsWith('#')) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? parts.slice(0, 2).join('/') : specifier;
  }
  return parts[0] || null;
};

const extractImports = (source) => {
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of source.matchAll(regex)) {
      if (!match[1]) continue;
      found.push(Object.freeze({
        specifier: match[1],
        offset: match.index ?? 0,
        line: lineAt(source, match.index ?? 0),
      }));
    }
  }
  found.sort((left, right) =>
    left.offset - right.offset || left.specifier.localeCompare(right.specifier));
  const unique = [];
  const seen = new Set();
  for (const item of found) {
    const key = item.offset + ':' + item.specifier;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return Object.freeze(unique);
};

const envReferences = (source) => {
  const matches = source.match(/process\.env\.[A-Z0-9_]+/gu) ?? [];
  return Object.freeze([...new Set(matches)].sort());
};

const finding = (severity, code, message, file = null, line = null, detail = null) =>
  Object.freeze({ severity, code, message, file, line, detail });

const sortedFindings = (items) => [...items].sort((left, right) =>
  left.severity.localeCompare(right.severity)
  || String(left.file || '').localeCompare(String(right.file || ''))
  || Number(left.line || 0) - Number(right.line || 0)
  || left.code.localeCompare(right.code));

const readPackageManifest = async (root) => {
  const file = path.join(root, WEB_ROOT, 'package.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  return Object.freeze({
    dependencies: Object.freeze({ ...(parsed.dependencies || {}) }),
    devDependencies: Object.freeze({ ...(parsed.devDependencies || {}) }),
  });
};

export const classifyRuntimePackage = (specifier, manifest) => {
  const name = packageName(specifier);
  if (!name) return Object.freeze({ kind: 'not-package', packageName: null });
  if (NODE_BUILTINS.has(name) || NODE_BUILTINS.has(specifier)) {
    return Object.freeze({ kind: 'node-builtin', packageName: name });
  }
  if (Object.prototype.hasOwnProperty.call(manifest.dependencies, name)) {
    return Object.freeze({ kind: 'dependency', packageName: name });
  }
  if (Object.prototype.hasOwnProperty.call(manifest.devDependencies, name)) {
    return Object.freeze({ kind: 'dev-dependency', packageName: name });
  }
  return Object.freeze({ kind: 'undeclared', packageName: name });
};

const domainOf = (relative) => {
  const prefix = SOURCE_ROOT + '/';
  if (!relative.startsWith(prefix)) return 'repository';
  const first = relative.slice(prefix.length).split('/')[0] || 'root';
  const known = new Map([
    ['platform', 'platform'],
    ['Business', 'business'],
    ['Components', 'components'],
    ['Core', 'core'],
    ['Store', 'store'],
    ['Toolbox', 'toolbox'],
    ['data-search', 'data-search'],
    ['experience', 'experience'],
    ['gis-engine', 'gis'],
  ]);
  return known.get(first) || 'web-root';
};

export const auditBrowserRuntimeBoundary = async (
  root = DEFAULT_ROOT,
  options = {},
) => {
  const resolvedRoot = path.resolve(root);
  const manifest = options.manifest ?? await readPackageManifest(resolvedRoot);
  const sourceRoot = path.join(resolvedRoot, SOURCE_ROOT);
  const sourceFiles = (await walk(sourceRoot))
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();

  const findings = [];
  const packages = new Map();
  const domains = new Map();
  let productionFiles = 0;
  let productionImports = 0;
  let externalPackageImports = 0;

  for (const file of sourceFiles) {
    const relative = relativePath(resolvedRoot, file);
    if (isTestPath(relative)) continue;
    productionFiles += 1;
    const domain = domainOf(relative);
    domains.set(domain, (domains.get(domain) || 0) + 1);
    const source = await fs.readFile(file, 'utf8');

    for (const reference of envReferences(source)) {
      if (!BROWSER_ENV_ALLOWED.has(reference)) {
        findings.push(finding(
          'error',
          'browser-process-env',
          'Browser production source cannot read arbitrary process.env values.',
          relative,
          null,
          { reference },
        ));
      }
    }

    const commonJsCount = [...source.matchAll(COMMONJS_PATTERN)].length;
    if (commonJsCount > 0) {
      findings.push(finding(
        domain === 'platform' ? 'error' : 'warning',
        'browser-commonjs',
        'Browser production source contains a CommonJS runtime pattern.',
        relative,
        null,
        { count: commonJsCount, domain },
      ));
    }

    const dynamicCodeCount = [...source.matchAll(DYNAMIC_CODE_PATTERN)].length;
    if (dynamicCodeCount > 0) {
      findings.push(finding(
        'error',
        'browser-dynamic-code',
        'Dynamic code execution is forbidden in browser production source.',
        relative,
        null,
        { count: dynamicCodeCount },
      ));
    }

    for (const item of extractImports(source)) {
      productionImports += 1;
      if (FORBIDDEN_SCHEMES.test(item.specifier)) {
        findings.push(finding(
          'error',
          'remote-executable-import',
          'Browser production modules cannot import executable code from URL/data/blob/file schemes.',
          relative,
          item.line,
          { specifier: item.specifier },
        ));
        continue;
      }

      const classification = classifyRuntimePackage(item.specifier, manifest);
      if (classification.kind === 'not-package') continue;
      externalPackageImports += 1;
      const name = classification.packageName;
      const usage = packages.get(name) || {
        packageName: name,
        imports: 0,
        files: new Set(),
        classification: classification.kind,
      };
      usage.imports += 1;
      usage.files.add(relative);
      if (usage.classification !== classification.kind) {
        usage.classification = 'mixed';
      }
      packages.set(name, usage);

      if (classification.kind === 'node-builtin') {
        findings.push(finding(
          'error',
          'node-builtin-in-browser',
          'Browser production source cannot import Node.js built-in modules.',
          relative,
          item.line,
          { specifier: item.specifier, packageName: name },
        ));
      } else if (classification.kind === 'dev-dependency') {
        findings.push(finding(
          'error',
          'dev-dependency-in-browser-runtime',
          'Browser production source imports a package declared only as a devDependency.',
          relative,
          item.line,
          { specifier: item.specifier, packageName: name },
        ));
      } else if (classification.kind === 'undeclared') {
        findings.push(finding(
          'error',
          'undeclared-browser-dependency',
          'Browser production source imports a package not declared in package.json dependencies.',
          relative,
          item.line,
          { specifier: item.specifier, packageName: name },
        ));
      }
    }
  }

  const packageUsage = Object.freeze([...packages.values()]
    .map((item) => Object.freeze({
      packageName: item.packageName,
      classification: item.classification,
      imports: item.imports,
      files: Object.freeze([...item.files].sort()),
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName)));

  const declaredButUnused = Object.keys(manifest.dependencies)
    .filter((name) => !packages.has(name))
    .sort();
  for (const name of declaredButUnused) {
    findings.push(finding(
      'info',
      'declared-runtime-dependency-not-seen',
      'Runtime dependency was not observed in static production import analysis.',
      'Webclient.app/package.json',
      null,
      { packageName: name },
    ));
  }

  const orderedFindings = Object.freeze(sortedFindings(findings));
  const errors = orderedFindings.filter((item) => item.severity === 'error').length;
  const warnings = orderedFindings.filter((item) => item.severity === 'warning').length;
  const infos = orderedFindings.filter((item) => item.severity === 'info').length;
  const domainFiles = Object.freeze([...domains.entries()]
    .map(([domain, files]) => Object.freeze({ domain, files }))
    .sort((left, right) => left.domain.localeCompare(right.domain)));

  return Object.freeze({
    manifest,
    summary: Object.freeze({
      generatedAt: new Date().toISOString(),
      passed: errors === 0,
      errors,
      warnings,
      infos,
      productionFiles,
      productionImports,
      externalPackageImports,
      runtimePackagesUsed: packageUsage.length,
      declaredRuntimePackages: Object.keys(manifest.dependencies).length,
      declaredButUnusedRuntimePackages: declaredButUnused.length,
    }),
    domainFiles,
    packageUsage,
    declaredButUnused: Object.freeze(declaredButUnused),
    findings: orderedFindings,
  });
};

const table = (headers, rows) => [
  '| ' + headers.join(' | ') + ' |',
  '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...(rows.length > 0 ? rows.map((row) => '| ' + row.join(' | ') + ' |') : ['| _none_ |']),
].join('\n');

export const formatBrowserRuntimeBoundaryMarkdown = (report) => {
  const packages = report.packageUsage.map((item) => [
    item.packageName,
    item.classification,
    String(item.imports),
    String(item.files.length),
  ]);
  const findings = report.findings.map((item) => [
    item.severity,
    item.code,
    item.file || '',
    item.line == null ? '' : String(item.line),
    item.message.replaceAll('|', '\\|'),
  ]);
  const domains = report.domainFiles.map((item) => [item.domain, String(item.files)]);

  return [
    '# Browser Runtime Boundary',
    '',
    'Generated: ' + report.summary.generatedAt,
    '',
    'Gate: **' + (report.summary.passed ? 'PASS' : 'FAIL') + '**',
    '',
    '- Production source files: **' + report.summary.productionFiles + '**',
    '- Production imports: **' + report.summary.productionImports + '**',
    '- External package imports: **' + report.summary.externalPackageImports + '**',
    '- Runtime packages used: **' + report.summary.runtimePackagesUsed + '**',
    '- Errors / warnings / info: **' + report.summary.errors + ' / ' + report.summary.warnings + ' / ' + report.summary.infos + '**',
    '',
    '## Domain source inventory',
    '',
    table(['Domain', 'Production files'], domains),
    '',
    '## Runtime package usage',
    '',
    table(['Package', 'Classification', 'Imports', 'Files'], packages),
    '',
    '## Findings',
    '',
    table(['Severity', 'Code', 'File', 'Line', 'Message'], findings),
    '',
    '## Declared runtime dependencies not seen by static import analysis',
    '',
    report.declaredButUnused.length > 0
      ? report.declaredButUnused.map((name) => '- ' + name).join('\n')
      : '- none',
    '',
    'Static absence is informational only because dependencies may be loaded indirectly. Node built-ins, remote executable imports, arbitrary process.env access, dynamic code execution, devDependency runtime imports and undeclared package imports are blocking.',
    '',
  ].join('\n');
};

const main = async () => {
  const strict = process.argv.includes('--strict');
  const report = await auditBrowserRuntimeBoundary(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'browser-runtime-boundary.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'browser-runtime-boundary.md'), formatBrowserRuntimeBoundaryMarkdown(report));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
  if (strict && !report.summary.passed) process.exitCode = 2;
};

if (import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
