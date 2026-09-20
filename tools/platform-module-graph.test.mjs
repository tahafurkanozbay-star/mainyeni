import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlatformModuleGraph,
  extractModuleSpecifiers,
  formatPlatformModuleGraphMarkdown,
} from './platform-module-graph.mjs';

const fixture = async (files) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-platform-module-graph-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return root;
};

const withFixture = async (files, callback) => {
  const root = await fixture(files);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const findingCodes = (report) => new Set(report.findings.map((item) => item.code));

test('extractModuleSpecifiers parses static, side-effect, re-export, dynamic and require imports', () => {
  const source = [
    "import type { A } from './a';",
    "import { b } from './b';",
    "import './side';",
    "export { c } from './c';",
    "export type { D } from './d';",
    "const lazy = import('./lazy');",
    "const legacy = require('./legacy');",
  ].join('\n');
  assert.deepEqual(
    extractModuleSpecifiers(source).map((item) => item.specifier),
    ['./a', './b', './side', './c', './d', './lazy', './legacy'],
  );
});

test('extractModuleSpecifiers reports deterministic source lines', () => {
  const source = "import './a';\n\nimport('./b');\n";
  assert.deepEqual(
    extractModuleSpecifiers(source).map((item) => [item.specifier, item.line]),
    [['./a', 1], ['./b', 3]],
  );
});

test('clean typed Platform fixture passes', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import { b } from './b'; export const a = b;",
    'Webclient.app/src/platform/runtime/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.errors, 0);
    assert.equal(report.summary.duplicateTypedJavascriptStems, 0);
    assert.equal(report.summary.languages.platformTypescript, 2);
    assert.equal(report.summary.languages.platformJavascript, 0);
    assert.equal(report.edges.length, 1);
  });
});

test('JS and TS production shadow pair is blocking in Platform', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': 'export const a = 1;',
    'Webclient.app/src/platform/runtime/a.js': 'export const a = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.passed, false);
    assert.equal(report.summary.duplicateTypedJavascriptStems, 1);
    assert.ok(report.findings.some((item) =>
      item.code === 'typed-javascript-shadow' && item.severity === 'error'));
  });
});

test('shadow pair outside Platform remains visible as warning', async () => {
  await withFixture({
    'Webclient.app/src/Feature/a.ts': 'export const a = 1;',
    'Webclient.app/src/Feature/a.js': 'export const a = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const duplicate = report.findings.find((item) => item.code === 'typed-javascript-shadow');
    assert.equal(duplicate?.severity, 'warning');
    assert.equal(report.summary.passed, true);
  });
});

test('legacy Platform production JS is blocking unless explicitly allowlisted', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/legacy.js': 'export const legacy = true;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.ok(findingCodes(report).has('legacy-platform-javascript'));
    assert.equal(report.summary.passed, false);
  });
});

test('typed bootstrapApplication composition is production-language compliant', async () => {
  await withFixture({
    'Webclient.app/src/platform/bootstrap/bootstrapApplication.ts': 'export const bootstrapApplication = (): null => null;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.errors, 0);
    assert.ok(!report.findings.some((finding) =>
      finding.code === 'legacy-platform-javascript'
      || finding.code === 'legacy-platform-javascript-allowlisted'));
    assert.equal(report.summary.passed, true);
  });
});

test('test JavaScript does not violate production Platform JS policy', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/runtime.test.js': "import { runtime } from './runtime';",
    'Webclient.app/src/platform/runtime/runtime.ts': 'export const runtime = true;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.languages.tests, 1);
    assert.ok(!findingCodes(report).has('legacy-platform-javascript'));
  });
});

test('ambiguous extensionless relative import is blocking', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import { x } from './dep'; export { x };",
    'Webclient.app/src/platform/runtime/dep.ts': 'export const x = 1;',
    'Webclient.app/src/platform/runtime/dep.js': 'export const x = 2;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const item = report.findings.find((finding) => finding.code === 'ambiguous-relative-import');
    assert.equal(item?.severity, 'error');
    assert.deepEqual(item?.detail?.candidates, [
      'Webclient.app/src/platform/runtime/dep.ts',
      'Webclient.app/src/platform/runtime/dep.js',
    ].sort());
  });
});

test('direct module versus index module ambiguity is blocking', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import { x } from './dep'; export { x };",
    'Webclient.app/src/platform/runtime/dep.ts': 'export const x = 1;',
    'Webclient.app/src/platform/runtime/dep/index.ts': 'export const x = 2;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const item = report.findings.find((finding) => finding.code === 'ambiguous-relative-import');
    assert.ok(item);
    assert.equal(item.detail.candidates.length, 2);
  });
});

test('explicit TypeScript import resolves one internal edge', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import { x } from './dep.ts'; export { x };",
    'Webclient.app/src/platform/runtime/dep.ts': 'export const x = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.errors, 0);
    assert.equal(report.edges.length, 1);
    assert.equal(report.edges[0].imported, 'Webclient.app/src/platform/runtime/dep.ts');
  });
});

test('unresolved source import is warning rather than destructive blocker', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import { x } from './missing'; export { x };",
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const item = report.findings.find((finding) => finding.code === 'unresolved-relative-import');
    assert.equal(item?.severity, 'warning');
    assert.equal(report.summary.passed, true);
  });
});

