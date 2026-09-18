import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLanguageModernization } from './language-modernization-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

test("flags JSX in JavaScript source", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/Legacy.js", text: "export const View = () => <div />;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-jsx-in-js"));
});

test("does not treat TSX as JSX-in-JS debt", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "export const View = () => <div />;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(!ids.includes('language-jsx-in-js'));
});

test("flags CommonJS require", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/legacy.js", text: "const x = require('./x');" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-commonjs-require"));
});

test("flags module.exports", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/legacy.js", text: "module.exports = createThing;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-commonjs-module-exports"));
});

test("flags exports assignment", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/legacy.js", text: "exports.value = 1;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-commonjs-exports"));
});

test("flags ts-ignore", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/value.ts", text: "// @ts-ignore\\nconst value: number = 'x';" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-ts-ignore"));
});

test("flags explicit any", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/value.ts", text: "export const value = input as any;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-explicit-any"));
});

test("flags process.env in client", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/env.ts", text: "export const api = process.env.API_URL;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-process-env-client"));
});

test("flags PUBLIC_URL", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/url.ts", text: "export const base = PUBLIC_URL + '/x';" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-public-url"));
});

test("flags webpack require.context", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/legacy.js", text: "const modules = require.context('./icons');" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-webpack-context"));
});

test("flags webpack runtime global", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/runtime.ts", text: "const load = __webpack_require__;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-webpack-runtime"));
});

test("flags module.hot", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/legacy.js", text: "if (module.hot) module.hot.accept();" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-module-hot"));
});

test("flags ReactDOM.render", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/index.tsx", text: "ReactDOM.render(<App />, root);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-reactdom-render"));
});

test("flags ReactDOM.hydrate", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/index.tsx", text: "ReactDOM.hydrate(<App />, root);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-reactdom-hydrate"));
});

test("flags findDOMNode", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "const node = findDOMNode(this);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-find-dom-node"));
});

test("flags string refs", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "const view = <div ref=\"legacyRef\" />;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-string-ref"));
});

test("flags unsafe lifecycle", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "UNSAFE_componentWillMount() {}" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-unsafe-lifecycle"));
});

test("flags componentWillMount", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "componentWillMount() {}" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-component-will-mount"));
});

test("flags componentWillReceiveProps", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "componentWillReceiveProps(next) {}" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-component-will-receive-props"));
});

test("flags componentWillUpdate", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "componentWillUpdate() {}" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-component-will-update"));
});

test("flags deprecated Buffer constructor", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/node.ts", text: "const data = new Buffer(size);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-new-buffer"));
});

test("flags substr", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/text.ts", text: "const part = value.substr(1);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-substr"));
});

test("flags execCommand", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/clipboard.ts", text: "document.execCommand('copy');" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-document-exec-command"));
});

test("flags escape APIs", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/url.ts", text: "const encoded = escape(value);" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-escape-api"));
});

test("flags explicit js import from typed source", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/bridge.ts", text: "import value from '../legacy.js';" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-js-extension-import-from-ts"));
});

test("reports PropTypes in TS as info", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Components/View.tsx", text: "View.propTypes = { name: PropTypes.string };" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-proptypes-in-ts"));
});

test("reports var declarations", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/value.ts", text: "var value = 1;" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-var-declaration"));
});

test("flags undocumented ts-expect-error", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/value.ts", text: "// @ts-expect-error\\nconst x = bad();" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-ts-expect-error-undocumented"));
});

test("flags cjs dependency edges", () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: "Webclient.app/src/Core/value.ts", text: "import legacy from './legacy.cjs';" },
  ]));
  const ids = section.findings.map(finding => finding.id);
  assert.ok(ids.includes("language-cjs-extension"));
});

test('ts-nocheck is critical and blocking inside a strict modern boundary', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/platform/runtime.ts',
      text: '// @ts-nocheck\nexport const runtime = true;',
    },
  ]));
  const finding = section.findings.find(item => item.id === 'language-ts-nocheck');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('ts-nocheck outside the modern typed boundary is still visible without forced blocking', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/Components/Legacy.tsx',
      text: '// @ts-nocheck\nexport const Legacy = () => null;',
    },
  ]));
  const finding = section.findings.find(item => item.id === 'language-ts-nocheck');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, undefined);
});

test('detects duplicate legacy and typed modules under the same stem', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/Core/AppConfig.js', text: 'export default {};\n' },
    { path: 'Webclient.app/src/Core/AppConfig.ts', text: 'export default {} as const;\n' },
  ]));
  const finding = section.findings.find(item => item.id === 'language-duplicate-js-ts-module');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.match(String(finding.evidence?.value), /AppConfig\.js/);
  assert.match(String(finding.evidence?.value), /AppConfig\.ts/);
});

test('duplicate module stems outside strict modern directories are reported as low migration debt', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/Components/Legacy.js', text: 'export default 1;\n' },
    { path: 'Webclient.app/src/Components/Legacy.ts', text: 'export default 1;\n' },
  ]));
  const finding = section.findings.find(item => item.id === 'language-duplicate-js-ts-module');
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
});

