import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDependencies, detectManifestLockDrift } from './dependency-audit.mts';
import { auditGis } from './gis-audit.mts';
import { auditModernization } from './modernization-audit.mts';
import { auditNetwork } from './network-audit.mts';
import { auditPerformance } from './performance-audit.mts';
import { scanFileWithRule, scanSource, SOURCE_RULES } from './source-audit.mts';
import { auditTestContracts } from './test-contracts.mts';
import { auditUx } from './ux-audit.mts';
import {
  directoryBuildProps,
  fixtureFile,
  fixtureInventory,
  fullFixtureInventory,
  minimalIconRegistry,
  requiredGisRuntimeFiles,
  requiredTestFiles,
  webLock,
  webManifest,
} from './test-helpers.mts';

test('source audit blocks direct dynamic eval', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'const value = eval(input);' }]);
  const section = scanSource(inventory);
  const finding = section.findings.find(item => item.id === 'dynamic-eval');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('source audit ignores rule definitions inside quality engine', () => {
  const inventory = fixtureInventory([{ path: 'quality/release/sample.mts', text: 'eval(userInput)' }]);
  const section = scanSource(inventory);
  assert.equal(section.findings.some(item => item.id === 'dynamic-eval'), false);
});

test('client secret env usage is a critical blocker', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/config.js', text: 'const key = process.env.REACT_APP_API_KEY;' }]);
  const finding = scanSource(inventory).findings.find(item => item.id === 'client-secret-env');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('WMS/WFS runtime drift is blocked only in active GIS code', () => {
  const inventory = fixtureInventory([
    { path: 'Webclient.app/src/gis-engine/adapter.js', text: "const layer = new WMSLayer({ url: 'x' });" },
    { path: 'docs/history.md', text: 'WMS is not supported.' },
  ]);
  const section = scanSource(inventory);
  assert.equal(section.findings.filter(item => item.id === 'forbidden-wms-wfs').length, 1);
});

test('unsafe HTML sink is high severity but not implicitly blocking', () => {
  const file = fixtureFile({ path: 'Webclient.app/src/x.js', text: 'node.innerHTML = html;' });
  const rule = SOURCE_RULES.find(item => item.id === 'unsafe-html-sink');
  assert.ok(rule);
  const finding = scanFileWithRule(file, rule)[0];
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, undefined);
});

test('dependency audit reports CRA, React, axios, crypto-js and jsPDF debt', () => {
  const inventory = fixtureInventory([webManifest()]);
  const section = auditDependencies(inventory);
  const ids = new Set(section.findings.map(item => item.id));
  assert.ok(ids.has('dependency-legacy-react-scripts'));
  assert.ok(ids.has('dependency-legacy-react'));
  assert.ok(ids.has('dependency-legacy-axios'));
  assert.ok(ids.has('dependency-legacy-crypto-js'));
  assert.ok(ids.has('dependency-legacy-jspdf'));
});

test('manifest-lock drift detects stale root package', () => {
  const inventory = fixtureInventory([
    webManifest({ react: '^17.0.1' }),
    webLock({ react: '^17.0.1', obsolete: '^1.0.0' }),
  ]);
  const findings = detectManifestLockDrift(inventory);
  assert.ok(findings.some(item => item.id === 'package-lock-stale-root-dependency'));
});

test('manifest-lock drift detects dependency missing from lock root', () => {
  const inventory = fixtureInventory([
    webManifest({ extra: '^1.0.0' }),
    webLock({ react: '^17.0.1' }),
  ]);
  const findings = detectManifestLockDrift(inventory);
  assert.ok(findings.some(item => item.id === 'package-lock-missing-root-dependency'));
});

test('network audit flags plain HTTP references', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Business/X.js', text: "const url = 'http://example.com/api';" }]);
  const section = auditNetwork(inventory);
  assert.equal(section.summary.insecureCount, 1);
  assert.ok(section.findings.some(item => item.id === 'network-insecure-http'));
});

test('network audit classifies remote Google font', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/styles.css', text: "@import url('https://fonts.googleapis.com/css2?family=X');" }]);
  const section = auditNetwork(inventory);
  assert.ok(section.findings.some(item => item.id === 'network-remote-font'));
});

