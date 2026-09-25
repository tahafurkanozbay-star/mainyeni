import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANGE_RISK_POLICIES,
  areaEvidencePaths,
  classifyRiskAreas,
  compareManifestDependencies,
  evidenceSupportsArea,
  isDocumentationPath,
  isGeneratedPath,
  isPackageLockPath,
  isPackageManifestPath,
  isProductionCandidatePath,
  isReleaseCriticalValidationPath,
  isReleaseValidationPath,
  isTestPath,
  isWorkflowPath,
  packageLockCandidates,
  pathNature,
  policyForArea,
  productionPathsForArea,
  testSupportsArea,
  validationSupportsArea,
  workspaceDirectory,
  type ChangeRiskArea,
} from './change-risk-policy.mts';

function includesArea(path: string, area: ChangeRiskArea, text = ''): boolean {
  return classifyRiskAreas(path, text).includes(area);
}

test('change risk policy identifiers are unique', () => {
  const areas = CHANGE_RISK_POLICIES.map(policy => policy.area);
  assert.equal(new Set(areas).size, areas.length);
});

test('every change risk policy has focused ownership metadata', () => {
  for (const policy of CHANGE_RISK_POLICIES) {
    assert.ok(policy.pathPatterns.length > 0);
    assert.ok(policy.testPatterns.length > 0);
    assert.ok(policy.title.length > 10);
    assert.ok(policy.description.length > 20);
  }
});

test('security paths classify as security', () => {
  assert.equal(includesArea('Webclient.app/src/auth/sessionRuntime.ts', 'security'), true);
  assert.equal(includesArea('Api.Core/Security/TokenIssuer.cs', 'security'), true);
});

test('security content classifies neutral path as security', () => {
  assert.equal(includesArea('Api.User/Controllers/ProfileController.cs', 'security', '[Authorize]\npublic class ProfileController {}'), true);
});

test('ordinary component does not classify as security without signal', () => {
  assert.equal(includesArea('Webclient.app/src/components/Card.tsx', 'security', 'export function Card() { return null; }'), false);
});

test('backend API paths classify independently from security', () => {
  const areas = classifyRiskAreas('Api.User/Controllers/ParcelController.cs', '[HttpGet]\npublic IActionResult Get() => Ok();');
  assert.equal(areas.includes('backend-api'), true);
});

test('backend endpoint content can classify a neutral backend file', () => {
  assert.equal(includesArea('Business/Parcel/ParcelEndpoint.cs', 'backend-api', 'app.MapGet("/parcel", Handle);'), true);
});

test('GIS file names classify as GIS', () => {
  assert.equal(includesArea('Webclient.app/src/gis/runtime/LayerBudget.ts', 'gis'), true);
  assert.equal(includesArea('Webclient.app/src/features/scene/SceneShell.tsx', 'gis'), true);
  assert.equal(includesArea('Webclient.app/src/spatial/queryCoordinator.ts', 'gis'), true);
});

test('ArcGIS content classifies otherwise generic runtime as GIS', () => {
  assert.equal(includesArea('Webclient.app/src/runtime/view.ts', 'gis', "import MapView from '@arcgis/core/views/MapView';"), true);
});

test('data paths classify stores repositories and schemas', () => {
  assert.equal(includesArea('Webclient.app/src/store/runtimeStore.ts', 'data'), true);
  assert.equal(includesArea('Business/ParcelRepository.cs', 'data'), true);
  assert.equal(includesArea('database/schema/parcel.sql', 'data'), true);
});

test('search paths classify address and geocode surfaces', () => {
  assert.equal(includesArea('Webclient.app/src/search/addressSession.ts', 'search'), true);
  assert.equal(includesArea('Webclient.app/src/features/geocode/geocoder.ts', 'search'), true);
});

test('frontend source classifies as frontend runtime', () => {
  assert.equal(includesArea('Webclient.app/src/components/Button.tsx', 'frontend-runtime'), true);
  assert.equal(includesArea('Webclient.admin/src/App.tsx', 'frontend-runtime'), true);
});

test('backend source is not misclassified as frontend runtime', () => {
  assert.equal(includesArea('Api.User/Controllers/HomeController.cs', 'frontend-runtime'), false);
});

