import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBaseline,
  releaseReportMarkdown,
  runReleaseEngine,
} from './release-engine.mts';
import type {
  FileKind,
  ReleaseContext,
  RepositoryInventory,
  SourceFile,
} from './contracts.mts';

const context: ReleaseContext = {
  repository: 'owner/repo',
  branch: 'agent/deep-qa',
  commit: 'integration-head',
  generatedAt: '2026-09-18T00:00:00.000Z',
};

const relaxedThresholds = {
  maxHighFindings: 10_000,
  maxMediumFindings: 10_000,
  maxRiskScore: 1_000_000,
};

function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile {
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: path.includes('.') ? `.${path.split('.').at(-1) ?? ''}` : '',
    kind,
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.split(/\r?\n/).length,
    text,
  };
}

function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-18T00:00:00.000Z',
  };
}

async function execute(files: readonly SourceFile[] = []) {
  return runReleaseEngine(inventory(files), context, { thresholds: relaxedThresholds });
}

function sectionTitles(execution: Awaited<ReturnType<typeof execute>>): string[] {
  return execution.report.sections.map(section => section.title);
}

function findingIds(execution: Awaited<ReturnType<typeof execute>>): string[] {
  return execution.report.findings.map(finding => finding.id);
}

test('release engine wires every deep QA section exactly once', async () => {
  const execution = await execute();
  const titles = sectionTitles(execution);
  const expected = [
    'TypeScript, ESM, Vite and React language-modernization audit',
    'Security boundary and credential regression audit',
    'Backend API authorization, input and transport boundary audit',
    'CI workflow integrity and supply-chain audit',
    'Release validation integrity and reproducibility audit',
    'ArcGIS transport, lifecycle, data and 2D/3D release-contract audit',
    'Accessibility and keyboard regression audit',
    'Responsive viewport and touch regression audit',
    'Runtime observability, cancellation and lifecycle audit',
  ];

  for (const title of expected) {
    assert.equal(
      titles.filter(candidate => candidate === title).length,
      1,
      `expected exactly one release section: ${title}\n${titles.join('\n')}`,
    );
  }
});

test('accessibility regression reaches top-level release findings', async () => {
  const execution = await execute([
    source('Webclient.app/src/Panel.tsx', 'export const Panel=()=> <div tabIndex={4}>Panel</div>;'),
  ]);
  assert.ok(findingIds(execution).includes('a11y-positive-tabindex'));
});

test('security regression reaches top-level release findings', async () => {
  const execution = await execute([
    source('Webclient.app/src/runtime.ts', 'export function run(code: string){ return eval(code); }'),
  ]);
  assert.ok(findingIds(execution).includes('security-dynamic-code-execution'));
  assert.equal(execution.report.decision.state, 'block');
});

test('CI integrity regression reaches top-level release findings', async () => {
  const execution = await execute([
    source('.github/workflows/unsafe.yml', `name: Unsafe
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@main
`, 'yaml'),
  ]);
  const ids = findingIds(execution);
  assert.ok(ids.includes('ci-action-mutable-ref'));
  assert.ok(ids.includes('ci-permissions-implicit'));
});

test('responsive regression reaches top-level release findings', async () => {
  const execution = await execute([
    source('Webclient.app/src/panel.css', '.panel { width: 1200px; }', 'css'),
  ]);
  assert.ok(findingIds(execution).includes('responsive-large-fixed-width'));
});

test('new integrated findings participate in exact baseline deltas', async () => {
  const clean = await execute();
  const baseline = createBaseline(clean.report);
  const dirty = await runReleaseEngine(
    inventory([
      source('Webclient.app/src/Panel.tsx', 'export const Panel=()=> <img src="marker.png" />;'),
    ]),
    context,
    { thresholds: relaxedThresholds },
    baseline,
  );

  assert.ok(dirty.regression);
  assert.ok(
    dirty.regression?.added.some(item => item.key.includes('a11y-image-alt-contract')),
  );
});

test('expanded release report fingerprint remains deterministic', async () => {
  const files = [
    source('Webclient.app/src/Panel.tsx', 'export const Panel=()=> <button type="button">OK</button>;'),
  ];
  const first = await execute(files);
  const second = await execute(files);
  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.deepEqual(
    first.report.findings.map(item => item.id),
    second.report.findings.map(item => item.id),
  );
});

