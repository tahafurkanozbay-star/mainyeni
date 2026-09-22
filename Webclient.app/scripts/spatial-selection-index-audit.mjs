import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REQUIRED_SOURCE_CONTRACTS = Object.freeze([
  [PATHS.runtime, 'shared-grid-index', /createSpatialGridIndex/u, 'selection index must reuse the shared spatial grid index'],
  [PATHS.runtime, 'grid-query-boundary', /#grid\.queryExtent/u, 'selection extent and nearest candidate work must cross the shared grid boundary'],
  [PATHS.runtime, 'bounded-query-candidates', /\bmaxQueryCandidates\b/u, 'selection candidate work must be explicitly bounded'],
  [PATHS.runtime, 'bounded-nearest-expansion', /\bnearestExpansionSteps\b/u, 'nearest selection expansion must be explicitly bounded'],
  [PATHS.runtime, 'abort-aware-query', /\bthrowIfSelectionAborted\b/u, 'selection queries must honor AbortSignal cancellation'],
  [PATHS.runtime, 'deterministic-disposal', /public\s+dispose\s*\(/u, 'selection index must own deterministic disposal'],
  [PATHS.runtime, 'bounded-history-runtime', /#history/u, 'selection mutation diagnostics must use bounded owned history'],
  [PATHS.contracts, 'global-entry-budget', /\bmaxEntries\b/u, 'selection contracts must define a global entry budget'],
  [PATHS.contracts, 'global-byte-budget', /\bmaxBytes\b/u, 'selection contracts must define a global byte budget'],
  [PATHS.contracts, 'layer-entry-budget', /\bmaxEntriesPerLayer\b/u, 'selection contracts must define a per-layer entry budget'],
  [PATHS.contracts, 'layer-byte-budget', /\bmaxBytesPerLayer\b/u, 'selection contracts must define a per-layer byte budget'],
  [PATHS.contracts, 'layer-count-budget', /\bmaxLayers\b/u, 'selection contracts must define a layer-count budget'],
  [PATHS.contracts, 'bounded-history-contract', /\bmaxHistory\b/u, 'selection contracts must define a bounded mutation history'],
  [PATHS.contracts, 'health-thresholds', /degradedBudgetRatio[\s\S]*blockedBudgetRatio/u, 'selection contracts must define degraded and blocked budget thresholds'],
  [PATHS.kernel, 'kernel-runtime-factory', /createSpatialSelectionIndexRuntime/u, 'analysis kernel must own the selection index runtime'],
  [PATHS.kernel, 'kernel-index-api', /indexSelection\s*</u, 'analysis kernel must expose indexed selection admission'],
  [PATHS.kernel, 'kernel-query-api', /querySelectionIndex\s*</u, 'analysis kernel must expose indexed extent queries'],
  [PATHS.kernel, 'kernel-nearest-api', /nearestIndexedSelection\s*</u, 'analysis kernel must expose bounded nearest queries'],
  [PATHS.kernel, 'kernel-selection-snapshot', /selectionIndex:\s*this\.#selectionIndex\.snapshot\(\)/u, 'analysis kernel diagnostics must expose selection-index health'],
  [PATHS.kernel, 'kernel-selection-disposal', /this\.#selectionIndex\.dispose\(\)/u, 'analysis kernel disposal must dispose the selection index'],
]);

const FORBIDDEN_RUNTIME_PATTERNS = Object.freeze([
  ['direct-fetch', /\bfetch\s*\(/u, 'selection index must not own browser/network transport'],
  ['axios-transport', /\baxios\b/u, 'selection index must not own axios transport'],
  ['xhr-transport', /\bXMLHttpRequest\b/u, 'selection index must not own XMLHttpRequest transport'],
  ['websocket-transport', /\bWebSocket\b/u, 'selection index must not own WebSocket transport'],
  ['eventsource-transport', /\bEventSource\b/u, 'selection index must not own EventSource transport'],
  ['recurring-polling', /\bsetInterval\s*\(/u, 'selection index must not create recurring polling'],
  ['browser-persistence', /\b(?:localStorage|sessionStorage|indexedDB)\b/u, 'selection index must remain in-memory and lifecycle-owned'],
  ['remote-url', /https?:\/\//iu, 'selection index production sources must not embed remote URLs'],
  ['direct-for-loop', /\bfor\s*\(/u, 'selection index runtime must use shared indexed/bounded collection primitives instead of direct full scans'],
  ['direct-while-loop', /\bwhile\s*\(/u, 'selection index runtime must not introduce unbounded synchronous while loops'],
  ['foreach-loop', /\.forEach\s*\(/u, 'selection index runtime must avoid full-set forEach scans'],
]);

const GRID_CONTRACTS = Object.freeze([
  ['linear-grid-cursor', /single linear cursor|Array\.from\(\{ length: range\.count \}/u],
  ['bounded-grid-features', /\bmaximumFeatures\b/u],
  ['bounded-grid-cells', /\bmaximumCells\b/u],
  ['bounded-grid-references', /\bmaximumReferences\b/u],
  ['bounded-grid-feature-cells', /\bmaximumCellsPerFeature\b/u],
  ['bounded-grid-bucket', /\bmaximumBucketSize\b/u],
]);

const LEGACY_TWINS = Object.freeze([
  'src/gis-engine/spatialSelectionIndexContracts.js',
  'src/gis-engine/spatialSelectionIndexContracts.jsx',
  'src/gis-engine/spatialSelectionIndexContracts.mjs',
  'src/gis-engine/spatialSelectionIndexContracts.cjs',
  'src/gis-engine/spatialSelectionIndexRuntime.js',
  'src/gis-engine/spatialSelectionIndexRuntime.jsx',
  'src/gis-engine/spatialSelectionIndexRuntime.mjs',
  'src/gis-engine/spatialSelectionIndexRuntime.cjs',
]);

const finding = (severity, id, file, message) => Object.freeze({ severity, id, file, message });

const requiredText = (files, file, errors) => {
  const value = files[file];
  if (typeof value === 'string') return value;
  errors.push(finding('error', 'missing-file', file, `required spatial selection file is missing: ${file}`));
  return '';
};

const parseJson = (source, file, errors) => {
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(finding('error', 'invalid-json', file, `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
};

const checkSourceContracts = (files, errors) => {
  REQUIRED_SOURCE_CONTRACTS.map(([file, id, pattern, message]) => {
    const source = requiredText(files, file, errors);
    if (source && !pattern.test(source)) errors.push(finding('error', id, file, message));
    return id;
  });
};

const checkForbiddenRuntimeBehavior = (files, errors) => {
  [PATHS.contracts, PATHS.runtime].map((file) => {
    const source = requiredText(files, file, errors);
    if (!source) return file;
    FORBIDDEN_RUNTIME_PATTERNS.map(([id, pattern, message]) => {
      if (pattern.test(source)) errors.push(finding('error', id, file, message));
      return id;
    });
    return file;
  });
};

const checkGridPrimitive = (files, errors) => {
  const source = requiredText(files, PATHS.grid, errors);
  if (!source) return;
  GRID_CONTRACTS.map(([id, pattern]) => {
    if (!pattern.test(source)) errors.push(finding('error', id, PATHS.grid, `shared spatial grid prerequisite is missing contract: ${id}`));
    return id;
  });
};

const checkStrictCompilerBoundary = (files, errors) => {
  const source = requiredText(files, PATHS.tsconfig, errors);
  if (!source) return;
  const parsed = parseJson(source, PATHS.tsconfig, errors);
  if (!parsed) return;
  const declared = new Set(Array.isArray(parsed.files) ? parsed.files.filter((value) => typeof value === 'string') : []);
  [PATHS.contracts, PATHS.runtime, PATHS.runtimeTest, PATHS.kernelIntegration].map((file) => {
    if (!declared.has(file)) errors.push(finding('error', 'missing-strict-boundary-file', PATHS.tsconfig, `strict GIS compiler boundary must include ${file}`));
    return file;
  });
};

const checkPackageContract = (files, errors) => {
  const source = requiredText(files, PATHS.package, errors);
  if (!source) return;
  const parsed = parseJson(source, PATHS.package, errors);
  if (!parsed) return;
  const scripts = parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  const quality = scripts['quality:spatial-selection-index'];
  if (typeof quality !== 'string' || !quality.includes('spatial-selection-index-audit.mjs') || !quality.includes('--strict')) {
    errors.push(finding('error', 'missing-package-quality-gate', PATHS.package, 'package.json must expose strict quality:spatial-selection-index'));
  }
  const tooling = scripts['test:tooling'];
  if (typeof tooling !== 'string' || !tooling.includes('spatial-selection-index-audit.test.mjs')) {
    errors.push(finding('error', 'missing-tooling-test', PATHS.package, 'test:tooling must execute the selection-index audit regression suite'));
  }
  const verify = scripts.verify;
  if (typeof verify !== 'string' || !verify.includes('quality:spatial-selection-index')) {
    errors.push(finding('error', 'missing-verify-gate', PATHS.package, 'package verify must enforce spatial-selection-index governance'));
  }
};

const checkWorkflowContract = (files, errors) => {
  [PATHS.qualityWorkflow, PATHS.releaseWorkflow].map((file) => {
    const source = requiredText(files, file, errors);
    if (source && !/npm\s+run\s+quality:spatial-selection-index/u.test(source)) {
      errors.push(finding('error', 'missing-workflow-gate', file, 'workflow must execute quality:spatial-selection-index'));
    }
    return file;
  });
};

const checkLegacyTwins = (files, errors) => {
  LEGACY_TWINS.map((file) => {
    if (Object.prototype.hasOwnProperty.call(files, file)) errors.push(finding('error', 'legacy-javascript-twin', file, `typed selection index must not have a JavaScript twin: ${file}`));
    return file;
  });
};

export const auditSpatialSelectionIndexSources = (files) => {
  const errors = [];
  const warnings = [];
  checkSourceContracts(files, errors);
  checkForbiddenRuntimeBehavior(files, errors);
  checkGridPrimitive(files, errors);
  checkStrictCompilerBoundary(files, errors);
  checkPackageContract(files, errors);
  checkWorkflowContract(files, errors);
  checkLegacyTwins(files, errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), warnings: Object.freeze(warnings), checkedFiles: Object.freeze(Object.keys(files).sort()) });
};

const readRepositoryFiles = (root) => {
  const files = {};
  Object.values(PATHS).map((file) => {
    const absolute = path.resolve(root, file);
    if (fs.existsSync(absolute)) files[file] = fs.readFileSync(absolute, 'utf8');
    return file;
  });
  LEGACY_TWINS.map((file) => {
    const absolute = path.resolve(root, file);
    if (fs.existsSync(absolute)) files[file] = fs.readFileSync(absolute, 'utf8');
    return file;
  });
  return files;
};

export const auditSpatialSelectionIndexRepository = (root = process.cwd()) => auditSpatialSelectionIndexSources(readRepositoryFiles(root));

const fixture = () => ({
  [PATHS.contracts]: 'maxEntries; maxBytes; maxEntriesPerLayer; maxBytesPerLayer; maxLayers; maxHistory; degradedBudgetRatio; blockedBudgetRatio;',
  [PATHS.runtime]: 'createSpatialGridIndex(); this.#grid.queryExtent(); maxQueryCandidates; nearestExpansionSteps; throwIfSelectionAborted(); #history; public dispose() {}',
  [PATHS.runtimeTest]: 'test("selection runtime", () => {});',
  [PATHS.kernel]: 'createSpatialSelectionIndexRuntime(); indexSelection<T>() {} querySelectionIndex<T>() {} nearestIndexedSelection<T>() {} selectionIndex: this.#selectionIndex.snapshot(); this.#selectionIndex.dispose();',
  [PATHS.kernelIntegration]: 'test("kernel selection integration", () => {});',
  [PATHS.grid]: '// single linear cursor\nArray.from({ length: range.count }, () => 0); maximumFeatures; maximumCells; maximumReferences; maximumCellsPerFeature; maximumBucketSize;',
  [PATHS.tsconfig]: JSON.stringify({ files: [PATHS.contracts, PATHS.runtime, PATHS.runtimeTest, PATHS.kernelIntegration] }),
  [PATHS.package]: JSON.stringify({ scripts: { 'quality:spatial-selection-index': 'node scripts/spatial-selection-index-audit.mjs --strict', 'test:tooling': 'node --test scripts/spatial-selection-index-audit.test.mjs', verify: 'npm run quality:spatial-selection-index' } }),
  [PATHS.qualityWorkflow]: 'run: npm run quality:spatial-selection-index',
  [PATHS.releaseWorkflow]: 'run: npm run quality:spatial-selection-index',
});

export const runSpatialSelectionIndexAuditSelfTest = () => {
  const passing = auditSpatialSelectionIndexSources(fixture());
  if (!passing.ok) throw new Error(`selection index audit self-test expected pass: ${JSON.stringify(passing.errors)}`);
  const unsafe = { ...fixture(), [PATHS.runtime]: `${fixture()[PATHS.runtime]} fetch('https://example.test'); for (;;) {}` };
  const failing = auditSpatialSelectionIndexSources(unsafe);
  const ids = new Set(failing.errors.map((entry) => entry.id));
  if (failing.ok || !ids.has('direct-fetch') || !ids.has('direct-for-loop')) throw new Error(`selection index audit self-test did not reject unsafe runtime: ${JSON.stringify(failing.errors)}`);
  return Object.freeze({ passingErrors: passing.errors.length, unsafeErrors: failing.errors.length });
};

const isEntrypoint = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isEntrypoint) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    const result = runSpatialSelectionIndexAuditSelfTest();
    process.stdout.write(`Spatial selection index audit self-test passed (${result.unsafeErrors} unsafe findings detected).\n`);
    process.exit(0);
  }
  const result = auditSpatialSelectionIndexRepository(process.cwd());
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    result.errors.map((error) => { process.stderr.write(`ERROR [${error.id}] ${error.file}: ${error.message}\n`); return error; });
    result.warnings.map((warning) => { process.stderr.write(`WARN [${warning.id}] ${warning.file}: ${warning.message}\n`); return warning; });
    process.stdout.write(`Spatial selection index audit checked ${result.checkedFiles.length} files: ${result.errors.length} error(s), ${result.warnings.length} warning(s).\n`);
  }
  if (args.has('--strict') && !result.ok) process.exit(1);
}
