import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNodeExecutionBoundaries } from './node-execution-boundary-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

interface Fixture {
  readonly path: string;
  readonly text: string;
  readonly kind?: FileKind;
}

function source(input: Fixture): SourceFile {
  const extension = input.path.slice(input.path.lastIndexOf('.')).toLowerCase();
  return {
    absolutePath: `/repo/${input.path}`,
    repositoryPath: input.path,
    extension,
    kind: input.kind ?? (/[cm]?ts$/i.test(extension) ? 'typescript' : 'javascript'),
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

function audit(text: string, path = 'tools/example.mts') {
  return auditNodeExecutionBoundaries(inventory([{ path, text }]));
}

function ids(text: string, path?: string): string[] {
  return audit(text, path).findings.map(item => item.id);
}

test('blocks eval in release tooling', () => {
  const report = audit('export const result = eval(source);');
  const finding = report.findings.find(item => item.id === 'node-execution-eval');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.location?.line, 1);
});

test('blocks new Function construction', () => {
  const report = audit("const compile = new Function('value', source);");
  assert.ok(ids("const compile = new Function('value', source);").includes('node-execution-function-constructor'));
  assert.equal(report.summary.dynamicCodeFiles, 1);
});

test('blocks direct Function constructor calls', () => {
  assert.ok(ids("const compile = Function('return 1');").includes('node-execution-function-constructor'));
});

test('does not mistake a method named Function for the global constructor', () => {
  assert.ok(!ids('factory.Function(source);').includes('node-execution-function-constructor'));
});

test('blocks vm execution primitives', () => {
  for (const expression of [
    'vm.runInNewContext(source, context);',
    'vm.runInContext(source, context);',
    'vm.runInThisContext(source);',
    'vm.compileFunction(source, []);',
    'new vm.Script(source);',
  ]) {
    assert.ok(ids(expression).includes('node-execution-vm-source'), expression);
  }
});

test('reports shell-string exec for migration without making it an automatic blocker', () => {
  const report = audit("exec('git status', callback);");
  const finding = report.findings.find(item => item.id === 'node-execution-exec');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
  assert.equal(report.summary.shellExecutionFiles, 1);
});

test('reports synchronous shell execution', () => {
  const report = audit("const output = execSync('git status', { encoding: 'utf8' });");
  assert.ok(report.findings.some(item => item.id === 'node-execution-exec-sync'));
});

test('reports shell true on spawn-style execution', () => {
  const report = audit("spawn('npm', ['test'], { shell: true });");
  assert.ok(report.findings.some(item => item.id === 'node-execution-shell-true'));
});

test('accepts literal ESM imports', () => {
  const report = audit("const module = await import('./known-module.mjs');");
  assert.ok(!report.findings.some(item => item.id === 'node-execution-dynamic-import'));
});

test('reports expression-derived ESM imports', () => {
  const report = audit('const module = await import(`./plugins/${name}.mjs`);');
  assert.ok(report.findings.some(item => item.id === 'node-execution-dynamic-import'));
  assert.equal(report.summary.dynamicModuleFiles, 1);
});

test('accepts literal CommonJS require while migration is separately governed', () => {
  const report = audit("const fs = require('node:fs');", 'tools/compat.js');
  assert.ok(!report.findings.some(item => item.id === 'node-execution-dynamic-require'));
});

test('reports expression-derived require', () => {
  const report = audit('const plugin = require(pluginPath);', 'tools/compat.js');
  assert.ok(report.findings.some(item => item.id === 'node-execution-dynamic-require'));
});

test('reports environment-derived child process composition on the same line', () => {
  const report = audit("spawn(process.env.TOOL, ['check'], { shell: false });");
  const finding = report.findings.find(item => item.id === 'node-execution-env-command-composition');
  assert.equal(finding?.severity, 'medium');
  assert.match(finding?.message ?? '', /Environment values/);
});

test('does not flag environment reads that are not process execution inputs', () => {
  const report = audit('const mode = process.env.NODE_ENV;\nconsole.log(mode);');
  assert.ok(!report.findings.some(item => item.id === 'node-execution-env-command-composition'));
  assert.equal(report.summary.files[0]?.envCommandReferences, 1);
});

test('scans root tools, quality tooling and Webclient scripts', () => {
  const report = auditNodeExecutionBoundaries(inventory([
    { path: 'tools/a.mts', text: 'eval(source);' },
    { path: 'quality/release/b.mts', text: 'exec(command);' },
    { path: 'Webclient.app/scripts/c.mjs', text: 'import(plugin);' },
    { path: 'scripts/d.js', text: 'require(plugin);' },
  ]));
  assert.equal(report.summary.scannedFiles, 4);
  assert.equal(report.summary.dynamicCodeFiles, 1);
  assert.equal(report.summary.shellExecutionFiles, 1);
  assert.equal(report.summary.dynamicModuleFiles, 2);
});

test('does not scan product browser source because browser authority is separate', () => {
  const report = audit('eval(source);', 'Webclient.app/src/App.tsx');
  assert.equal(report.summary.scannedFiles, 0);
  assert.equal(report.findings.length, 0);
});

test('does not scan tests as production execution authority', () => {
  const report = audit('eval(source);', 'quality/release/example.test.mts');
  assert.equal(report.summary.scannedFiles, 0);
});

test('does not scan generated output', () => {
  const report = auditNodeExecutionBoundaries(inventory([
    { path: 'tools/dist/a.js', text: 'eval(source);' },
    { path: 'Webclient.app/scripts/coverage/b.js', text: 'exec(command);' },
    { path: 'quality/fixtures/c.mts', text: 'new Function(source);' },
  ]));
  assert.equal(report.summary.scannedFiles, 0);
});

test('counts multiple risk classes in one file', () => {
  const report = audit(`
const a = eval(source);
const b = new Function(source);
const c = execSync(command);
const d = import(plugin);
const e = require(plugin);
spawn('npm', ['test'], { shell: true });
`);
  const signal = report.summary.files[0];
  assert.equal(signal?.evalCalls, 1);
  assert.equal(signal?.functionConstructors, 1);
  assert.equal(signal?.execSyncCalls, 1);
  assert.equal(signal?.dynamicImports, 1);
  assert.equal(signal?.dynamicRequires, 1);
  assert.equal(signal?.shellSpawns, 1);
});

test('keeps all blocking dynamic-code findings even when review findings exceed the cap', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `exec(command${index});`).join('\n');
  const report = audit(`${lines}\neval(source);`);
  assert.ok(report.findings.some(item => item.id === 'node-execution-eval' && item.blocking === true));
  assert.ok(report.findings.length <= 33);
});

