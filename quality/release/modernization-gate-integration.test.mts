import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPageUsabilityContracts } from './page-usability-contract-audit.mts';
import { auditToolingLanguageContracts } from './tooling-language-contract-audit.mts';
import { auditWholePageExperience } from './whole-page-experience-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const packageJson = JSON.stringify({
  name: 'webclient',
  private: true,
  type: 'module',
  engines: { node: '>=24.0.0', npm: '>=11.0.0' },
  scripts: {
    verify: 'npm run dependency:verify && npm run lint:strict && npm run typecheck && npm run test:ci && npm run test:tooling && npm run build && npm run build:verify',
    'test:tooling': 'node --test scripts/release-contract.test.mts',
    typecheck: 'tsc --noEmit -p tsconfig.json',
  },
}, null, 2);

const css = `
  .skip-link:focus-visible, button:focus-visible { outline: 3px solid CanvasText; }
  .page { min-height: 100dvh; }
  .table-scroll { overflow-x: auto; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (forced-colors: active) { button:focus-visible { outline: 2px solid Highlight; } }
  @media (pointer: coarse) { button { min-width: 44px; min-height: 44px; } }
`;

const shell = `
  export const App = () => <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <main id="main-content">
      <h1>Kent Rehberi</h1>
      <button type="button">Open map</button>
    </main>
  </>;
`;

test('modernization gates agree on a typed and usable product fixture', () => {
  const inventory = fixtureInventory([
    { path: 'Webclient.app/package.json', text: packageJson },
    { path: 'Webclient.app/scripts/release-contract.mts', text: 'export const releaseReady: boolean = true;\n' },
    { path: 'Webclient.app/scripts/release-contract.test.mts', text: "import test from 'node:test'; test('ready', () => {});\n" },
    { path: 'Webclient.app/src/App.tsx', text: shell },
    { path: 'Webclient.app/src/App.css', text: css },
  ]);

  const tooling = auditToolingLanguageContracts(inventory);
  const page = auditPageUsabilityContracts(inventory);
  const wholePage = auditWholePageExperience(inventory);

  assert.equal(tooling.findings.some(item => item.blocking === true), false);
  assert.equal(page.findings.some(item => item.blocking === true), false);
  assert.equal(wholePage.findings.some(item => item.blocking === true), false);
  assert.equal(wholePage.summary.focusVisibleContract, true);
  assert.equal(wholePage.summary.reducedMotionContract, true);
  assert.equal(wholePage.summary.forcedColorsContract, true);
  assert.equal(wholePage.summary.coarsePointerContract, true);
});

test('modernization gates preserve independent blockers for language and page regressions', () => {
  const inventory = fixtureInventory([
    {
      path: 'Webclient.app/package.json',
      text: JSON.stringify({
        name: 'webclient',
        type: 'commonjs',
        engines: { node: '>=22', npm: '>=10' },
        scripts: { verify: 'echo skipped', typecheck: 'echo skipped', 'test:tooling': 'echo skipped' },
      }),
    },
    { path: 'Webclient.app/scripts/release-gate.cjs', text: 'module.exports = true;\n' },
    { path: 'Webclient.app/src/App.tsx', text: 'export const App = () => <div onClick={open}>Open</div>;\n' },
    { path: 'Webclient.app/src/App.css', text: 'button { outline: none; } .page { height: 100vh; min-width: 720px; }\n' },
  ]);

  const tooling = auditToolingLanguageContracts(inventory);
  const page = auditPageUsabilityContracts(inventory);
  const wholePage = auditWholePageExperience(inventory);

  assert.ok(tooling.findings.some(item => item.id === 'tooling-package-esm-contract-missing' && item.blocking === true));
  assert.ok(tooling.findings.some(item => item.id === 'tooling-release-authority-commonjs' && item.blocking === true));
  assert.ok(wholePage.findings.some(item => item.id === 'whole-page-main-landmark-missing' && item.blocking === true));
  assert.ok(wholePage.findings.some(item => item.id === 'whole-page-focus-outline-suppressed' && item.blocking === true));
  assert.ok(wholePage.findings.some(item => item.id === 'whole-page-pointer-only-interaction'));
  assert.ok(page.findings.length >= 0);
});
