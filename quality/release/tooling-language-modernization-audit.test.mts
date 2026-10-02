import assert from 'node:assert/strict';
import test from 'node:test';
import { auditToolingLanguageModernization } from './tooling-language-modernization-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

interface Fixture {
  readonly path: string;
  readonly text: string;
  readonly kind?: FileKind;
}

function source(input: Fixture): SourceFile {
  const index = input.path.lastIndexOf('.');
  const extension = index >= 0 ? input.path.slice(index).toLowerCase() : '';
  const typed = /\.(?:ts|tsx|mts|cts)$/i.test(extension);
  return {
    absolutePath: `/repo/${input.path}`,
    repositoryPath: input.path,
    extension,
    kind: input.kind ?? (typed ? 'typescript' : 'javascript'),
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
  return auditToolingLanguageModernization(inventory(fixtures));
}

function ids(fixtures: readonly Fixture[]): string[] {
  return audit(fixtures).findings.map(item => item.id);
}

test('treats mts and ts tooling as typed source', () => {
  const report = audit([
    { path: 'tools/a.mts', text: "import fs from 'node:fs';" },
    { path: 'quality/release/b.ts', text: 'export const value: string = "ok";' },
  ]);
  assert.equal(report.summary.totalToolingFiles, 2);
  assert.equal(report.summary.typedFiles, 2);
  assert.equal(report.summary.legacyJavaScriptFiles, 0);
  assert.equal(report.summary.typedRatio, 1);
});

test('reports mjs tooling as staged migration inventory without blocking', () => {
  const report = audit([{ path: 'Webclient.app/scripts/build.mjs', text: "import fs from 'node:fs';" }]);
  const finding = report.findings.find(item => item.id === 'tooling-language-untyped-module');
  assert.equal(finding?.severity, 'info');
  assert.equal(finding?.blocking, undefined);
  assert.equal(report.summary.typedRatio, 0);
});

test('reports plain js tooling as staged migration inventory', () => {
  assert.ok(ids([{ path: 'scripts/audit.js', text: 'export const run = () => true;' }]).includes('tooling-language-untyped-module'));
});

test('reports jsx tooling with a stronger TSX migration hint', () => {
  const report = audit([{ path: 'tools/panel.jsx', text: 'export const View = () => <div />;' }]);
  const finding = report.findings.find(item => item.id === 'tooling-language-jsx-without-types');
  assert.equal(finding?.severity, 'low');
});

test('reports cjs as explicit CommonJS architecture debt', () => {
  const report = audit([{ path: 'tools/legacy.cjs', text: 'module.exports = require("node:path");' }]);
  assert.ok(report.findings.some(item => item.id === 'tooling-language-commonjs-extension' && item.severity === 'medium'));
  assert.ok(report.findings.some(item => item.id === 'tooling-language-commonjs-contract'));
  assert.equal(report.summary.commonJsFiles, 1);
});

test('detects require in a js compatibility island', () => {
  const report = audit([{ path: 'Webclient.app/scripts/legacy.js', text: 'const fs = require("node:fs");' }]);
  assert.ok(report.findings.some(item => item.id === 'tooling-language-commonjs-contract'));
  assert.equal(report.summary.files[0]?.commonJsRequire, 1);
});

test('detects CommonJS export assignments', () => {
  const report = audit([{ path: 'tools/exporter.js', text: 'exports.run = run;\nmodule.exports.extra = value;' }]);
  assert.equal(report.summary.files[0]?.commonJsExports, 2);
});

test('blocks ts-nocheck in release tooling', () => {
  const report = audit([{ path: 'quality/release/unsafe.mts', text: '// @ts-nocheck\nexport const value = input;' }]);
  const finding = report.findings.find(item => item.id === 'tooling-language-ts-nocheck');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('reports ts-ignore as migration debt', () => {
  const report = audit([{ path: 'tools/compat.mts', text: '// @ts-ignore\nlegacy();' }]);
  const finding = report.findings.find(item => item.id === 'tooling-language-ts-ignore');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('counts ts-expect-error without treating it like ts-ignore', () => {
  const report = audit([{ path: 'tools/compat.mts', text: '// @ts-expect-error upstream lacks types\nlegacy();' }]);
  assert.equal(report.summary.files[0]?.tsExpectError, 1);
  assert.ok(!report.findings.some(item => item.id === 'tooling-language-ts-ignore'));
});

test('reports explicit any as informational strictness debt', () => {
  const report = audit([{ path: 'tools/parser.mts', text: 'export const parse = (value: any) => value as any;' }]);
  const finding = report.findings.find(item => item.id === 'tooling-language-explicit-any');
  assert.equal(finding?.severity, 'info');
  assert.equal(report.summary.files[0]?.explicitAny, 2);
});

test('does not report any text in legacy JS as TypeScript any debt', () => {
  const report = audit([{ path: 'tools/parser.js', text: 'const any = value;' }]);
  assert.ok(!report.findings.some(item => item.id === 'tooling-language-explicit-any'));
});

test('scans root tools, quality and both webclient script surfaces', () => {
  const report = audit([
    { path: 'tools/a.mts', text: 'export {};' },
    { path: 'quality/release/b.mts', text: 'export {};' },
    { path: 'scripts/c.mjs', text: 'export {};' },
    { path: 'Webclient.app/scripts/d.mjs', text: 'export {};' },
    { path: 'Webclient.Admin/scripts/e.js', text: 'export {};' },
  ]);
  assert.equal(report.summary.totalToolingFiles, 5);
  assert.equal(report.summary.typedFiles, 2);
  assert.equal(report.summary.legacyJavaScriptFiles, 3);
  assert.equal(report.summary.typedRatio, 0.4);
});

test('does not scan product source already owned by the frontend language audit', () => {
  const report = audit([{ path: 'Webclient.app/src/App.js', text: 'module.exports = App;' }]);
  assert.equal(report.summary.totalToolingFiles, 0);
});

test('does not scan generated output', () => {
  const report = audit([
    { path: 'tools/dist/a.js', text: 'module.exports = 1;' },
    { path: 'quality/coverage/b.js', text: 'module.exports = 1;' },
    { path: 'Webclient.app/scripts/build/generated/c.js', text: 'module.exports = 1;' },
  ]);
  assert.equal(report.summary.totalToolingFiles, 0);
});

test('does not scan fixture and snapshot data as executable authority', () => {
  const report = audit([
    { path: 'quality/fixtures/a.js', text: 'module.exports = 1;' },
    { path: 'quality/snapshots/b.mjs', text: 'require("x");' },
  ]);
  assert.equal(report.summary.totalToolingFiles, 0);
});

test('bounds legacy inventory findings while retaining contract findings', () => {
  const fixtures: Fixture[] = [];
  for (let index = 0; index < 40; index += 1) {
    fixtures.push({ path: `tools/legacy-${index}.mjs`, text: 'export const value = 1;' });
  }
  fixtures.push({ path: 'tools/unsafe.mts', text: '// @ts-nocheck\nexport {};' });
  const report = audit(fixtures);
  assert.equal(report.findings.filter(item => item.id === 'tooling-language-untyped-module').length, 24);
  assert.ok(report.findings.some(item => item.id === 'tooling-language-ts-nocheck' && item.blocking === true));
});

test('calculates typed ratio to four decimals', () => {
  const report = audit([
    { path: 'tools/a.mts', text: 'export {};' },
    { path: 'tools/b.mts', text: 'export {};' },
    { path: 'tools/c.mjs', text: 'export {};' },
  ]);
  assert.equal(report.summary.typedRatio, 0.6667);
});

test('returns a perfect ratio for an empty tooling inventory', () => {
  const report = audit([]);
  assert.equal(report.summary.typedRatio, 1);
});

test('sorts files and findings deterministically', () => {
  const fixtures: readonly Fixture[] = [
    { path: 'tools/z.cjs', text: 'module.exports = 1;' },
    { path: 'tools/a.js', text: 'const x = require("x");' },
    { path: 'quality/release/m.mts', text: '// @ts-ignore\nlegacy();' },
  ];
  const first = audit(fixtures);
  const second = audit([...fixtures].reverse());
  assert.deepEqual(first.summary.files.map(item => item.file), ['quality/release/m.mts', 'tools/a.js', 'tools/z.cjs']);
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location, blocking: item.blocking })),
    second.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location, blocking: item.blocking })),
  );
});
