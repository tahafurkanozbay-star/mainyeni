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

const unlimitedBudgets = () =>
  Object.fromEntries(
    Object.keys(DEFAULT_WEB_BUILD_BUDGETS).map((key) => [key, Number.MAX_SAFE_INTEGER])
  );

const viteManifest = ({
  entry = 'assets/entry.js',
  imports = [],
  dynamicImports = [],
  css = [],
  assets = []
} = {}) => ({
  'src/main.tsx': {
    file: entry,
    isEntry: true,
    imports,
    dynamicImports,
    css,
    assets
  }
});

test('analyzeBuildDirectory inventories JS, CSS, assets and maps separately', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'console.log("hello");'.repeat(200));
    await writeFixture(root, 'static/js/chunk.js', 'export const value = 42;'.repeat(100));
    await writeFixture(root, 'static/js/main.js.map', '{"version":3}'.repeat(50));
    await writeFixture(root, 'static/css/main.css', '.app{display:block}'.repeat(100));
    await writeFixture(root, 'media/logo.svg', '<svg></svg>'.repeat(20));

    const report = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });

    assert.equal(report.measurements.fileCount, 5);
    assert.equal(report.measurements.productionFileCount, 4);
    assert.equal(report.measurements.javascriptFileCount, 2);
    assert.equal(report.measurements.cssFileCount, 1);
    assert.ok(report.measurements.totalJavaScriptBytes > 0);
    assert.ok(report.measurements.totalJavaScriptGzipBytes > 0);
    assert.ok(report.measurements.totalCssGzipBytes > 0);
    assert.ok(report.measurements.totalStaticBytes > 0);
    assert.equal(report.measurements.eagerStaticBytes, report.measurements.totalStaticBytes);
    assert.equal(report.measurements.lazyStaticBytes, 0);
    assert.equal(report.measurements.viteManifestUsed, false);
    assert.ok(report.measurements.sourceMapBytes > 0);
    assert.equal(report.pass, true);
  });
});

test('source maps do not count toward production static or eager bytes', async () => {
  await withFixture(async (root) => {
    const js = 'console.log(1);';
    const map = 'x'.repeat(5000);
    await writeFixture(root, 'static/js/main.js', js);
    await writeFixture(root, 'static/js/main.js.map', map);

    const report = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });

    assert.equal(report.measurements.totalStaticBytes, Buffer.byteLength(js));
    assert.equal(report.measurements.eagerStaticBytes, Buffer.byteLength(js));
    assert.equal(report.measurements.sourceMapBytes, Buffer.byteLength(map));
  });
});

test('Vite manifest measures only entry and recursive static imports as eager', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'index.html', '<div id="root"></div>');
    await writeFixture(root, 'assets/entry.js', 'import "./vendor.js";'.repeat(100));
    await writeFixture(root, 'assets/vendor.js', 'export const vendor = true;'.repeat(100));
    await writeFixture(root, 'assets/lazy.js', 'export const lazy = true;'.repeat(500));
    await writeFixture(root, 'assets/main.css', '.root{display:grid}'.repeat(100));
    await writeFixture(root, '.vite/manifest.json', JSON.stringify({
      ...viteManifest({
        imports: ['_vendor'],
        dynamicImports: ['_lazy'],
        css: ['assets/main.css']
      }),
      _vendor: { file: 'assets/vendor.js' },
      _lazy: { file: 'assets/lazy.js', isDynamicEntry: true }
    }));

    const report = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });

    assert.equal(report.measurements.viteManifestUsed, true);
    assert.ok(report.measurements.eagerStaticBytes < report.measurements.totalStaticBytes);
    assert.ok(report.measurements.lazyStaticBytes > 0);
    assert.equal(report.measurements.eagerFileCount, 4);
    assert.ok(report.measurements.lazyFileCount >= 2);
    assert.ok(report.largestEagerFiles.every((file) => file.path !== 'assets/lazy.js'));
    assert.ok(report.largestFiles.some((file) => file.path === 'assets/lazy.js'));
  });
});