test('markdown exposes integrated deep QA sections', async () => {
  const markdown = releaseReportMarkdown(await execute());
  assert.match(markdown, /Accessibility and keyboard regression audit/);
  assert.match(markdown, /CI workflow integrity and supply-chain audit/);
  assert.match(markdown, /Runtime observability, cancellation and lifecycle audit/);
  assert.match(markdown, /ArcGIS transport, lifecycle, data and 2D\/3D release-contract audit/);
});

test('expanded engine does not mutate caller inventory', async () => {
  const file = source(
    'Webclient.app/src/Panel.tsx',
    'export const Panel=()=> <button type="button">OK</button>;',
  );
  const before = file.text;
  await execute([file]);
  assert.equal(file.text, before);
});

test('section ordering keeps security and supply-chain gates before runtime UX audits', async () => {
  const titles = sectionTitles(await execute());
  const security = titles.indexOf('Security boundary and credential regression audit');
  const backend = titles.indexOf('Backend API authorization, input and transport boundary audit');
  const ci = titles.indexOf('CI workflow integrity and supply-chain audit');
  const gis = titles.indexOf('ArcGIS transport, lifecycle, data and 2D/3D release-contract audit');
  const accessibility = titles.indexOf('Accessibility and keyboard regression audit');

  assert.ok(security >= 0);
  assert.ok(backend > security);
  assert.ok(ci > backend);
  assert.ok(gis > ci);
  assert.ok(accessibility > gis);
});

test('client log privacy release section scans both user and admin runtime files', async () => {
  const execution = await execute([
    source('Webclient.app/src/QueryWindow.tsx', 'safeClientLog(LoggingBusiness, "query", record.address);'),
    source('Webclient.admin/src/QueryPanel.ts', 'safeClientLog(LoggingBusiness, "query", JSON.stringify(query));'),
    source('Webclient.app/src/QueryPanel.test.tsx', 'safeClientLog(LoggingBusiness, "query", record.address);'),
  ]);
  const sections = execution.report.sections.filter(section => section.title === 'Client log payload privacy');
  assert.equal(sections.length, 1, 'privacy scan must run once in the release engine');
  const findings = sections[0]?.findings ?? [];
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.severity === 'high'));
  assert.deepEqual(
    findings.map(finding => finding.location?.file).sort(),
    ['Webclient.admin/src/QueryPanel.ts', 'Webclient.app/src/QueryWindow.tsx'],
  );
  assert.equal(execution.report.findings.filter(finding => finding.id === 'client-log-sensitive-payload').length, 2);
});

test('client log privacy release gate preserves bounded non-identifying metadata', async () => {
  const execution = await execute([
    source('Webclient.app/src/QueryWindow.tsx', [
      'safeClientLog(LoggingBusiness, "count", String(resultCount));',
      'safeClientLog(LoggingBusiness, "service", serviceKey);',
    ].join('\n')),
  ]);
  const section = execution.report.sections.find(item => item.title === 'Client log payload privacy');
  assert.ok(section, 'release engine must execute privacy audit even with no findings');
  assert.equal(section.findings.length, 0);
  assert.equal(execution.report.findings.filter(finding => finding.id === 'client-log-sensitive-payload').length, 0);
});

test('client log privacy regressions reach the baseline delta and report fingerprint', async () => {
  const clean = await execute([]);
  const baseline = createBaseline(clean.report);
  const unsafe = inventory([
    source('Webclient.admin/src/AddressPanel.tsx', 'safeClientLog(LoggingBusiness, "address", path?.mahalle);'),
  ]);
  const first = await runReleaseEngine(unsafe, context, { thresholds: relaxedThresholds }, baseline);
  const second = await runReleaseEngine(unsafe, context, { thresholds: relaxedThresholds }, baseline);
  assert.ok(first.report.findings.some(finding => finding.id === 'client-log-sensitive-payload'));
  assert.ok(first.regression?.added.some(finding => finding.key.includes('client-log-sensitive-payload')));
  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.deepEqual(first.regression?.added, second.regression?.added);
});
