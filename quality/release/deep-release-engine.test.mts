import assert from 'node:assert/strict';
import test from 'node:test';

import { auditAccessibility } from './accessibility-audit.mts';
import { auditBackendSecurity } from './backend-security-audit.mts';
import { auditCiIntegrity } from './ci-integrity-audit.mts';
import {
  DEFAULT_THRESHOLDS,
  findingKey,
  type AuditSection,
  type Finding,
  type ReleaseContext,
  type RepositoryInventory,
} from './contracts.mts';
import { auditDataIntegrity } from './data-integrity-audit.mts';
import { auditGisReleaseContracts } from './gis-release-contract-audit.mts';
import { auditLanguageModernization } from './language-modernization-audit.mts';
import { auditObservability } from './observability-audit.mts';
import {
  createBaseline,
  releaseReportMarkdown,
  runReleaseEngine,
} from './release-engine.mts';
import { auditResponsive } from './responsive-audit.mts';
import { auditRuntimeResilience } from './runtime-resilience-audit.mts';
import { auditSecurity } from './security-audit.mts';
import {
  fixtureInventory,
  type FixtureFileInput,
} from './test-helpers.mts';

type Auditor = (inventory: RepositoryInventory) => AuditSection<unknown>;

const context: ReleaseContext = {
  repository: 'tahafurkanozbay-star/mainyeni',
  branch: 'integration-test',
  commit: '0123456789abcdef0123456789abcdef01234567',
  generatedAt: '2026-09-18T00:00:00.000Z',
};

const lenientThresholds = {
  ...DEFAULT_THRESHOLDS,
  maxHighFindings: 999,
  maxMediumFindings: 999,
  maxRiskScore: 999_999,
};

async function execute(inputs: readonly FixtureFileInput[]) {
  return runReleaseEngine(
    fixtureInventory(inputs),
    context,
    { thresholds: lenientThresholds },
  );
}

async function assertIntegrated(
  auditor: Auditor,
  inputs: readonly FixtureFileInput[],
): Promise<void> {
  const inventory = fixtureInventory(inputs);
  const standalone = auditor(inventory);
  assert.ok(
    standalone.findings.length > 0,
    `Expected standalone audit "${standalone.title}" to produce a fixture finding.`,
  );

  const execution = await runReleaseEngine(
    inventory,
    context,
    { thresholds: lenientThresholds },
  );
  const engineKeys = new Set(execution.report.findings.map(findingKey));

  for (const finding of standalone.findings) {
    assert.ok(
      engineKeys.has(findingKey(finding)),
      `Release engine did not include ${finding.id} from "${standalone.title}".`,
    );
  }
}

function findingIds(findings: readonly Finding[]): string[] {
  return findings.map(finding => finding.id);
}

test('release engine exposes every deep QA section in deterministic order', async () => {
  const execution = await execute([]);
  const titles = execution.report.sections.map(section => section.title);

  const expected = [
    'Language, framework and build modernization readiness',
    auditLanguageModernization(fixtureInventory([])).title,
    'Source security and architecture audit',
    auditSecurity(fixtureInventory([])).title,
    auditBackendSecurity(fixtureInventory([])).title,
    'Dependency and build-chain modernization audit',
    'Network boundary and external dependency audit',
    'GIS 2D/3D, service, lifecycle and icon audit',
    auditGisReleaseContracts(fixtureInventory([])).title,
    'Accessibility and responsive static audit',
    auditAccessibility(fixtureInventory([])).title,
    auditResponsive(fixtureInventory([])).title,
    auditObservability(fixtureInventory([])).title,
    'Static performance and large-data readiness audit',
    auditDataIntegrity(fixtureInventory([])).title,
    auditRuntimeResilience(fixtureInventory([])).title,
    auditCiIntegrity(fixtureInventory([])).title,
    'Release regression contract coverage',
  ];

  assert.deepEqual(titles, expected);
});

test('language modernization findings participate in the release report', async () => {
  await assertIntegrated(
    auditLanguageModernization,
    [{
      path: 'Webclient.app/src/platform/unsafe.ts',
      text: '// @ts-nocheck\nexport const value = legacy;',
    }],
  );
});