test('Vite manifest assets attached to an eager chunk count toward startup bytes', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'index.html', '<main></main>');
    await writeFixture(root, 'assets/entry.js', 'export const app = true;');
    await writeFixture(root, 'assets/logo.svg', '<svg></svg>'.repeat(100));
    await writeFixture(root, '.vite/manifest.json', JSON.stringify(
      viteManifest({ assets: ['assets/logo.svg'] })
    ));

    const report = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });
    const logoBytes = Buffer.byteLength('<svg></svg>'.repeat(100));

    assert.ok(report.measurements.eagerStaticBytes >= logoBytes);
    assert.ok(report.largestEagerFiles.some((file) => file.path === 'assets/logo.svg'));
  });
});

test('malformed Vite manifest fails closed instead of silently treating lazy files as safe', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, '.vite/manifest.json', '{');
    await assert.rejects(
      analyzeBuildDirectory(root),
      /Unable to analyze Vite eager graph/
    );
  });
});

test('manifest without an application entry fails closed', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, '.vite/manifest.json', JSON.stringify({
      _lazy: { file: 'assets/lazy.js', isDynamicEntry: true }
    }));
    await assert.rejects(
      analyzeBuildDirectory(root),
      /does not contain an application entry/
    );
  });
});

test('largest JavaScript measurement is based on compressed transfer size', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/repetitive.js', 'a'.repeat(10000));
    await writeFixture(
      root,
      'static/js/randomish.js',
      Array.from({ length: 1000 }, (_, index) => `v${index}=${index};`).join('')
    );

    const report = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });

    assert.ok(report.measurements.largestJavaScriptPath);
    const largest = report.largestFiles.find(
      (file) => file.path === report.measurements.largestJavaScriptPath
    );
    assert.ok(largest);
    assert.equal(largest.gzipBytes, report.measurements.largestJavaScriptGzipBytes);
  });
});

test('report can fail eager startup bytes while full artifact budget still passes', async () => {
  await withFixture(async (root) => {
    const payload = 'const x = "startup";'.repeat(1000);
    await writeFixture(root, 'index.html', '<div></div>');
    await writeFixture(root, 'assets/entry.js', payload);
    await writeFixture(root, '.vite/manifest.json', JSON.stringify(viteManifest()));

    const baseline = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });
    const report = await analyzeBuildDirectory(root, {
      budgets: {
        ...unlimitedBudgets(),
        eagerStaticBytes: baseline.measurements.eagerStaticBytes - 1,
        totalStaticBytes: baseline.measurements.totalStaticBytes
      }
    });

    assert.equal(report.pass, false);
    assert.equal(
      report.checks.find((check) => check.metric === 'eagerStaticBytes')?.pass,
      false
    );
    assert.equal(
      report.checks.find((check) => check.metric === 'totalStaticBytes')?.pass,
      true
    );
    assert.equal(report.checks.filter((check) => !check.pass).length, 1);
  });
});

test('report can fail deploy artifact bytes without mislabelling eager startup', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'index.html', '<div></div>');
    await writeFixture(root, 'assets/entry.js', 'export const app = 1;');
    await writeFixture(root, 'assets/lazy.bin', 'x'.repeat(5000));
    await writeFixture(root, '.vite/manifest.json', JSON.stringify(viteManifest()));

    const baseline = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });
    const report = await analyzeBuildDirectory(root, {
      budgets: {
        ...unlimitedBudgets(),
        eagerStaticBytes: baseline.measurements.eagerStaticBytes,
        totalStaticBytes: baseline.measurements.totalStaticBytes - 1
      }
    });

    assert.equal(report.pass, false);
    assert.equal(
      report.checks.find((check) => check.metric === 'eagerStaticBytes')?.pass,
      true
    );
    assert.equal(
      report.checks.find((check) => check.metric === 'totalStaticBytes')?.pass,
      false
    );
  });
});

test('report fails only the exceeded JavaScript transfer budget while retaining all measurements', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'const x = 1;'.repeat(500));
    const baseline = await analyzeBuildDirectory(root, { budgets: unlimitedBudgets() });

    const report = await analyzeBuildDirectory(root, {
      budgets: {
        ...unlimitedBudgets(),
        totalJavaScriptGzipBytes: Math.max(
          0,
          baseline.measurements.totalJavaScriptGzipBytes - 1
        )
      }
    });

    assert.equal(report.pass, false);
    const jsCheck = report.checks.find(
      (check) => check.metric === 'totalJavaScriptGzipBytes'
    );
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
      eagerStaticBytes: 0,
      lazyStaticBytes: 0,
      totalStaticBytes: 0,
      sourceMapBytes: 0,
      eagerFileCount: 0,
      lazyFileCount: 0,
      viteManifestUsed: false
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