test('accessibility naming classifies focus and dialog surfaces', () => {
  assert.equal(includesArea('Webclient.app/src/components/dialog/DialogRuntime.ts', 'accessibility'), true);
  assert.equal(includesArea('Webclient.app/src/a11y/focusTrap.ts', 'accessibility'), true);
});

test('accessibility content classifies generic component', () => {
  assert.equal(includesArea('Webclient.app/src/components/Toolbar.tsx', 'accessibility', '<button aria-label="Open" onKeyDown={handler} />'), true);
});

test('responsive naming classifies layout surfaces', () => {
  assert.equal(includesArea('Webclient.app/src/layout/mobileSidebar.tsx', 'responsive'), true);
  assert.equal(includesArea('Webclient.app/src/runtime/viewportPolicy.ts', 'responsive'), true);
});

test('responsive content classifies generic stylesheet', () => {
  assert.equal(includesArea('Webclient.app/src/styles/shell.css', 'responsive', '@media (max-width: 800px) { .a { width: 100%; } }'), true);
});

test('dependency manifests and project files classify dependencies', () => {
  assert.equal(includesArea('Webclient.app/package.json', 'dependencies'), true);
  assert.equal(includesArea('Webclient.app/package-lock.json', 'dependencies'), true);
  assert.equal(includesArea('Directory.Packages.props', 'dependencies'), true);
  assert.equal(includesArea('Api.User/Api.User.csproj', 'dependencies'), true);
});

test('workflow files classify CI', () => {
  assert.equal(includesArea('.github/workflows/release-qa.yml', 'ci'), true);
});

test('release tooling classifies typed release implementation', () => {
  assert.equal(includesArea('quality/release/pr-gate.mts', 'release-tooling'), true);
  assert.equal(includesArea('Webclient.app/scripts/workflow-security-contract.test.mjs', 'release-tooling'), false);
});

test('database paths classify migrations and SQL', () => {
  assert.equal(includesArea('database/migrations/20260924_add_index.sql', 'database'), true);
  assert.equal(includesArea('Api.Core/Migrations/AddParcelIndex.cs', 'database'), true);
});

test('database content classifies schema mutation in neutral SQL path', () => {
  assert.equal(includesArea('scripts/bootstrap.sql', 'database', 'ALTER TABLE parcels ADD COLUMN source text;'), true);
});

test('observability paths classify tracing and metrics', () => {
  assert.equal(includesArea('Webclient.app/src/platform/observability/requestMetrics.ts', 'observability'), true);
  assert.equal(includesArea('Api.Core/Logging/RequestLogger.cs', 'observability'), true);
});

test('observability content classifies generic diagnostic module', () => {
  assert.equal(includesArea('Webclient.app/src/platform/runtime.ts', 'observability', 'const observer = new PerformanceObserver(callback);'), true);
});

test('performance paths classify queue cache and budget surfaces', () => {
  assert.equal(includesArea('Webclient.app/src/platform/cache/requestCache.ts', 'performance'), true);
  assert.equal(includesArea('Webclient.app/src/gis/queue/LayerQueue.ts', 'performance'), true);
});

test('performance content classifies generic scheduler', () => {
  assert.equal(includesArea('Webclient.app/src/runtime/clock.ts', 'performance', 'requestAnimationFrame(render);'), true);
});

test('configuration paths classify build and runtime config', () => {
  assert.equal(includesArea('Webclient.app/vite.config.ts', 'configuration'), true);
  assert.equal(includesArea('Api.User/appsettings.Production.json', 'configuration'), true);
  assert.equal(includesArea('Directory.Build.props', 'configuration'), true);
});

test('test files are excluded from production risk classification', () => {
  const areas = classifyRiskAreas('Webclient.app/src/gis/LayerBudget.test.ts', "import FeatureLayer from '@arcgis/core/layers/FeatureLayer';");
  assert.deepEqual(areas, []);
});

test('documentation is excluded from production risk classification', () => {
  assert.deepEqual(classifyRiskAreas('docs/security/session.md', 'Bearer token'), []);
  assert.deepEqual(classifyRiskAreas('KENT_REHBERI_PROGRESS.md', 'GIS release'), []);
});

test('generated output is excluded from production risk classification', () => {
  assert.deepEqual(classifyRiskAreas('Webclient.app/build/gis/runtime.js', 'SceneView'), []);
  assert.deepEqual(classifyRiskAreas('Api.User/obj/Release/generated.cs', '[Authorize]'), []);
});