test('strict=false in primary webclient tsconfig is critical and blocking', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/tsconfig.json',
      text: JSON.stringify({ compilerOptions: { strict: false } }),
    },
  ]));
  const finding = section.findings.find(item => item.id === 'language-tsconfig-strict-disabled');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('strict=false in a non-primary tsconfig remains high severity without forced blocking', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'tools/tsconfig.json',
      text: JSON.stringify({ compilerOptions: { strict: false } }),
    },
  ]));
  const finding = section.findings.find(item => item.id === 'language-tsconfig-strict-disabled');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, undefined);
});

test('primary compiler contract reports disabled noUncheckedIndexedAccess', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/tsconfig.json',
      text: JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: false,
          exactOptionalPropertyTypes: true,
          useUnknownInCatchVariables: true,
        },
      }),
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'language-tsconfig-noUncheckedIndexedAccess-disabled'));
});

test('primary compiler contract reports disabled exactOptionalPropertyTypes', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/tsconfig.json',
      text: JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: false,
          useUnknownInCatchVariables: true,
        },
      }),
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'language-tsconfig-exactOptionalPropertyTypes-disabled'));
});

test('primary compiler contract reports disabled useUnknownInCatchVariables', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'quality/release/tsconfig.json',
      text: JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          useUnknownInCatchVariables: false,
        },
      }),
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'language-tsconfig-useUnknownInCatchVariables-disabled'));
});

test('healthy strict compiler contract produces no compiler hardening findings', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/tsconfig.json',
      text: JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          useUnknownInCatchVariables: true,
          verbatimModuleSyntax: true,
        },
      }),
    },
  ]));
  assert.ok(!section.findings.some(item => item.id.startsWith('language-tsconfig-')));
});

test('summary computes typed ratio across active frontend script files', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/a.ts', text: 'export const a = 1;\n' },
    { path: 'Webclient.app/src/b.tsx', text: 'export const b = () => null;\n' },
    { path: 'Webclient.app/src/c.js', text: 'export const c = 1;\n' },
    { path: 'README.md', text: '# ignored\n' },
  ]));
  assert.equal(section.summary.frontendScriptFiles, 3);
  assert.equal(section.summary.typescriptFiles, 2);
  assert.equal(section.summary.javascriptFiles, 1);
  assert.equal(section.summary.typedRatio, 2 / 3);
});

test('summary exposes JSX-in-JavaScript and CommonJS file inventories deterministically', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/z.js', text: 'const x = require("./x");\nexport const Z = () => <div />;\n' },
    { path: 'Webclient.app/src/a.js', text: 'module.exports = 1;\n' },
  ]));
  assert.deepEqual(section.summary.jsxInJavaScriptFiles, ['Webclient.app/src/z.js']);
  assert.deepEqual(section.summary.commonJsFiles, [
    'Webclient.app/src/a.js',
    'Webclient.app/src/z.js',
  ]);
});

test('summary exposes TypeScript suppression files', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/Core/a.ts', text: '// @ts-ignore\nexport const a = bad;\n' },
    { path: 'Webclient.app/src/Core/b.ts', text: '// @ts-nocheck\nexport const b = bad;\n' },
  ]));
  assert.deepEqual(section.summary.suppressionFiles, [
    'Webclient.app/src/Core/a.ts',
    'Webclient.app/src/Core/b.ts',
  ]);
});

test('test files do not create production language debt findings', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/Core/value.test.ts', text: '// @ts-nocheck\nconst x = require("./x");\n' },
  ]));
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.scannedFiles, 0);
});

test('generated and build output paths do not create language findings', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/build/generated.js', text: 'module.exports = <div />;\n' },
    { path: 'Webclient.app/src/coverage/report.js', text: 'module.exports = 1;\n' },
  ]));
  assert.equal(section.findings.length, 0);
});

test('per-rule matching is bounded to three findings per file', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/Core/many.ts',
      text: 'const a: any = 1;\nconst b: any = 2;\nconst c: any = 3;\nconst d: any = 4;\n',
    },
  ]));
  const findings = section.findings.filter(item => item.id === 'language-explicit-any');
  assert.equal(findings.length, 3);
});

test('findings preserve exact source line numbers', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/Core/env.ts',
      text: 'export const a = 1;\nexport const b = 2;\nexport const api = process.env.API_URL;\n',
    },
  ]));
  const finding = section.findings.find(item => item.id === 'language-process-env-client');
  assert.ok(finding);
  assert.equal(finding.location?.line, 3);
});

test('findingsByRule is deterministic and aggregated', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/legacy.js',
      text: 'const a = require("./a");\nconst b = require("./b");\nmodule.exports = { a, b };\n',
    },
  ]));
  assert.equal(section.summary.findingsByRule['language-commonjs-require'], 2);
  assert.equal(section.summary.findingsByRule['language-commonjs-module-exports'], 1);
  assert.deepEqual(
    Object.keys(section.summary.findingsByRule),
    [...Object.keys(section.summary.findingsByRule)].sort((a, b) => a.localeCompare(b, 'en')),
  );
});

test('clean modern TS source remains finding-free', () => {
  const section = auditLanguageModernization(fixtureInventory([
    {
      path: 'Webclient.app/src/platform/clean.ts',
      text: 'export interface Value { readonly id: string; }\nexport const read = (value: Value): string => value.id;\n',
    },
    {
      path: 'Webclient.app/tsconfig.json',
      text: JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          useUnknownInCatchVariables: true,
          verbatimModuleSyntax: true,
        },
      }),
    },
  ]));
  assert.equal(section.findings.length, 0);
});
