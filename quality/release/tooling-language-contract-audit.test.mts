import assert from 'node:assert/strict';
import test from 'node:test';
import { auditToolingLanguageContracts } from './tooling-language-contract-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function packageJson(overrides: Record<string, unknown> = {}): FixtureFileInput {
  const base = {
    name: 'webclient',
    private: true,
    type: 'module',
    engines: { node: '>=24.0.0', npm: '>=11.0.0' },
    scripts: {
      verify: 'npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run build && npm run build:verify',
      'test:tooling': 'node --test scripts/example.test.mjs',
      typecheck: 'tsc --noEmit -p tsconfig.json',
    },
    ...overrides,
  };
  return { path: 'Webclient.app/package.json', text: JSON.stringify(base, null, 2) };
}

function audit(files: readonly FixtureFileInput[]) {
  return auditToolingLanguageContracts(fixtureInventory([packageJson(), ...files]));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

test('accepts modern typed ESM release tooling', () => {
  const section = audit([
    {
      path: 'Webclient.app/scripts/release-contract.mts',
      text: "import { readFile } from 'node:fs/promises';\nimport { parse } from './parse.mts';\nexport async function run(): Promise<void> { await readFile('x'); parse('x'); }\n",
    },
    {
      path: 'Webclient.app/scripts/release-contract.test.mts',
      text: "import test from 'node:test';\ntest('ok', () => {});\n",
    },
  ]);
  assert.equal(section.findings.some(item => item.severity === 'high' || item.severity === 'critical'), false);
  assert.equal(section.summary.typedFiles, 2);
  assert.equal(section.summary.typedRatio, 1);
});

test('blocks CommonJS inside release authority tooling', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-gate.cjs', text: "module.exports = { run: () => require('./gate') };\n" },
  ]);
  const finding = section.findings.find(item => item.id === 'tooling-release-authority-commonjs');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('reports non-release CommonJS as migration debt without forcing a block', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/local-helper.cjs', text: 'module.exports = 1;\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'tooling-commonjs-debt');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
  assert.notEqual(finding.blocking, true);
});

test('blocks ts-nocheck in typed tooling', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-gate.mts', text: '// @ts-nocheck\nexport const run = () => true;\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'tooling-type-suppression');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('blocks ts-ignore in typed tooling', () => {
  const section = audit([
    { path: 'tools/release-check.ts', text: '// @ts-ignore\nexport const result: number = "x";\n' },
  ]);
  assert.ok(section.findings.some(item => item.id === 'tooling-type-suppression'));
});

test('reports deprecated Buffer constructor once as aggregate debt', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/local-helper.mjs', text: 'const x = new Buffer(2);\n' },
    { path: 'tools/local-helper.mjs', text: 'const y = new Buffer(3);\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'tooling-deprecated-node-api');
  assert.ok(finding);
  assert.equal(finding.evidence?.value, 2);
});

test('reports fs.exists as deprecated Node API', () => {
  assert.ok(ids([
    { path: 'Webclient.app/scripts/helper.mjs', text: "import fs from 'node:fs';\nfs.exists('x', () => {});\n" },
  ]).includes('tooling-deprecated-node-api'));
});

test('reports util.isArray as deprecated Node API', () => {
  assert.ok(ids([
    { path: 'tools/helper.mjs', text: "import util from 'node:util';\nutil.isArray([]);\n" },
  ]).includes('tooling-deprecated-node-api'));
});

test('reports url.parse as deprecated Node API', () => {
  assert.ok(ids([
    { path: 'tools/helper.mjs', text: "import url from 'node:url';\nurl.parse('https://example.test');\n" },
  ]).includes('tooling-deprecated-node-api'));
});

test('flags extensionless relative imports in typed Node ESM tooling', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-gate.mts', text: "import { gate } from './gate';\nexport { gate };\n" },
  ]);
  const finding = section.findings.find(item => item.id === 'tooling-typed-esm-extensionless-import');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
});

test('accepts explicit mts relative imports', () => {
  assert.ok(!ids([
    { path: 'Webclient.app/scripts/release-gate.mts', text: "import { gate } from './gate.mts';\nexport { gate };\n" },
  ]).includes('tooling-typed-esm-extensionless-import'));
});

test('accepts explicit js relative imports from typed tooling', () => {
  assert.ok(!ids([
    { path: 'Webclient.app/scripts/release-gate.mts', text: "import { gate } from './gate.js';\nexport { gate };\n" },
  ]).includes('tooling-typed-esm-extensionless-import'));
});

test('does not inspect application source as tooling', () => {
  const section = audit([
    { path: 'Webclient.app/src/legacy.cjs', text: 'module.exports = 1;\n' },
  ]);
  assert.equal(section.summary.inspectedFiles, 0);
  assert.equal(section.findings.some(item => item.id.includes('commonjs')), false);
});

test('does not inspect generated output', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/dist/release.cjs', text: 'module.exports = 1;\n' },
    { path: 'tools/coverage/release.cjs', text: 'module.exports = 1;\n' },
  ]);
  assert.equal(section.summary.inspectedFiles, 0);
});