test('network audit reports direct fetch outside shared transport', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Components/Foo.js', text: "fetch('/api/items');" }]);
  const section = auditNetwork(inventory);
  assert.ok(section.findings.some(item => item.id === 'network-direct-fetch-outside-transport'));
});

test('network audit does not report fetch inside shared transport path', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/platform/http/apiClient.js', text: "fetch('/api/items');" }]);
  const section = auditNetwork(inventory);
  assert.equal(section.findings.some(item => item.id === 'network-direct-fetch-outside-transport'), false);
});

test('GIS audit reports missing shared runtimes', () => {
  const inventory = fixtureInventory([minimalIconRegistry()]);
  const section = auditGis(inventory);
  assert.ok(section.findings.some(item => item.id.startsWith('gis-runtime-missing-')));
});

test('GIS audit detects duplicate normalized icon keys', () => {
  const inventory = fixtureInventory([
    minimalIconRegistry([
      { id: 'Park', aliases: ['park'], icon: 'images/a.svg' },
      { id: 'park', aliases: ['green'], icon: 'images/b.svg' },
      { id: 'default', aliases: ['unknown'], icon: 'images/default.svg' },
    ]),
    ...requiredGisRuntimeFiles(),
  ]);
  const section = auditGis(inventory);
  assert.ok(section.findings.some(item => item.id === 'gis-icon-duplicate-key'));
});

test('GIS audit detects alias collision only when visual assets differ', () => {
  const inventory = fixtureInventory([
    minimalIconRegistry([
      { id: 'a', aliases: ['shared'], icon: 'images/a.svg' },
      { id: 'b', aliases: ['shared'], icon: 'images/b.svg' },
      { id: 'default', aliases: ['unknown'], icon: 'images/default.svg' },
    ]),
    ...requiredGisRuntimeFiles(),
  ]);
  const section = auditGis(inventory);
  assert.ok(section.findings.some(item => item.id === 'gis-icon-alias-collision'));
});

test('GIS audit blocks missing default fallback', () => {
  const inventory = fixtureInventory([
    minimalIconRegistry([{ id: 'park', aliases: ['park'], icon: 'images/a.svg' }]),
    ...requiredGisRuntimeFiles(),
  ]);
  const finding = auditGis(inventory).findings.find(item => item.id === 'gis-icon-default-missing');
  assert.equal(finding?.blocking, true);
});

test('GIS audit blocks active WFS service drift', () => {
  const inventory = fixtureInventory([
    minimalIconRegistry(),
    ...requiredGisRuntimeFiles(),
    { path: 'Webclient.app/src/gis-engine/bad.js', text: "const service = 'WFSService';" },
  ]);
  const section = auditGis(inventory);
  assert.ok(section.findings.some(item => item.id === 'gis-forbidden-protocol-wfs'));
});

test('GIS audit reports global graphics clearing outside ownership runtime', () => {
  const inventory = fixtureInventory([
    minimalIconRegistry(),
    ...requiredGisRuntimeFiles(),
    { path: 'Webclient.app/src/Components/Map/Tool.js', text: 'view.graphics.removeAll();' },
  ]);
  const section = auditGis(inventory);
  assert.ok(section.findings.some(item => item.id === 'gis-global-resource-clear'));
});

test('UX audit reports positive tabindex', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Component.jsx', text: 'export const X = () => <button tabIndex={2}>X</button>;' }]);
  const section = auditUx(inventory);
  assert.ok(section.findings.some(item => item.id === 'a11y-positive-tabindex'));
});

test('UX audit reports clickable div missing keyboard contract', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Component.jsx', text: 'export const X = () => <div onClick={go}>Go</div>;' }]);
  const section = auditUx(inventory);
  assert.ok(section.findings.some(item => item.id === 'a11y-clickable-nonsemantic-control'));
});

test('UX audit accepts clickable div with role and keyboard signal', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Component.jsx', text: "export const X = () => <div role='button' tabIndex={0} onClick={go} onKeyDown={key}>Go</div>;" }]);
  const section = auditUx(inventory);
  assert.equal(section.findings.some(item => item.id === 'a11y-clickable-nonsemantic-control'), false);
});

