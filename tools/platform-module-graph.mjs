#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOT = path.resolve(process.cwd());
const WEB_ROOT = 'Webclient.app';
const SOURCE_ROOT = 'Webclient.app/src';
const PLATFORM_ROOT = 'Webclient.app/src/platform';
const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']);
const RESOLUTION_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/iu;
const TYPE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);
const LEGACY_PLATFORM_ALLOWLIST = new Set([
  'Webclient.app/src/platform/bootstrap/bootstrapApplication.js',
]);
const TYPE_OPT_OUT = /(?:@ts-nocheck|@ts-ignore|@ts-expect-error)/gu;
const COMMONJS_PATTERN = /\b(?:require\s*\(|module\.exports\b|exports\.[A-Za-z_$])/gu;
const IMPORT_PATTERNS = Object.freeze([
  /\bimport\s+(?:type\s+)?(?:[^'";()]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
]);

const normalizePath = (value) => value.split(path.sep).join('/');
const relativePath = (root, value) => normalizePath(path.relative(root, value));
const isSourceExtension = (value) => SOURCE_EXTENSIONS.includes(path.extname(value).toLowerCase());
const isTestPath = (value) => TEST_PATH.test(normalizePath(value));
const isRelativeSpecifier = (value) => /^\.{1,2}(?:\/|$)/u.test(value);

const existsFile = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};

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

export const extractModuleSpecifiers = (source) => {
  const matches = [];
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of source.matchAll(regex)) {
      const specifier = match[1];
      if (!specifier) continue;
      matches.push(Object.freeze({
        specifier,
        offset: match.index ?? 0,
        line: lineAt(source, match.index ?? 0),
      }));
    }
  }
  matches.sort((left, right) =>
    left.offset - right.offset || left.specifier.localeCompare(right.specifier));
  const unique = [];
  const seen = new Set();
  for (const item of matches) {
    const key = item.offset + ':' + item.specifier;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return Object.freeze(unique);
};

const sourceStem = (relative) => {
  const extension = path.extname(relative);
  return extension ? relative.slice(0, -extension.length) : relative;
};

const sourceKind = (relative) => {
  const extension = path.extname(relative).toLowerCase();
  if (TYPE_EXTENSIONS.has(extension)) return 'typescript';
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return 'javascript';
  return 'other';
};

const domainOf = (relative) => {
  const normalized = normalizePath(relative);
  const marker = 'Webclient.app/src/';
  const index = normalized.indexOf(marker);
  if (index < 0) return 'repository';
  const remainder = normalized.slice(index + marker.length);
  const first = remainder.split('/')[0] || 'root';
  const known = new Map([
    ['platform', 'platform'],
    ['Business', 'business'],
    ['Core', 'core'],
    ['Store', 'store'],
    ['Toolbox', 'toolbox'],
    ['Components', 'components'],
    ['gis-engine', 'gis'],
    ['experience', 'experience'],
    ['data-search', 'data-search'],
  ]);
  return known.get(first) || 'web-root';
};

const resolutionCandidates = (absoluteBase) => {
  const candidates = [];
  for (const extension of RESOLUTION_EXTENSIONS) candidates.push(absoluteBase + extension);
  for (const extension of RESOLUTION_EXTENSIONS) candidates.push(path.join(absoluteBase, 'index' + extension));
  return candidates;
};

const resolveRelativeSpecifier = async (importer, specifier) => {
  const absoluteBase = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(specifier);
  if (extension) {
    const exact = await existsFile(absoluteBase) ? [absoluteBase] : [];
    return Object.freeze({
      explicit: true,
      candidates: Object.freeze(exact),
      resolved: exact[0] ?? null,
    });
  }
  const candidates = [];
  for (const candidate of resolutionCandidates(absoluteBase)) {
    if (await existsFile(candidate)) candidates.push(candidate);
  }
  return Object.freeze({
    explicit: false,
    candidates: Object.freeze(candidates),
    resolved: candidates.length === 1 ? candidates[0] : null,
  });
};

const finding = (severity, code, message, file = null, line = null, detail = null) =>
  Object.freeze({ severity, code, message, file, line, detail });

const sortedFindings = (items) => [...items].sort((left, right) =>
  left.severity.localeCompare(right.severity)
  || String(left.file || '').localeCompare(String(right.file || ''))
  || Number(left.line || 0) - Number(right.line || 0)
  || left.code.localeCompare(right.code)
  || left.message.localeCompare(right.message));

const stronglyConnectedComponents = (nodes, adjacency) => {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const components = [];

  const visit = (node) => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) || []) {
      if (!nodes.has(next)) continue;
      if (!indexes.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const candidate = stack.pop();
      onStack.delete(candidate);
      component.push(candidate);
      if (candidate === node) break;
    }
    components.push(component.sort());
  };

  for (const node of [...nodes].sort()) {
    if (!indexes.has(node)) visit(node);
  }
  return components;
};

