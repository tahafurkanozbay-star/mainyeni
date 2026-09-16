import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeBuildDirectory,
  DEFAULT_WEB_BUILD_BUDGETS,
  formatBuildBudgetMarkdown
} from './web-build-budget.mjs';

const withFixture = async (callback) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-rehberi-build-budget-'));
  try {
    await fs.mkdir(path.join(root, 'static', 'js'), { recursive: true });
    await fs.mkdir(path.join(root, 'static', 'css'), { recursive: true });
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const writeFixture = async (root, relative, content) => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};

test('analyzeBuildDirectory inventories JS, CSS, assets and maps separately', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'console.log("hello");'.repeat(200));
    await writeFixture(root, 'static/js/chunk.js', 'export const value = 42;'.repeat(100));
    await writeFixture(root, 'static/js/main.js.map', '{"version":3}'.repeat(50));
    await writeFixture(root, 'static/css/main.css', '.app{display:block}'.repeat(100));
    await writeFixture(root, 'media/logo.svg', '<svg></svg>'.repeat(20));

    const report = await analyzeBuildDirectory(root, {
      budgets: {
        totalJavaScriptGzipBytes: Number.MAX_SAFE_INTEGER,
        largestJavaScriptGzipBytes: Number.MAX_SAFE_INTEGER,
        totalCssGzipBytes: Number.MAX_SAFE_INTEGER,
        totalStaticBytes: Number.MAX_SAFE_INTEGER,
        sourceMapBytes: Number.MAX_SAFE_INTEGER
      }
    });

    assert.equal(report.measurements.fileCount, 5);
    assert.equal(report.measurements.productionFileCount, 4);
    assert.equal(report.measurements.javascriptFileCount, 2);
    assert.equal(report.measurements.cssFileCount, 1);
    assert.ok(report.measurements.totalJavaScriptBytes > 0);
    assert.ok(report.measurements.totalJavaScriptGzipBytes > 0);
    assert.ok(report.measurements.totalCssGzipBytes > 0);
    assert.ok(report.measurements.totalStaticBytes > 0);
    assert.ok(report.measurements.sourceMapBytes > 0);
    assert.equal(report.pass, true);
  });
});

test('source maps do not count toward production static bytes', async () => {
  await withFixture(async (root) => {
    const js = 'console.log(1);';
    const map = 'x'.repeat(5000);
    await writeFixture(root, 'static/js/main.js', js);
    await writeFixture(root, 'static/js/main.js.map', map);

    const report = await analyzeBuildDirectory(root, {
      budgets: {
        totalJavaScriptGzipBytes: 10000,
        largestJavaScriptGzipBytes: 10000,
        totalCssGzipBytes: 10000,
        totalStaticBytes: 10000,
        sourceMapBytes: 10000
      }
    });

    assert.equal(report.measurements.totalStaticBytes, Buffer.byteLength(js));
    assert.equal(report.measurements.sourceMapBytes, Buffer.byteLength(map));
  });
});

test('largest JavaScript measurement is based on compressed transfer size', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/repetitive.js', 'a'.repeat(10000));
    await writeFixture(root, 'static/js/randomish.js', Array.from({ length: 1000 }, (_, index) => `v${index}=${index};`).join(''));

    const report = await analyzeBuildDirectory(root, {
      budgets: Object.fromEntries(Object.keys(DEFAULT_WEB_BUILD_BUDGETS).map((key) => [key, Number.MAX_SAFE_INTEGER]))
    });

    assert.ok(report.measurements.largestJavaScriptPath);
    const largest = report.largestFiles.find((file) => file.path === report.measurements.largestJavaScriptPath);
    assert.ok(largest);
    assert.equal(largest.gzipBytes, report.measurements.largestJavaScriptGzipBytes);
  });
});

