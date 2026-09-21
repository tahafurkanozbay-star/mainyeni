import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditGisQueryGovernanceSources,
  runSelfTest,
} from './gis-query-governance-audit.mjs';

const PATHS = Object.freeze({
  lifecycle: 'src/gis-engine/queryLifecycle.ts',
  controlPlane: 'src/gis-engine/spatialQueryControlPlane.ts',
  kernel: 'src/gis-engine/modernGisKernel.ts',
  tsconfig: 'tsconfig.gis-modern-core.json',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
});

const fixture = () => ({
  [PATHS.lifecycle]: `
    export class QueryLifecycleCoordinator {
      maxQueued = 10;
      maxRecentEntries = 10;
      maxSubscribersPerQuery = 10;
      timeoutMs = 1000;
      public dispose() {}
    }
  `,
  [PATHS.controlPlane]: `
    createSpatialQueryLifecycleRuntime();
    createSpatialQueryExecutionSupervisor();
    createSpatialQueryCacheRuntime();
    new QueryLifecycleCoordinator();
    export const createSpatialQueryControlPlane = () => {};
    const invalidateLayer = () => {};
    const invalidateService = () => {};
    const ownerFingerprint = 'owner-fingerprint';
  `,
  [PATHS.kernel]: `
    createSpatialQueryControlPlane();
    const queryControlPlane = {};
    queryControlPlane.execute();
    signal: governedSignal;
    bypassCache: true;
    queryControlPlane.invalidateLayer();
    queryControlPlane.invalidateService();
    queryControlPlane: queryControlPlane.snapshot();
    queryControlPlane.dispose();
  `,
  [PATHS.tsconfig]: JSON.stringify({
    files: [
      PATHS.lifecycle,
      'src/gis-engine/queryLifecycle.test.ts',
      PATHS.controlPlane,
      'src/gis-engine/spatialQueryControlPlane.test.ts',
      'src/gis-engine/modernGisQueryControlPlane.integration.test.ts',
    ],
  }),
  [PATHS.package]: JSON.stringify({
    scripts: {
      'quality:gis-query-governance': 'node scripts/gis-query-governance-audit.mjs --strict',
      'test:tooling': 'node --test scripts/gis-query-governance-audit.test.mjs',
      verify: 'npm run quality:gis-query-governance',
    },
  }),
  [PATHS.qualityWorkflow]: 'run: npm run quality:gis-query-governance',
  [PATHS.releaseWorkflow]: 'run: npm run quality:gis-query-governance',
});

test('self-test proves pass and unsafe-source detection paths', () => {
  const result = runSelfTest();
  assert.equal(result.passingErrors, 0);
  assert.ok(result.unsafeErrors >= 2);
});