test('strict typed boundary suppression blocks the release gate', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/platform/unsafe.ts',
    text: '// @ts-nocheck\nexport const value = legacy;',
  }]);

  assert.ok(findingIds(execution.report.findings).includes('language-ts-nocheck'));
  assert.equal(execution.report.decision.state, 'block');
});

test('GIS release-contract findings participate in the release report', async () => {
  await assertIntegrated(
    auditGisReleaseContracts,
    [{
      path: 'Webclient.app/src/gis-engine/legacyService.ts',
      text: "export const endpoint = '/wms?service=WMS';",
    }],
  );
});

test('forbidden GIS protocols remain explicitly release-blocking', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/gis-engine/legacyService.ts',
    text: "export const endpoint = '/wfs?service=WFS';",
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'gis-forbidden-wfs',
  );
  assert.ok(finding);
  assert.equal(finding.blocking, true);
  assert.equal(execution.report.decision.state, 'block');
});

test('security-boundary findings participate in the release report', async () => {
  await assertIntegrated(
    auditSecurity,
    [{
      path: 'Webclient.app/src/unsafe.ts',
      text: 'const result = eval(code);',
    }],
  );
});

test('dynamic execution remains explicitly release-blocking', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/unsafe.ts',
    text: 'const result = eval(code);',
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'security-dynamic-code-execution',
  );
  assert.ok(finding);
  assert.equal(finding.blocking, true);
  assert.equal(execution.report.decision.state, 'block');
});

test('backend security findings participate in the release report', async () => {
  await assertIntegrated(
    auditBackendSecurity,
    [{
      path: 'Api.Core/Program.cs',
      text: 'policy.AllowAnyOrigin();',
    }],
  );
});

test('data-integrity findings participate in the release report', async () => {
  await assertIntegrated(
    auditDataIntegrity,
    [{
      path: 'Webclient.app/src/data/runtime.json',
      text: '{"broken":',
    }],
  );
});

test('invalid runtime JSON blocks the release gate', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/data/runtime.json',
    text: '{"broken":',
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'data-invalid-json',
  );
  assert.ok(finding);
  assert.equal(finding.blocking, true);
  assert.equal(execution.report.decision.state, 'block');
});

test('runtime resilience findings participate in the release report', async () => {
  await assertIntegrated(
    auditRuntimeResilience,
    [{
      path: 'Webclient.app/src/Core/poller.ts',
      text: 'setInterval(() => tick(), 1000);',
    }],
  );
});

test('CI integrity findings participate in the release report', async () => {
  await assertIntegrated(
    auditCiIntegrity,
    [{
      path: '.github/workflows/quality.yml',
      text: [
        'name: Quality',
        'on: [pull_request]',
        'jobs:',
        '  quality:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
      ].join('\n'),
    }],
  );
});

test('CI implicit permission findings remain visible at high severity', async () => {
  const execution = await execute([{
    path: '.github/workflows/quality.yml',
    text: [
      'name: Quality',
      'on: [pull_request]',
      'jobs:',
      '  quality:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n'),
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'ci-permissions-implicit',
  );
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
});

test('observability findings participate in the release report', async () => {
  await assertIntegrated(
    auditObservability,
    [{
      path: 'Webclient.app/src/Core/runtime.ts',
      text: 'try { run(); } catch {}',
    }],
  );
});

test('swallowed exceptions remain visible at high severity', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/Core/runtime.ts',
    text: 'try { run(); } catch {}',
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'observability-swallowed-exception',
  );
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
});

test('accessibility findings participate in the release report', async () => {
  await assertIntegrated(
    auditAccessibility,
    [{
      path: 'Webclient.app/src/Panel.tsx',
      text: '<div tabIndex={3}>Panel</div>',
    }],
  );
});

test('viewport zoom disabling remains a critical accessibility blocker', async () => {
  const execution = await execute([{
    path: 'Webclient.app/index.html',
    text: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
  }]);

  const finding = execution.report.findings.find(
    item => item.id === 'a11y-viewport-zoom-disabled',
  );
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
  assert.equal(execution.report.decision.state, 'block');
});

test('responsive findings participate in the release report', async () => {
  await assertIntegrated(
    auditResponsive,
    [{
      path: 'Webclient.app/src/panel.css',
      text: '.panel { width: 900px; }',
    }],
  );
});

