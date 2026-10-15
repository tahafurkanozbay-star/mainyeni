import assert from 'node:assert/strict';
import test from 'node:test';
import { auditResponsive } from './responsive-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const adminCss = 'Webclient.admin/src/components/Sidebar/Sidebar.css';
const adminComponent = 'Webclient.admin/src/components/Sidebar/Sidebar.tsx';

function css(path: string, text: string): FixtureFileInput {
  return { path, text, kind: 'css' };
}

function component(path: string, text: string): FixtureFileInput {
  return { path, text, kind: 'typescript' };
}

function inspect(...files: FixtureFileInput[]) {
  return auditResponsive(fixtureInventory(files));
}

test('includes real Admin CSS and flags mobile overflow risks', () => {
  const result = inspect(css(adminCss, '.sidebar { width: 920px; height: 100vh; }'));
  assert.equal(result.summary.cssFiles, 1);
  assert.equal(result.summary.componentFiles, 0);
  assert.equal(result.summary.fixedWidthCandidates, 1);
  assert.equal(result.summary.viewportHeightCandidates, 1);
  assert.deepEqual(result.findings.map(item => item.id), [
    'responsive-large-fixed-width',
    'responsive-legacy-viewport-height',
  ]);
  assert.equal(result.findings[0]?.location?.file, adminCss);
});

test('includes Admin TSX inline widths but not adjacent test modules', () => {
  const result = inspect(
    component(adminComponent, '<aside style={{ width: "900px" }} />'),
    component('Webclient.admin/src/components/Sidebar/Sidebar.test.tsx',
      '<aside style={{ width: "900px" }} />'),
    component('Webclient.admin/src/components/Sidebar/Sidebar.spec.tsx',
      '<aside style={{ width: "900px" }} />'),
  );
  assert.equal(result.summary.componentFiles, 1);
  assert.deepEqual(result.findings.map(item => item.id), ['responsive-inline-fixed-width']);
  assert.equal(result.findings[0]?.location?.file, adminComponent);
});

test('ignores Admin fixtures and generated build/coverage directories', () => {
  const result = inspect(
    css('Webclient.admin/src/fixtures/layout.css', '.x { width: 900px; }'),
    css('Webclient.admin/src/__tests__/layout.css', '.x { width: 900px; }'),
    css('Webclient.admin/coverage/src/layout.css', '.x { width: 900px; }'),
    component('Webclient.admin/src/tests/Panel.tsx',
      '<div style={{ width: "900px" }} />'),
    component('Webclient.admin/src/fixtures/Panel.tsx',
      '<div style={{ width: "900px" }} />'),
  );
  assert.equal(result.summary.cssFiles, 0);
  assert.equal(result.summary.componentFiles, 0);
  assert.equal(result.findings.length, 0);
});

test('counts Admin media and container queries without manufacturing findings', () => {
  const result = inspect(css(adminCss, [
    '@media (max-width: 700px) { .sidebar { max-width: 100%; } }',
    '@container sidebar (max-width: 400px) { .sidebar { min-width: 0; } }',
  ].join('\n')));
  assert.equal(result.summary.cssFiles, 1);
  assert.equal(result.summary.mediaQueries, 1);
  assert.equal(result.summary.containerQueries, 1);
  assert.equal(result.findings.length, 0);
});

test('respects an Admin mobile breakpoint when reviewing fixed overlays', () => {
  const result = inspect(css(adminCss, [
    '.one { position: fixed; }',
    '.two { position: fixed; }',
    '.three { position: fixed; }',
    '.four { position: fixed; }',
    '@media (max-width: 600px) { .one { position: static; } }',
  ].join('\n')));
  assert.ok(!result.findings.some(item =>
    item.id === 'responsive-fixed-overlays-without-breakpoint'));
});

test('audits app and Admin components together without double-counting', () => {
  const result = inspect(
    component('Webclient.app/src/Components/Map/MapPanel.tsx',
      '<div style={{ width: "700px" }} />'),
    component(adminComponent, '<aside style={{ width: "900px" }} />'),
  );
  assert.equal(result.summary.componentFiles, 2);
  assert.equal(result.summary.fixedWidthCandidates, 2);
  assert.deepEqual(result.findings.map(item => item.location?.file), [
    'Webclient.app/src/Components/Map/MapPanel.tsx',
    adminComponent,
  ]);
});


test('never mistakes responsive query feature widths for layout declarations', () => {
  const result = inspect(css(adminCss, [
    '@media screen and (min-width: 800px) and (max-width: 1200px) {',
    '  .sidebar { max-width: 100%; }',
    '}',
    '@container sidebar (width: 900px) and (min-width: 20px) {',
    '  .sidebar { min-width: 0; }',
    '}',
    '@media (height: 100vh) and (max-height: 30px) {',
    '  .sidebar { max-height: 100%; }',
    '}',
  ].join('\n')));
  assert.equal(result.summary.mediaQueries, 2);
  assert.equal(result.summary.containerQueries, 1);
  assert.equal(result.summary.fixedWidthCandidates, 0);
  assert.equal(result.summary.viewportHeightCandidates, 0);
  assert.equal(result.summary.touchTargetCandidates, 0);
  assert.equal(result.findings.length, 0);
});

test('real CSS declarations inside query blocks still trigger safety findings', () => {
  const result = inspect(css(adminCss, [
    '@media (max-width: 700px) {',
    '  .sidebar { width: 920px; height: 100vh; min-width: 20px; }',
    '}',
  ].join('\n')));
  assert.deepEqual(result.findings.map(item => item.id), [
    'responsive-large-fixed-width',
    'responsive-legacy-viewport-height',
    'responsive-small-interaction-dimension',
  ]);
});