test('bounds nonblocking findings so existing migration debt cannot explode report size', () => {
  const lines = Array.from({ length: 80 }, (_, index) => `exec(command${index});`).join('\n');
  const report = audit(lines);
  assert.equal(report.findings.length, 32);
  assert.ok(report.findings.every(item => item.blocking !== true));
});

test('normalizes CRLF line numbers', () => {
  const report = audit("const safe = 1;\r\nexec(command);\r\neval(source);\r\n");
  const evalFinding = report.findings.find(item => item.id === 'node-execution-eval');
  const execFinding = report.findings.find(item => item.id === 'node-execution-exec');
  assert.equal(execFinding?.location?.line, 2);
  assert.equal(evalFinding?.location?.line, 3);
});

test('reports deterministic output independent of inventory order', () => {
  const fixtures: readonly Fixture[] = [
    { path: 'tools/z.mts', text: 'exec(command);' },
    { path: 'tools/a.mts', text: 'eval(source);' },
    { path: 'Webclient.app/scripts/m.mjs', text: 'import(plugin);' },
  ];
  const first = auditNodeExecutionBoundaries(inventory(fixtures));
  const second = auditNodeExecutionBoundaries(inventory([...fixtures].reverse()));
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, location: item.location, severity: item.severity, blocking: item.blocking })),
    second.findings.map(item => ({ id: item.id, location: item.location, severity: item.severity, blocking: item.blocking })),
  );
  assert.deepEqual(first.summary.files.map(item => item.file), ['Webclient.app/scripts/m.mjs', 'tools/a.mts', 'tools/z.mts']);
});