const languageSummary = (records) => {
  const summary = {
    typescript: 0,
    javascript: 0,
    tests: 0,
    production: 0,
    platformTypescript: 0,
    platformJavascript: 0,
  };
  for (const record of records) {
    summary[sourceKind(record.relative)] += 1;
    if (record.test) summary.tests += 1;
    else summary.production += 1;
    if (record.relative.startsWith(PLATFORM_ROOT + '/')) {
      if (sourceKind(record.relative) === 'typescript') summary.platformTypescript += 1;
      if (sourceKind(record.relative) === 'javascript') summary.platformJavascript += 1;
    }
  }
  return Object.freeze(summary);
};

const duplicateStems = (records) => {
  const groups = new Map();
  for (const record of records.filter((item) => !item.test)) {
    const stem = sourceStem(record.relative);
    const list = groups.get(stem) || [];
    list.push(record);
    groups.set(stem, list);
  }
  return [...groups.entries()]
    .filter(([, items]) => {
      const kinds = new Set(items.map((item) => sourceKind(item.relative)));
      return kinds.has('typescript') && kinds.has('javascript');
    })
    .map(([stem, items]) => Object.freeze({
      stem,
      files: Object.freeze(items.map((item) => item.relative).sort()),
    }))
    .sort((left, right) => left.stem.localeCompare(right.stem));
};

const readRecord = async (root, file) => {
  const relative = relativePath(root, file);
  return Object.freeze({
    absolute: file,
    relative,
    text: await fs.readFile(file, 'utf8'),
    test: isTestPath(relative),
  });
};