test('report fails only the exceeded budget while retaining all measurements', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'const x = 1;'.repeat(500));
    const baseline = await analyzeBuildDirectory(root, {
      budgets: Object.fromEntries(Object.keys(DEFAULT_WEB_BUILD_BUDGETS).map((key) => [key, Number.MAX_SAFE_INTEGER]))
    });

    const report = await analyzeBuildDirectory(root, {
      budgets: {
        totalJavaScriptGzipBytes: Math.max(0, baseline.measurements.totalJavaScriptGzipBytes - 1),
        largestJavaScriptGzipBytes: Number.MAX_SAFE_INTEGER,
        totalCssGzipBytes: Number.MAX_SAFE_INTEGER,
        totalStaticBytes: Number.MAX_SAFE_INTEGER,
        sourceMapBytes: Number.MAX_SAFE_INTEGER
      }
    });

    assert.equal(report.pass, false);
    const jsCheck = report.checks.find((check) => check.metric === 'totalJavaScriptGzipBytes');
    assert.equal(jsCheck.pass, false);
    assert.ok(jsCheck.remaining < 0);
    assert.equal(report.checks.filter((check) => !check.pass).length, 1);
  });
});

test('empty build directory produces deterministic zero measurements', async () => {
  await withFixture(async (root) => {
    const report = await analyzeBuildDirectory(root);
    assert.equal(report.pass, true);
    assert.deepEqual(report.measurements, {
      fileCount: 0,
      productionFileCount: 0,
      javascriptFileCount: 0,
      cssFileCount: 0,
      totalJavaScriptBytes: 0,
      totalJavaScriptGzipBytes: 0,
      largestJavaScriptGzipBytes: 0,
      largestJavaScriptPath: null,
      totalCssBytes: 0,
      totalCssGzipBytes: 0,
      totalStaticBytes: 0,
      sourceMapBytes: 0
    });
  });
});

test('missing build directory fails with a clear message', async () => {
  const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
  await assert.rejects(
    analyzeBuildDirectory(missing),
    /Build directory does not exist/
  );
});

test('environment values override default budgets', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'console.log(1);'.repeat(20));
    const report = await analyzeBuildDirectory(root, {
      environment: {
        WEB_BUDGET_JS_GZIP_BYTES: '1',
        WEB_BUDGET_LARGEST_JS_GZIP_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.largestJavaScriptGzipBytes),
        WEB_BUDGET_CSS_GZIP_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.totalCssGzipBytes),
        WEB_BUDGET_TOTAL_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.totalStaticBytes),
        WEB_BUDGET_SOURCEMAP_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.sourceMapBytes)
      }
    });

    assert.equal(report.budgets.totalJavaScriptGzipBytes, 1);
    assert.equal(report.pass, false);
  });
});

test('invalid environment values fall back to safe defaults', async () => {
  await withFixture(async (root) => {
    const report = await analyzeBuildDirectory(root, {
      environment: {
        WEB_BUDGET_JS_GZIP_BYTES: 'not-a-number',
        WEB_BUDGET_TOTAL_BYTES: '-1'
      }
    });
    assert.equal(report.budgets.totalJavaScriptGzipBytes, DEFAULT_WEB_BUILD_BUDGETS.totalJavaScriptGzipBytes);
    assert.equal(report.budgets.totalStaticBytes, DEFAULT_WEB_BUILD_BUDGETS.totalStaticBytes);
  });
});

test('largestFiles is capped and sorted by raw size', async () => {
  await withFixture(async (root) => {
    for (let index = 1; index <= 30; index += 1) {
      await writeFixture(root, `media/${index}.txt`, 'x'.repeat(index));
    }
    const report = await analyzeBuildDirectory(root);
    assert.equal(report.largestFiles.length, 20);
    assert.ok(report.largestFiles[0].bytes >= report.largestFiles[19].bytes);
  });
});

test('markdown contains overall outcome, budgets and largest assets', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'console.log("budget")');
    const report = await analyzeBuildDirectory(root);
    const markdown = formatBuildBudgetMarkdown(report);
    assert.match(markdown, /Web production build budget/);
    assert.match(markdown, /Overall: \*\*PASS\*\*/);
    assert.match(markdown, /totalJavaScriptGzipBytes/);
    assert.match(markdown, /static\/js\/main\.js/);
  });
});
