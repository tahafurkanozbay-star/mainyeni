import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditSpatialSelectionIndexSources,
  runSpatialSelectionIndexAuditSelfTest,
} from './spatial-selection-index-audit.mjs';

const PATHS = Object.freeze({
  contracts: 'src/gis-engine/spatialSelectionIndexContracts.ts',
  runtime: 'src/gis-engine/spatialSelectionIndexRuntime.ts',
  runtimeTest: 'src/gis-engine/spatialSelectionIndexRuntime.test.ts',
  kernel: 'src/gis-engine/modernSpatialAnalysisKernel.ts',
  kernelIntegration: 'src/gis-engine/modernSpatialAnalysisSelectionIndex.integration.test.ts',
  grid: 'src/gis-engine/spatialGridIndex.ts',
  tsconfig: 'tsconfig.gis-modern-core.json',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
});

const fixture = () => ({
  [PATHS.contracts]: `
    maxEntries; maxBytes; maxEntriesPerLayer; maxBytesPerLayer; maxLayers;
    maxHistory; degradedBudgetRatio; blockedBudgetRatio;
  `,
  [PATHS.runtime]: `
    createSpatialGridIndex();
    this.#grid.queryExtent();
    maxQueryCandidates;
    nearestExpansionSteps;
    throwIfSelectionAborted();
    #history;
    public dispose() {}
  `,
  [PATHS.runtimeTest]: 'test("selection runtime", () => {});',
  [PATHS.kernel]: `
    createSpatialSelectionIndexRuntime();
    indexSelection<T>() {}
    querySelectionIndex<T>() {}
    nearestIndexedSelection<T>() {}
    selectionIndex: this.#selectionIndex.snapshot();
    this.#selectionIndex.dispose();
  `,
  [PATHS.kernelIntegration]: 'test("selection integration", () => {});',
  [PATHS.grid]: `
    // single linear cursor
    Array.from({ length: range.count }, () => 0);
    maximumFeatures;
    maximumCells;
    maximumReferences;
    maximumCellsPerFeature;
    maximumBucketSize;
  `,
  [PATHS.tsconfig]: JSON.stringify({
    files: [
      PATHS.contracts,
      PATHS.runtime,
      PATHS.runtimeTest,
      PATHS.kernelIntegration,
    ],
  }),
  [PATHS.package]: JSON.stringify({
    scripts: {
      'quality:spatial-selection-index': 'node scripts/spatial-selection-index-audit.mjs --strict',
      'test:tooling': 'node --test scripts/spatial-selection-index-audit.test.mjs',
      verify: 'npm run quality:spatial-selection-index',
    },
  }),
  [PATHS.qualityWorkflow]: 'run: npm run quality:spatial-selection-index',
  [PATHS.releaseWorkflow]: 'run: npm run quality:spatial-selection-index',
});

const ids = (result) => new Set(result.errors.map((entry) => entry.id));

test('self-test proves both passing and unsafe audit paths', () => {
  const result = runSpatialSelectionIndexAuditSelfTest();
  assert.equal(result.passingErrors, 0);
  assert.ok(result.unsafeErrors >= 2);
});

test('accepts a complete spatial selection index contract', () => {
  const result = auditSpatialSelectionIndexSources(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('fails closed when the runtime is missing', () => {
  const files = fixture();
  delete files[PATHS.runtime];
  const result = auditSpatialSelectionIndexSources(files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => (
    entry.id === 'missing-file'
    && entry.file === PATHS.runtime
  )));
});

test('requires reuse of the shared spatial grid primitive', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'createSpatialGridIndex();',
    'createPrivateIndex();',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('shared-grid-index'));
});

test('requires extent candidate work to cross the shared grid boundary', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'this.#grid.queryExtent();',
    'this.#records.values();',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('grid-query-boundary'));
});

test('requires an explicit maximum candidate budget', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'maxQueryCandidates;',
    'queryCandidates;',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('bounded-query-candidates'));
});

test('requires bounded nearest expansion', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'nearestExpansionSteps;',
    'nearestExpansion;',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('bounded-nearest-expansion'));
});

test('requires explicit AbortSignal observation', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'throwIfSelectionAborted();',
    '',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('abort-aware-query'));
});

test('requires deterministic disposal', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace(
    'public dispose() {}',
    'public close() {}',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('deterministic-disposal'));
});

