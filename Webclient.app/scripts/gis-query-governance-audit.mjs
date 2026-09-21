import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PATHS = Object.freeze({
  lifecycle: 'src/gis-engine/queryLifecycle.ts',
  controlPlane: 'src/gis-engine/spatialQueryControlPlane.ts',
  kernel: 'src/gis-engine/modernGisKernel.ts',
  tsconfig: 'tsconfig.gis-modern-core.json',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
});

const FORBIDDEN_RUNTIME_PATTERNS = Object.freeze([
  {
    id: 'direct-fetch',
    pattern: /\bfetch\s*\(/u,
    message: 'query governance must not create a direct fetch transport',
  },
  {
    id: 'axios-transport',
    pattern: /\baxios\b/u,
    message: 'query governance must not create a parallel axios transport',
  },
  {
    id: 'xhr-transport',
    pattern: /\bXMLHttpRequest\b/u,
    message: 'query governance must not create an XMLHttpRequest transport',
  },
  {
    id: 'websocket-transport',
    pattern: /\bWebSocket\b/u,
    message: 'query governance must not create a WebSocket transport',
  },
  {
    id: 'eventsource-transport',
    pattern: /\bEventSource\b/u,
    message: 'query governance must not create an EventSource transport',
  },
  {
    id: 'beacon-transport',
    pattern: /\bsendBeacon\b/u,
    message: 'query governance must not create a telemetry beacon',
  },
  {
    id: 'recurring-polling',
    pattern: /\bsetInterval\s*\(/u,
    message: 'query governance must not create a recurring polling loop',
  },
  {
    id: 'browser-persistence',
    pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/u,
    message: 'query governance must not create browser persistence',
  },
  {
    id: 'remote-url',
    pattern: /https?:\/\//iu,
    message: 'query governance production source must not embed remote URLs',
  },
]);

const REQUIRED_SOURCE_CONTRACTS = Object.freeze([
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'lifecycle-coordinator',
    pattern: /export\s+class\s+QueryLifecycleCoordinator\b/u,
    message: 'QueryLifecycleCoordinator export is required',
  },
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'bounded-queue',
    pattern: /maxQueued/u,
    message: 'query lifecycle must declare a bounded queue',
  },
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'bounded-recent-cache',
    pattern: /maxRecentEntries/u,
    message: 'query lifecycle must bound recent-result retention',
  },
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'bounded-subscribers',
    pattern: /maxSubscribersPerQuery/u,
    message: 'query lifecycle must bound deduplicated subscriber fan-out',
  },
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'hard-timeout',
    pattern: /timeoutMs/u,
    message: 'query lifecycle must retain a hard timeout',
  },
  {
    path: REQUIRED_PATHS.lifecycle,
    id: 'deterministic-dispose',
    pattern: /public\s+dispose\s*\(/u,
    message: 'query lifecycle must expose deterministic disposal',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'control-plane-factory',
    pattern: /export\s+const\s+createSpatialQueryControlPlane\b/u,
    message: 'SpatialQueryControlPlane factory is required',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'lifecycle-composition',
    pattern: /createSpatialQueryLifecycleRuntime/u,
    message: 'control plane must compose the spatial query lifecycle runtime',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'supervision-composition',
    pattern: /createSpatialQueryExecutionSupervisor/u,
    message: 'control plane must compose admission/budget supervision',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'cache-composition',
    pattern: /createSpatialQueryCacheRuntime/u,
    message: 'control plane must compose the bounded spatial cache runtime',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'queue-composition',
    pattern: /new\s+QueryLifecycleCoordinator\s*\(/u,
    message: 'control plane must compose the priority-aware query lifecycle queue',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'layer-invalidation',
    pattern: /invalidateLayer\s*=|const\s+invalidateLayer/u,
    message: 'control plane must expose layer invalidation',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'service-invalidation',
    pattern: /invalidateService\s*=|const\s+invalidateService/u,
    message: 'control plane must expose service invalidation',
  },
  {
    path: REQUIRED_PATHS.controlPlane,
    id: 'privacy-fingerprint',
    pattern: /ownerFingerprint/u,
    message: 'control plane events must project privacy-safe owner fingerprints',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-import',
    pattern: /createSpatialQueryControlPlane/u,
    message: 'modern GIS kernel must import the spatial query control plane',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-instance',
    pattern: /const\s+queryControlPlane\s*=/u,
    message: 'modern GIS kernel must own one query control-plane instance',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-execution-boundary',
    pattern: /queryControlPlane\.execute/u,
    message: 'kernel executeQuery must cross the query control-plane boundary',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'governed-signal',
    pattern: /signal:\s*governedSignal/u,
    message: 'scheduler transport must receive the governed AbortSignal',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'avoid-double-cache',
    pattern: /bypassCache:\s*true/u,
    message: 'kernel integration must avoid a second result cache in front of scheduler cache',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-layer-invalidation',
    pattern: /queryControlPlane\.invalidateLayer/u,
    message: 'kernel layer invalidation must invalidate governed query state',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-service-invalidation',
    pattern: /queryControlPlane\.invalidateService/u,
    message: 'kernel service unregister must invalidate governed query state',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-diagnostics',
    pattern: /queryControlPlane:\s*queryControlPlane\.snapshot\(\)/u,
    message: 'kernel diagnostics must expose query governance health',
  },
  {
    path: REQUIRED_PATHS.kernel,
    id: 'kernel-disposal',
    pattern: /queryControlPlane\.dispose/u,
    message: 'kernel destroy must dispose query governance',
  },
]);

