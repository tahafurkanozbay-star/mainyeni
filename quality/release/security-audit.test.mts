import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSecurity } from './security-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';
function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile { return { absolutePath: `/repo/${path}`, repositoryPath: path, extension: '', kind, bytes: new TextEncoder().encode(text).byteLength, lines: text.split(/\r?\n/).length, text }; }
function inventory(files: readonly SourceFile[]): RepositoryInventory { return { root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((sum, file) => sum + file.lines, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-16T00:00:00.000Z' }; }
function ids(files: readonly SourceFile[]): string[] { return auditSecurity(inventory(files)).findings.map(item => item.id); }
test('blocks committed private key material', () => { const section = auditSecurity(inventory([source('config/app.json', '"key":"-----BEGIN PRIVATE KEY-----abc"', 'json')])); const item = section.findings.find(candidate => candidate.id === 'security-private-key-material'); assert.ok(item); assert.equal(item.blocking, true); assert.equal(item.severity, 'critical'); });
test('flags raw html sinks in browser source', () => { assert.ok(ids([source('Webclient.app/src/View.tsx', '<div dangerouslySetInnerHTML={{__html: html}} />')]).includes('security-unsafe-html-sink')); });
test('flags dynamic execution as blocking', () => { const section = auditSecurity(inventory([source('Webclient.app/src/run.ts', 'const x = eval(code);')])); assert.equal(section.findings.find(item => item.id === 'security-dynamic-code-execution')?.blocking, true); });
test('flags bearer token persistence in local storage', () => { assert.ok(ids([source('Webclient.app/src/auth.ts', 'localStorage.setItem("accessToken", token);')]).includes('security-browser-token-storage')); });
test('does not flag non-sensitive preference storage', () => { assert.ok(!ids([source('Webclient.app/src/theme.ts', 'localStorage.setItem("theme", theme);')]).includes('security-browser-token-storage')); });
test('flags wildcard backend CORS', () => { assert.ok(ids([source('Webclient.Business/Program.cs', 'policy.AllowAnyOrigin();', 'csharp')]).includes('security-permissive-cors')); });
test('flags disabled certificate validation', () => { assert.ok(ids([source('Webclient.Business/Http.cs', 'handler.ServerCertificateCustomValidationCallback = (_,_,_,_) => true;', 'csharp')]).includes('security-tls-validation-disabled')); });
test('flags interpolated SQL command candidate', () => { assert.ok(ids([source('Webclient.Business/Repo.cs', 'var cmd = new SqlCommand($"select * from x where id={id}");', 'csharp')]).includes('security-sql-interpolation')); });
test('ignores release audit fixtures and test files', () => { assert.equal(auditSecurity(inventory([source('quality/release/fixture.ts', 'eval(code)'), source('Webclient.app/src/__tests__/x.ts', 'eval(code)')])).findings.length, 0); });
test('reports deterministic per-rule counts', () => { const section = auditSecurity(inventory([source('Webclient.app/src/a.ts', 'eval(a); eval(b);')])); assert.deepEqual(section.summary.findingsByRule, { 'security-dynamic-code-execution': 2 }); });
