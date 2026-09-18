import assert from 'node:assert/strict';
import test from 'node:test';
import { scanSource } from './source-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

const source = (
  repositoryPath: string,
  text: string,
  kind: FileKind = 'typescript',
): SourceFile => ({
  absolutePath: `/repo/${repositoryPath}`,
  repositoryPath,
  extension: repositoryPath.slice(repositoryPath.lastIndexOf('.')),
  kind,
  bytes: new TextEncoder().encode(text).byteLength,
  lines: text.split(/\r?\n/u).length,
  text,
});

const inventory = (files: readonly SourceFile[]): RepositoryInventory => ({
  root: '/repo',
  files,
  ignoredDirectories: [],
  languageStats: [],
  totalFiles: files.length,
  totalLines: files.reduce((sum, file) => sum + file.lines, 0),
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  generatedAt: '2026-09-18T00:00:00.000Z',
});

test('dynamic execution fixtures in conventional test/spec files are excluded', () => {
  const report = scanSource(inventory([
    source(
      'tools/browser-runtime-boundary.test.mjs',
      "test('rejects eval', () => { const fixture = 'eval(input)'; });",
      'javascript',
    ),
    source(
      'Webclient.app/src/runtime.spec.ts',
      "const fixture = 'new Function(input)()';",
    ),
  ]));

  assert.equal(
    report.findings.filter((finding) => finding.id === 'dynamic-eval').length,
    0,
  );
});

test('production dynamic execution remains critical and explicitly blocking', () => {
  const report = scanSource(inventory([
    source('Webclient.app/src/runtime.ts', 'export const run = (input) => eval(input);'),
  ]));

  const finding = report.findings.find((candidate) => candidate.id === 'dynamic-eval');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
  assert.equal(finding.location?.file, 'Webclient.app/src/runtime.ts');
});
