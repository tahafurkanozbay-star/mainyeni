#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOT = path.resolve(process.cwd());
const SOURCE_ROOT = 'Webclient.app/src';
const DEFAULT_BASELINE = 'tools/platform-language-baseline.json';
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/iu;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);

const normalizePath = (value) => value.split(path.sep).join('/');
const relativePath = (root, value) => normalizePath(path.relative(root, value));
const isTestPath = (value) => TEST_PATH.test(normalizePath(value));

const domainOf = (relative) => {
  const prefix = SOURCE_ROOT + '/';
  const normalized = normalizePath(relative);
  if (!normalized.startsWith(prefix)) return 'repository';
  const first = normalized.slice(prefix.length).split('/')[0] || 'root';
  const map = new Map([
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
  return map.get(first) || 'web-root';
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

const lineCount = (source) => source === '' ? 0 : source.split(/\r?\n/u).length;

const emptyDomain = (domain) => ({
  domain,
  productionFiles: 0,
  productionJavascriptFiles: 0,
  productionTypescriptFiles: 0,
  productionJavascriptLines: 0,
  productionTypescriptLines: 0,
  testFiles: 0,
  testJavascriptFiles: 0,
  testTypescriptFiles: 0,
  javascriptBytes: 0,
  typescriptBytes: 0,
});

const immutableDomain = (value) => Object.freeze({
  ...value,
  typedProductionRatio: value.productionFiles === 0
    ? 1
    : value.productionTypescriptFiles / value.productionFiles,
});

const readBaseline = async (root, baselinePath) => {
  const absolute = path.resolve(root, baselinePath);
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !parsed.domains || typeof parsed.domains !== 'object') {
    throw new Error('Language modernization baseline must use schemaVersion=1 and define domains.');
  }
  const domains = {};
  for (const [domain, value] of Object.entries(parsed.domains)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('Invalid JavaScript budget for domain ' + domain + '.');
    }
    domains[domain] = value;
  }
  const testDomains = {};
  for (const [domain, value] of Object.entries(parsed.testDomains ?? {})) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('Invalid test JavaScript budget for domain ' + domain + '.');
    }
    testDomains[domain] = value;
  }
  return Object.freeze({
    schemaVersion: 1,
    description: String(parsed.description || ''),
    domains: Object.freeze(domains),
    testDomains: Object.freeze(testDomains),
    platformLegacyAllowlist: Object.freeze(
      Array.isArray(parsed.platformLegacyAllowlist)
        ? parsed.platformLegacyAllowlist.map(String).sort()
        : [],
    ),
  });
};

const finding = (severity, code, message, file = null, detail = null) =>
  Object.freeze({ severity, code, message, file, detail });

const priority = (record) => {
  const sizeScore = Math.min(50, Math.ceil(record.bytes / 2048));
  const lineScore = Math.min(50, Math.ceil(record.lines / 50));
  const domainScore = record.domain === 'platform' ? 50
    : record.domain === 'business' ? 40
      : record.domain === 'components' ? 30
        : 20;
  return domainScore + sizeScore + lineScore;
};

