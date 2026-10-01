import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  auditBrowserRuntimeBoundary,
  classifyRuntimePackage,
  formatBrowserRuntimeBoundaryMarkdown,
} from './browser-runtime-boundary.mjs';

const manifest = Object.freeze({
  dependencies: Object.freeze({
    react: '^19.3.0',
    axios: '^1.20.0',
    '@arcgis/core': '5.1.24',
    'crypto-js': '^4.2.0',
  }),
  devDependencies: Object.freeze({
    vite: '^8.3.0',
    vitest: '^5.0.1',
    typescript: '^7.0.2',
  }),
});

const fixture = async (files, packageJson = manifest) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-browser-boundary-'));
  const all = {
    'Webclient.app/package.json': JSON.stringify(packageJson),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return root;
};

const withFixture = async (files, callback, packageJson = manifest) => {
  const root = await fixture(files, packageJson);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const codes = (report) => new Set(report.findings.map((item) => item.code));

test('classifies declared runtime dependency', () => {
  assert.deepEqual(classifyRuntimePackage('react', manifest), {
    kind: 'dependency',
    packageName: 'react',
  });
});

test('classifies scoped package subpath by package root', () => {
  assert.deepEqual(classifyRuntimePackage('@arcgis/core/Map.js', manifest), {
    kind: 'dependency',
    packageName: '@arcgis/core',
  });
});

test('classifies ordinary package subpath by package root', () => {
  assert.deepEqual(classifyRuntimePackage('axios/lib/adapters/xhr.js', manifest), {
    kind: 'dependency',
    packageName: 'axios',
  });
});

test('classifies dev dependency separately', () => {
  assert.deepEqual(classifyRuntimePackage('vite', manifest), {
    kind: 'dev-dependency',
    packageName: 'vite',
  });
});

test('classifies undeclared package', () => {
  assert.deepEqual(classifyRuntimePackage('left-pad', manifest), {
    kind: 'undeclared',
    packageName: 'left-pad',
  });
});

test('classifies node-prefixed builtin', () => {
  assert.deepEqual(classifyRuntimePackage('node:fs', manifest), {
    kind: 'node-builtin',
    packageName: 'node:fs',
  });
});

test('classifies bare Node builtin', () => {
  const result = classifyRuntimePackage('path', manifest);
  assert.equal(result.kind, 'node-builtin');
  assert.equal(result.packageName, 'path');
});

test('relative imports are not package dependencies', () => {
  assert.deepEqual(classifyRuntimePackage('../runtime', manifest), {
    kind: 'not-package',
    packageName: null,
  });
});

test('absolute browser paths are not package dependencies', () => {
  assert.deepEqual(classifyRuntimePackage('/images/icon.svg', manifest), {
    kind: 'not-package',
    packageName: null,
  });
});

test('clean production dependency imports pass', async () => {
  await withFixture({
    'Webclient.app/src/App.tsx': [
      "import React from 'react';",
      "import axios from 'axios';",
      "import Map from '@arcgis/core/Map.js';",
      "import './styles.css';",
      'export { React, axios, Map };',
    ].join('\n'),
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.productionFiles, 1);
    assert.equal(report.summary.externalPackageImports, 3);
    assert.ok(!codes(report).has('undeclared-browser-dependency'));
  });
});

test('Node builtin import fails browser runtime gate', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/bad.ts': "import fs from 'node:fs'; export { fs };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'node-builtin-in-browser');
    assert.equal(item?.severity, 'error');
    assert.equal(item?.detail?.specifier, 'node:fs');
    assert.equal(report.summary.passed, false);
  });
});

test('bare Node builtin import also fails', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import path from 'path'; export { path };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('node-builtin-in-browser'));
  });
});

test('devDependency cannot be imported by production browser source', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import { defineConfig } from 'vite'; export { defineConfig };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) =>
      finding.code === 'dev-dependency-in-browser-runtime');
    assert.equal(item?.detail?.packageName, 'vite');
    assert.equal(report.summary.passed, false);
  });
});

test('undeclared production package import fails closed', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import leftPad from 'left-pad'; export { leftPad };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) =>
      finding.code === 'undeclared-browser-dependency');
    assert.equal(item?.detail?.packageName, 'left-pad');
  });
});

test('remote http executable import is rejected', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import runtime from 'https://cdn.example.com/runtime.js'; export { runtime };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'remote-executable-import');
    assert.equal(item?.severity, 'error');
    assert.match(item?.detail?.specifier || '', /^https:/);
  });
});

test('data URL dynamic import is rejected', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "export const load = () => import('data:text/javascript,export default 1');",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('remote-executable-import'));
  });
});

test('blob URL static-like import string is rejected by scheme policy', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "export const load = () => import('blob:https://example.com/id');",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('remote-executable-import'));
  });
});

