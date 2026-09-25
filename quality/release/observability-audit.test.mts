import assert from 'node:assert/strict';
import test from 'node:test';
import { auditObservability } from './observability-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile {
  return { absolutePath: `/repo/${path}`, repositoryPath: path, extension: '.ts', kind, bytes: new TextEncoder().encode(text).byteLength, lines: text.split(/\r?\n/).length, text };
}
function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return { root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((sum, file) => sum + file.lines, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-16T00:00:00.000Z' };
}
function ids(section: ReturnType<typeof auditObservability>): string[] { return section.findings.map(item => item.id); }

test('flags direct runtime console output', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/runtime.ts', `export function run() { console.error('failed'); }`)]));
  assert.ok(ids(section).includes('observability-console-runtime'));
  assert.equal(section.summary.consoleCalls, 1);
});

test('flags silently swallowed exceptions', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/runtime.ts', `try { run(); } catch { }`)]));
  const finding = section.findings.find(item => item.id === 'observability-swallowed-exception');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
});

test('accepts catch block with explicit handling', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/runtime.ts', `try { run(); } catch (error) { report(error); }`)]));
  assert.ok(!ids(section).includes('observability-swallowed-exception'));
});

test('flags interval without cleanup evidence', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/poll.ts', `export function start() { setInterval(refresh, 5000); }`)]));
  assert.ok(ids(section).includes('observability-interval-cleanup-review'));
  assert.equal(section.summary.intervalCalls, 1);
});

test('accepts interval with nearby deterministic cleanup', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/poll.ts', `export function start() { const id = setInterval(refresh, 5000); return () => clearInterval(id); }`)]));
  assert.ok(!ids(section).includes('observability-interval-cleanup-review'));
});

test('flags listener without file-local cleanup', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/events.ts', `window.addEventListener('resize', resize);`)]));
  assert.ok(ids(section).includes('observability-listener-cleanup-review'));
});

test('accepts listener with removal contract', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/events.ts', `window.addEventListener('resize', resize); window.removeEventListener('resize', resize);`)]));
  assert.ok(!ids(section).includes('observability-listener-cleanup-review'));
});

test('flags timer-dense module', () => {
  const text = Array.from({ length: 8 }, (_, index) => `setTimeout(task${index}, ${index + 1});`).join('\n');
  const section = auditObservability(inventory([source('Webclient.app/src/scheduler.ts', text)]));
  assert.ok(ids(section).includes('observability-timer-pressure'));
  assert.equal(section.summary.timerCalls, 8);
});

test('raises timer pressure severity for very dense scheduling', () => {
  const text = Array.from({ length: 20 }, (_, index) => `setTimeout(task${index}, ${index + 1});`).join('\n');
  const section = auditObservability(inventory([source('Webclient.app/src/scheduler.ts', text)]));
  assert.equal(section.findings.find(item => item.id === 'observability-timer-pressure')?.severity, 'high');
});

test('does not classify call-dense synchronous runtime code as detached Promise work', () => {
  const calls = Array.from({ length: 20 }, (_, index) => `record${index}(state);`).join('\n');
  const section = auditObservability(inventory([source('Webclient.app/src/controller.ts', calls)]));
  assert.equal(section.summary.unhandledPromises, 0);
  assert.ok(!ids(section).includes('observability-async-boundary-review'));
});

test('flags dense detached async work without a visible failure boundary', () => {
  const calls = Array.from({ length: 12 }, () => 'refreshAsync();').join('\n');
  const section = auditObservability(inventory([source('Webclient.app/src/async-runtime.ts', `async function refreshAsync() { return 1; }\n${calls}`)]));
  assert.equal(section.summary.unhandledPromises, 12);
  assert.ok(ids(section).includes('observability-async-boundary-review'));
});

test('flags repeated network work without cancellation signal', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/data.ts', `fetch('/a'); fetch('/b'); fetch('/c');`)]));
  assert.ok(ids(section).includes('observability-cancellation-contract-review'));
});

test('accepts network module with AbortSignal contract', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/data.ts', `export async function load(signal: AbortSignal) { await fetch('/a', { signal }); await fetch('/b', { signal }); await fetch('/c', { signal }); }`)]));
  assert.ok(!ids(section).includes('observability-cancellation-contract-review'));
});

test('counts abort-controller evidence', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/data.ts', `const controller = new AbortController(); fetch('/a', { signal: controller.signal });`)]));
  assert.equal(section.summary.abortControllers, 1);
});

test('flags diagnostic-rich module without correlation vocabulary', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/diag.ts', `logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric);`)]));
  assert.ok(ids(section).includes('observability-correlation-review'));
});

test('accepts diagnostic-rich module with request correlation', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/diag.ts', `const requestId = id; logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric); logger.info(metric);`)]));
  assert.ok(!ids(section).includes('observability-correlation-review'));
  assert.ok(section.summary.correlationSignals > 0);
});

test('ignores tests and generated output', () => {
  const section = auditObservability(inventory([
    source('Webclient.app/src/__tests__/bad.test.ts', `console.error('x'); try { x(); } catch {}`),
    source('Webclient.app/src/runtime.test.ts', `window.addEventListener('resize', resize); fetch('/a'); fetch('/b'); fetch('/c');`),
    source('Webclient.app/src/runtime.spec.ts', `setInterval(refresh, 1); console.warn('spec');`),
    source('Webclient.app/dist/app.js', `console.error('x'); setInterval(x, 1);`, 'javascript'),
  ]));
  assert.equal(section.summary.runtimeFiles, 0);
  assert.equal(section.findings.length, 0);
});

test('does not treat generic admission request vocabulary as network IO', () => {
  const section = auditObservability(inventory([
    source('Webclient.app/src/admission.ts', `
      export const score = (request) => request.cost;
      export const queue = (request) => request.priority;
      export const decide = (request) => request.lane;
    `),
  ]));
  assert.ok(!ids(section).includes('observability-cancellation-contract-review'));
});

test('still flags repeated explicit transport calls without cancellation', () => {
  const section = auditObservability(inventory([
    source('Webclient.app/src/transport.ts', `
      httpClient.get('/a');
      httpClient.get('/b');
      httpClient.get('/c');
    `),
  ]));
  assert.ok(ids(section).includes('observability-cancellation-contract-review'));
});

test('ignores backend and tooling files outside browser runtime roots', () => {
  const section = auditObservability(inventory([source('quality/release/tool.mts', `console.error('x');`)]));
  assert.equal(section.summary.runtimeFiles, 0);
});

test('preserves source line for swallowed exception finding', () => {
  const section = auditObservability(inventory([source('Webclient.app/src/runtime.ts', `function x() {\n try { run(); }\n catch { }\n}`)]));
  assert.equal(section.findings.find(item => item.id === 'observability-swallowed-exception')?.location?.line, 3);
});

test('summary aggregates runtime signals across files', () => {
  const section = auditObservability(inventory([
    source('Webclient.app/src/a.ts', `console.warn('a'); const c = new AbortController();`),
    source('Webclient.Admin/src/b.ts', `setTimeout(work, 1); window.addEventListener('resize', work); window.removeEventListener('resize', work);`),
  ]));
  assert.equal(section.summary.runtimeFiles, 2);
  assert.equal(section.summary.consoleCalls, 1);
  assert.equal(section.summary.abortControllers, 1);
  assert.equal(section.summary.timerCalls, 1);
  assert.equal(section.summary.eventListeners, 1);
});