test('blocks package manifests that leave native ESM mode', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({ type: 'commonjs' }),
  ]));
  const finding = section.findings.find(item => item.id === 'tooling-package-esm-contract-missing');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('blocks missing package manifest', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    { path: 'Webclient.app/scripts/release.mts', text: 'export const x = 1;\n' },
  ]));
  const finding = section.findings.find(item => item.id === 'tooling-package-contract-missing');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('blocks Node engine below 24', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({ engines: { node: '>=22.0.0', npm: '>=11.0.0' } }),
  ]));
  const finding = section.findings.find(item => item.id === 'tooling-node-engine-outdated');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('accepts caret-free and dotted Node 24 engine expressions', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({ engines: { node: '>=24.1.0', npm: '>=11.1.0' } }),
  ]));
  assert.ok(!section.findings.some(item => item.id === 'tooling-node-engine-outdated'));
});

test('reports npm engine below 11', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({ engines: { node: '>=24.0.0', npm: '>=10.0.0' } }),
  ]));
  assert.ok(section.findings.some(item => item.id === 'tooling-npm-engine-outdated'));
});

test('blocks incomplete npm verify chain', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({
      scripts: {
        verify: 'npm run typecheck && npm run test:ci',
        'test:tooling': 'node --test scripts/example.test.mjs',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
    }),
  ]));
  const finding = section.findings.find(item => item.id === 'tooling-verify-chain-incomplete');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
  assert.match(finding.message, /dependency:verify/);
  assert.match(finding.message, /build:verify/);
});

test('reports missing node:test tooling contract', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({
      scripts: {
        verify: 'npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run build && npm run build:verify',
        'test:tooling': 'vitest run scripts',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
    }),
  ]));
  assert.ok(section.findings.some(item => item.id === 'tooling-node-test-contract-missing'));
});

test('blocks missing primary tsc noEmit contract', () => {
  const section = auditToolingLanguageContracts(fixtureInventory([
    packageJson({
      scripts: {
        verify: 'npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run build && npm run build:verify',
        'test:tooling': 'node --test scripts/example.test.mjs',
        typecheck: 'echo skipped',
      },
    }),
  ]));
  const finding = section.findings.find(item => item.id === 'tooling-primary-typecheck-contract-missing');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('emits one low typed-ratio ratchet finding instead of one finding per legacy authority', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-a.mjs', text: 'export const a = 1;\n' },
    { path: 'Webclient.app/scripts/release-b.mjs', text: 'export const b = 1;\n' },
    { path: 'Webclient.app/scripts/workflow-c.mjs', text: 'export const c = 1;\n' },
    { path: 'Webclient.app/scripts/security-d.mjs', text: 'export const d = 1;\n' },
    { path: 'Webclient.app/scripts/release-e.mts', text: 'export const e: number = 1;\n' },
  ]);
  const findings = section.findings.filter(item => item.id === 'tooling-release-authority-typed-ratio');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'low');
  assert.equal(findings[0]?.evidence?.value, 4);
});

test('does not emit typed-ratio debt once typed release tooling reaches the ratchet threshold', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-a.mts', text: 'export const a: number = 1;\n' },
    { path: 'Webclient.app/scripts/release-b.mts', text: 'export const b: number = 1;\n' },
    { path: 'Webclient.app/scripts/workflow-c.mjs', text: 'export const c = 1;\n' },
    { path: 'Webclient.app/scripts/security-d.mjs', text: 'export const d = 1;\n' },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'tooling-release-authority-typed-ratio'));
});

test('counts tests in typed ratio but excludes them from release authority ratio', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-a.mjs', text: 'export const a = 1;\n' },
    { path: 'Webclient.app/scripts/release-a.test.mts', text: "import test from 'node:test';\ntest('x', () => {});\n" },
  ]);
  assert.equal(section.summary.inspectedFiles, 2);
  assert.equal(section.summary.typedFiles, 1);
  assert.equal(section.summary.releaseAuthorityFiles, 1);
  assert.equal(section.summary.typedReleaseAuthorityFiles, 0);
});

test('keeps findings deterministic across repeated audits', () => {
  const inventory = fixtureInventory([
    packageJson(),
    { path: 'Webclient.app/scripts/release-a.cjs', text: 'module.exports = 1;\n' },
    { path: 'Webclient.app/scripts/release-b.mts', text: "import x from './x';\n// @ts-ignore\nexport const y = x;\n" },
  ]);
  const left = auditToolingLanguageContracts(inventory);
  const right = auditToolingLanguageContracts(inventory);
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, severity: item.severity, blocking: item.blocking, file: item.location?.file })),
    right.findings.map(item => ({ id: item.id, severity: item.severity, blocking: item.blocking, file: item.location?.file })),
  );
});

test('summary exposes manifest and migration ratios for reporting', () => {
  const section = audit([
    { path: 'Webclient.app/scripts/release-a.mjs', text: 'export const a = 1;\n' },
    { path: 'Webclient.app/scripts/release-b.mts', text: 'export const b: number = 1;\n' },
  ]);
  assert.equal(section.summary.manifest.moduleType, 'module');
  assert.equal(section.summary.manifest.nodeEngine, '>=24.0.0');
  assert.equal(section.summary.manifest.npmEngine, '>=11.0.0');
  assert.equal(section.summary.typedRatio, 0.5);
  assert.equal(section.summary.releaseAuthorityFiles, 2);
  assert.equal(section.summary.typedReleaseAuthorityRatio, 0.5);
});