test('arbitrary process.env access fails', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': 'export const api = process.env.REACT_APP_API_URL;',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'browser-process-env');
    assert.equal(item?.detail?.reference, 'process.env.REACT_APP_API_URL');
  });
});

test('bounded PUBLIC_URL compatibility bridge remains allowed', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': 'export const base = process.env.PUBLIC_URL;',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(!codes(report).has('browser-process-env'));
    assert.equal(report.summary.passed, true);
  });
});

test('multiple process.env references are de-duplicated per file', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': [
      'const a = process.env.SECRET;',
      'const b = process.env.SECRET;',
      'export { a, b };',
    ].join('\n'),
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(
      report.findings.filter((finding) => finding.code === 'browser-process-env').length,
      1,
    );
  });
});

test('dynamic eval is blocking', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': 'export const run = (input) => eval(input);',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('browser-dynamic-code'));
  });
});

test('new Function is blocking', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': 'export const run = (input) => new Function(input)();',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('browser-dynamic-code'));
  });
});

test('CommonJS in Platform production is error', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/legacy.js': "const x = require('react'); module.exports = x;",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'browser-commonjs');
    assert.equal(item?.severity, 'error');
  });
});

test('CommonJS outside Platform remains visible as warning during staged migration', async () => {
  await withFixture({
    'Webclient.app/src/Business/legacy.js': "const x = require('react'); module.exports = x;",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'browser-commonjs');
    assert.equal(item?.severity, 'warning');
    assert.equal(report.summary.passed, true);
  });
});

test('test files are excluded from browser production dependency policy', async () => {
  await withFixture({
    'Webclient.app/src/App.test.ts': [
      "import { describe } from 'vitest';",
      "import fs from 'node:fs';",
      'describe("x", () => {});',
      'export { fs };',
    ].join('\n'),
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.productionFiles, 0);
    assert.equal(report.summary.passed, true);
    assert.deepEqual(report.findings.filter((item) => item.severity === 'error'), []);
  });
});

test('fixtures and mocks are excluded from production scan', async () => {
  await withFixture({
    'Webclient.app/src/fixtures/runtime.ts': "import fs from 'node:fs'; export { fs };",
    'Webclient.app/src/__tests__/runtime.ts': "import fs from 'node:fs'; export { fs };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.productionFiles, 0);
  });
});

test('package usage aggregates imports and distinct files', async () => {
  await withFixture({
    'Webclient.app/src/a.ts': "import React from 'react'; export { React };",
    'Webclient.app/src/b.ts': "import React from 'react'; import { useState } from 'react'; export { React, useState };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const react = report.packageUsage.find((item) => item.packageName === 'react');
    assert.equal(react?.imports, 3);
    assert.deepEqual(react?.files, [
      'Webclient.app/src/a.ts',
      'Webclient.app/src/b.ts',
    ]);
  });
});

test('scoped package usage aggregates subpaths under one package', async () => {
  await withFixture({
    'Webclient.app/src/a.ts': [
      "import Map from '@arcgis/core/Map.js';",
      "import Point from '@arcgis/core/geometry/Point.js';",
      'export { Map, Point };',
    ].join('\n'),
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const arcgis = report.packageUsage.find((item) => item.packageName === '@arcgis/core');
    assert.equal(arcgis?.imports, 2);
    assert.equal(report.packageUsage.filter((item) => item.packageName.startsWith('@arcgis/core')).length, 1);
  });
});

test('declared dependency not observed by static imports is informational', async () => {
  await withFixture({
    'Webclient.app/src/a.ts': "import React from 'react'; export { React };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(report.declaredButUnused.includes('axios'));
    assert.ok(report.findings.some((finding) =>
      finding.code === 'declared-runtime-dependency-not-seen'
      && finding.detail?.packageName === 'axios'
      && finding.severity === 'info'));
    assert.equal(report.summary.passed, true);
  });
});

test('domain inventory counts production files by architecture area', async () => {
  await withFixture({
    'Webclient.app/src/Business/a.ts': 'export {};',
    'Webclient.app/src/Components/a.tsx': 'export {};',
    'Webclient.app/src/Core/a.ts': 'export {};',
    'Webclient.app/src/Store/a.ts': 'export {};',
    'Webclient.app/src/Toolbox/a.ts': 'export {};',
    'Webclient.app/src/data-search/a.ts': 'export {};',
    'Webclient.app/src/experience/a.ts': 'export {};',
    'Webclient.app/src/gis-engine/a.ts': 'export {};',
    'Webclient.app/src/platform/a.ts': 'export {};',
    'Webclient.app/src/App.tsx': 'export {};',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.deepEqual(report.domainFiles.map((item) => item.domain), [
      'business',
      'components',
      'core',
      'data-search',
      'experience',
      'gis',
      'platform',
      'store',
      'toolbox',
      'web-root',
    ]);
    assert.ok(report.domainFiles.every((item) => item.files === 1));
  });
});

