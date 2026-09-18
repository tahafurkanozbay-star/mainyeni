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
  branch: 'agent/integration',
  commit: 'integration-head',
  generatedAt: '2026-09-18T00:00:00.000Z',
};

function source(
  path: string,
  text: string,
  kind: FileKind = 'typescript',
): SourceFile {
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

const relaxedThresholds = {
  maxHighFindings: 10_000,
  maxMediumFindings: 10_000,
  maxRiskScore: 1_000_000,
};

async function execute(files: readonly SourceFile[]) {
  return runReleaseEngine(
    inventory(files),
    context,
    { thresholds: relaxedThresholds },
  );
}

function titles(execution: Awaited<ReturnType<typeof execute>>): string[] {
  return execution.report.sections.map(section => section.title);
}

function ids(execution: Awaited<ReturnType<typeof execute>>): string[] {
  return execution.report.findings.map(finding => finding.id);
}

test('deep release engine exposes every integrated audit section', async () => {
  const execution = await execute([]);
  const sectionTitles = titles(execution);

  const expected = [
    'Whole-code modernization and language audit',
    'Security boundary and credential regression audit',
    'Backend security boundary regression audit',
    'CI workflow integrity and supply-chain audit',
    'GIS runtime release-contract audit',
    'Accessibility and keyboard regression audit',
    'Responsive and mobile layout regression audit',
    'Observability and runtime lifecycle regression audit',
  ];

  for (const title of expected) {
    assert.ok(
      sectionTitles.includes(title),
      `missing integrated section: ${title}\n${sectionTitles.join('\n')}`,
    );
  }
});

test('deep release section order is deterministic around critical boundaries', async () => {
  const execution = await execute([]);
  const sectionTitles = titles(execution);

  const security = sectionTitles.indexOf(
    'Security boundary and credential regression audit',
  );
  const backend = sectionTitles.indexOf(
    'Backend security boundary regression audit',
  );
  const dependencies = sectionTitles.indexOf(
    'Dependency and build-chain modernization audit',
  );
  const ci = sectionTitles.indexOf(
    'CI workflow integrity and supply-chain audit',
  );
  const network = sectionTitles.indexOf(
    'Network boundary and external dependency audit',
  );

  assert.ok(security >= 0);
  assert.ok(backend > security);
  assert.ok(dependencies > backend);
  assert.ok(ci > dependencies);
  assert.ok(network > ci);
});

test('accessibility findings now participate in the top-level release report', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/Panel.tsx',
      'export function Panel(){ return <div tabIndex={4}>Panel</div>; }',
    ),
  ]);

  assert.ok(ids(execution).includes('a11y-positive-tabindex'));
});

test('responsive findings now participate in the top-level release report', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/panel.css',
      '.panel { width: 1200px; }',
      'css',
    ),
  ]);

  assert.ok(ids(execution).includes('responsive-large-fixed-width'));
});

test('security findings now participate in the top-level release report', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/runtime.ts',
      'export function run(code: string){ return eval(code); }',
    ),
  ]);

  assert.ok(ids(execution).includes('security-dynamic-code-execution'));
});

test('CI integrity findings now participate in the top-level release report', async () => {
  const execution = await execute([
    source(
      '.github/workflows/unsafe.yml',
      `name: unsafe
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm test
`,
      'yaml',
    ),
  ]);

  assert.ok(ids(execution).includes('ci-permissions-implicit'));
  assert.ok(ids(execution).includes('ci-action-mutable-ref'));
});

test('runtime resilience findings remain integrated alongside new sections', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/runtime/heartbeat.ts',
      'export function start(){ setInterval(() => work(), 1000); }',
    ),
  ]);

  assert.ok(ids(execution).includes('runtime-timer-without-clear'));
});

test('data integrity findings remain integrated alongside new sections', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/runtime/identity.ts',
      'export function key(record){ return Number(record.globalId); }',
    ),
  ]);

  assert.ok(
    ids(execution).some(id => id.includes('identity')),
    `expected identity finding, got: ${ids(execution).join(', ')}`,
  );
});

test('new integrated critical finding affects release decision', async () => {
  const execution = await runReleaseEngine(
    inventory([
      source(
        'Webclient.app/src/runtime.ts',
        'export function run(code: string){ return eval(code); }',
      ),
    ]),
    context,
    {
      thresholds: {
        ...relaxedThresholds,
        blockOnCritical: true,
      },
    },
  );

  assert.equal(execution.report.decision.state, 'block');
  assert.ok(execution.report.decision.counts.critical >= 1);
  assert.ok(
    execution.report.decision.blockingFindingIds.some(id =>
      id.includes('security-dynamic-code-execution'),
    ),
  );
});

