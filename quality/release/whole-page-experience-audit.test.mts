import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWholePageExperience } from './whole-page-experience-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditWholePageExperience(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

const accessibleShell: FixtureFileInput = {
  path: 'Webclient.app/src/App.tsx',
  text: `
    export function App() {
      return <>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <nav aria-label="Primary"><a href="/">Home</a></nav>
        <main id="main-content"><h1>Kent Rehberi</h1><button type="button">Open</button></main>
      </>;
    }
  `,
};

const resilientCss: FixtureFileInput = {
  path: 'Webclient.app/src/App.css',
  text: `
    .skip-link:focus-visible, button:focus-visible { outline: 3px solid CanvasText; }
    .workspace { min-height: 100dvh; }
    .table-scroll { overflow-x: auto; }
    @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
    @media (forced-colors: active) { button:focus-visible { outline: 2px solid Highlight; } }
    @media (pointer: coarse) { button { min-width: 44px; min-height: 44px; } }
  `,
};

test('accepts a resilient whole-page shell contract', () => {
  const section = audit([accessibleShell, resilientCss]);
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.mainLandmarks, 1);
  assert.equal(section.summary.headings, 1);
  assert.equal(section.summary.focusVisibleContract, true);
  assert.equal(section.summary.reducedMotionContract, true);
  assert.equal(section.summary.forcedColorsContract, true);
  assert.equal(section.summary.coarsePointerContract, true);
  assert.equal(section.summary.skipLinkContract, true);
  assert.equal(section.summary.modernViewportContract, true);
  assert.equal(section.summary.responsiveTableContract, true);
});

test('blocks a product surface with no main landmark', () => {
  const section = audit([
    { path: 'Webclient.app/src/App.tsx', text: 'export const App = () => <div><h1>Map</h1></div>;\n' },
    resilientCss,
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-main-landmark-missing');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('reports missing heading hierarchy without forcing a release block', () => {
  const section = audit([
    { path: 'Webclient.app/src/App.tsx', text: 'export const App = () => <main id="main-content"><button>Map</button></main>;\n' },
    resilientCss,
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-heading-hierarchy-missing');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  assert.notEqual(finding.blocking, true);
});

test('reports missing focus-visible contract when interactive elements exist', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.workspace { min-height: 100dvh; }\n' },
  ]);
  assert.ok(section.findings.some(item => item.id === 'whole-page-focus-visible-contract-missing'));
});

test('does not require focus-visible when no interactive element exists', () => {
  const section = audit([
    { path: 'Webclient.app/src/Static.tsx', text: 'export const Static = () => <main><h1>Info</h1></main>;\n' },
    { path: 'Webclient.app/src/Static.css', text: '.page { min-height: 100dvh; }\n' },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-focus-visible-contract-missing'));
});

test('reports animated interfaces without reduced-motion contract', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: 'button:focus-visible{outline:2px solid currentColor}.panel{transition: transform 200ms ease;min-height:100dvh}\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-reduced-motion-contract-missing');
  assert.ok(finding);
  assert.equal(finding.evidence?.value, 1);
});

test('accepts transition when reduced-motion contract is present anywhere in product CSS', () => {
  const section = audit([
    accessibleShell,
    {
      path: 'Webclient.app/src/App.css',
      text: '.panel{transition: transform 200ms ease;min-height:100dvh}.x:focus-visible{outline:2px solid}@media (prefers-reduced-motion: reduce){.panel{transition:none}}',
    },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-reduced-motion-contract-missing'));
});

test('reports missing forced-colors adaptation as low-severity debt', () => {
  const section = audit([
    accessibleShell,
    {
      path: 'Webclient.app/src/App.css',
      text: '.x:focus-visible{outline:2px solid}.page{min-height:100dvh}@media (pointer: coarse){button{min-height:44px}}',
    },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-forced-colors-contract-missing');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
});

test('reports missing coarse pointer adaptation as low-severity debt', () => {
  const section = audit([
    accessibleShell,
    {
      path: 'Webclient.app/src/App.css',
      text: '.x:focus-visible{outline:2px solid}.page{min-height:100dvh}@media (forced-colors: active){button{border:1px solid}}',
    },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-coarse-pointer-contract-missing');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
});

test('reports missing skip link when a main landmark exists', () => {
  const section = audit([
    { path: 'Webclient.app/src/App.tsx', text: 'export const App=()=> <main><h1>Map</h1><button>Open</button></main>;\n' },
    resilientCss,
  ]);
  assert.ok(section.findings.some(item => item.id === 'whole-page-skip-link-contract-missing'));
});

test('accepts common main-content skip target variants', () => {
  const section = audit([
    { path: 'Webclient.app/src/App.tsx', text: 'export const App=()=> <><a href="#content">Skip</a><main id="content"><h1>Map</h1></main></>;\n' },
    resilientCss,
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-skip-link-contract-missing'));
});

test('reports pointer-only div click interaction', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Map</h1><div onClick={() => open()}>Open</div></main>;\n',
    },
    resilientCss,
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-pointer-only-interaction');
  assert.ok(finding);
  assert.equal(finding.evidence?.value, 1);
});

test('accepts custom clickable element with role and keyboard contract', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Map</h1><div role="button" tabIndex={0} onKeyDown={onKey} onClick={open}>Open</div></main>;\n',
    },
    resilientCss,
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-pointer-only-interaction'));
});

test('prefers native button without pointer-only warning', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Map</h1><button type="button" onClick={open}>Open</button></main>;\n',
    },
    resilientCss,
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-pointer-only-interaction'));
});

test('blocks outline suppression when no focus-visible replacement exists', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: 'button{outline:none}.page{min-height:100dvh}\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-focus-outline-suppressed');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('allows outline suppression when repository has explicit focus-visible replacement', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: 'button{outline:none}button:focus-visible{outline:3px solid}.page{min-height:100dvh}\n' },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-focus-outline-suppressed'));
});

test('reports legacy near-full vh when no dynamic viewport companion exists', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.page{height:100vh}.x:focus-visible{outline:2px solid}\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-mobile-viewport-legacy-vh');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
});