export const auditLanguageModernization = async (
  root = DEFAULT_ROOT,
  options = {},
) => {
  const resolvedRoot = path.resolve(root);
  const baselinePath = options.baselinePath || DEFAULT_BASELINE;
  const baseline = await readBaseline(resolvedRoot, baselinePath);
  const sourceDirectory = path.join(resolvedRoot, SOURCE_ROOT);
  const files = (await walk(sourceDirectory))
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();

  const domainNames = new Set(Object.keys(baseline.domains));
  const domains = new Map([...domainNames].map((domain) => [domain, emptyDomain(domain)]));
  const records = [];

  for (const file of files) {
    const relative = relativePath(resolvedRoot, file);
    const extension = path.extname(file).toLowerCase();
    const javascript = JAVASCRIPT_EXTENSIONS.has(extension);
    const typescript = TYPESCRIPT_EXTENSIONS.has(extension);
    const test = isTestPath(relative);
    const domain = domainOf(relative);
    domainNames.add(domain);
    if (!domains.has(domain)) domains.set(domain, emptyDomain(domain));

    const source = await fs.readFile(file, 'utf8');
    const bytes = Buffer.byteLength(source);
    const lines = lineCount(source);
    const bucket = domains.get(domain);

    if (test) {
      bucket.testFiles += 1;
      if (javascript) bucket.testJavascriptFiles += 1;
      if (typescript) bucket.testTypescriptFiles += 1;
    } else {
      bucket.productionFiles += 1;
      if (javascript) {
        bucket.productionJavascriptFiles += 1;
        bucket.productionJavascriptLines += lines;
        bucket.javascriptBytes += bytes;
      }
      if (typescript) {
        bucket.productionTypescriptFiles += 1;
        bucket.productionTypescriptLines += lines;
        bucket.typescriptBytes += bytes;
      }
    }

    records.push(Object.freeze({
      path: relative,
      domain,
      extension,
      javascript,
      typescript,
      test,
      bytes,
      lines,
    }));
  }

  const findings = [];
  for (const domain of [...domainNames].sort()) {
    const current = domains.get(domain) || emptyDomain(domain);
    const budget = baseline.domains[domain];
    const testBudget = baseline.testDomains[domain];
    if (budget === undefined) {
      if (current.productionJavascriptFiles > 0) {
        findings.push(finding(
          'error',
          'unbudgeted-javascript-domain',
          'A domain without a modernization baseline contains production JavaScript.',
          null,
          { domain, current: current.productionJavascriptFiles },
        ));
      }
      continue;
    }
    if (current.productionJavascriptFiles > budget) {
      findings.push(finding(
        'error',
        'javascript-budget-regression',
        'Production JavaScript count exceeds the ratcheted domain ceiling.',
        null,
        { domain, current: current.productionJavascriptFiles, budget },
      ));
    }
    if (testBudget !== undefined && current.testJavascriptFiles > testBudget) {
      findings.push(finding(
        'error',
        'test-javascript-budget-regression',
        'Test JavaScript count exceeds the ratcheted domain ceiling.',
        null,
        { domain, current: current.testJavascriptFiles, budget: testBudget },
      ));
    }
  }

  const platformJavascript = records
    .filter((record) => record.domain === 'platform' && !record.test && record.javascript)
    .map((record) => record.path)
    .sort();
  const allowlist = new Set(baseline.platformLegacyAllowlist);
  for (const file of platformJavascript) {
    if (!allowlist.has(file)) {
      findings.push(finding(
        'error',
        'platform-javascript-not-allowlisted',
        'Platform production JavaScript must be migrated or explicitly justified by the bounded baseline.',
        file,
      ));
    }
  }
  for (const file of baseline.platformLegacyAllowlist) {
    if (!platformJavascript.includes(file)) {
      findings.push(finding(
        'info',
        'stale-platform-javascript-allowlist',
        'A Platform JavaScript allowlist entry is no longer present and should be removed from the baseline.',
        file,
      ));
    }
  }

  const migrationQueue = records
    .filter((record) => !record.test && record.javascript)
    .map((record) => Object.freeze({ ...record, priority: priority(record) }))
    .sort((left, right) =>
      right.priority - left.priority
      || right.bytes - left.bytes
      || left.path.localeCompare(right.path));

  const orderedDomains = [...domains.values()]
    .map(immutableDomain)
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const orderedFindings = Object.freeze([...findings].sort((left, right) =>
    left.severity.localeCompare(right.severity)
    || String(left.file || '').localeCompare(String(right.file || ''))
    || left.code.localeCompare(right.code)));
  const errors = orderedFindings.filter((item) => item.severity === 'error').length;
  const warnings = orderedFindings.filter((item) => item.severity === 'warning').length;
  const infos = orderedFindings.filter((item) => item.severity === 'info').length;
  const totals = orderedDomains.reduce((accumulator, item) => {
    accumulator.productionFiles += item.productionFiles;
    accumulator.javascript += item.productionJavascriptFiles;
    accumulator.typescript += item.productionTypescriptFiles;
    accumulator.javascriptLines += item.productionJavascriptLines;
    accumulator.typescriptLines += item.productionTypescriptLines;
    accumulator.testFiles += item.testFiles;
    accumulator.testJavascript += item.testJavascriptFiles;
    accumulator.testTypescript += item.testTypescriptFiles;
    return accumulator;
  }, {
    productionFiles: 0,
    javascript: 0,
    typescript: 0,
    javascriptLines: 0,
    typescriptLines: 0,
    testFiles: 0,
    testJavascript: 0,
    testTypescript: 0,
  });

  return Object.freeze({
    baseline,
    summary: Object.freeze({
      generatedAt: new Date().toISOString(),
      passed: errors === 0,
      errors,
      warnings,
      infos,
      productionFiles: totals.productionFiles,
      productionJavascriptFiles: totals.javascript,
      productionTypescriptFiles: totals.typescript,
      productionJavascriptLines: totals.javascriptLines,
      productionTypescriptLines: totals.typescriptLines,
      testFiles: totals.testFiles,
      testJavascriptFiles: totals.testJavascript,
      testTypescriptFiles: totals.testTypescript,
      typedProductionRatio: totals.productionFiles === 0
        ? 1
        : totals.typescript / totals.productionFiles,
      typedTestRatio: totals.testFiles === 0
        ? 1
        : totals.testTypescript / totals.testFiles,
    }),
    domains: Object.freeze(orderedDomains),
    migrationQueue: Object.freeze(migrationQueue),
    findings: orderedFindings,
  });
};