test('non-source asset imports are not reported as unresolved source debt', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import './app.css'; export {};",
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.ok(!findingCodes(report).has('unresolved-relative-import'));
  });
});

test('external package imports are cataloged without being resolved as repository edges', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "import React from 'react'; import Map from '@arcgis/core/Map.js'; export { React, Map };",
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.externalImports.length, 2);
    assert.equal(report.edges.length, 0);
    assert.equal(report.summary.externalImports, 2);
  });
});

test('TypeScript diagnostic opt-outs block Platform production code', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': '// @ts-nocheck\nexport const a = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const item = report.findings.find((finding) => finding.code === 'typescript-opt-out');
    assert.equal(item?.severity, 'error');
    assert.equal(item?.detail?.count, 1);
  });
});

test('TypeScript opt-outs inside tests do not become production gate findings', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.test.ts': '// @ts-ignore\nexport const a = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.ok(!findingCodes(report).has('typescript-opt-out'));
  });
});

test('CommonJS blocks Platform production runtime', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/app.ts': "const x = require('./x'); module.exports = x;",
    'Webclient.app/src/platform/runtime/x.ts': 'export const x = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const item = report.findings.find((finding) => finding.code === 'platform-commonjs');
    assert.equal(item?.severity, 'error');
    assert.ok(Number(item?.detail?.count) >= 2);
  });
});

test('explicit JavaScript import is blocking when typed sibling exists', async () => {
  await withFixture({
    'Webclient.app/src/Feature/app.ts': "import { x } from './dep.js'; export { x };",
    'Webclient.app/src/Feature/dep.js': 'export const x = 1;',
    'Webclient.app/src/Feature/dep.ts': 'export const x = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.ok(findingCodes(report).has('explicit-legacy-import-shadows-typed'));
  });
});

test('two-node production cycle is reported deterministically', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import { b } from './b'; export const a = b;",
    'Webclient.app/src/platform/runtime/b.ts': "import { a } from './a'; export const b = a;",
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.cycles.length, 1);
    assert.deepEqual(report.cycles[0], [
      'Webclient.app/src/platform/runtime/a.ts',
      'Webclient.app/src/platform/runtime/b.ts',
    ]);
    const item = report.findings.find((finding) => finding.code === 'dependency-cycle');
    assert.equal(item?.severity, 'warning');
    assert.equal(report.summary.passed, true);
  });
});

test('test-only cycle is excluded from production cycle reporting', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.test.ts': "import { b } from './b.test'; export const a = b;",
    'Webclient.app/src/platform/runtime/b.test.ts': "import { a } from './a.test'; export const b = a;",
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.cycles.length, 0);
  });
});

test('domain boundary inventory records production dependency direction', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import { b } from '../../Core/b'; export const a = b;",
    'Webclient.app/src/Core/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.deepEqual(report.boundaries, [
      { boundary: 'platform -> core', count: 1 },
    ]);
  });
});

test('test edges do not pollute production boundary inventory', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.test.ts': "import { b } from '../../Core/b'; export const a = b;",
    'Webclient.app/src/Core/b.ts': 'export const b = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.deepEqual(report.boundaries, []);
  });
});

test('language summary distinguishes production and test source', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': 'export const a = 1;',
    'Webclient.app/src/platform/runtime/a.test.ts': 'export const testA = 1;',
    'Webclient.app/src/Feature/legacy.js': 'export const legacy = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.deepEqual(report.summary.languages, {
      typescript: 2,
      javascript: 1,
      tests: 1,
      production: 2,
      platformTypescript: 2,
      platformJavascript: 0,
    });
  });
});

test('findings are sorted deterministically independent of fixture write order', async () => {
  await withFixture({
    'Webclient.app/src/platform/z.js': 'module.exports = 1;',
    'Webclient.app/src/platform/a.js': 'module.exports = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const files = report.findings
      .filter((finding) => finding.code === 'legacy-platform-javascript')
      .map((finding) => finding.file);
    assert.deepEqual(files, [
      'Webclient.app/src/platform/a.js',
      'Webclient.app/src/platform/z.js',
    ]);
  });
});

test('markdown contains gate, language metrics, findings and boundary sections', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': 'export const a = 1;',
  }, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    const markdown = formatPlatformModuleGraphMarkdown(report);
    assert.match(markdown, /Platform Module Graph/);
    assert.match(markdown, /Gate: \*\*PASS\*\*/);
    assert.match(markdown, /Platform TypeScript \/ JavaScript files/);
    assert.match(markdown, /Duplicate typed \/ JavaScript stems/);
    assert.match(markdown, /Domain boundaries/);
    assert.match(markdown, /strict TypeScript\/native-ESM runtime/);
  });
});

test('report policy exposes an empty production JavaScript allowlist', async () => {
  await withFixture({}, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.deepEqual(report.policy.platformLegacyJavascriptAllowlist, []);
  });
});

test('empty source tree produces a passing deterministic report', async () => {
  await withFixture({}, async (root) => {
    const report = await buildPlatformModuleGraph(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.sourceFiles, 0);
    assert.deepEqual(report.files, []);
    assert.deepEqual(report.edges, []);
    assert.deepEqual(report.findings, []);
  });
});