test('environment values override startup and deploy budgets independently', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'static/js/main.js', 'console.log(1);'.repeat(20));
    const report = await analyzeBuildDirectory(root, {
      environment: {
        WEB_BUDGET_JS_GZIP_BYTES: '1',
        WEB_BUDGET_LARGEST_JS_GZIP_BYTES: String(
          DEFAULT_WEB_BUILD_BUDGETS.largestJavaScriptGzipBytes
        ),
        WEB_BUDGET_CSS_GZIP_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.totalCssGzipBytes),
        WEB_BUDGET_EAGER_BYTES: '12345',
        WEB_BUDGET_TOTAL_BYTES: '23456',
        WEB_BUDGET_SOURCEMAP_BYTES: String(DEFAULT_WEB_BUILD_BUDGETS.sourceMapBytes)
      }
    });

    assert.equal(report.budgets.totalJavaScriptGzipBytes, 1);
    assert.equal(report.budgets.eagerStaticBytes, 12345);
    assert.equal(report.budgets.totalStaticBytes, 23456);
    assert.equal(report.pass, false);
  });
});

test('invalid environment values fall back to safe defaults', async () => {
  await withFixture(async (root) => {
    const report = await analyzeBuildDirectory(root, {
      environment: {
        WEB_BUDGET_JS_GZIP_BYTES: 'not-a-number',
        WEB_BUDGET_EAGER_BYTES: '-1',
        WEB_BUDGET_TOTAL_BYTES: '-1'
      }
    });
    assert.equal(
      report.budgets.totalJavaScriptGzipBytes,
      DEFAULT_WEB_BUILD_BUDGETS.totalJavaScriptGzipBytes
    );
    assert.equal(
      report.budgets.eagerStaticBytes,
      DEFAULT_WEB_BUILD_BUDGETS.eagerStaticBytes
    );
    assert.equal(
      report.budgets.totalStaticBytes,
      DEFAULT_WEB_BUILD_BUDGETS.totalStaticBytes
    );
  });
});

test('largestFiles and largestEagerFiles are capped and sorted by raw size', async () => {
  await withFixture(async (root) => {
    for (let index = 1; index <= 30; index += 1) {
      await writeFixture(root, `media/${index}.txt`, 'x'.repeat(index));
    }
    const report = await analyzeBuildDirectory(root);
    assert.equal(report.largestFiles.length, 20);
    assert.equal(report.largestEagerFiles.length, 20);
    assert.ok(report.largestFiles[0].bytes >= report.largestFiles[19].bytes);
    assert.ok(
      report.largestEagerFiles[0].bytes >= report.largestEagerFiles[19].bytes
    );
  });
});

test('markdown distinguishes eager startup and full deploy artifact budgets', async () => {
  await withFixture(async (root) => {
    await writeFixture(root, 'index.html', '<div></div>');
    await writeFixture(root, 'assets/entry.js', 'console.log("budget")');
    await writeFixture(root, 'assets/lazy.js', 'export const lazy = true;');
    await writeFixture(root, '.vite/manifest.json', JSON.stringify(
      viteManifest({ dynamicImports: ['_lazy'] })
    ));
    await writeFixture(root, 'assets/lazy.js', 'export const lazy = true;');
    const manifestPath = path.join(root, '.vite', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest._lazy = { file: 'assets/lazy.js', isDynamicEntry: true };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const report = await analyzeBuildDirectory(root);
    const markdown = formatBuildBudgetMarkdown(report);

    assert.match(markdown, /Web production build budget/);
    assert.match(markdown, /Overall: \*\*PASS\*\*/);
    assert.match(markdown, /eagerStaticBytes/);
    assert.match(markdown, /totalStaticBytes/);
    assert.match(markdown, /Vite manifest startup graph: \*\*enabled\*\*/);
    assert.match(markdown, /Largest eager startup assets/);
    assert.match(markdown, /Largest production artifacts/);
    assert.match(markdown, /assets\/entry\.js/);
  });
});