test('risk areas are deterministic lexical order', () => {
  const areas = classifyRiskAreas(
    'Webclient.app/src/gis/security/sessionCache.ts',
    'requestAnimationFrame(() => {}); <button aria-label="Map" />',
  );
  assert.deepEqual(areas, [...areas].sort((left, right) => left.localeCompare(right, 'en')));
});

test('isTestPath recognizes JS TS JSX TSX and .NET test directories', () => {
  assert.equal(isTestPath('Webclient.app/src/a.test.ts'), true);
  assert.equal(isTestPath('Webclient.app/src/a.spec.tsx'), true);
  assert.equal(isTestPath('Webclient.app/tests/a.mjs'), true);
  assert.equal(isTestPath('tests/Platform.Security.Tests/AuthTests.cs'), true);
  assert.equal(isTestPath('Webclient.app/src/a.ts'), false);
});

test('documentation detection covers docs progress and markdown', () => {
  assert.equal(isDocumentationPath('docs/runbook.md'), true);
  assert.equal(isDocumentationPath('progress/qa.md'), true);
  assert.equal(isDocumentationPath('KENT_REHBERI_PROGRESS.md'), true);
  assert.equal(isDocumentationPath('Webclient.app/src/runtime.ts'), false);
});

test('generated path detection covers common build outputs', () => {
  assert.equal(isGeneratedPath('Webclient.app/node_modules/a.js'), true);
  assert.equal(isGeneratedPath('Webclient.app/dist/a.js'), true);
  assert.equal(isGeneratedPath('Api.User/bin/Release/a.dll'), true);
  assert.equal(isGeneratedPath('Api.User/src/a.cs'), false);
});

test('workflow path detection is limited to GitHub workflow YAML', () => {
  assert.equal(isWorkflowPath('.github/workflows/release-qa.yml'), true);
  assert.equal(isWorkflowPath('.github/workflows/release-qa.yaml'), true);
  assert.equal(isWorkflowPath('.github/dependabot.yml'), false);
});

test('package manifest and lockfile detection are precise', () => {
  assert.equal(isPackageManifestPath('Webclient.app/package.json'), true);
  assert.equal(isPackageManifestPath('package.json'), true);
  assert.equal(isPackageManifestPath('package-lock.json'), false);
  assert.equal(isPackageLockPath('Webclient.app/package-lock.json'), true);
  assert.equal(isPackageLockPath('Webclient.app/pnpm-lock.yaml'), true);
  assert.equal(isPackageLockPath('Webclient.app/yarn.lock'), true);
  assert.equal(isPackageLockPath('package.json'), false);
});

test('release validation recognizes typed release and authoritative workflow paths', () => {
  assert.equal(isReleaseValidationPath('quality/release/pr-gate.mts'), true);
  assert.equal(isReleaseValidationPath('.github/workflows/release-qa.yml'), true);
  assert.equal(isReleaseValidationPath('tools/platform-audit.test.mjs'), true);
  assert.equal(isReleaseValidationPath('Webclient.app/src/App.tsx'), false);
});

test('critical validation set protects canonical merge authorities', () => {
  assert.equal(isReleaseCriticalValidationPath('.github/workflows/release-qa.yml'), true);
  assert.equal(isReleaseCriticalValidationPath('.github/workflows/webclient-quality.yml'), true);
  assert.equal(isReleaseCriticalValidationPath('quality/release/release-engine.mts'), true);
  assert.equal(isReleaseCriticalValidationPath('quality/release/pr-gate.mts'), true);
  assert.equal(isReleaseCriticalValidationPath('quality/release/accessibility-audit.mts'), false);
});

test('production candidate excludes tests docs workflows and generated outputs', () => {
  assert.equal(isProductionCandidatePath('Webclient.app/src/runtime.ts'), true);
  assert.equal(isProductionCandidatePath('Api.User/Controllers/HomeController.cs'), true);
  assert.equal(isProductionCandidatePath('database/schema.sql'), true);
  assert.equal(isProductionCandidatePath('Webclient.app/src/runtime.test.ts'), false);
  assert.equal(isProductionCandidatePath('docs/runtime.md'), false);
  assert.equal(isProductionCandidatePath('.github/workflows/release-qa.yml'), false);
  assert.equal(isProductionCandidatePath('Webclient.app/build/runtime.js'), false);
});