test('accepts legacy fallback when dynamic viewport unit also exists', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.page{height:100vh;height:100dvh}.x:focus-visible{outline:2px solid}\n' },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-mobile-viewport-legacy-vh'));
});

test('reports fixed min width at or above 480px', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.panel{min-width:720px;min-height:100dvh}.x:focus-visible{outline:2px solid}\n' },
  ]);
  const finding = section.findings.find(item => item.id === 'whole-page-rigid-mobile-min-width');
  assert.ok(finding);
  assert.equal(finding.evidence?.value, 1);
});

test('does not report compact component min widths below mobile threshold', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.button{min-width:44px;min-height:44px}.x:focus-visible{outline:2px solid}\n' },
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-rigid-mobile-min-width'));
});

test('reports semantic table without responsive overflow contract', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Results</h1><table><tbody><tr><td>A</td></tr></tbody></table></main>;\n',
    },
    { path: 'Webclient.app/src/App.css', text: '.x:focus-visible{outline:2px solid}.page{min-height:100dvh}\n' },
  ]);
  assert.ok(section.findings.some(item => item.id === 'whole-page-table-responsive-contract-missing'));
});

test('accepts wide table inside responsive overflow contract', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Results</h1><table><tbody><tr><td>A</td></tr></tbody></table></main>;\n',
    },
    resilientCss,
  ]);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-table-responsive-contract-missing'));
});

test('recognizes ARIA grid as tabular UI', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Results</h1><div role="grid"><div role="row" /></div></main>;\n',
    },
    { path: 'Webclient.app/src/App.css', text: '.grid{overflow-x:auto}.x:focus-visible{outline:2px solid}.page{min-height:100dvh}\n' },
  ]);
  assert.equal(section.summary.tables, 1);
  assert.ok(!section.findings.some(item => item.id === 'whole-page-table-responsive-contract-missing'));
});

test('counts dialogs and forms in summary without inventing findings', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Map</h1><form><input aria-label="Query" /></form><div role="dialog" aria-label="Details" /></main>;\n',
    },
    resilientCss,
  ]);
  assert.equal(section.summary.dialogs, 1);
  assert.equal(section.summary.forms, 1);
});

test('ignores tests, fixtures and generated product files', () => {
  const section = audit([
    accessibleShell,
    resilientCss,
    { path: 'Webclient.app/src/App.test.tsx', text: '<div onClick={x}>x</div>\n' },
    { path: 'Webclient.app/src/fixtures/Page.tsx', text: '<div onClick={x}>x</div>\n' },
    { path: 'Webclient.app/src/generated/Page.css', text: '.x{min-width:999px}\n' },
  ]);
  assert.equal(section.summary.inspectedFiles, 2);
});

