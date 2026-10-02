import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPageUsabilityGovernance } from './page-usability-governance-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

interface Fixture {
  readonly path: string;
  readonly text: string;
  readonly kind?: FileKind;
}

function source(input: Fixture): SourceFile {
  const extension = input.path.slice(input.path.lastIndexOf('.')).toLowerCase();
  const kind: FileKind = input.kind ?? (extension === '.css' ? 'css' : extension === '.jsx' ? 'javascript' : 'typescript');
  return {
    absolutePath: `/repo/${input.path}`,
    repositoryPath: input.path,
    extension,
    kind,
    bytes: Buffer.byteLength(input.text),
    lines: input.text.split('\n').length,
    text: input.text,
  };
}

function inventory(fixtures: readonly Fixture[]): RepositoryInventory {
  const files = fixtures.map(source);
  return {
    root: '/repo', files, ignoredDirectories: [], languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function audit(fixtures: readonly Fixture[]) {
  return auditPageUsabilityGovernance(inventory(fixtures));
}

function ids(fixtures: readonly Fixture[]): string[] {
  return audit(fixtures).findings.map(item => item.id);
}

test('reports clickable div without keyboard semantics', () => {
  const report = audit([{ path: 'Webclient.app/src/View.tsx', text: '<div onClick={() => open()}>Open</div>' }]);
  const finding = report.findings.find(item => item.id === 'page-usability-clickable-noninteractive');
  assert.equal(finding?.severity, 'low');
  assert.equal(report.summary.files[0]?.clickableNonInteractive, 1);
});

test('accepts native buttons as click targets', () => {
  const report = audit([{ path: 'Webclient.app/src/View.tsx', text: '<button type="button" onClick={() => open()}>Open</button>' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-clickable-noninteractive'));
});

test('accepts custom click targets with role and keyboard contract', () => {
  const report = audit([{ path: 'Webclient.app/src/View.tsx', text: '<div role="button" tabIndex={0} onKeyDown={onKey} onClick={open}>Open</div>' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-clickable-noninteractive'));
});

test('does not classify custom React components as raw non-interactive elements', () => {
  const report = audit([{ path: 'Webclient.app/src/View.tsx', text: '<MapResult onClick={open} />' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-clickable-noninteractive'));
});

test('reports img without alt', () => {
  const report = audit([{ path: 'Webclient.app/src/Logo.tsx', text: '<img src={logo} />' }]);
  assert.ok(report.findings.some(item => item.id === 'page-usability-image-alt-missing'));
  assert.equal(report.summary.files[0]?.imagesWithoutAlt, 1);
});

test('accepts meaningful image alt text', () => {
  const report = audit([{ path: 'Webclient.app/src/Logo.tsx', text: '<img src={logo} alt="Kent rehberi" />' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-image-alt-missing'));
});

test('accepts empty alt for decorative images', () => {
  const report = audit([{ path: 'Webclient.app/src/Decoration.tsx', text: '<img src={shape} alt="" />' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-image-alt-missing'));
});

test('reports blank target without opener isolation', () => {
  const report = audit([{ path: 'Webclient.app/src/Link.tsx', text: '<a href={url} target="_blank">Open</a>' }]);
  assert.ok(report.findings.some(item => item.id === 'page-usability-blank-target-noopener'));
  assert.equal(report.summary.files[0]?.blankTargetsWithoutRel, 1);
});

test('accepts blank target with noopener', () => {
  const report = audit([{ path: 'Webclient.app/src/Link.tsx', text: '<a href={url} target="_blank" rel="noopener noreferrer">Open</a>' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-blank-target-noopener'));
});

test('supports JSX expression spelling for blank target and rel', () => {
  const report = audit([{ path: 'Webclient.app/src/Link.tsx', text: '<a href={url} target={"_blank"} rel={"noopener"}>Open</a>' }]);
  assert.equal(report.summary.files[0]?.blankTargets, 1);
  assert.equal(report.summary.files[0]?.blankTargetsWithoutRel, 0);
});

test('reports outline suppression as focus review information', () => {
  const report = audit([{ path: 'Webclient.app/src/view.css', text: '.button:focus { outline: none; }' }]);
  const finding = report.findings.find(item => item.id === 'page-usability-outline-suppressed');
  assert.equal(finding?.severity, 'info');
  assert.equal(report.summary.files[0]?.outlineSuppressions, 1);
});

test('counts focus-visible, reduced-motion and forced-color contracts', () => {
  const report = audit([{ path: 'Webclient.app/src/view.css', text: `
.button:focus-visible { outline: 2px solid currentColor; }
@media (prefers-reduced-motion: reduce) { .button { transition: none; } }
@media (forced-colors: active) { .button { border: 1px solid ButtonText; } }
` }]);
  const signal = report.summary.files[0];
  assert.equal(signal?.focusVisibleContracts, 1);
  assert.equal(signal?.reducedMotionContracts, 1);
  assert.equal(signal?.forcedColorContracts, 1);
});

test('reports only large fixed widths at or above the mobile-risk threshold', () => {
  const report = audit([{ path: 'Webclient.app/src/layout.css', text: '.small{width:360px}.large{min-width:720px}.huge{width:1200px}' }]);
  assert.equal(report.summary.files[0]?.largeFixedWidths, 2);
  assert.equal(report.findings.filter(item => item.id === 'page-usability-large-fixed-width').length, 2);
});

test('does not report rem, percent, clamp or max-width responsive contracts', () => {
  const report = audit([{ path: 'Webclient.app/src/layout.css', text: '.a{width:45rem}.b{width:100%}.c{width:clamp(20rem,80vw,60rem)}.d{max-width:1200px}' }]);
  assert.equal(report.summary.files[0]?.largeFixedWidths, 0);
});

test('reports global body overflow clipping', () => {
  const report = audit([{ path: 'Webclient.app/src/global.css', text: 'html, body, #root { min-height: 100%; overflow: hidden; }' }]);
  const finding = report.findings.find(item => item.id === 'page-usability-global-overflow-hidden');
  assert.equal(finding?.severity, 'low');
  assert.equal(report.summary.responsiveRiskFiles, 1);
});

test('does not report component-local overflow clipping as a global document lock', () => {
  const report = audit([{ path: 'Webclient.app/src/card.css', text: '.thumbnail { overflow: hidden; }' }]);
  assert.ok(!report.findings.some(item => item.id === 'page-usability-global-overflow-hidden'));
});

test('ignores component tests because interaction behavior is already asserted there', () => {
  const report = audit([{ path: 'Webclient.app/src/View.test.tsx', text: '<div onClick={open}><img src="x" /></div>' }]);
  assert.equal(report.summary.componentFiles, 0);
});

test('ignores non-primary webclient paths', () => {
  const report = audit([
    { path: 'Webclient.Admin/src/View.tsx', text: '<div onClick={open}>Open</div>' },
    { path: 'tools/View.tsx', text: '<img src="x" />' },
  ]);
  assert.equal(report.summary.files.length, 0);
});

test('ignores generated source paths', () => {
  const report = audit([
    { path: 'Webclient.app/src/generated/View.tsx', text: '<div onClick={open}>Open</div>' },
    { path: 'Webclient.app/src/dist/view.css', text: 'body{overflow:hidden}' },
  ]);
  assert.equal(report.summary.files.length, 0);
});

test('counts interaction, accessibility and responsive risk files independently', () => {
  const report = audit([
    { path: 'Webclient.app/src/A.tsx', text: '<div onClick={open}>Open</div>' },
    { path: 'Webclient.app/src/B.tsx', text: '<img src={logo} />' },
    { path: 'Webclient.app/src/C.css', text: '.panel{width:900px}' },
  ]);
  assert.equal(report.summary.interactionFiles, 1);
  assert.equal(report.summary.accessibilityRiskFiles, 2);
  assert.equal(report.summary.responsiveRiskFiles, 1);
});

test('bounds findings so a legacy page cannot overwhelm release reporting', () => {
  const markup = Array.from({ length: 50 }, (_, index) => `<div onClick={() => open(${index})}>${index}</div>`).join('\n');
  const report = audit([{ path: 'Webclient.app/src/Legacy.tsx', text: markup }]);
  assert.equal(report.findings.length, 24);
  assert.equal(report.summary.files[0]?.clickableNonInteractive, 50);
});

test('normalizes CRLF line locations', () => {
  const report = audit([{ path: 'Webclient.app/src/View.tsx', text: '<section>safe</section>\r\n<img src={logo} />\r\n' }]);
  const finding = report.findings.find(item => item.id === 'page-usability-image-alt-missing');
  assert.equal(finding?.location?.line, 2);
});

test('sorts signals and findings deterministically', () => {
  const fixtures: readonly Fixture[] = [
    { path: 'Webclient.app/src/Z.tsx', text: '<img src={z} />' },
    { path: 'Webclient.app/src/A.tsx', text: '<div onClick={open}>A</div>' },
    { path: 'Webclient.app/src/M.css', text: '.x{width:800px}' },
  ];
  const first = audit(fixtures);
  const second = audit([...fixtures].reverse());
  assert.deepEqual(first.summary.files.map(item => item.file), ['Webclient.app/src/A.tsx', 'Webclient.app/src/M.css', 'Webclient.app/src/Z.tsx']);
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location })),
    second.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location })),
  );
});
