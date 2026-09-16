import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAccessibility } from './accessibility-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile {
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: path.includes('.') ? `.${path.split('.').pop() ?? ''}` : '',
    kind,
    bytes: Buffer.byteLength(text),
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
    generatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function ids(section: ReturnType<typeof auditAccessibility>): string[] {
  return section.findings.map(item => item.id);
}

test('flags positive tabindex and preserves source line', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Panel.tsx', `export function Panel() {\n  return <div tabIndex={3}>A</div>;\n}`),
  ]));
  const item = section.findings.find(candidate => candidate.id === 'a11y-positive-tabindex');
  assert.ok(item);
  assert.equal(item.location?.line, 2);
  assert.equal(item.severity, 'high');
});

test('flags pointer-only div interactions', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Card.tsx', `export const Card = () => <div onClick={() => open()}>Open</div>;`),
  ]));
  assert.ok(ids(section).includes('a11y-nonsemantic-click-target'));
});

test('accepts non-semantic click target with explicit keyboard role and focus contract', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Card.tsx', `export const Card = () => <div role="button" tabIndex={0} onClick={open} onKeyDown={key}>Open</div>;`),
  ]));
  assert.ok(!ids(section).includes('a11y-nonsemantic-click-target'));
});

test('flags target blank without opener isolation', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Link.tsx', `export const Link = () => <a href="/help" target="_blank">Help</a>;`),
  ]));
  assert.ok(ids(section).includes('a11y-external-link-isolation'));
});

test('accepts target blank with noopener', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Link.tsx', `export const Link = () => <a href="/help" target="_blank" rel="noopener noreferrer">Help</a>;`),
  ]));
  assert.ok(!ids(section).includes('a11y-external-link-isolation'));
});

test('flags image without alt and accepts decorative image', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Image.tsx', `export const Images = () => <><img src="a.png"/><img src="b.png" alt="" /></>;`),
  ]));
  assert.equal(section.findings.filter(item => item.id === 'a11y-image-alt-contract').length, 1);
});

test('flags implicit button type', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Form.tsx', `export const Form = () => <form><button>Reset</button><button type="submit">Save</button></form>;`),
  ]));
  assert.equal(section.findings.filter(item => item.id === 'a11y-button-type-contract').length, 1);
});

test('accepts static label association', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Form.tsx', `export const Form = () => <><label htmlFor="name">Name</label><input id="name" /></>;`),
  ]));
  assert.ok(!ids(section).includes('a11y-form-control-name'));
});

test('accepts aria-labelledby form control naming', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Form.tsx', `export const Form = () => <><span id="name-label">Name</span><input aria-labelledby="name-label" /></>;`),
  ]));
  assert.ok(!ids(section).includes('a11y-form-control-name'));
});

test('flags unnamed form control', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Form.tsx', `export const Form = () => <input value={value} onChange={change} />;`),
  ]));
  assert.ok(ids(section).includes('a11y-form-control-name'));
});

test('flags autofocus for explicit review', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Dialog.tsx', `export const Dialog = () => <input autoFocus aria-label="Search" />;`),
  ]));
  assert.ok(ids(section).includes('a11y-autofocus'));
});

test('flags focus outline suppression without nearby replacement', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/panel.css', `.button:focus { outline: none; }`, 'css'),
  ]));
  assert.ok(ids(section).includes('a11y-focus-indicator-suppression'));
});

test('accepts focus suppression with replacement focus-visible ring', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/panel.css', `.button:focus-visible {\n outline: none;\n box-shadow: 0 0 0 3px currentColor;\n}`, 'css'),
  ]));
  assert.ok(!ids(section).includes('a11y-focus-indicator-suppression'));
});

test('flags motion stylesheet without reduced-motion contract', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/panel.css', `.panel { transition: transform 200ms ease; }`, 'css'),
  ]));
  assert.ok(ids(section).includes('a11y-reduced-motion-contract'));
  assert.equal(section.summary.motionDeclarations, 1);
  assert.equal(section.summary.reducedMotionContracts, 0);
});

test('accepts motion stylesheet with reduced-motion contract', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/panel.css', `.panel { transition: transform 200ms ease; }\n@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }`, 'css'),
  ]));
  assert.ok(!ids(section).includes('a11y-reduced-motion-contract'));
  assert.equal(section.summary.reducedMotionContracts, 1);
});

test('counts forced-colors contracts for release evidence', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/panel.css', `@media (forced-colors: active) { button { border: 1px solid ButtonText; } }`, 'css'),
  ]));
  assert.equal(section.summary.forcedColorContracts, 1);
});

test('blocks viewport zoom disabling configuration', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/index.html', `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">`, 'html'),
  ]));
  const item = section.findings.find(candidate => candidate.id === 'a11y-viewport-zoom-disabled');
  assert.ok(item);
  assert.equal(item.severity, 'critical');
  assert.equal(item.blocking, true);
});

test('accepts zoomable viewport configuration', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/index.html', `<meta name="viewport" content="width=device-width, initial-scale=1">`, 'html'),
  ]));
  assert.ok(!ids(section).includes('a11y-viewport-zoom-disabled'));
});

test('ignores test fixtures so intentional bad examples do not poison release score', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/__tests__/bad.fixture.tsx', `<div tabIndex={4} onClick={x}><img src="x" /></div>`),
  ]));
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.uiFiles, 0);
});

test('ignores generated distribution files', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/dist/assets/app.js', `<div tabIndex={9} onClick={x}></div>`),
  ]));
  assert.equal(section.findings.length, 0);
});

test('reports deterministic rule counts', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Panel.tsx', `<><img src="a"/><img src="b"/><button>Go</button></>`),
  ]));
  assert.deepEqual(section.summary.findingsByRule, {
    'a11y-button-type-contract': 1,
    'a11y-image-alt-contract': 2,
  });
});

test('reports candidate inventory useful for release review', () => {
  const section = auditAccessibility(inventory([
    source('Webclient.app/src/Panel.tsx', `<><button type="button">Go</button><a href="/x">X</a><img src="x" alt="X"/><input aria-label="Q" /></>`),
    source('Webclient.app/src/panel.css', `.x { color: CanvasText; }`, 'css'),
    source('Webclient.app/index.html', `<main>App</main>`, 'html'),
  ]));
  assert.equal(section.summary.uiFiles, 1);
  assert.equal(section.summary.cssFiles, 1);
  assert.equal(section.summary.htmlFiles, 1);
  assert.equal(section.summary.interactiveCandidates, 3);
  assert.equal(section.summary.imageCandidates, 1);
  assert.equal(section.summary.labelCandidates, 1);
});
