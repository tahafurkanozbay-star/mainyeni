import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const DEFAULT_BUILD_DIR = 'build';
const DEFAULT_MANIFEST = path.join(DEFAULT_BUILD_DIR, '.vite', 'manifest.json');
const DEFAULT_CONFIG = path.join('tooling', 'admin-build-budget.json');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const sum = (values) => values.reduce((total, value) => total + value, 0);

const unique = (values) => [...new Set(values)];

const fileStats = (root, relative) => {
  const absolute = path.join(root, relative);
  const content = fs.readFileSync(absolute);
  return Object.freeze({
    file: relative.replaceAll(path.sep, '/'),
    bytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
  });
};

const findEntry = (manifest) => {
  const preferred = Object.entries(manifest).find(
    ([key, value]) => key.endsWith('/main.tsx') && value?.isEntry === true,
  );
  if (preferred) return preferred[0];

  const entries = Object.entries(manifest).filter(([, value]) => value?.isEntry === true);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one Vite entry chunk, found ${entries.length}.`);
  }
  return entries[0][0];
};

const collectStaticGraph = (manifest, entryKey) => {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) {
      throw new Error(`Manifest import ${key} was not found.`);
    }
    visited.add(key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entryKey);
  return [...visited];
};

export const analyzeAdminBuild = ({
  root = process.cwd(),
  manifestPath = DEFAULT_MANIFEST,
} = {}) => {
  const manifestAbsolute = path.join(root, manifestPath);
  const manifest = readJson(manifestAbsolute);
  const entryKey = findEntry(manifest);
  const staticGraphKeys = collectStaticGraph(manifest, entryKey);

  const jsFiles = unique(
    staticGraphKeys
      .map((key) => manifest[key]?.file)
      .filter((file) => typeof file === 'string' && file.endsWith('.js')),
  );
  const cssFiles = unique(
    staticGraphKeys.flatMap((key) =>
      Array.isArray(manifest[key]?.css) ? manifest[key].css : []),
  );
  const dynamicImports = unique(
    staticGraphKeys.flatMap((key) =>
      Array.isArray(manifest[key]?.dynamicImports)
        ? manifest[key].dynamicImports
        : []),
  );

  const js = jsFiles.map((file) => fileStats(root, path.join(DEFAULT_BUILD_DIR, file)));
  const css = cssFiles.map((file) => fileStats(root, path.join(DEFAULT_BUILD_DIR, file)));

  return Object.freeze({
    entryKey,
    staticGraphKeys: Object.freeze(staticGraphKeys),
    dynamicImports: Object.freeze(dynamicImports),
    javascript: Object.freeze({
      files: Object.freeze(js),
      bytes: sum(js.map((item) => item.bytes)),
      gzipBytes: sum(js.map((item) => item.gzipBytes)),
      largestBytes: Math.max(0, ...js.map((item) => item.bytes)),
    }),
    css: Object.freeze({
      files: Object.freeze(css),
      bytes: sum(css.map((item) => item.bytes)),
      gzipBytes: sum(css.map((item) => item.gzipBytes)),
    }),
  });
};

export const evaluateAdminBuildBudget = (report, config) => {
  const violations = [];

  const checks = [
    ['initial-js-bytes', report.javascript.bytes, config.maxInitialJavaScriptBytes],
    ['initial-js-gzip-bytes', report.javascript.gzipBytes, config.maxInitialJavaScriptGzipBytes],
    ['largest-initial-js-bytes', report.javascript.largestBytes, config.maxLargestInitialJavaScriptBytes],
    ['initial-css-bytes', report.css.bytes, config.maxInitialCssBytes],
  ];

  for (const [id, actual, maximum] of checks) {
    if (Number.isFinite(maximum) && actual > maximum) {
      violations.push(Object.freeze({
        id,
        actual,
        maximum,
      }));
    }
  }

  const minimumDynamicImports = Number(config.minDynamicImports ?? 0);
  if (report.dynamicImports.length < minimumDynamicImports) {
    violations.push(Object.freeze({
      id: 'dynamic-import-count',
      actual: report.dynamicImports.length,
      minimum: minimumDynamicImports,
    }));
  }

  for (const forbidden of config.forbiddenInitialSources ?? []) {
    if (report.staticGraphKeys.includes(forbidden)) {
      violations.push(Object.freeze({
        id: 'forbidden-initial-source',
        source: forbidden,
      }));
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
  });
};

export const formatAdminBuildReport = (report, evaluation = null) => {
  const lines = [
    'Admin build performance',
    `entry=${report.entryKey}`,
    `initialJsBytes=${report.javascript.bytes}`,
    `initialJsGzipBytes=${report.javascript.gzipBytes}`,
    `largestInitialJsBytes=${report.javascript.largestBytes}`,
    `initialCssBytes=${report.css.bytes}`,
    `initialCssGzipBytes=${report.css.gzipBytes}`,
    `dynamicImports=${report.dynamicImports.length}`,
    `staticGraphModules=${report.staticGraphKeys.length}`,
  ];

  if (evaluation) {
    lines.push(`budget=${evaluation.ok ? 'PASS' : 'FAIL'}`);
    for (const violation of evaluation.violations) {
      lines.push(`violation=${JSON.stringify(violation)}`);
    }
  }

  return lines.join('\n');
};

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectExecution) {
  const root = process.cwd();
  const strict = process.argv.includes('--strict');
  const report = analyzeAdminBuild({ root });
  let evaluation = null;

  if (fs.existsSync(path.join(root, DEFAULT_CONFIG))) {
    evaluation = evaluateAdminBuildBudget(report, readJson(path.join(root, DEFAULT_CONFIG)));
  } else if (strict) {
    throw new Error(`Missing build budget config: ${DEFAULT_CONFIG}`);
  }

  process.stdout.write(formatAdminBuildReport(report, evaluation) + '\n');
  if (strict && evaluation && !evaluation.ok) process.exitCode = 2;
}