test('accepts the complete governance contract', () => {
  const result = auditGisQueryGovernanceSources(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('fails closed when a required source file is missing', () => {
  const files = fixture();
  delete files[PATHS.controlPlane];
  const result = auditGisQueryGovernanceSources(files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => (
    entry.id === 'missing-file'
    && entry.file === PATHS.controlPlane
  )));
});

test('rejects direct fetch and embedded remote URLs in governance source', () => {
  const files = fixture();
  files[PATHS.controlPlane] += `
    export const unsafe = () => fetch('https://example.test/private');
  `;

  const result = auditGisQueryGovernanceSources(files);
  const ids = new Set(result.errors.map((entry) => entry.id));

  assert.equal(result.ok, false);
  assert.ok(ids.has('direct-fetch'));
  assert.ok(ids.has('remote-url'));
});

test('rejects alternate axios and browser transport stacks', () => {
  const transports = [
    ['axios-transport', 'const transport = axios;'],
    ['xhr-transport', 'const transport = XMLHttpRequest;'],
    ['websocket-transport', 'const transport = WebSocket;'],
    ['eventsource-transport', 'const transport = EventSource;'],
    ['beacon-transport', 'const transport = navigator.sendBeacon;'],
  ];

  for (const [expected, source] of transports) {
    const files = fixture();
    files[PATHS.controlPlane] += source;
    const result = auditGisQueryGovernanceSources(files);
    assert.ok(
      result.errors.some((entry) => entry.id === expected),
      `expected ${expected}`,
    );
  }
});

test('rejects recurring polling and browser persistence', () => {
  const files = fixture();
  files[PATHS.controlPlane] += `
    setInterval(() => {}, 1000);
    localStorage.setItem('query', 'value');
  `;

  const result = auditGisQueryGovernanceSources(files);
  const ids = new Set(result.errors.map((entry) => entry.id));

  assert.ok(ids.has('recurring-polling'));
  assert.ok(ids.has('browser-persistence'));
});

test('requires bounded queue, result retention and subscriber fan-out', () => {
  const required = [
    ['bounded-queue', 'maxQueued'],
    ['bounded-recent-cache', 'maxRecentEntries'],
    ['bounded-subscribers', 'maxSubscribersPerQuery'],
    ['hard-timeout', 'timeoutMs'],
  ];

  for (const [expected, token] of required) {
    const files = fixture();
    files[PATHS.lifecycle] = files[PATHS.lifecycle].replace(token, 'removedToken');
    const result = auditGisQueryGovernanceSources(files);
    assert.ok(
      result.errors.some((entry) => entry.id === expected),
      `expected ${expected}`,
    );
  }
});

test('requires deterministic lifecycle disposal', () => {
  const files = fixture();
  files[PATHS.lifecycle] = files[PATHS.lifecycle].replace(
    'public dispose() {}',
    'public close() {}',
  );

  const result = auditGisQueryGovernanceSources(files);
  assert.ok(result.errors.some((entry) => entry.id === 'deterministic-dispose'));
});

test('requires control-plane composition of lifecycle, supervision, cache and queue', () => {
  const contracts = [
    ['lifecycle-composition', 'createSpatialQueryLifecycleRuntime'],
    ['supervision-composition', 'createSpatialQueryExecutionSupervisor'],
    ['cache-composition', 'createSpatialQueryCacheRuntime'],
    ['queue-composition', 'new QueryLifecycleCoordinator'],
  ];

  for (const [expected, token] of contracts) {
    const files = fixture();
    files[PATHS.controlPlane] = files[PATHS.controlPlane].replace(
      token,
      'removedContract',
    );
    const result = auditGisQueryGovernanceSources(files);
    assert.ok(
      result.errors.some((entry) => entry.id === expected),
      `expected ${expected}`,
    );
  }
});

test('requires layer and service invalidation surfaces', () => {
  const files = fixture();
  files[PATHS.controlPlane] = files[PATHS.controlPlane]
    .replace('const invalidateLayer = () => {};', '')
    .replace('const invalidateService = () => {};', '');

  const result = auditGisQueryGovernanceSources(files);
  const ids = new Set(result.errors.map((entry) => entry.id));

  assert.ok(ids.has('layer-invalidation'));
  assert.ok(ids.has('service-invalidation'));
});

test('requires privacy-safe event fingerprints', () => {
  const files = fixture();
  files[PATHS.controlPlane] = files[PATHS.controlPlane].replace(
    "const ownerFingerprint = 'owner-fingerprint';",
    "const rawOwner = 'owner';",
  );

  const result = auditGisQueryGovernanceSources(files);
  assert.ok(result.errors.some((entry) => entry.id === 'privacy-fingerprint'));
});

test('requires modern kernel execution to cross governance before scheduler transport', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'queryControlPlane.execute();',
    'scheduler.schedule();',
  );

  const result = auditGisQueryGovernanceSources(files);
  assert.ok(result.errors.some((entry) => entry.id === 'kernel-execution-boundary'));
});

test('requires the governed AbortSignal to reach scheduler transport', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'signal: governedSignal;',
    'signal: callerSignal;',
  );

  const result = auditGisQueryGovernanceSources(files);
  assert.ok(result.errors.some((entry) => entry.id === 'governed-signal'));
});

test('requires scheduler cache to remain authoritative during kernel migration', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel].replace(
    'bypassCache: true;',
    'bypassCache: false;',
  );

  const result = auditGisQueryGovernanceSources(files);
  assert.ok(result.errors.some((entry) => entry.id === 'avoid-double-cache'));
});

