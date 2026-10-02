import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditBrowserRuntimeGovernance,
  auditModernizationPlatform,
} from './modernization-platform-audit.mts';
import {
  fixtureInventory,
  type FixtureFileInput,
} from './test-helpers.mts';

function manifest(
  dependencies: Readonly<Record<string, string>> = {},
  devDependencies: Readonly<Record<string, string>> = {},
): FixtureFileInput {
  return {
    path: 'Webclient.app/package.json',
    text: JSON.stringify({
      name: 'kent-rehberi-web',
      version: '1.0.0',
      type: 'module',
      engines: { node: '>=24', npm: '>=11' },
      dependencies,
      devDependencies,
      scripts: { build: 'vite build', test: 'vitest run' },
    }, null, 2),
  };
}

function source(path: string, text: string): FixtureFileInput {
  return { path: `Webclient.app/src/${path}`, text };
}

function runtimeAudit(files: readonly FixtureFileInput[]) {
  return auditBrowserRuntimeGovernance(fixtureInventory(files));
}

function findingIds(files: readonly FixtureFileInput[]): readonly string[] {
  return runtimeAudit(files).findings.map(item => item.id);
}

test('accepts declared ESM runtime dependencies', () => {
  const result = runtimeAudit([
    manifest({ react: '^19.3.0' }),
    source('App.tsx', "import React from 'react';\nexport const App = () => <main />;\n"),
  ]);
  assert.equal(result.summary.packageCount, 1);
  assert.equal(result.summary.sourceFiles, 1);
  assert.equal(result.findings.length, 0);
});