const toPosix = (value) => value.split(path.sep).join('/');

const finding = (
  severity,
  id,
  file,
  message,
) => Object.freeze({
  severity,
  id,
  file,
  message,
});

const parseJson = (
  source,
  file,
  errors,
) => {
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(finding(
      'error',
      'invalid-json',
      file,
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
};

const hasFile = (files, file) => (
  Object.prototype.hasOwnProperty.call(files, file)
);

const readRequired = (
  files,
  file,
  errors,
) => {
  const value = files[file];
  if (typeof value === 'string') return value;
  errors.push(finding(
    'error',
    'missing-file',
    file,
    `required GIS query governance file is missing: ${file}`,
  ));
  return '';
};

const checkStrictCompilerBoundary = (
  files,
  errors,
) => {
  const source = readRequired(files, REQUIRED_PATHS.tsconfig, errors);
  if (!source) return;
  const config = parseJson(source, REQUIRED_PATHS.tsconfig, errors);
  if (!config) return;

  const declared = new Set(
    Array.isArray(config.files)
      ? config.files.filter((value) => typeof value === 'string')
      : [],
  );
  for (const required of [
    REQUIRED_PATHS.lifecycle,
    'src/gis-engine/queryLifecycle.test.ts',
    REQUIRED_PATHS.controlPlane,
    'src/gis-engine/spatialQueryControlPlane.test.ts',
    'src/gis-engine/modernGisQueryControlPlane.integration.test.ts',
  ]) {
    if (!declared.has(required)) {
      errors.push(finding(
        'error',
        'missing-strict-boundary-file',
        REQUIRED_PATHS.tsconfig,
        `strict GIS compiler boundary must include ${required}`,
      ));
    }
  }
};

const checkPackageContract = (
  files,
  errors,
) => {
  const source = readRequired(files, REQUIRED_PATHS.package, errors);
  if (!source) return;
  const packageJson = parseJson(source, REQUIRED_PATHS.package, errors);
  if (!packageJson) return;

  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  const command = scripts['quality:gis-query-governance'];
  if (
    typeof command !== 'string'
    || !command.includes('gis-query-governance-audit.mjs')
    || !command.includes('--strict')
  ) {
    errors.push(finding(
      'error',
      'missing-package-script',
      REQUIRED_PATHS.package,
      'package.json must expose strict quality:gis-query-governance',
    ));
  }

  const tooling = scripts['test:tooling'];
  if (
    typeof tooling !== 'string'
    || !tooling.includes('gis-query-governance-audit.test.mjs')
  ) {
    errors.push(finding(
      'error',
      'missing-tooling-test',
      REQUIRED_PATHS.package,
      'test:tooling must run GIS query governance audit tests',
    ));
  }

  const verify = scripts.verify;
  if (
    typeof verify !== 'string'
    || !verify.includes('quality:gis-query-governance')
  ) {
    errors.push(finding(
      'error',
      'missing-verify-gate',
      REQUIRED_PATHS.package,
      'verify must enforce GIS query governance before release validation',
    ));
  }
};

const checkWorkflowContract = (
  files,
  errors,
) => {
  for (const workflow of [
    REQUIRED_PATHS.qualityWorkflow,
    REQUIRED_PATHS.releaseWorkflow,
  ]) {
    const source = readRequired(files, workflow, errors);
    if (!source) continue;
    if (!/npm\s+run\s+quality:gis-query-governance/u.test(source)) {
      errors.push(finding(
        'error',
        'missing-workflow-gate',
        workflow,
        'workflow must execute quality:gis-query-governance',
      ));
    }
  }
};

const checkForbiddenRuntimeBehavior = (
  files,
  errors,
) => {
  for (const file of [
    REQUIRED_PATHS.lifecycle,
    REQUIRED_PATHS.controlPlane,
  ]) {
    const source = readRequired(files, file, errors);
    if (!source) continue;
    for (const rule of FORBIDDEN_RUNTIME_PATTERNS) {
      if (!rule.pattern.test(source)) continue;
      errors.push(finding(
        'error',
        rule.id,
        file,
        rule.message,
      ));
    }
  }
};

const checkSourceContracts = (
  files,
  errors,
) => {
  for (const contract of REQUIRED_SOURCE_CONTRACTS) {
    const source = readRequired(files, contract.path, errors);
    if (!source || contract.pattern.test(source)) continue;
    errors.push(finding(
      'error',
      contract.id,
      contract.path,
      contract.message,
    ));
  }
};

const checkNoLegacyJavascriptTwin = (
  files,
  errors,
) => {
  for (const source of [
    REQUIRED_PATHS.lifecycle,
    REQUIRED_PATHS.controlPlane,
  ]) {
    const stem = source.replace(/\.ts$/u, '');
    for (const extension of ['.js', '.jsx', '.mjs', '.cjs']) {
      const legacy = `${stem}${extension}`;
      if (!hasFile(files, legacy)) continue;
      errors.push(finding(
        'error',
        'legacy-javascript-twin',
        legacy,
        `typed GIS source must not have a legacy JavaScript twin: ${legacy}`,
      ));
    }
  }
};

export const auditGisQueryGovernanceSources = (
  files,
) => {
  const errors = [];
  const warnings = [];

  checkSourceContracts(files, errors);
  checkForbiddenRuntimeBehavior(files, errors);
  checkStrictCompilerBoundary(files, errors);
  checkPackageContract(files, errors);
  checkWorkflowContract(files, errors);
  checkNoLegacyJavascriptTwin(files, errors);

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    checkedFiles: Object.freeze(Object.keys(files).sort()),
  });
};