test('baseline comparison observes newly integrated accessibility regressions', async () => {
  const cleanExecution = await execute([]);
  const baseline = createBaseline(cleanExecution.report);

  const dirtyExecution = await runReleaseEngine(
    inventory([
      source(
        'Webclient.app/src/Panel.tsx',
        'export function Panel(){ return <div tabIndex={9}>Panel</div>; }',
      ),
    ]),
    context,
    { thresholds: relaxedThresholds },
    baseline,
  );

  assert.ok(dirtyExecution.regression);
  assert.ok(
    dirtyExecution.regression?.added.some(item =>
      item.key.includes('a11y-positive-tabindex'),
    ),
  );
});

test('baseline comparison observes newly integrated CI regressions', async () => {
  const cleanExecution = await execute([]);
  const baseline = createBaseline(cleanExecution.report);

  const dirtyExecution = await runReleaseEngine(
    inventory([
      source(
        '.github/workflows/new.yml',
        `name: New
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
`,
        'yaml',
      ),
    ]),
    context,
    { thresholds: relaxedThresholds },
    baseline,
  );

  assert.ok(
    dirtyExecution.regression?.added.some(item =>
      item.key.includes('ci-action-mutable-ref'),
    ),
  );
});

test('report fingerprint changes when integrated audit evidence changes', async () => {
  const cleanExecution = await execute([]);
  const dirtyExecution = await execute([
    source(
      'Webclient.app/src/Panel.tsx',
      'export function Panel(){ return <img src="x.png" />; }',
    ),
  ]);

  assert.notEqual(
    cleanExecution.report.fingerprint,
    dirtyExecution.report.fingerprint,
  );
});

test('release markdown lists newly integrated accessibility section', async () => {
  const execution = await execute([]);
  const markdown = releaseReportMarkdown(execution);

  assert.match(
    markdown,
    /Accessibility and keyboard regression audit/,
  );
});

test('release markdown lists newly integrated observability section', async () => {
  const execution = await execute([]);
  const markdown = releaseReportMarkdown(execution);

  assert.match(
    markdown,
    /Observability and runtime lifecycle regression audit/,
  );
});

test('release markdown lists newly integrated CI integrity section', async () => {
  const execution = await execute([]);
  const markdown = releaseReportMarkdown(execution);

  assert.match(
    markdown,
    /CI workflow integrity and supply-chain audit/,
  );
});

test('engine preserves one section instance per integrated title', async () => {
  const execution = await execute([]);
  const counts = new Map<string, number>();

  for (const title of titles(execution)) {
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }

  for (const [
    title,
    count,
  ] of counts) {
    assert.equal(
      count,
      1,
      `release engine emitted duplicate section ${title}`,
    );
  }
});

test('engine report findings remain deterministically sorted after expansion', async () => {
  const execution = await execute([
    source(
      'Webclient.app/src/Panel.tsx',
      'export function Panel(){ return <div tabIndex={7}><img src="x.png" /></div>; }',
    ),
    source(
      '.github/workflows/unsafe.yml',
      `name: Unsafe
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
`,
      'yaml',
    ),
  ]);

  const findings = execution.report.findings;
  const criticalIndex = findings.findIndex(item => item.severity === 'critical');
  const highIndex = findings.findIndex(item => item.severity === 'high');
  const mediumIndex = findings.findIndex(item => item.severity === 'medium');

  if (criticalIndex >= 0 && highIndex >= 0) {
    assert.ok(criticalIndex <= highIndex);
  }
  if (highIndex >= 0 && mediumIndex >= 0) {
    assert.ok(highIndex <= mediumIndex);
  }
});

test('integrated audit expansion does not mutate caller inventory', async () => {
  const files = [
    source(
      'Webclient.app/src/Panel.tsx',
      'export function Panel(){ return <button type="button">OK</button>; }',
    ),
  ] as const;
  const originalText = files[0].text;

  await execute(files);

  assert.equal(files[0].text, originalText);
});

test('identical expanded-engine executions remain fingerprint deterministic', async () => {
  const files = [
    source(
      'Webclient.app/src/Panel.tsx',
      'export function Panel(){ return <button type="button">OK</button>; }',
    ),
  ];

  const first = await execute(files);
  const second = await execute(files);

  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.deepEqual(
    first.report.findings.map(item => item.id),
    second.report.findings.map(item => item.id),
  );
});