test('UX audit reports likely missing image alt coverage', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/Component.jsx', text: 'export const X = () => <><img src={a}/><img src={b} alt="b"/></>;' }]);
  const section = auditUx(inventory);
  assert.ok(section.findings.some(item => item.id === 'a11y-image-alt-coverage'));
});

test('UX CSS audit reports fixed layout without responsive rules', () => {
  const declarations = Array.from({ length: 14 }, (_, index) => `.x${index}{width:${300 + index}px}`).join('\n');
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/fixed.css', text: declarations }]);
  const section = auditUx(inventory);
  assert.ok(section.findings.some(item => item.id === 'responsive-fixed-layout-without-breakpoint'));
});

test('UX CSS audit reports removed focus outline without replacement', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/focus.css', text: 'button:focus{outline:none}' }]);
  const section = auditUx(inventory);
  assert.ok(section.findings.some(item => item.id === 'a11y-focus-outline-removed'));
});

test('performance audit reports oversized source file', () => {
  const text = `export const x = '${'a'.repeat(500_000)}';`;
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/huge.js', text }]);
  const section = auditPerformance(inventory);
  assert.ok(section.findings.some(item => item.id === 'performance-source-file-bytes'));
});

test('performance audit reports nested synchronous iteration', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/nested.js', text: 'for(let i=0;i<a.length;i++){ for(let j=0;j<b.length;j++){ work(i,j); }}' }]);
  const section = auditPerformance(inventory);
  assert.ok(section.findings.some(item => item.id === 'performance-nested-loop-review'));
});

test('performance audit captures dynamic import as lazy-loading evidence', () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/lazy.js', text: "const Page = React.lazy(() => import('./Page'));" }]);
  const section = auditPerformance(inventory);
  assert.ok(section.summary.lazyImportFiles.includes('Webclient.app/src/lazy.js'));
});

test('test-contract audit passes representative required evidence', () => {
  const inventory = fixtureInventory(requiredTestFiles());
  const section = auditTestContracts(inventory);
  assert.equal(section.summary.missing.length, 0);
});

test('test-contract audit reports missing evidence', () => {
  const inventory = fixtureInventory([]);
  const section = auditTestContracts(inventory);
  assert.ok(section.summary.missing.length > 10);
  assert.ok(section.findings.every(item => item.domain === 'testing'));
});

test('modernization audit recognizes modern .NET target while flagging nullable disable', () => {
  const inventory = fixtureInventory([webManifest(), directoryBuildProps('disable')]);
  const section = auditModernization(inventory);
  assert.equal(section.summary.targetFramework, 'net10.0');
  assert.ok(section.findings.some(item => item.id === 'modernization-csharp-nullable-disabled'));
});

test('modernization audit recommends phased TypeScript adoption', () => {
  const inventory = fixtureInventory([webManifest(), { path: 'Webclient.app/src/a.js', text: 'export const a = 1;' }]);
  const section = auditModernization(inventory);
  assert.equal(section.summary.typescriptRatio, 0);
  assert.ok(section.findings.some(item => item.id === 'modernization-typescript-adoption-low'));
});

test('modernization audit detects Vite config and changes build strategy to keep', () => {
  const inventory = fixtureInventory([
    webManifest({ vite: '^8.3.0' }),
    { path: 'Webclient.app/vite.config.ts', text: 'export default {};' },
  ]);
  const section = auditModernization(inventory);
  assert.equal(section.summary.viteDetected, true);
  const buildTarget = section.summary.targets.find(target => target.area === 'frontend-build');
  assert.equal(buildTarget?.strategy, 'keep');
});

test('full fixture produces multiple sections without throwing', () => {
  const inventory = fullFixtureInventory();
  assert.ok(auditDependencies(inventory).summary.dependencies.length > 0);
  assert.ok(auditGis(inventory).summary.runtimes.length > 0);
  assert.ok(auditTestContracts(inventory).summary.satisfied.length > 0);
});
