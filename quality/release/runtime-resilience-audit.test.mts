import { describe, expect, it } from 'vitest';
import { auditRuntimeResilience } from './runtime-resilience-audit.mts';
import type { RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string): SourceFile {
  return { absolutePath: `/${path}`, repositoryPath: path, extension: '.ts', kind: 'typescript', bytes: text.length, lines: text.split('\n').length, text };
}
function inventory(...files: SourceFile[]): RepositoryInventory {
  return { root: '/', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((n, f) => n + f.lines, 0), totalBytes: files.reduce((n, f) => n + f.bytes, 0), generatedAt: '2026-09-18T00:00:00Z' };
}
function ids(...files: SourceFile[]): string[] { return auditRuntimeResilience(inventory(...files)).findings.map(finding => finding.id); }

describe('auditRuntimeResilience', () => {
  it('flags lifecycle timers without teardown', () => {
    expect(ids(source('Webclient.app/src/runtime/MapRuntime.ts', 'export function start(){ setInterval(() => work(), 1000); }'))).toContain('runtime-timer-without-cleanup');
  });
  it('accepts lifecycle timers with explicit cleanup', () => {
    expect(ids(source('Webclient.app/src/runtime/MapRuntime.ts', 'export function start(){ const id=setInterval(work,1000); return () => clearInterval(id); }'))).not.toContain('runtime-timer-without-cleanup');
  });
  it('flags listeners without removal ownership', () => {
    expect(ids(source('Webclient.app/src/runtime/ViewRuntime.ts', 'export function mount(){ window.addEventListener("resize", resize); }'))).toContain('runtime-listener-without-cleanup');
  });
  it('accepts listeners with deterministic teardown', () => {
    expect(ids(source('Webclient.app/src/runtime/ViewRuntime.ts', 'export function mount(){ window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }'))).not.toContain('runtime-listener-without-cleanup');
  });
  it('flags unbounded network retry semantics', () => {
    expect(ids(source('Webclient.app/src/api/retryTransport.ts', 'export async function retryRequest(){ return fetch("/api/x").catch(retryRequest); }'))).toContain('runtime-retry-without-bound');
  });
  it('accepts retry semantics with an attempt bound', () => {
    expect(ids(source('Webclient.app/src/api/retryTransport.ts', 'const maxAttempts=3; export async function retryRequest(){ return fetch("/api/x"); }'))).not.toContain('runtime-retry-without-bound');
  });
  it('flags empty catch blocks in runtime source', () => {
    expect(ids(source('Webclient.app/src/runtime/CommandRuntime.ts', 'export async function run(){ try { await command(); } catch {} }'))).toContain('runtime-empty-catch');
  });
  it('blocks credential-like browser storage', () => {
    const result = auditRuntimeResilience(inventory(source('Webclient.app/src/auth/session.ts', 'localStorage.setItem("token", bearerToken);')));
    const finding = result.findings.find(item => item.id === 'runtime-sensitive-web-storage');
    expect(finding?.severity).toBe('critical');
    expect(finding?.blocking).toBe(true);
  });
  it('does not classify ordinary preference storage as credential storage', () => {
    expect(ids(source('Webclient.app/src/preferences/theme.ts', 'localStorage.setItem("theme", theme);'))).not.toContain('runtime-sensitive-web-storage');
  });
  it('excludes test fixtures from release findings', () => {
    expect(ids(source('Webclient.app/src/runtime/__tests__/bad.test.ts', 'function start(){ setInterval(work, 1); try { work(); } catch {} }'))).toEqual([]);
  });
  it('reports resilience signal inventory', () => {
    const result = auditRuntimeResilience(inventory(source('Webclient.app/src/runtime/ManagedRuntime.ts', 'const c=new AbortController(); const id=setTimeout(work,10); window.addEventListener("x", work); return () => { c.abort(); clearTimeout(id); window.removeEventListener("x", work); };')));
    expect(result.summary.timerFiles).toBe(1);
    expect(result.summary.listenerFiles).toBe(1);
    expect(result.summary.abortAwareFiles).toBe(1);
  });
});