export const buildPlatformModuleGraph = async (root = DEFAULT_ROOT) => {
  const resolvedRoot = path.resolve(root);
  const sourceDirectory = path.join(resolvedRoot, SOURCE_ROOT);
  const allFiles = await walk(sourceDirectory);
  const sourceFiles = allFiles.filter(isSourceExtension).sort();
  const records = await Promise.all(sourceFiles.map((file) => readRecord(resolvedRoot, file)));
  const byAbsolute = new Map(records.map((record) => [path.resolve(record.absolute), record]));
  const findings = [];
  const edges = [];
  const externalImports = [];
  const adjacency = new Map(records.map((record) => [record.relative, new Set()]));

  const duplicates = duplicateStems(records);
  for (const duplicate of duplicates) {
    const isPlatform = duplicate.stem.startsWith(PLATFORM_ROOT + '/');
    findings.push(finding(
      isPlatform ? 'error' : 'warning',
      'typed-javascript-shadow',
      'TypeScript and JavaScript production modules share the same resolution stem.',
      duplicate.stem,
      null,
      { files: duplicate.files },
    ));
  }

  for (const record of records) {
    const kind = sourceKind(record.relative);
    const platformProduction = !record.test
      && record.relative.startsWith(PLATFORM_ROOT + '/');

    if (platformProduction && kind === 'javascript') {
      const allowlisted = LEGACY_PLATFORM_ALLOWLIST.has(record.relative);
      findings.push(finding(
        allowlisted ? 'warning' : 'error',
        allowlisted ? 'legacy-platform-javascript-allowlisted' : 'legacy-platform-javascript',
        allowlisted
          ? 'Platform JavaScript remains temporarily allowlisted pending an upstream typed dependency.'
          : 'Platform production JavaScript is forbidden once a module is eligible for the strict TypeScript boundary.',
        record.relative,
      ));
    }

    if (platformProduction) {
      const optOutCount = [...record.text.matchAll(TYPE_OPT_OUT)].length;
      if (optOutCount > 0) {
        findings.push(finding(
          'error',
          'typescript-opt-out',
          'Platform production code cannot suppress TypeScript diagnostics.',
          record.relative,
          null,
          { count: optOutCount },
        ));
      }
      const commonJsCount = [...record.text.matchAll(COMMONJS_PATTERN)].length;
      if (commonJsCount > 0) {
        findings.push(finding(
          'error',
          'platform-commonjs',
          'Platform production modules must remain native ESM.',
          record.relative,
          null,
          { count: commonJsCount },
        ));
      }
    }

    const specifiers = extractModuleSpecifiers(record.text);
    for (const item of specifiers) {
      if (!isRelativeSpecifier(item.specifier)) {
        externalImports.push(Object.freeze({
          importer: record.relative,
          specifier: item.specifier,
          line: item.line,
        }));
        continue;
      }

      const resolution = await resolveRelativeSpecifier(record.absolute, item.specifier);
      if (resolution.candidates.length > 1) {
        const candidates = resolution.candidates
          .map((candidate) => relativePath(resolvedRoot, candidate))
          .sort();
        findings.push(finding(
          'error',
          'ambiguous-relative-import',
          'Extensionless relative import resolves to multiple source candidates.',
          record.relative,
          item.line,
          { specifier: item.specifier, candidates },
        ));
        continue;
      }

      if (resolution.candidates.length === 0) {
        const extension = path.extname(item.specifier);
        if (!extension || SOURCE_EXTENSIONS.includes(extension)) {
          findings.push(finding(
            'warning',
            'unresolved-relative-import',
            'Relative source import could not be resolved by the modernization audit.',
            record.relative,
            item.line,
            { specifier: item.specifier },
          ));
        }
        continue;
      }

      const targetAbsolute = path.resolve(resolution.candidates[0]);
      const targetRecord = byAbsolute.get(targetAbsolute);
      if (!targetRecord) continue;

      const edge = Object.freeze({
        importer: record.relative,
        imported: targetRecord.relative,
        specifier: item.specifier,
        line: item.line,
        importerDomain: domainOf(record.relative),
        importedDomain: domainOf(targetRecord.relative),
        test: record.test,
      });
      edges.push(edge);
      adjacency.get(record.relative)?.add(targetRecord.relative);

      if (!record.test
        && JAVASCRIPT_EXTENSIONS.has(path.extname(targetRecord.relative).toLowerCase())) {
        const typedCandidates = records.filter((candidate) =>
          !candidate.test
          && sourceStem(candidate.relative) === sourceStem(targetRecord.relative)
          && TYPE_EXTENSIONS.has(path.extname(candidate.relative).toLowerCase()));
        if (typedCandidates.length > 0) {
          findings.push(finding(
            'error',
            'explicit-legacy-import-shadows-typed',
            'Import targets JavaScript while a typed implementation with the same stem exists.',
            record.relative,
            item.line,
            {
              specifier: item.specifier,
              javascript: targetRecord.relative,
              typed: typedCandidates.map((candidate) => candidate.relative).sort(),
            },
          ));
        }
      }
    }
  }

  const productionNodes = new Set(records.filter((record) => !record.test).map((record) => record.relative));
  const components = stronglyConnectedComponents(productionNodes, adjacency)
    .filter((component) => component.length > 1)
    .map((component) => Object.freeze(component));
  for (const component of components) {
    const platformOnly = component.every((file) => file.startsWith(PLATFORM_ROOT + '/'));
    findings.push(finding(
      platformOnly ? 'warning' : 'info',
      'dependency-cycle',
      'Production module dependency cycle detected.',
      component[0],
      null,
      { files: component },
    ));
  }

  const boundaryCounts = new Map();
  for (const edge of edges.filter((item) => !item.test)) {
    const key = edge.importerDomain + ' -> ' + edge.importedDomain;
    boundaryCounts.set(key, (boundaryCounts.get(key) || 0) + 1);
  }
  const boundaries = [...boundaryCounts.entries()]
    .map(([boundary, count]) => Object.freeze({ boundary, count }))
    .sort((left, right) => left.boundary.localeCompare(right.boundary));

  const orderedFindings = Object.freeze(sortedFindings(findings));
  const errors = orderedFindings.filter((item) => item.severity === 'error').length;
  const warnings = orderedFindings.filter((item) => item.severity === 'warning').length;
  const infos = orderedFindings.filter((item) => item.severity === 'info').length;

  return Object.freeze({
    root: resolvedRoot,
    policy: Object.freeze({
      platformLegacyJavascriptAllowlist: Object.freeze([...LEGACY_PLATFORM_ALLOWLIST].sort()),
      sourceExtensions: SOURCE_EXTENSIONS,
      resolutionExtensions: RESOLUTION_EXTENSIONS,
    }),
    summary: Object.freeze({
      generatedAt: new Date().toISOString(),
      sourceFiles: records.length,
      productionFiles: productionNodes.size,
      edges: edges.length,
      externalImports: externalImports.length,
      duplicateTypedJavascriptStems: duplicates.length,
      dependencyCycles: components.length,
      errors,
      warnings,
      infos,
      passed: errors === 0,
      languages: languageSummary(records),
    }),
    files: Object.freeze(records.map((record) => Object.freeze({
      path: record.relative,
      language: sourceKind(record.relative),
      test: record.test,
      domain: domainOf(record.relative),
    })).sort((left, right) => left.path.localeCompare(right.path))),
    edges: Object.freeze([...edges].sort((left, right) =>
      left.importer.localeCompare(right.importer)
      || left.imported.localeCompare(right.imported)
      || left.line - right.line)),
    externalImports: Object.freeze([...externalImports].sort((left, right) =>
      left.importer.localeCompare(right.importer)
      || left.specifier.localeCompare(right.specifier)
      || left.line - right.line)),
    duplicateStems: Object.freeze(duplicates),
    cycles: Object.freeze(components),
    boundaries: Object.freeze(boundaries),
    findings: orderedFindings,
  });
};