test('blocks remote executable browser imports', () => {
  const result = runtimeAudit([
    manifest(),
    source('remote.ts', "export const load = () => import('https://cdn.example.test/runtime.mjs');\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-remote-executable-import');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
  assert.equal(finding.domain, 'security');
});

test('blocks Node builtins from browser source', () => {
  const result = runtimeAudit([
    manifest(),
    source('node-only.ts', "import { readFile } from 'node:fs';\nexport { readFile };\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-node-builtin');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('blocks dynamically constructed browser code', () => {
  const result = runtimeAudit([
    manifest(),
    source('dynamic.ts', "export const execute = (value: string) => new Function('return ' + value)();\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-dynamic-code');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('reports CommonJS contracts as a typed migration risk', () => {
  const result = runtimeAudit([
    manifest({ legacy: '1.0.0' }),
    source('legacy.ts', "const legacy = require('legacy');\nexport { legacy };\n"),
  ]);
  const ids = result.findings.map(item => item.id);
  assert.ok(ids.includes('modernization-browser-commonjs'));
});

test('blocks undeclared runtime packages', () => {
  const result = runtimeAudit([
    manifest(),
    source('missing.ts', "import missing from 'missing-runtime';\nexport { missing };\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-undeclared-dependency');
  assert.ok(finding);
  assert.equal(finding.domain, 'dependencies');
  assert.equal(finding.blocking, true);
});

test('reports development-only packages consumed by runtime source', () => {
  const result = runtimeAudit([
    manifest({}, { helper: '1.0.0' }),
    source('helper.ts', "import helper from 'helper';\nexport { helper };\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-dev-dependency');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.domain, 'dependencies');
});

test('reports direct process.env access outside the public compatibility allowlist', () => {
  const result = runtimeAudit([
    manifest(),
    source('config.ts', "export const endpoint = process.env.API_ENDPOINT;\n"),
  ]);
  const finding = result.findings.find(item => item.id === 'modernization-browser-process-env');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
  assert.equal(finding.domain, 'architecture');
});

test('keeps the bounded PUBLIC_URL compatibility contract', () => {
  const result = runtimeAudit([
    manifest(),
    source('public-url.ts', "export const base = process.env.PUBLIC_URL;\n"),
  ]);
  assert.equal(result.findings.some(item => item.id === 'modernization-browser-process-env'), false);
});

test('ignores test and fixture source when evaluating production runtime imports', () => {
  const result = runtimeAudit([
    manifest(),
    source('feature.test.ts', "import fs from 'node:fs';\nvoid fs;\n"),
    source('__tests__/feature.ts', "import fs from 'node:fs';\nvoid fs;\n"),
    source('fixtures/feature.ts', "import fs from 'node:fs';\nvoid fs;\n"),
  ]);
  assert.equal(result.summary.sourceFiles, 0);
  assert.equal(result.findings.length, 0);
});

test('supports multiple package roots without leaking dependency authority', () => {
  const adminManifest: FixtureFileInput = {
    path: 'Webclient.admin/AdminWebClientFrontend/package.json',
    text: JSON.stringify({
      name: 'admin-web',
      type: 'module',
      dependencies: { '@admin/runtime': '1.0.0' },
      devDependencies: {},
    }),
  };
  const result = auditBrowserRuntimeGovernance(fixtureInventory([
    manifest({ '@public/runtime': '1.0.0' }),
    source('public.ts', "import runtime from '@public/runtime';\nexport { runtime };\n"),
    adminManifest,
    {
      path: 'Webclient.admin/AdminWebClientFrontend/src/admin.ts',
      text: "import runtime from '@admin/runtime';\nexport { runtime };\n",
    },
  ]));
  assert.equal(result.summary.packageCount, 2);
  assert.equal(result.summary.sourceFiles, 2);
  assert.equal(result.findings.length, 0);
});

test('does not let one package use another package dependency declaration', () => {
  const adminManifest: FixtureFileInput = {
    path: 'Webclient.admin/AdminWebClientFrontend/package.json',
    text: JSON.stringify({ name: 'admin-web', type: 'module', dependencies: {}, devDependencies: {} }),
  };
  const result = auditBrowserRuntimeGovernance(fixtureInventory([
    manifest({ '@public/runtime': '1.0.0' }),
    adminManifest,
    {
      path: 'Webclient.admin/AdminWebClientFrontend/src/admin.ts',
      text: "import runtime from '@public/runtime';\nexport { runtime };\n",
    },
  ]));
  assert.ok(result.findings.some(item => item.id === 'modernization-browser-undeclared-dependency'));
});

test('deduplicates runtime findings deterministically', () => {
  const files = [
    manifest(),
    source('unsafe.ts', "import fs from 'node:fs';\nexport const run = () => eval('1 + 1');\nvoid fs;\n"),
  ] as const;
  const first = runtimeAudit(files).findings;
  const second = runtimeAudit(files).findings;
  assert.deepEqual(
    first.map(item => ({ id: item.id, severity: item.severity, file: item.location?.file, line: item.location?.line })),
    second.map(item => ({ id: item.id, severity: item.severity, file: item.location?.file, line: item.location?.line })),
  );
});

test('integrated platform audit exposes all modernization authorities', () => {
  const result = auditModernizationPlatform(fixtureInventory([
    manifest({ react: '^19.3.0' }),
    source('App.tsx', "import React from 'react';\nexport const App = () => <main />;\n"),
  ]));
  const ids = result.summary.components.map(item => item.id);
  assert.deepEqual(ids, [
    'toolchain',
    'tooling-language',
    'node-execution',
    'package-scripts',
    'package-lock',
    'artifact-downloads',
    'cache-provenance',
    'browser-runtime',
    'page-usability',
  ]);
  assert.equal(result.summary.componentCount, 9);
  assert.equal(result.summary.browserRuntimeFiles, 1);
  assert.ok(result.summary.packageLockFiles >= 0);
});

test('integrated platform audit propagates blocking browser findings', () => {
  const result = auditModernizationPlatform(fixtureInventory([
    manifest(),
    source('unsafe.ts', "import fs from 'node:fs';\nvoid fs;\n"),
  ]));
  assert.ok(result.findings.some(item => item.id === 'modernization-browser-node-builtin'));
  assert.ok(result.summary.blockingFindingCount > 0);
  assert.equal(result.summary.findingCount, result.findings.length);
});

test('integrated platform findings remain stably ordered between runs', () => {
  const inventory = fixtureInventory([
    manifest(),
    source('unsafe.ts', "import fs from 'node:fs';\nexport const x = process.env.INTERNAL_TOKEN;\nvoid fs;\n"),
  ]);
  const first = auditModernizationPlatform(inventory).findings;
  const second = auditModernizationPlatform(inventory).findings;
  assert.deepEqual(
    first.map(item => `${item.severity}:${item.domain}:${item.id}:${item.location?.file ?? ''}:${item.location?.line ?? 0}`),
    second.map(item => `${item.severity}:${item.domain}:${item.id}:${item.location?.file ?? ''}:${item.location?.line ?? 0}`),
  );
});

test('browser runtime result IDs are unique per detected contract', () => {
  const ids = findingIds([
    manifest({}, { helper: '1.0.0' }),
    source('mixed.ts', "import fs from 'node:fs';\nimport helper from 'helper';\nimport missing from 'missing';\nexport const value = process.env.INTERNAL;\nvoid fs; void helper; void missing;\n"),
  ]);
  assert.equal(new Set(ids).size, ids.length);
});