const repositoryFiles = (
  root,
) => {
  const files = {};
  for (const file of Object.values(REQUIRED_PATHS)) {
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute)) continue;
    files[toPosix(file)] = fs.readFileSync(absolute, 'utf8');
  }

  const scriptTest = 'scripts/gis-query-governance-audit.test.mjs';
  const testAbsolute = path.resolve(root, scriptTest);
  if (fs.existsSync(testAbsolute)) {
    files[scriptTest] = fs.readFileSync(testAbsolute, 'utf8');
  }

  for (const legacy of [
    'src/gis-engine/queryLifecycle.js',
    'src/gis-engine/queryLifecycle.jsx',
    'src/gis-engine/queryLifecycle.mjs',
    'src/gis-engine/queryLifecycle.cjs',
    'src/gis-engine/spatialQueryControlPlane.js',
    'src/gis-engine/spatialQueryControlPlane.jsx',
    'src/gis-engine/spatialQueryControlPlane.mjs',
    'src/gis-engine/spatialQueryControlPlane.cjs',
  ]) {
    const absolute = path.resolve(root, legacy);
    if (fs.existsSync(absolute)) {
      files[legacy] = fs.readFileSync(absolute, 'utf8');
    }
  }

  return files;
};

export const auditGisQueryGovernanceRepository = (
  root = process.cwd(),
) => auditGisQueryGovernanceSources(repositoryFiles(root));

