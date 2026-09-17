import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBackendSecurity } from './backend-security-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'csharp'): SourceFile {
  return { absolutePath: `/repo/${path}`, repositoryPath: path, extension: '.cs', kind, bytes: new TextEncoder().encode(text).byteLength, lines: text.split(/\r?\n/).length, text };
}
function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return { root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((sum, file) => sum + file.lines, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-17T00:00:00.000Z' };
}
function ids(section: ReturnType<typeof auditBackendSecurity>): string[] { return section.findings.map(item => item.id); }

const controllerPrefix = `using Microsoft.AspNetCore.Authorization;\n[ApiController]\n[Route("api/[controller]")]\npublic class PlacesController : ControllerBase {`;

test('blocks wildcard CORS combined with credentials', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Program.cs', `services.AddCors(o => o.AddPolicy("bad", p => p.AllowAnyOrigin().AllowCredentials()));`)]));
  const finding = section.findings.find(item => item.id === 'backend-cors-wildcard-credentials');
  assert.ok(finding); assert.equal(finding.severity, 'critical'); assert.equal(finding.blocking, true);
});

test('does not flag explicit-origin credentialed CORS policy', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Program.cs', `services.AddCors(o => o.AddPolicy("ok", p => p.WithOrigins("https://kent.example").AllowCredentials()));`)]));
  assert.ok(!ids(section).includes('backend-cors-wildcard-credentials'));
});

test('blocks dangerous HttpClient certificate validator', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Startup.cs', `handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;`)]));
  assert.ok(ids(section).includes('backend-tls-validation-disabled'));
});

test('blocks lambda certificate validation returning true', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Startup.cs', `handler.ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => true;`)]));
  assert.ok(ids(section).includes('backend-tls-validation-disabled'));
});

test('blocks backend process execution boundary', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/ExportController.cs', `public void Export() { Process.Start("cmd.exe", "/c convert input output"); }`)]));
  const finding = section.findings.find(item => item.id === 'backend-command-shell-execution'); assert.ok(finding); assert.equal(finding.blocking, true);
});

test('flags request-derived filesystem path composition', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/FileController.cs', `var path = Path.Combine(root, Request.Query["name"]);`)]));
  assert.ok(ids(section).includes('backend-path-composition-input'));
});

test('accepts server-owned fixed filesystem composition', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/FileService.cs', `var path = Path.Combine(root, "icons", "default.svg");`)]));
  assert.ok(!ids(section).includes('backend-path-composition-input'));
});

test('flags request-derived redirect target', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/AuthController.cs', `return Redirect(returnUrl);`)]));
  assert.ok(ids(section).includes('backend-open-redirect-input'));
});

test('accepts fixed redirect target', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/AuthController.cs', `return Redirect("/home");`)]));
  assert.ok(!ids(section).includes('backend-open-redirect-input'));
});

test('flags unbounded request body ReadToEndAsync', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/ImportController.cs', `using var reader = new StreamReader(Request.Body); var body = await reader.ReadToEndAsync();`)]));
  assert.ok(ids(section).includes('backend-unbounded-request-body-read'));
});

test('flags logging of authorization material', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/AuthService.cs', `_logger.LogInformation("Authorization {authorization}", authorization);`)]));
  assert.ok(ids(section).includes('backend-sensitive-log-value'));
});

test('accepts bounded event-only logging', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/AuthService.cs', `_logger.LogInformation("Authentication completed for request {RequestId}", requestId);`)]));
  assert.ok(!ids(section).includes('backend-sensitive-log-value'));
});

test('flags controller endpoints with no authorization evidence', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/PlacesController.cs', `${controllerPrefix}\n[HttpGet] public IActionResult Get() => Ok();\n}`)]));
  const finding = section.findings.find(item => item.id === 'backend-endpoint-authorization-evidence-missing'); assert.ok(finding); assert.equal(finding.severity, 'high');
});

test('accepts controller protected with Authorize', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/PlacesController.cs', `[Authorize]\n${controllerPrefix}\n[HttpGet] public IActionResult Get() => Ok();\n}`)]));
  assert.ok(!ids(section).includes('backend-endpoint-authorization-evidence-missing'));
});

test('accepts explicitly anonymous endpoint when every endpoint is public', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/HealthController.cs', `${controllerPrefix}\n[AllowAnonymous]\n[HttpGet] public IActionResult Get() => Ok();\n}`)]));
  assert.ok(!ids(section).includes('backend-endpoint-authorization-evidence-missing'));
});