test('pathNature returns orthogonal path facts', () => {
  const testNature = pathNature('quality/release/change-risk-policy.test.mts');
  assert.equal(testNature.test, true);
  assert.equal(testNature.releaseValidation, true);
  assert.equal(testNature.productionCandidate, false);

  const workflow = pathNature('.github/workflows/release-qa.yml');
  assert.equal(workflow.workflow, true);
  assert.equal(workflow.releaseValidation, true);
  assert.equal(workflow.productionCandidate, false);
});

test('policyForArea returns exact policy ownership', () => {
  assert.equal(policyForArea('gis').domain, 'gis');
  assert.equal(policyForArea('ci').domain, 'build');
  assert.equal(policyForArea('release-tooling').domain, 'release');
});

test('policyForArea rejects unknown runtime value', () => {
  assert.throws(() => policyForArea('unknown' as ChangeRiskArea));
});

test('GIS tests support GIS area but unrelated tests do not', () => {
  assert.equal(testSupportsArea('Webclient.app/src/gis/LayerBudget.test.ts', 'gis'), true);
  assert.equal(testSupportsArea('Webclient.app/src/components/Button.test.tsx', 'gis'), false);
});

test('security test paths support security area', () => {
  assert.equal(testSupportsArea('tests/Platform.Security.Tests/AuthControllerTests.cs', 'security'), true);
  assert.equal(testSupportsArea('Webclient.app/src/auth/session.security.test.ts', 'security'), true);
});

test('non-test path never supports area as test evidence', () => {
  assert.equal(testSupportsArea('Webclient.app/src/gis/LayerBudget.ts', 'gis'), false);
});

test('release workflow validates backend and GIS ownership where configured', () => {
  assert.equal(validationSupportsArea('.github/workflows/release-qa.yml', 'backend-api'), true);
  assert.equal(validationSupportsArea('.github/workflows/webclient-quality.yml', 'gis'), true);
});

test('typed release test validates release-tooling area', () => {
  assert.equal(validationSupportsArea('quality/release/pr-gate.test.mts', 'release-tooling'), false);
  assert.equal(testSupportsArea('quality/release/pr-gate.test.mts', 'release-tooling'), true);
});

test('evidenceSupportsArea accepts focused tests and validation contracts', () => {
  assert.equal(evidenceSupportsArea('Webclient.app/src/gis/LayerBudget.test.ts', 'gis'), true);
  assert.equal(evidenceSupportsArea('.github/workflows/webclient-quality.yml', 'gis'), true);
  assert.equal(evidenceSupportsArea('docs/gis.md', 'gis'), false);
});

test('workspaceDirectory handles root and nested manifests', () => {
  assert.equal(workspaceDirectory('package.json'), '');
  assert.equal(workspaceDirectory('Webclient.app/package.json'), 'Webclient.app');
  assert.equal(workspaceDirectory('packages/a/package.json'), 'packages/a');
});

test('packageLockCandidates remain workspace-local and deterministic', () => {
  assert.deepEqual(packageLockCandidates('Webclient.app/package.json'), [
    'Webclient.app/package-lock.json',
    'Webclient.app/pnpm-lock.yaml',
    'Webclient.app/yarn.lock',
    'Webclient.app/bun.lock',
    'Webclient.app/bun.lockb',
  ]);
  assert.deepEqual(packageLockCandidates('package.json'), [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ]);
});

test('manifest dependency comparison detects added dependency', () => {
  const result = compareManifestDependencies(
    '{"dependencies":{"react":"1.0.0"}}',
    '{"dependencies":{"react":"1.0.0","axios":"2.0.0"}}',
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ['dependencies:axios']);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.versionChanged, []);
});

test('manifest dependency comparison detects removed dependency', () => {
  const result = compareManifestDependencies(
    '{"dependencies":{"react":"1.0.0","axios":"2.0.0"}}',
    '{"dependencies":{"react":"1.0.0"}}',
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['dependencies:axios']);
});

test('manifest dependency comparison detects version change', () => {
  const result = compareManifestDependencies(
    '{"dependencies":{"react":"1.0.0"}}',
    '{"dependencies":{"react":"2.0.0"}}',
  );
  assert.deepEqual(result.versionChanged, ['dependencies:react']);
});