const selfTestFiles = () => ({
  [REQUIRED_PATHS.lifecycle]: `
    export class QueryLifecycleCoordinator {
      maxQueued = 1;
      maxRecentEntries = 1;
      maxSubscribersPerQuery = 1;
      timeoutMs = 1;
      public dispose() {}
    }
  `,
  [REQUIRED_PATHS.controlPlane]: `
    createSpatialQueryLifecycleRuntime();
    createSpatialQueryExecutionSupervisor();
    createSpatialQueryCacheRuntime();
    new QueryLifecycleCoordinator();
    export const createSpatialQueryControlPlane = () => {};
    const invalidateLayer = () => {};
    const invalidateService = () => {};
    const ownerFingerprint = 'owner-x';
  `,
  [REQUIRED_PATHS.kernel]: `
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
  [REQUIRED_PATHS.tsconfig]: JSON.stringify({
    files: [
      REQUIRED_PATHS.lifecycle,
      'src/gis-engine/queryLifecycle.test.ts',
      REQUIRED_PATHS.controlPlane,
      'src/gis-engine/spatialQueryControlPlane.test.ts',
      'src/gis-engine/modernGisQueryControlPlane.integration.test.ts',
    ],
  }),
  [REQUIRED_PATHS.package]: JSON.stringify({
    scripts: {
      'quality:gis-query-governance': 'node scripts/gis-query-governance-audit.mjs --strict',
      'test:tooling': 'node --test scripts/gis-query-governance-audit.test.mjs',
      verify: 'npm run quality:gis-query-governance',
    },
  }),
  [REQUIRED_PATHS.qualityWorkflow]: 'run: npm run quality:gis-query-governance',
  [REQUIRED_PATHS.releaseWorkflow]: 'run: npm run quality:gis-query-governance',
});

export const runSelfTest = () => {
  const passing = auditGisQueryGovernanceSources(selfTestFiles());
  if (!passing.ok) {
    throw new Error(
      `GIS query governance audit self-test expected pass but received: ${JSON.stringify(passing.errors)}`,
    );
  }

  const unsafe = {
    ...selfTestFiles(),
    [REQUIRED_PATHS.controlPlane]: `
      createSpatialQueryLifecycleRuntime();
      createSpatialQueryExecutionSupervisor();
      createSpatialQueryCacheRuntime();
      new QueryLifecycleCoordinator();
      export const createSpatialQueryControlPlane = () => fetch('https://example.test');
      const invalidateLayer = () => {};
      const invalidateService = () => {};
      const ownerFingerprint = 'owner-x';
    `,
  };
  const failing = auditGisQueryGovernanceSources(unsafe);
  if (failing.ok) {
    throw new Error('GIS query governance audit self-test expected unsafe source to fail');
  }
  const ids = new Set(failing.errors.map((entry) => entry.id));
  for (const expected of ['direct-fetch', 'remote-url']) {
    if (!ids.has(expected)) {
      throw new Error(`GIS query governance audit self-test missing expected failure: ${expected}`);
    }
  }

  return Object.freeze({
    passingErrors: passing.errors.length,
    unsafeErrors: failing.errors.length,
  });
};

const isEntrypoint = (
  import.meta.url === new URL(`file://${process.argv[1] ?? ''}`).href
  || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')
);

if (isEntrypoint) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    const result = runSelfTest();
    process.stdout.write(
      `GIS query governance audit self-test passed (${result.unsafeErrors} unsafe findings detected).\n`,
    );
    process.exit(0);
  }

  const result = auditGisQueryGovernanceRepository(process.cwd());
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const error of result.errors) {
      process.stderr.write(
        `ERROR [${error.id}] ${error.file}: ${error.message}\n`,
      );
    }
    for (const warning of result.warnings) {
      process.stderr.write(
        `WARN [${warning.id}] ${warning.file}: ${warning.message}\n`,
      );
    }
    process.stdout.write(
      `GIS query governance audit checked ${result.checkedFiles.length} files: ${result.errors.length} error(s), ${result.warnings.length} warning(s).\n`,
    );
  }

  if (args.has('--strict') && !result.ok) process.exit(1);
}
