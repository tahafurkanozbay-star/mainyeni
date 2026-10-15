import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRuntimeResilience } from './runtime-resilience-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function source(path: string, text: string): FixtureFileInput {
  return { path, text, kind: 'typescript' };
}

function audit(...files: FixtureFileInput[]) {
  return auditRuntimeResilience(fixtureInventory(files));
}

function ids(...files: FixtureFileInput[]): string[] {
  return audit(...files).findings.map(finding => finding.id);
}

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
  const result = audit(source('Webclient.app/src/auth/session.ts', 'localStorage.setItem("token", bearerToken);'));
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
  const result = audit(source('Webclient.app/src/runtime/ManagedRuntime.ts', 'const c=new AbortController(); const id=setTimeout(work,10); window.addEventListener("x", work); return () => { c.abort(); clearTimeout(id); window.removeEventListener("x", work); };'));
  assert.equal(result.summary.timerFiles, 1);
  assert.equal(result.summary.listenerFiles, 1);
  assert.equal(result.summary.abortAwareFiles, 1);
});


test('does not classify retryable metadata as executable retry logic', () => {
  for (const fragment of [
    'const retryable = false;',
    'const retryable = true;',
    'const Retryable = Boolean(error);',
    'type Result = { retryable: boolean };',
    'const payload = { retryable: false, data: [] };',
  ]) {
    assert.ok(!ids(source('Webclient.app/src/runtime/Result.ts', fragment)).includes('runtime-retry-without-bound'), fragment);
  }
});

test('continues to identify real unbounded retry helpers and uppercase signals', () => {
  for (const fragment of [
    'async function retryRequest(){ return fetch("/api/x").catch(retryRequest); }',
    'async function retryFetch(){ return fetch("/api/x").catch(retryFetch); }',
    'const RETRY_COUNT = 1; function retryRequest(){ return request(); }',
    'const retries = 3; function retryRequest(){ return request(); }',
  ]) {
    assert.ok(ids(source('Webclient.app/src/runtime/RetryTransport.ts', fragment)).includes('runtime-retry-without-bound'), fragment);
  }
});

test('retains attempt-bound exemptions for real retry helpers', () => {
  const text = 'const maxAttempts = 3; async function retryRequest(){ return fetch("/api/x").catch(retryRequest); }';
  assert.ok(!ids(source('Webclient.app/src/runtime/BoundedTransport.ts', text)).includes('runtime-retry-without-bound'));
});

test('includes lowercase admin runtime in lifecycle audit', () => {
  const file = source('Webclient.admin/src/runtime/AdminRuntime.ts', 'export function mount(){ window.addEventListener("resize", refresh); }');
  const result = audit(file);
  assert.ok(result.findings.some(finding => finding.id === 'runtime-listener-without-cleanup' && finding.location?.file === file.path));
});
