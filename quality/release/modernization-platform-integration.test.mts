import assert from 'node:assert/strict';
import test from 'node:test';
import { auditModernization } from './modernization-audit.mts';
import {
  directoryBuildProps,
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
      private: true,
      type: 'module',
      packageManager: 'npm@11.6.1',
      engines: { node: '>=24', npm: '>=11' },
      dependencies: {
        react: '^19.3.0',
        'react-dom': '^19.3.0',
        ...dependencies,
      },
      devDependencies: {
        typescript: '^7.0.0',
        vite: '^8.0.0',
        ...devDependencies,
      },
      scripts: {
        build: 'vite build',
        test: 'vitest run',
      },
    }, null, 2),
  };
}

function tsconfig(): FixtureFileInput {
  return {
    path: 'Webclient.app/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        useUnknownInCatchVariables: true,
      },
    }, null, 2),
  };
}

function source(path: string, text: string): FixtureFileInput {
  return { path: `Webclient.app/src/${path}`, text };
}

function base(extra: readonly FixtureFileInput[] = []) {
  return fixtureInventory([
    manifest(),
    tsconfig(),
    directoryBuildProps('enable'),
    ...extra,
  ]);
}

test('canonical modernization summary exposes integrated platform governance', () => {
  const result = auditModernization(base([
    source('App.tsx', "import React from 'react';\nexport const App = () => <main>Ready</main>;\n"),
  ]));

  assert.equal(result.summary.platformGovernance.componentCount, 9);
  assert.ok(result.summary.platformGovernance.components.some(item => item.id === 'browser-runtime'));
  assert.ok(result.summary.platformGovernance.components.some(item => item.id === 'page-usability'));
  assert.equal(result.summary.platformGovernance.findingCount, result.summary.platformGovernance.findings.length);
});

test('canonical modernization findings block Node-only browser imports', () => {
  const result = auditModernization(base([
    source('unsafe.ts', "import { readFile } from 'node:fs';\nexport { readFile };\n"),
  ]));

  const finding = result.findings.find(item => item.id === 'modernization-browser-node-builtin');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
  assert.equal(finding.severity, 'high');
  assert.equal(result.summary.findings.some(item => item.id === finding.id), true);
});

test('canonical modernization findings propagate whole-page keyboard usability risks', () => {
  const result = auditModernization(base([
    source('Clickable.tsx', "export const Clickable = () => <div onClick={() => undefined}>Open</div>;\n"),
  ]));

  const finding = result.findings.find(item => item.id === 'page-usability-clickable-noninteractive');
  assert.ok(finding);
  assert.equal(finding.domain, 'accessibility');
  assert.equal(result.summary.platformGovernance.components.some(item => item.id === 'page-usability' && item.findings > 0), true);
});

test('canonical modernization findings propagate browser dependency authority failures', () => {
  const result = auditModernization(base([
    source('undeclared.ts', "import helper from 'runtime-helper';\nexport { helper };\n"),
  ]));

  const finding = result.findings.find(item => item.id === 'modernization-browser-undeclared-dependency');
  assert.ok(finding);
  assert.equal(finding.domain, 'dependencies');
  assert.equal(finding.blocking, true);
});

test('canonical modernization keeps package dependency authority isolated', () => {
  const result = auditModernization(fixtureInventory([
    manifest({ '@public/runtime': '1.0.0' }),
    tsconfig(),
    directoryBuildProps('enable'),
    source('public.ts', "import runtime from '@public/runtime';\nexport { runtime };\n"),
    {
      path: 'Webclient.admin/AdminWebClientFrontend/package.json',
      text: JSON.stringify({
        name: 'admin-web',
        type: 'module',
        packageManager: 'npm@11.6.1',
        engines: { node: '>=24', npm: '>=11' },
        dependencies: {},
        devDependencies: {},
      }),
    },
    {
      path: 'Webclient.admin/AdminWebClientFrontend/src/admin.ts',
      text: "import runtime from '@public/runtime';\nexport { runtime };\n",
    },
  ]));

  assert.ok(result.findings.some(item => item.id === 'modernization-browser-undeclared-dependency'
    && item.location?.file === 'Webclient.admin/AdminWebClientFrontend/src/admin.ts'));
});

test('canonical modernization ordering stays deterministic after aggregation', () => {
  const inventory = base([
    source('mixed.tsx', [
      "import fs from 'node:fs';",
      "import helper from 'missing-runtime';",
      'export const Mixed = () => <div onClick={() => undefined}><img src="/x.png" /></div>;',
      'void fs; void helper;',
      '',
    ].join('\n')),
  ]);

  const first = auditModernization(inventory).findings;
  const second = auditModernization(inventory).findings;
  assert.deepEqual(
    first.map(item => `${item.severity}:${item.domain}:${item.id}:${item.location?.file ?? ''}:${item.location?.line ?? 0}`),
    second.map(item => `${item.severity}:${item.domain}:${item.id}:${item.location?.file ?? ''}:${item.location?.line ?? 0}`),
  );
});