const markdownTable = (headers, rows) => {
  const head = '| ' + headers.join(' | ') + ' |';
  const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
  if (rows.length === 0) return [head, separator, '| _none_ |' + ' |'.repeat(Math.max(0, headers.length - 1))].join('\n');
  return [head, separator, ...rows.map((row) => '| ' + row.join(' | ') + ' |')].join('\n');
};

export const formatPlatformModuleGraphMarkdown = (report) => {
  const language = report.summary.languages;
  const findings = report.findings.map((item) => [
    item.severity,
    item.code,
    item.file || '',
    item.line == null ? '' : String(item.line),
    item.message.replaceAll('|', '\\|'),
  ]);
  const duplicates = report.duplicateStems.map((item) => [
    item.stem,
    item.files.join('<br>'),
  ]);
  const boundaries = report.boundaries.map((item) => [item.boundary, String(item.count)]);
  const cycles = report.cycles.map((items, index) => [
    String(index + 1),
    items.join(' → '),
  ]);

  return [
    '# Platform Module Graph',
    '',
    'Generated: ' + report.summary.generatedAt,
    '',
    'Gate: **' + (report.summary.passed ? 'PASS' : 'FAIL') + '**',
    '',
    '## Summary',
    '',
    '- Source files: **' + report.summary.sourceFiles + '**',
    '- Production files: **' + report.summary.productionFiles + '**',
    '- Internal edges: **' + report.summary.edges + '**',
    '- External imports: **' + report.summary.externalImports + '**',
    '- Duplicate JS/TS stems: **' + report.summary.duplicateTypedJavascriptStems + '**',
    '- Dependency cycles: **' + report.summary.dependencyCycles + '**',
    '- Errors / warnings / info: **' + report.summary.errors + ' / ' + report.summary.warnings + ' / ' + report.summary.infos + '**',
    '- Platform TypeScript / JavaScript files: **' + language.platformTypescript + ' / ' + language.platformJavascript + '**',
    '',
    '## Findings',
    '',
    markdownTable(['Severity', 'Code', 'File', 'Line', 'Message'], findings),
    '',
    '## Duplicate typed / JavaScript stems',
    '',
    markdownTable(['Stem', 'Files'], duplicates),
    '',
    '## Production dependency cycles',
    '',
    markdownTable(['#', 'Cycle'], cycles),
    '',
    '## Domain boundaries',
    '',
    markdownTable(['Boundary', 'Edges'], boundaries),
    '',
    '## Policy',
    '',
    'The Platform domain is moving to a strict TypeScript/native-ESM runtime. JavaScript/TypeScript shadow pairs, ambiguous extensionless imports, CommonJS production modules and TypeScript diagnostic opt-outs are blocking. The single bootstrapApplication.js adapter is temporarily allowlisted because it still composes a legacy Business module; the audit keeps that debt visible until the upstream dependency is typed.',
    '',
  ].join('\n');
};

const main = async () => {
  const strict = process.argv.includes('--strict');
  const report = await buildPlatformModuleGraph(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'platform-module-graph.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'platform-module-graph.md'), formatPlatformModuleGraphMarkdown(report));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
  if (strict && !report.summary.passed) process.exitCode = 2;
};

if (import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