test('requires kernel layer and service invalidation integration', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel]
    .replace('queryControlPlane.invalidateLayer();', '')
    .replace('queryControlPlane.invalidateService();', '');

  const result = auditGisQueryGovernanceSources(files);
  const ids = new Set(result.errors.map((entry) => entry.id));

  assert.ok(ids.has('kernel-layer-invalidation'));
  assert.ok(ids.has('kernel-service-invalidation'));
});

test('requires query-control diagnostics and kernel-owned disposal', () => {
  const files = fixture();
  files[PATHS.kernel] = files[PATHS.kernel]
    .replace('queryControlPlane: queryControlPlane.snapshot();', '')
    .replace('queryControlPlane.dispose();', '');

  const result = auditGisQueryGovernanceSources(files);
  const ids = new Set(result.errors.map((entry) => entry.id));

  assert.ok(ids.has('kernel-diagnostics'));
  assert.ok(ids.has('kernel-disposal'));
});

test('requires every governance source and regression suite in strict GIS compiler boundary', () => {
  const required = [
    PATHS.lifecycle,
    'src/gis-engine/queryLifecycle.test.ts',
    PATHS.controlPlane,
    'src/gis-engine/spatialQueryControlPlane.test.ts',
    'src/gis-engine/modernGisQueryControlPlane.integration.test.ts',
  ];

  for (const target of required) {
    const files = fixture();
    const config = JSON.parse(files[PATHS.tsconfig]);
    config.files = config.files.filter((entry) => entry !== target);
    files[PATHS.tsconfig] = JSON.stringify(config);

    const result = auditGisQueryGovernanceSources(files);
    assert.ok(
      result.errors.some((entry) => (
        entry.id === 'missing-strict-boundary-file'
        && entry.message.includes(target)
      )),
      `expected strict-boundary failure for ${target}`,
    );
  }
});

test('requires the package quality command, tooling unit test and verify chain', () => {
  const cases = [
    ['missing-package-script', 'quality:gis-query-governance'],
    ['missing-tooling-test', 'test:tooling'],
    ['missing-verify-gate', 'verify'],
  ];

  for (const [expected, script] of cases) {
    const files = fixture();
    const packageJson = JSON.parse(files[PATHS.package]);
    delete packageJson.scripts[script];
    files[PATHS.package] = JSON.stringify(packageJson);

    const result = auditGisQueryGovernanceSources(files);
    assert.ok(
      result.errors.some((entry) => entry.id === expected),
      `expected ${expected}`,
    );
  }
});

test('requires both Webclient Quality and Release QA to run the governance gate', () => {
  for (const workflow of [PATHS.qualityWorkflow, PATHS.releaseWorkflow]) {
    const files = fixture();
    files[workflow] = 'run: npm run lint';
    const result = auditGisQueryGovernanceSources(files);

    assert.ok(result.errors.some((entry) => (
      entry.id === 'missing-workflow-gate'
      && entry.file === workflow
    )));
  }
});

test('rejects JavaScript twins that could shadow typed governance source', () => {
  const files = fixture();
  files['src/gis-engine/queryLifecycle.js'] = 'export const legacy = true;';
  files['src/gis-engine/spatialQueryControlPlane.cjs'] = 'module.exports = {};';

  const result = auditGisQueryGovernanceSources(files);
  const twins = result.errors.filter((entry) => entry.id === 'legacy-javascript-twin');

  assert.equal(twins.length, 2);
});

test('reports invalid JSON in strict compiler or package contracts', () => {
  const files = fixture();
  files[PATHS.tsconfig] = '{';
  files[PATHS.package] = '{';

  const result = auditGisQueryGovernanceSources(files);
  const invalid = result.errors.filter((entry) => entry.id === 'invalid-json');

  assert.equal(invalid.length, 2);
});

test('returns deterministic checked file ordering for release artifacts', () => {
  const files = fixture();
  const result = auditGisQueryGovernanceSources(files);
  const sorted = [...result.checkedFiles].sort();

  assert.deepEqual(result.checkedFiles, sorted);
});