test('manifest dependency comparison includes dev optional and peer scopes', () => {
  const result = compareManifestDependencies(
    '{"devDependencies":{"vitest":"1"},"optionalDependencies":{"sharp":"1"},"peerDependencies":{"react":"18"}}',
    '{"devDependencies":{"vitest":"2"},"optionalDependencies":{"sharp":"2"},"peerDependencies":{"react":"19"}}',
  );
  assert.deepEqual(result.versionChanged, [
    'devDependencies:vitest',
    'optionalDependencies:sharp',
    'peerDependencies:react',
  ]);
});

test('manifest script-only change does not count as dependency mutation', () => {
  const result = compareManifestDependencies(
    '{"scripts":{"test":"node a"},"dependencies":{"react":"1"}}',
    '{"scripts":{"test":"node b"},"dependencies":{"react":"1"}}',
  );
  assert.equal(result.changed, false);
});

test('manifest malformed current JSON is reported without throwing', () => {
  const result = compareManifestDependencies('{"dependencies":{}}', '{');
  assert.equal(result.invalidCurrent, true);
  assert.equal(result.changed, false);
});

test('manifest malformed baseline JSON is reported without throwing', () => {
  const result = compareManifestDependencies('{', '{"dependencies":{}}');
  assert.equal(result.invalidBaseline, true);
});

test('manifest dependency keys are stable lexical order', () => {
  const result = compareManifestDependencies(
    '{"dependencies":{"z":"1","a":"1"}}',
    '{"dependencies":{"z":"2","a":"2","m":"1"}}',
  );
  assert.deepEqual(result.added, ['dependencies:m']);
  assert.deepEqual(result.versionChanged, ['dependencies:a', 'dependencies:z']);
});

test('areaEvidencePaths returns unique compatible changed paths in lexical order', () => {
  const paths = areaEvidencePaths([
    'Webclient.app/src/gis/z.test.ts',
    '.github/workflows/webclient-quality.yml',
    'Webclient.app/src/gis/a.test.ts',
    'docs/gis.md',
  ], 'gis');
  assert.deepEqual(paths, [
    '.github/workflows/webclient-quality.yml',
    'Webclient.app/src/gis/a.test.ts',
    'Webclient.app/src/gis/z.test.ts',
  ]);
});

test('productionPathsForArea filters files by classified risk area', () => {
  const paths = productionPathsForArea([
    { path: 'Webclient.app/src/gis/LayerBudget.ts', text: 'export const x = 1;' },
    { path: 'Webclient.app/src/auth/session.ts', text: 'export const y = 1;' },
    { path: 'Webclient.app/src/gis/LayerBudget.test.ts', text: 'SceneView' },
  ], 'gis');
  assert.deepEqual(paths, ['Webclient.app/src/gis/LayerBudget.ts']);
});

test('generic frontend file can carry focused accessibility and responsive areas together', () => {
  const areas = classifyRiskAreas(
    'Webclient.app/src/components/Toolbar.tsx',
    '<button aria-label="Open" />\nconst query = matchMedia("(max-width: 700px)");',
  );
  assert.equal(areas.includes('frontend-runtime'), true);
  assert.equal(areas.includes('accessibility'), true);
  assert.equal(areas.includes('responsive'), true);
});

test('GIS performance runtime can carry GIS and performance ownership together', () => {
  const areas = classifyRiskAreas(
    'Webclient.app/src/gis/cache/LayerCache.ts',
    'requestAnimationFrame(render);',
  );
  assert.equal(areas.includes('gis'), true);
  assert.equal(areas.includes('performance'), true);
});

test('security-sensitive backend API can carry backend and security ownership together', () => {
  const areas = classifyRiskAreas(
    'Api.User/Controllers/AuthController.cs',
    '[Authorize]\n[HttpPost]\npublic IActionResult Login() => Ok();',
  );
  assert.equal(areas.includes('security'), true);
  assert.equal(areas.includes('backend-api'), true);
});

test('database migration with repository naming can carry data and database ownership', () => {
  const areas = classifyRiskAreas('database/migrations/ParcelRepository.sql', 'ALTER TABLE parcel ADD source text;');
  assert.equal(areas.includes('database'), true);
  assert.equal(areas.includes('data'), true);
});

test('configuration package manifest can carry dependency and configuration ownership', () => {
  const areas = classifyRiskAreas('global.json', '{"sdk":{"version":"10.0.100"}}');
  assert.equal(areas.includes('dependencies'), true);
  assert.equal(areas.includes('configuration'), true);
});