test('requires a bounded mutation history', () => {
  const files = fixture();
  files[PATHS.runtime] = files[PATHS.runtime].replace('#history;', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('bounded-history-runtime'));
});

test('requires global entry and byte budgets', () => {
  const files = fixture();
  files[PATHS.contracts] = files[PATHS.contracts]
    .replace('maxEntries;', '')
    .replace('maxBytes;', '');

  const resultIds = ids(auditSpatialSelectionIndexSources(files));
  assert.ok(resultIds.has('global-entry-budget'));
  assert.ok(resultIds.has('global-byte-budget'));
});

test('requires per-layer entry and byte budgets', () => {
  const files = fixture();
  files[PATHS.contracts] = files[PATHS.contracts]
    .replace('maxEntriesPerLayer;', '')
    .replace('maxBytesPerLayer;', '');

  const resultIds = ids(auditSpatialSelectionIndexSources(files));
  assert.ok(resultIds.has('layer-entry-budget'));
  assert.ok(resultIds.has('layer-byte-budget'));
});

test('requires a bounded layer count', () => {
  const files = fixture();
  files[PATHS.contracts] = files[PATHS.contracts].replace('maxLayers;', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('layer-count-budget'));
});

test('requires a bounded history contract', () => {
  const files = fixture();
  files[PATHS.contracts] = files[PATHS.contracts].replace('maxHistory;', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('bounded-history-contract'));
});

test('requires degraded and blocked health thresholds together', () => {
  const files = fixture();
  files[PATHS.contracts] = files[PATHS.contracts].replace(
    'degradedBudgetRatio; blockedBudgetRatio;',
    'healthyBudgetRatio;',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('health-thresholds'));
});

test('rejects direct fetch transport from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += "fetch('/selection');";

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('direct-fetch'));
});

test('rejects axios transport from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += 'const transport = axios;';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('axios-transport'));
});

test('rejects XMLHttpRequest transport from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += 'const transport = XMLHttpRequest;';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('xhr-transport'));
});

test('rejects WebSocket transport from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += 'const transport = WebSocket;';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('websocket-transport'));
});

test('rejects EventSource transport from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += 'const transport = EventSource;';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('eventsource-transport'));
});

test('rejects recurring polling from the selection runtime', () => {
  const files = fixture();
  files[PATHS.runtime] += 'setInterval(() => {}, 1000);';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('recurring-polling'));
});

test('rejects browser persistence from the selection runtime', () => {
  const stores = ['localStorage', 'sessionStorage', 'indexedDB'];

  stores.map((store) => {
    const files = fixture();
    files[PATHS.runtime] += `const store = ${store};`;
    assert.ok(
      ids(auditSpatialSelectionIndexSources(files)).has('browser-persistence'),
      `expected browser-persistence for ${store}`,
    );
    return store;
  });
});

test('rejects embedded remote URLs from production selection sources', () => {
  const files = fixture();
  files[PATHS.contracts] += "const endpoint = 'https://example.test';";

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('remote-url'));
});

test('rejects direct for loops that can reintroduce full-set scans', () => {
  const files = fixture();
  files[PATHS.runtime] += 'for (let index = 0; index < 10; index += 1) {}';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('direct-for-loop'));
});

test('rejects synchronous while loops', () => {
  const files = fixture();
  files[PATHS.runtime] += 'while (true) { break; }';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('direct-while-loop'));
});

test('rejects forEach scans over mutable runtime collections', () => {
  const files = fixture();
  files[PATHS.runtime] += 'records.forEach(() => {});';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('foreach-loop'));
});

test('requires shared grid linear-cursor evidence', () => {
  const files = fixture();
  files[PATHS.grid] = files[PATHS.grid]
    .replace('// single linear cursor', '')
    .replace('Array.from({ length: range.count }, () => 0);', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('linear-grid-cursor'));
});

test('requires every shared grid resource budget', () => {
  const contracts = [
    ['bounded-grid-features', 'maximumFeatures;'],
    ['bounded-grid-cells', 'maximumCells;'],
    ['bounded-grid-references', 'maximumReferences;'],
    ['bounded-grid-feature-cells', 'maximumCellsPerFeature;'],
    ['bounded-grid-bucket', 'maximumBucketSize;'],
  ];

  contracts.map(([expected, token]) => {
    const files = fixture();
    files[PATHS.grid] = files[PATHS.grid].replace(token, '');
    assert.ok(
      ids(auditSpatialSelectionIndexSources(files)).has(expected),
      `expected ${expected}`,
    );
    return expected;
  });
});

