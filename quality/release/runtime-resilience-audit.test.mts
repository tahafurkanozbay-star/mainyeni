import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRuntimeResilience } from './runtime-resilience-audit.mts';
import type { RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string): SourceFile {
  return { absolutePath: `/${path}`, repositoryPath: path, extension: '.ts', kind: 'typescript', bytes: text.length, lines: text.split('\n').length, text };
}
function inventory(...files: SourceFile[]): RepositoryInventory {
  return { root: '/', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((n, f) => n + f.lines, 0), totalBytes: files.reduce((n, f) => n + f.bytes, 0), generatedAt: '2026-09-18T00:00:00Z' };
}
function ids(...files: SourceFile[]): string[] { return auditRuntimeResilience(inventory(...files)).findings.map(finding => finding.id); }

test('flags lifecycle timers without teardown', () => {
  assert.ok(ids(source('Webclient.app/src/runtime/MapRuntime.ts', 'export function start(){ setInterval(() => work(), 1000); }')).includes('runtime-timer-without-cleanup'));
});
test('accepts lifecycle timers with explicit cleanup', () => {
  assert.ok(!ids(source('Webclient.app/src/runtime/MapRuntime.ts', 'export function start(){ const id=setInterval(work,1000); return () => clearInterval(id); }')).includes('runtime-timer-without-cleanup'));
});
test('flags listeners without removal ownership', () => {
  assert.ok(ids(source('Webclient.app/src/runtime/ViewRuntime.ts', 'export function mount(){ window.addEventListener("resize", resize); }')).includes('runtime-listener-without-cleanup'));
});
test('accepts listeners with deterministic teardown', () => {
  assert.ok(!ids(source('Webclient.app/src/runtime/ViewRuntime.ts', 'export function mount(){ window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }')).includes('runtime-listener-without-cleanup'));
});
test('flags unbounded network retry semantics', () => {
  assert.ok(ids(source('Webclient.app/src/api/retryTransport.ts', 'export async function retryRequest(){ return fetch("/api/x").catch(retryRequest); }')).includes('runtime-retry-without-bound'));
});
test('accepts retry semantics with an attempt bound', () => {
  assert.ok(!ids(source('Webclient.app/src/api/retryTransport.ts', 'const maxAttempts=3; export async function retryRequest(){ return fetch("/api/x"); }')).includes('runtime-retry-without-bound'));
});
test('flags empty catch blocks in runtime source', () => {
  assert.ok(ids(source('Webclient.app/src/runtime/CommandRuntime.ts', 'export async function run(){ try { await command(); } catch {} }')).includes('runtime-empty-catch'));
});
test('blocks credential-like browser storage', () => {
  const result = auditRuntimeResilience(inventory(source('Webclient.app/src/auth/session.ts', 'localStorage.setItem("token", bearerToken);')));
  const finding = result.findings.find(item => item.id === 'runtime-sensitive-web-storage');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});
test('does not classify ordinary preference storage as credential storage', () => {
  assert.ok(!ids(source('Webclient.app/src/preferences/theme.ts', 'localStorage.setItem("theme", theme);')).includes('runtime-sensitive-web-storage'));
});
test('excludes test fixtures from release findings', () => {
  assert.deepEqual(ids(source('Webclient.app/src/runtime/__tests__/bad.test.ts', 'function start(){ setInterval(work, 1); try { work(); } catch {} }')), []);
});
test('reports resilience signal inventory', () => {
  const result = auditRuntimeResilience(inventory(source('Webclient.app/src/runtime/ManagedRuntime.ts', 'const c=new AbortController(); const id=setTimeout(work,10); window.addEventListener("x", work); return () => { c.abort(); clearTimeout(id); window.removeEventListener("x", work); };')));
  assert.equal(result.summary.timerFiles, 1);
  assert.equal(result.summary.listenerFiles, 1);
  assert.equal(result.summary.abortAwareFiles, 1);
});
