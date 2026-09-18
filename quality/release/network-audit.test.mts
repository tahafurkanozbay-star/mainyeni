import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNetwork } from './network-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile {
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: path.includes('.') ? `.${path.split('.').pop() ?? ''}` : '',
    kind,
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.split(/\r?\n/).length,
    text,
  };
}

function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function ids(section: ReturnType<typeof auditNetwork>): string[] {
  return section.findings.map(finding => finding.id);
}

test('flags plain HTTP runtime references with source evidence', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/Business/catalog.ts', `export const endpoint = 'http://example.test/api/catalog';`),
  ]));
  const finding = section.findings.find(item => item.id === 'network-insecure-http');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.location?.file, 'Webclient.app/src/Business/catalog.ts');
  assert.equal(section.summary.insecureCount, 1);
});

test('accepts HTTPS transport references', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/Business/catalog.ts', `export const endpoint = 'https://example.test/api/catalog';`),
  ]));
  assert.ok(!ids(section).includes('network-insecure-http'));
  assert.equal(section.summary.insecureCount, 0);
});

test('flags remote fonts in runtime stylesheets', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/app.css', `@import url('https://fonts.googleapis.com/css2?family=Inter');`, 'css'),
  ]));
  assert.ok(ids(section).includes('network-remote-font'));
});

test('flags remote runtime assets', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/theme.ts', `export const icon = 'https://cdn.example.test/icons/pin.svg';`),
  ]));
  assert.ok(ids(section).includes('network-remote-runtime-asset'));
});

test('flags third-party analytics endpoints in runtime source', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/telemetry.ts', `export const endpoint = 'https://analytics.example.test/collect';`),
  ]));
  assert.ok(ids(section).includes('network-third-party-analytics'));
});

test('flags direct fetch outside shared transport', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/features/search/load.ts', `export async function load() { return fetch('/api/search'); }`),
  ]));
  assert.ok(ids(section).includes('network-direct-fetch-outside-transport'));
  assert.equal(section.summary.directFetchCalls, 1);
});

test('does not flag direct fetch in the shared platform transport', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/platform/http/client.ts', `export async function request() { return fetch('/api/search'); }`),
  ]));
  assert.ok(!ids(section).includes('network-direct-fetch-outside-transport'));
  assert.equal(section.summary.directFetchCalls, 1);
});

test('flags absolute browser fetch URLs as boundary review', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/features/search/load.ts', `export const load = () => fetch('https://api.example.test/search');`),
  ]));
  assert.ok(ids(section).includes('network-absolute-fetch-summary'));
  assert.equal(section.summary.absoluteFetchCalls, 1);
});

test('same-origin relative fetch does not trigger absolute-fetch summary', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/platform/http/client.ts', `export const load = () => fetch('/api/search');`),
  ]));
  assert.ok(!ids(section).includes('network-absolute-fetch-summary'));
  assert.equal(section.summary.absoluteFetchCalls, 0);
});

test('deduplicates URL extraction when style import also matches generic URL pattern', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/app.css', `@import url('https://fonts.googleapis.com/css2?family=Inter');`, 'css'),
  ]));
  const refs = section.summary.references.filter(reference => reference.host === 'fonts.googleapis.com');
  assert.equal(refs.length, 1);
});

test('records network call signals for release evidence', () => {
  const section = auditNetwork(inventory([
    source('Webclient.app/src/platform/http/client.ts', `export async function a(){return fetch('/a')}\nexport async function b(){return axios.get('/b')}`),
  ]));
  assert.equal(section.summary.calls.length, 2);
  assert.deepEqual(section.summary.calls.map(call => call.kind), ['fetch', 'axios.get']);
});

test('caps direct-fetch findings per file while preserving aggregate count', () => {
  const calls = Array.from({ length: 12 }, (_, index) => `export const f${index}=()=>fetch('/${index}');`).join('\n');
  const section = auditNetwork(inventory([
    source('Webclient.app/src/features/bulk.ts', calls),
  ]));
  assert.equal(section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 8);
  assert.equal(section.summary.directFetchCalls, 12);
});
