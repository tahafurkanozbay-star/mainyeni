import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  analyzeAdminBuild,
  evaluateAdminBuildBudget,
} from './admin-build-budget.mjs';

const withFixture = (callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-build-budget-'));
  try {
    fs.mkdirSync(path.join(root, 'build', '.vite'), { recursive: true });
    fs.mkdirSync(path.join(root, 'build', 'assets'), { recursive: true });
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const write = (root, relative, content) => {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
};

test('measures only statically reachable entry assets', () => {
  withFixture((root) => {
    write(root, 'build/assets/index.js', 'a'.repeat(100));
    write(root, 'build/assets/vendor.js', 'b'.repeat(80));
    write(root, 'build/assets/route.js', 'c'.repeat(500));
    write(root, 'build/assets/index.css', 'd'.repeat(40));
    write(root, 'build/.vite/manifest.json', JSON.stringify({
      'src/main.tsx': {
        file: 'assets/index.js',
        isEntry: true,
        imports: ['_vendor.js'],
        dynamicImports: ['src/Pages/MapSettings/MapSettingsPage.tsx'],
        css: ['assets/index.css'],
      },
      '_vendor.js': {
        file: 'assets/vendor.js',
      },
      'src/Pages/MapSettings/MapSettingsPage.tsx': {
        file: 'assets/route.js',
        isDynamicEntry: true,
      },
    }));

    const report = analyzeAdminBuild({ root });

    assert.equal(report.javascript.bytes, 180);
    assert.equal(report.css.bytes, 40);
    assert.equal(report.dynamicImports.length, 1);
    assert.deepEqual(report.staticGraphKeys, ['src/main.tsx', '_vendor.js']);
  });
});

test('fails budgets when initial payloads exceed configured ceilings', () => {
  const evaluation = evaluateAdminBuildBudget({
    javascript: { bytes: 1000, gzipBytes: 400, largestBytes: 700 },
    css: { bytes: 300, gzipBytes: 100 },
    dynamicImports: [],
    staticGraphKeys: ['src/main.tsx'],
  }, {
    maxInitialJavaScriptBytes: 900,
    maxInitialJavaScriptGzipBytes: 300,
    maxLargestInitialJavaScriptBytes: 600,
    maxInitialCssBytes: 200,
    minDynamicImports: 2,
  });

  assert.equal(evaluation.ok, false);
  assert.deepEqual(
    new Set(evaluation.violations.map((item) => item.id)),
    new Set([
      'initial-js-bytes',
      'initial-js-gzip-bytes',
      'largest-initial-js-bytes',
      'initial-css-bytes',
      'dynamic-import-count',
    ]),
  );
});

test('rejects heavy source modules from the initial static graph', () => {
  const evaluation = evaluateAdminBuildBudget({
    javascript: { bytes: 1, gzipBytes: 1, largestBytes: 1 },
    css: { bytes: 1, gzipBytes: 1 },
    dynamicImports: ['src/Pages/MapSettings/MapSettingsPage.tsx'],
    staticGraphKeys: ['src/main.tsx', 'src/Components/Map.tsx'],
  }, {
    forbiddenInitialSources: ['src/Components/Map.tsx'],
    minDynamicImports: 1,
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.violations[0]?.id, 'forbidden-initial-source');
});

test('passes a bounded lazy-loaded graph', () => {
  const evaluation = evaluateAdminBuildBudget({
    javascript: { bytes: 400, gzipBytes: 120, largestBytes: 250 },
    css: { bytes: 90, gzipBytes: 20 },
    dynamicImports: ['a', 'b', 'c'],
    staticGraphKeys: ['src/main.tsx'],
  }, {
    maxInitialJavaScriptBytes: 500,
    maxInitialJavaScriptGzipBytes: 150,
    maxLargestInitialJavaScriptBytes: 300,
    maxInitialCssBytes: 100,
    minDynamicImports: 3,
    forbiddenInitialSources: ['src/Components/Map.tsx'],
  });

  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.violations.length, 0);
});