const table = (headers, rows) => [
  '| ' + headers.join(' | ') + ' |',
  '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...(rows.length > 0 ? rows.map((row) => '| ' + row.join(' | ') + ' |') : ['| _none_ |']),
].join('\n');

const percent = (value) => (value * 100).toFixed(1) + '%';

export const formatLanguageModernizationMarkdown = (report) => {
  const domainRows = report.domains.map((item) => [
    item.domain,
    String(item.productionTypescriptFiles),
    String(item.productionJavascriptFiles),
    String(report.baseline.domains[item.domain] ?? 'n/a'),
    String(item.testTypescriptFiles),
    String(item.testJavascriptFiles),
    String(report.baseline.testDomains[item.domain] ?? 'n/a'),
    percent(item.typedProductionRatio),
    String(item.productionTypescriptLines),
    String(item.productionJavascriptLines),
  ]);
  const queueRows = report.migrationQueue.slice(0, 50).map((item) => [
    String(item.priority),
    item.domain,
    item.path,
    String(item.lines),
    String(item.bytes),
  ]);
  const findingRows = report.findings.map((item) => [
    item.severity,
    item.code,
    item.file || '',
    item.message.replaceAll('|', '\\|'),
  ]);
  return [
    '# Language Modernization Ratchet',
    '',
    'Generated: ' + report.summary.generatedAt,
    '',
    'Gate: **' + (report.summary.passed ? 'PASS' : 'FAIL') + '**',
    '',
    '- Production TypeScript files: **' + report.summary.productionTypescriptFiles + '**',
    '- Production JavaScript files: **' + report.summary.productionJavascriptFiles + '**',
    '- Typed production ratio: **' + percent(report.summary.typedProductionRatio) + '**',
    '- Production TypeScript lines: **' + report.summary.productionTypescriptLines + '**',
    '- Production JavaScript lines: **' + report.summary.productionJavascriptLines + '**',
    '- Test TypeScript files: **' + report.summary.testTypescriptFiles + '**',
    '- Test JavaScript files: **' + report.summary.testJavascriptFiles + '**',
    '- Typed test ratio: **' + percent(report.summary.typedTestRatio) + '**',
    '',
    '## Domain ratchet',
    '',
    table(
      ['Domain', 'Prod TS', 'Prod JS', 'Prod JS ceiling', 'Test TS', 'Test JS', 'Test JS ceiling', 'Prod typed ratio', 'TS lines', 'JS lines'],
      domainRows,
    ),
    '',
    '## Migration queue',
    '',
    table(['Priority', 'Domain', 'File', 'Lines', 'Bytes'], queueRows),
    '',
    '## Findings',
    '',
    table(['Severity', 'Code', 'File', 'Message'], findingRows),
    '',
    'The JavaScript ceilings are ratchets, not targets. Production and test ceilings may decrease as modules migrate to TypeScript but must never increase. Domains already at zero JavaScript are permanently protected from regression.',
    '',
  ].join('\n');
};

const main = async () => {
  const strict = process.argv.includes('--strict');
  const report = await auditLanguageModernization(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'language-modernization.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'language-modernization.md'), formatLanguageModernizationMarkdown(report));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
  if (strict && !report.summary.passed) process.exitCode = 2;
};

if (import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