test('requires analysis-kernel ownership of the selection runtime', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'createSpatialSelectionIndexRuntime();',
    '',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-runtime-factory'));
});

test('requires kernel index admission API', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace('indexSelection<T>() {}', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-index-api'));
});

test('requires kernel extent-query API', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace('querySelectionIndex<T>() {}', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-query-api'));
});

test('requires kernel nearest-query API', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace('nearestIndexedSelection<T>() {}', '');

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-nearest-api'));
});

test('requires kernel diagnostics to include selection health', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'selectionIndex: this.#selectionIndex.snapshot();',
    '',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-selection-snapshot'));
});

test('requires kernel disposal to own selection-index teardown', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'this.#selectionIndex.dispose();',
    '',
  );

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('kernel-selection-disposal'));
});

test('requires all selection sources and tests in strict GIS TypeScript boundary', () => {
  const required = [
    PATHS.contracts,
    PATHS.runtime,
    PATHS.runtimeTest,
    PATHS.kernelIntegration,
  ];

  required.map((target) => {
    const files = fixture();
    const config = JSON.parse(files[PATHS.tsconfig]);
    config.files = config.files.filter((file) => file !== target);
    files[PATHS.tsconfig] = JSON.stringify(config);

    const result = auditSpatialSelectionIndexSources(files);
    assert.ok(result.errors.some((entry) => (
      entry.id === 'missing-strict-boundary-file'
      && entry.message.includes(target)
    )));
    return target;
  });
});

test('reports invalid strict compiler JSON', () => {
  const files = fixture();
  files[PATHS.tsconfig] = '{';

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('invalid-json'));
});

test('requires package quality command', () => {
  const files = fixture();
  const parsed = JSON.parse(files[PATHS.package]);
  delete parsed.scripts['quality:spatial-selection-index'];
  files[PATHS.package] = JSON.stringify(parsed);

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('missing-package-quality-gate'));
});

test('requires audit unit tests in native tooling suite', () => {
  const files = fixture();
  const parsed = JSON.parse(files[PATHS.package]);
  parsed.scripts['test:tooling'] = 'node --test scripts/other.test.mjs';
  files[PATHS.package] = JSON.stringify(parsed);

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('missing-tooling-test'));
});

test('requires package verify chain to include selection governance', () => {
  const files = fixture();
  const parsed = JSON.parse(files[PATHS.package]);
  parsed.scripts.verify = 'npm run lint:strict';
  files[PATHS.package] = JSON.stringify(parsed);

  assert.ok(ids(auditSpatialSelectionIndexSources(files)).has('missing-verify-gate'));
});

test('requires Webclient Quality to enforce selection governance', () => {
  const files = fixture();
  files[PATHS.qualityWorkflow] = 'run: npm run lint';

  const result = auditSpatialSelectionIndexSources(files);
  assert.ok(result.errors.some((entry) => (
    entry.id === 'missing-workflow-gate'
    && entry.file === PATHS.qualityWorkflow
  )));
});

test('requires Release QA to enforce selection governance', () => {
  const files = fixture();
  files[PATHS.releaseWorkflow] = 'run: npm run build';

  const result = auditSpatialSelectionIndexSources(files);
  assert.ok(result.errors.some((entry) => (
    entry.id === 'missing-workflow-gate'
    && entry.file === PATHS.releaseWorkflow
  )));
});

test('rejects JavaScript twins of strict TypeScript selection sources', () => {
  const files = fixture();
  files['src/gis-engine/spatialSelectionIndexRuntime.js'] = 'export const legacy = true;';
  files['src/gis-engine/spatialSelectionIndexContracts.cjs'] = 'module.exports = {};';

  const result = auditSpatialSelectionIndexSources(files);
  assert.equal(
    result.errors.filter((entry) => entry.id === 'legacy-javascript-twin').length,
    2,
  );
});

test('returns deterministic checked-file ordering for release artifacts', () => {
  const result = auditSpatialSelectionIndexSources(fixture());
  assert.deepEqual(
    result.checkedFiles,
    [...result.checkedFiles].sort(),
  );
});