test('responsive legacy viewport-height debt is preserved in the report', async () => {
  const execution = await execute([{
    path: 'Webclient.app/src/panel.css',
    text: '.app { height: 100vh; }',
  }]);

  assert.ok(
    findingIds(execution.report.findings).includes(
      'responsive-legacy-viewport-height',
    ),
  );
});

test('baseline comparison turns a new critical GIS regression into a release regression', async () => {
  const baselineExecution = await execute([]);
  const baseline = createBaseline(baselineExecution.report);

  const inventory = fixtureInventory([{
    path: 'Webclient.app/src/gis-engine/legacyService.ts',
    text: "export const endpoint = '/wms?service=WMS';",
  }]);

  const execution = await runReleaseEngine(
    inventory,
    context,
    { thresholds: lenientThresholds },
    baseline,
  );

  assert.ok(execution.regression);
  assert.ok(
    execution.report.findings.some(
      finding => finding.id === 'release-new-critical-regression',
    ),
  );
  assert.equal(execution.report.decision.state, 'block');
});

test('baseline comparison reports new high-severity language regressions', async () => {
  const baselineExecution = await execute([]);
  const baseline = createBaseline(baselineExecution.report);

  const inventory = fixtureInventory([{
    path: 'Webclient.app/tsconfig.json',
    text: JSON.stringify({ compilerOptions: { strict: false } }),
  }]);

  const execution = await runReleaseEngine(
    inventory,
    context,
    { thresholds: lenientThresholds },
    baseline,
  );

  assert.ok(execution.regression);
  assert.ok(
    execution.report.findings.some(
      finding => finding.id === 'release-new-critical-regression',
    ),
  );
});

test('release markdown exposes deep QA section names', async () => {
  const execution = await execute([]);
  const markdown = releaseReportMarkdown(execution);

  assert.match(
    markdown,
    /TypeScript, ESM, Vite and React language-modernization audit/,
  );
  assert.match(
    markdown,
    /ArcGIS transport, lifecycle, data and 2D\/3D release-contract audit/,
  );
  assert.match(markdown, /Security boundary and credential regression audit/);
  assert.match(markdown, /Backend API and server trust-boundary audit/);
  assert.match(markdown, /Runtime observability and reliability audit/);
});

test('release report keeps findings deterministically sorted', async () => {
  const execution = await execute([
    {
      path: 'Webclient.app/src/z.ts',
      text: 'try { run(); } catch {}',
    },
    {
      path: 'Webclient.app/src/a.ts',
      text: 'const result = eval(code);',
    },
  ]);

  const keys = execution.report.findings.map(findingKey);
  const second = await execute([
    {
      path: 'Webclient.app/src/z.ts',
      text: 'try { run(); } catch {}',
    },
    {
      path: 'Webclient.app/src/a.ts',
      text: 'const result = eval(code);',
    },
  ]);

  assert.deepEqual(
    second.report.findings.map(findingKey),
    keys,
  );
});

test('report fingerprint is deterministic for the same inventory and context', async () => {
  const inputs = [{
    path: 'Webclient.app/src/Core/runtime.ts',
    text: 'export const value = 1;',
  }];

  const first = await execute(inputs);
  const second = await execute(inputs);

  assert.equal(first.report.fingerprint, second.report.fingerprint);
});

test('clean strict TypeScript GIS fixture does not introduce deep critical findings', async () => {
  const execution = await execute([
    {
      path: 'Webclient.app/src/platform/clean.ts',
      text: 'export const value: Readonly<{ id: string }> = { id: "a" };',
    },
    {
      path: 'Webclient.app/src/gis-engine/cleanRuntime.ts',
      text: [
        'export async function run(layer, signal: AbortSignal, maxPages: number) {',
        '  if (signal.aborted) return;',
        '  for (let page = 0; page < maxPages; page += 1) {',
        '    await layer.queryFeatures({ where: "1=1", signal });',
        '  }',
        '}',
      ].join('\n'),
    },
  ]);

  const deepIds = new Set([
    'language-ts-nocheck',
    'gis-forbidden-wms',
    'gis-forbidden-wfs',
    'gis-forbidden-wmts',
    'security-dynamic-code-execution',
    'data-invalid-json',
  ]);

  assert.ok(
    !execution.report.findings.some(
      finding => deepIds.has(finding.id),
    ),
  );
});