test('relative CSS side-effect import does not become package usage', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import './styles.css'; export {};",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.externalPackageImports, 0);
    assert.deepEqual(report.packageUsage, []);
  });
});

test('package subpath with CSS is still attributed to declared package', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import 'react/some-runtime.css'; export {};",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.packageUsage[0]?.packageName, 'react');
    assert.equal(report.packageUsage[0]?.classification, 'dependency');
  });
});

test('hash import maps are not misclassified as package dependencies', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import config from '#config'; export { config };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.externalPackageImports, 0);
  });
});

test('file URL import is rejected', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "export const load = () => import('file:///tmp/runtime.js');",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(codes(report).has('remote-executable-import'));
  });
});

test('https package-like value is not double-counted as undeclared package', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "export const load = () => import('https://example.com/pkg');",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.findings.filter((item) => item.code === 'remote-executable-import').length, 1);
    assert.equal(report.findings.filter((item) => item.code === 'undeclared-browser-dependency').length, 0);
  });
});

test('multiple violations retain deterministic file ordering', async () => {
  await withFixture({
    'Webclient.app/src/z.ts': "import fs from 'node:fs'; export { fs };",
    'Webclient.app/src/a.ts': "import path from 'node:path'; export { path };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const files = report.findings
      .filter((item) => item.code === 'node-builtin-in-browser')
      .map((item) => item.file);
    assert.deepEqual(files, [
      'Webclient.app/src/a.ts',
      'Webclient.app/src/z.ts',
    ]);
  });
});

test('summary counts error warning and info independently', async () => {
  await withFixture({
    'Webclient.app/src/platform/runtime/a.ts': "import fs from 'node:fs'; export { fs };",
    'Webclient.app/src/Business/legacy.js': "module.exports = require('react');",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.ok(report.summary.errors >= 1);
    assert.ok(report.summary.warnings >= 1);
    assert.ok(report.summary.infos >= 1);
    assert.equal(report.summary.passed, false);
  });
});

test('markdown includes package usage, findings and unused dependency section', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import React from 'react'; export { React };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const markdown = formatBrowserRuntimeBoundaryMarkdown(report);
    assert.match(markdown, /Browser Runtime Boundary/);
    assert.match(markdown, /Gate: \*\*PASS\*\*/);
    assert.match(markdown, /Runtime package usage/);
    assert.match(markdown, /Declared runtime dependencies not seen/);
    assert.match(markdown, /react/);
    assert.match(markdown, /axios/);
  });
});

test('empty browser source tree passes while reporting unused runtime dependencies', async () => {
  await withFixture({}, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.productionFiles, 0);
    assert.equal(report.summary.externalPackageImports, 0);
    assert.equal(report.declaredButUnused.length, Object.keys(manifest.dependencies).length);
  });
});

test('custom manifest can be injected without package.json classification drift', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import custom from 'custom-runtime'; export { custom };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root, {
      manifest: {
        dependencies: { 'custom-runtime': '1.0.0' },
        devDependencies: {},
      },
    });
    assert.equal(report.summary.passed, true);
    assert.equal(report.packageUsage[0]?.classification, 'dependency');
  });
});

test('undeclared scoped package uses complete scope/name identity', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import x from '@private/runtime/subpath'; export { x };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    const item = report.findings.find((finding) => finding.code === 'undeclared-browser-dependency');
    assert.equal(item?.detail?.packageName, '@private/runtime');
  });
});

test('same file can use runtime dependencies and relative modules without false findings', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': [
      "import React from 'react';",
      "import { local } from './local';",
      'export { React, local };',
    ].join('\n'),
    'Webclient.app/src/local.ts': 'export const local = 1;',
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.externalPackageImports, 1);
  });
});

test('query and fragment package specifiers remain package-root classified', () => {
  assert.equal(classifyRuntimePackage('react/jsx-runtime', manifest).packageName, 'react');
  assert.equal(classifyRuntimePackage('@arcgis/core/Map.js', manifest).packageName, '@arcgis/core');
});

test('browser runtime report stays immutable at top-level collection boundaries', async () => {
  await withFixture({
    'Webclient.app/src/App.ts': "import React from 'react'; export { React };",
  }, async (root) => {
    const report = await auditBrowserRuntimeBoundary(root);
    assert.equal(Object.isFrozen(report.packageUsage), true);
    assert.equal(Object.isFrozen(report.findings), true);
    assert.equal(Object.isFrozen(report.domainFiles), true);
    assert.equal(Object.isFrozen(report.summary), true);
  });
});