test('does not inspect admin html outside primary Webclient.app public/index surface', () => {
  const section = audit([
    accessibleShell,
    resilientCss,
    { path: 'Api.Admin/wwwroot/index.html', text: '<div>legacy</div>' },
  ]);
  assert.equal(section.summary.htmlFiles, 0);
});

test('recognizes public html product surface', () => {
  const section = audit([
    accessibleShell,
    resilientCss,
    { path: 'Webclient.app/public/offline.html', text: '<main><h1>Offline</h1></main>' },
  ]);
  assert.equal(section.summary.htmlFiles, 1);
  assert.ok(section.summary.mainLandmarks >= 2);
});

test('summary remains deterministic regardless of fixture order', () => {
  const left = audit([accessibleShell, resilientCss]);
  const right = audit([resilientCss, accessibleShell]);
  assert.deepEqual(
    left.summary.files.map(item => item.file),
    right.summary.files.map(item => item.file),
  );
  assert.deepEqual(left.findings.map(item => item.id), right.findings.map(item => item.id));
});

test('fixed and sticky surfaces are surfaced in inventory for review', () => {
  const section = audit([
    accessibleShell,
    {
      path: 'Webclient.app/src/App.css',
      text: '.toolbar{position:sticky;top:0}.drawer{position:fixed;inset:0}.x:focus-visible{outline:2px solid}.page{min-height:100dvh}',
    },
  ]);
  const css = section.summary.files.find(item => item.kind === 'css');
  assert.equal(css?.fixedOrStickySurfaces, 2);
});

test('multiple pointer-only elements are aggregated into one finding', () => {
  const section = audit([
    {
      path: 'Webclient.app/src/App.tsx',
      text: 'export const App=()=> <main id="main-content"><h1>Map</h1><div onClick={a}>A</div><span onClick={b}>B</span></main>;\n',
    },
    resilientCss,
  ]);
  const findings = section.findings.filter(item => item.id === 'whole-page-pointer-only-interaction');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence?.value, 2);
});

test('multiple rigid widths are aggregated into one finding', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/App.css', text: '.a{min-width:480px}.b{min-width:900px}.x:focus-visible{outline:2px solid}.page{min-height:100dvh}' },
  ]);
  const findings = section.findings.filter(item => item.id === 'whole-page-rigid-mobile-min-width');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence?.value, 2);
});

test('aggregate contract can be split across multiple CSS modules', () => {
  const section = audit([
    accessibleShell,
    { path: 'Webclient.app/src/focus.css', text: 'button:focus-visible{outline:2px solid}' },
    { path: 'Webclient.app/src/motion.css', text: '@media (prefers-reduced-motion: reduce){*{transition:none}}' },
    { path: 'Webclient.app/src/contrast.css', text: '@media (forced-colors: active){button{border:1px solid}}' },
    { path: 'Webclient.app/src/touch.css', text: '@media (pointer: coarse){button{min-height:44px}}' },
    { path: 'Webclient.app/src/layout.css', text: '.page{min-height:100dvh}.table-scroll{overflow-x:auto}' },
  ]);
  assert.equal(section.summary.focusVisibleContract, true);
  assert.equal(section.summary.reducedMotionContract, true);
  assert.equal(section.summary.forcedColorsContract, true);
  assert.equal(section.summary.coarsePointerContract, true);
  assert.equal(section.summary.modernViewportContract, true);
  assert.equal(section.summary.responsiveTableContract, true);
});

test('keeps findings stable across repeated audits', () => {
  const inventory = fixtureInventory([
    { path: 'Webclient.app/src/App.tsx', text: 'export const App=()=> <div onClick={x}>X</div>;\n' },
    { path: 'Webclient.app/src/App.css', text: 'button{outline:none}.page{height:100vh;min-width:700px;transition:all 1s}' },
  ]);
  const left = auditWholePageExperience(inventory);
  const right = auditWholePageExperience(inventory);
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, severity: item.severity, blocking: item.blocking, value: item.evidence?.value })),
    right.findings.map(item => ({ id: item.id, severity: item.severity, blocking: item.blocking, value: item.evidence?.value })),
  );
});
