#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const KiB = 1024;

export const DEFAULT_WEB_BUILD_BUDGETS = Object.freeze({
  totalJavaScriptGzipBytes: 5 * MiB,
  largestJavaScriptGzipBytes: 2500 * KiB,
  totalCssGzipBytes: 750 * KiB,
  totalStaticBytes: 25 * MiB,
  sourceMapBytes: 25 * MiB
});

const finitePositive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const budgetFromEnvironment = (environment = process.env) => ({
  totalJavaScriptGzipBytes: finitePositive(
    environment.WEB_BUDGET_JS_GZIP_BYTES,
    DEFAULT_WEB_BUILD_BUDGETS.totalJavaScriptGzipBytes
  ),
  largestJavaScriptGzipBytes: finitePositive(
    environment.WEB_BUDGET_LARGEST_JS_GZIP_BYTES,
    DEFAULT_WEB_BUILD_BUDGETS.largestJavaScriptGzipBytes
  ),
  totalCssGzipBytes: finitePositive(
    environment.WEB_BUDGET_CSS_GZIP_BYTES,
    DEFAULT_WEB_BUILD_BUDGETS.totalCssGzipBytes
  ),
  totalStaticBytes: finitePositive(
    environment.WEB_BUDGET_TOTAL_BYTES,
    DEFAULT_WEB_BUILD_BUDGETS.totalStaticBytes
  ),
  sourceMapBytes: finitePositive(
    environment.WEB_BUDGET_SOURCEMAP_BYTES,
    DEFAULT_WEB_BUILD_BUDGETS.sourceMapBytes
  )
});

const walk = async (directory) => {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walk(absolute));
    } else if (entry.isFile()) {
      result.push(absolute);
    }
  }
  return result;
};

const relativePortable = (root, file) =>
  path.relative(root, file).split(path.sep).join('/');

const classify = (file) => {
  const lower = file.toLowerCase();
  if (lower.endsWith('.map')) return 'map';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'javascript';
  if (lower.endsWith('.css')) return 'css';
  return 'asset';
};

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value >= MiB) return `${(value / MiB).toFixed(2)} MiB`;
  if (value >= KiB) return `${(value / KiB).toFixed(1)} KiB`;
  return `${value} B`;
};

const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);

export const analyzeBuildDirectory = async (buildDirectory, options = {}) => {
  const root = path.resolve(buildDirectory);
  const budgets = {
    ...budgetFromEnvironment(options.environment || {}),
    ...(options.budgets || {})
  };

  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Build directory does not exist: ${root}`);
  }

  const files = await walk(root);
  const records = [];
  for (const file of files) {
    const buffer = await fs.readFile(file);
    const type = classify(file);
    records.push({
      path: relativePortable(root, file),
      type,
      bytes: buffer.byteLength,
      gzipBytes: type === 'javascript' || type === 'css'
        ? gzipSync(buffer, { level: 9 }).byteLength
        : null
    });
  }

  const javascript = records.filter((file) => file.type === 'javascript');
  const css = records.filter((file) => file.type === 'css');
  const sourceMaps = records.filter((file) => file.type === 'map');
  const productionFiles = records.filter((file) => file.type !== 'map');
  const largestJavaScript = [...javascript]
    .sort((left, right) => right.gzipBytes - left.gzipBytes)[0] || null;

  const measurements = Object.freeze({
    fileCount: records.length,
    productionFileCount: productionFiles.length,
    javascriptFileCount: javascript.length,
    cssFileCount: css.length,
    totalJavaScriptBytes: sum(javascript, 'bytes'),
    totalJavaScriptGzipBytes: sum(javascript, 'gzipBytes'),
    largestJavaScriptGzipBytes: largestJavaScript?.gzipBytes || 0,
    largestJavaScriptPath: largestJavaScript?.path || null,
    totalCssBytes: sum(css, 'bytes'),
    totalCssGzipBytes: sum(css, 'gzipBytes'),
    totalStaticBytes: sum(productionFiles, 'bytes'),
    sourceMapBytes: sum(sourceMaps, 'bytes')
  });

  const checks = [
    ['totalJavaScriptGzipBytes', measurements.totalJavaScriptGzipBytes, budgets.totalJavaScriptGzipBytes],
    ['largestJavaScriptGzipBytes', measurements.largestJavaScriptGzipBytes, budgets.largestJavaScriptGzipBytes],
    ['totalCssGzipBytes', measurements.totalCssGzipBytes, budgets.totalCssGzipBytes],
    ['totalStaticBytes', measurements.totalStaticBytes, budgets.totalStaticBytes],
    ['sourceMapBytes', measurements.sourceMapBytes, budgets.sourceMapBytes]
  ].map(([metric, actual, budget]) => Object.freeze({
    metric,
    actual,
    budget,
    remaining: budget - actual,
    pass: actual <= budget
  }));

  return Object.freeze({
    root,
    budgets: Object.freeze({ ...budgets }),
    measurements,
    checks: Object.freeze(checks),
    pass: checks.every((check) => check.pass),
    largestFiles: Object.freeze([...productionFiles]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20)
      .map((file) => Object.freeze({ ...file })))
  });
};

export const formatBuildBudgetMarkdown = (report) => {
  const rows = report.checks.map((check) =>
    `| ${check.pass ? 'PASS' : 'FAIL'} | ${check.metric} | ${formatBytes(check.actual)} | ${formatBytes(check.budget)} |`
  );
  const largest = report.largestFiles.slice(0, 10).map((file) =>
    `| \`${file.path}\` | ${file.type} | ${formatBytes(file.bytes)} | ${file.gzipBytes === null ? 'n/a' : formatBytes(file.gzipBytes)} |`
  );

  return [
    '## Web production build budget',
    '',
    `Overall: **${report.pass ? 'PASS' : 'FAIL'}**`,
    '',
    '| Result | Metric | Actual | Budget |',
    '| --- | --- | ---: | ---: |',
    ...rows,
    '',
    '### Largest production assets',
    '',
    '| Asset | Type | Raw | Gzip |',
    '| --- | --- | ---: | ---: |',
    ...largest,
    ''
  ].join('\n');
};

const parseArguments = (argv) => {
  const args = [...argv];
  const buildDirectory = args.find((value) => !value.startsWith('--')) || 'Webclient.app/build';
  const strict = args.includes('--strict');
  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
  return { buildDirectory, strict, jsonPath };
};

const runCli = async () => {
  const { buildDirectory, strict, jsonPath } = parseArguments(process.argv.slice(2));
  const report = await analyzeBuildDirectory(buildDirectory, { environment: process.env });
  const markdown = formatBuildBudgetMarkdown(report);
  process.stdout.write(`${markdown}\n`);

  if (jsonPath) {
    const destination = path.resolve(jsonPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
  }

  if (strict && !report.pass) process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