test('still flags mixed controller when only one of two endpoints is anonymous', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/MixedController.cs', `${controllerPrefix}\n[AllowAnonymous][HttpGet("public")] public IActionResult Public() => Ok();\n[HttpGet("private")] public IActionResult Private() => Ok();\n}`)]));
  assert.ok(ids(section).includes('backend-endpoint-authorization-evidence-missing'));
});

test('blocks interpolated FromSqlRaw query', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/SearchRepository.cs', `var rows = db.Items.FromSqlRaw($"SELECT * FROM Items WHERE Name = '{name}'");`)]));
  const finding = section.findings.find(item => item.id === 'backend-interpolated-raw-sql'); assert.ok(finding); assert.equal(finding.severity, 'critical'); assert.equal(finding.blocking, true);
});

test('blocks concatenated ExecuteSqlRaw query', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/SearchRepository.cs', `db.Database.ExecuteSqlRaw("DELETE FROM Items WHERE Id=" + id);`)]));
  assert.ok(ids(section).includes('backend-interpolated-raw-sql'));
});

test('accepts parameterized FromSqlRaw query', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/SearchRepository.cs', `var rows = db.Items.FromSqlRaw("SELECT * FROM Items WHERE Name = {0}", name);`)]));
  assert.ok(!ids(section).includes('backend-interpolated-raw-sql'));
});

test('flags outbound HttpClient without timeout or cancellation evidence', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/ArcgisProxy.cs', `public async Task<string> Get() { using var client = new HttpClient(); return await client.GetStringAsync(url); }`)]));
  assert.ok(ids(section).includes('backend-outbound-http-bounds-missing'));
});

test('accepts outbound HttpClient with explicit timeout', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/ArcgisProxy.cs', `public async Task Get() { using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) }; await client.GetAsync(url); }`)]));
  assert.ok(!ids(section).includes('backend-outbound-http-bounds-missing'));
});

test('accepts outbound HttpClient with cancellation token', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/ArcgisProxy.cs', `public async Task Get(CancellationToken cancellationToken) { using var client = new HttpClient(); await client.GetAsync(url, cancellationToken); }`)]));
  assert.ok(!ids(section).includes('backend-outbound-http-bounds-missing'));
});

test('ignores generated obj source', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/obj/Generated.cs', `handler.ServerCertificateCustomValidationCallback = (_,_,_,_) => true;`)]));
  assert.equal(section.summary.backendFiles, 0); assert.equal(section.findings.length, 0);
});

test('ignores intentional security fixtures under tests', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/tests/BadSecurityFixture.cs', `Process.Start("cmd.exe");`)]));
  assert.equal(section.summary.backendFiles, 0); assert.equal(section.findings.length, 0);
});

test('reports deterministic backend evidence inventory', () => {
  const section = auditBackendSecurity(inventory([
    source('Webclient.API/PlacesController.cs', `[Authorize]\n${controllerPrefix}\n[HttpGet] public IActionResult Get() => Ok();\n}`),
    source('Webclient.API/Proxy.cs', `public async Task Get(CancellationToken cancellationToken) { using var client = new HttpClient(); await client.GetAsync(url, cancellationToken); }`),
  ]));
  assert.equal(section.summary.backendFiles, 2); assert.equal(section.summary.controllerFiles, 1); assert.equal(section.summary.endpointFiles, 1); assert.ok(section.summary.authorizationSignals >= 1); assert.ok(section.summary.outboundHttpSignals >= 1);
});

test('reports findings by rule in stable lexical key order', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Danger.cs', `Process.Start("cmd.exe");\n_logger.LogError("password {password}", password);`)]));
  assert.deepEqual(Object.keys(section.summary.findingsByRule), [...Object.keys(section.summary.findingsByRule)].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(section.summary.findingsByRule['backend-command-shell-execution'], 1); assert.equal(section.summary.findingsByRule['backend-sensitive-log-value'], 1);
});

test('preserves source line for security evidence', () => {
  const section = auditBackendSecurity(inventory([source('Webclient.API/Danger.cs', `public class Danger {\n  public void Run() {\n    Process.Start("cmd.exe");\n  }\n}`)]));
  assert.equal(section.findings.find(item => item.id === 'backend-command-shell-execution')?.location?.line, 3);
});
