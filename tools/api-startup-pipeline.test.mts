import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateApiStartupPipeline, stripCSharpTrivia, renderApiStartupPipelineMarkdown,
} from './api-startup-pipeline.mts';

const host = (user = false) => `
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKentRehberiTransport(builder.Configuration);
builder.WebHost.ConfigureKestrel(options => { options.AddServerHeader = false; });
builder.Services.AddKentRehberiApiPlatform(builder.Configuration);
var app = builder.Build();
app.UseKentRehberiPlatformBeforeRouting();
${user ? 'app.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();' : ''}
app.UseRouting();
app.UseKentRehberiPlatformAfterRouting();
app.UseAuthorization();
app.MapKentRehberiHealthChecks();
app.MapControllers();
app.Run();
`;
const shared = () => `
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseMiddleware<ApiExceptionMiddleware>();
app.UseMiddleware<SecurityHeadersMiddleware>();
app.UseMiddleware<RequestGovernanceMiddleware>();
app.UseMiddleware<RequestGuardMiddleware>();
app.UseCors(ApiPlatformDefaults.CorsPolicyName);
app.UseMiddleware<RequestMetricsMiddleware>();
app.UseRateLimiter();
app.UseRequestTimeouts();
`;
const fixture = () => ({
  'Api.User/Program.cs': host(true),
  'Api.Admin/Program.cs': host(),
  'Api.Core/Platform/ApiPlatformApplicationExtensions.cs': shared(),
});
const evaluate = values => evaluateApiStartupPipeline(values ?? fixture());
const codes = report => report.findings.map(x => x.code);

test('both API hosts and the shared middleware chain pass', () => {
  const report = evaluate();
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.summary, { sources: 3, requiredSteps: 29, violations: 0 });
});
test('host sequence requires platform configuration registration', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('builder.Services.AddKentRehberiApiPlatform(builder.Configuration);', '');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('host sequence requires transport setup before build', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] = files['Api.Admin/Program.cs']
    .replace('builder.WebHost.ConfigureKentRehberiTransport(builder.Configuration);', '');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('host sequence rejects routing before platform request guards', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseKentRehberiPlatformBeforeRouting();\napp.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();\napp.UseRouting();',
      'app.UseRouting();\napp.UseKentRehberiPlatformBeforeRouting();\napp.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-out-of-order'));
});
test('host sequence rejects post-routing policy before routing', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] = files['Api.Admin/Program.cs']
    .replace('app.UseRouting();\napp.UseKentRehberiPlatformAfterRouting();',
      'app.UseKentRehberiPlatformAfterRouting();\napp.UseRouting();');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-out-of-order'));
});
test('host sequence requires authorization before controller mapping', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] = files['Api.Admin/Program.cs'].replace('app.UseAuthorization();', '');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('host sequence rejects duplicated authorization registration', () => {
  const files = fixture();
  files['Api.User/Program.cs'] += '\napp.UseAuthorization();';
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-duplicate'));
});
test('host sequence rejects direct CORS bypass', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] += '\napp.UseCors("*");';
  assert.ok(codes(evaluate(files)).includes('api-host-cors-bypass'));
});
test('host sequence requires suppressed Kestrel server banner', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs'].replace('AddServerHeader = false', 'AddServerHeader = true');
  assert.ok(codes(evaluate(files)).includes('api-server-header-enabled'));
});
test('GIS request-body limit must be installed before routing', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();', '')
    .replace('app.UseRouting();', 'app.UseRouting();\napp.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();');
  assert.ok(codes(evaluate(files)).includes('api-gis-body-limit-order'));
});
test('GIS request-body limit is mandatory for User API only', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseMiddleware<GisProxyRequestBodyLimitMiddleware>();', '');
  assert.ok(codes(evaluate(files)).includes('api-gis-body-limit-order'));
  assert.equal(evaluate({ ...fixture(), 'Api.Admin/Program.cs': host() }).ok, true);
});
test('shared chain requires security headers before governance', () => {
  const files = fixture();
  files['Api.Core/Platform/ApiPlatformApplicationExtensions.cs'] = shared()
    .replace('app.UseMiddleware<SecurityHeadersMiddleware>();\napp.UseMiddleware<RequestGovernanceMiddleware>();',
      'app.UseMiddleware<RequestGovernanceMiddleware>();\napp.UseMiddleware<SecurityHeadersMiddleware>();');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-out-of-order'));
});
test('shared chain requires request guard before CORS', () => {
  const files = fixture();
  files['Api.Core/Platform/ApiPlatformApplicationExtensions.cs'] = shared()
    .replace('app.UseMiddleware<RequestGuardMiddleware>();', '');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('shared chain requires rate limiter and timeout middleware', () => {
  const files = fixture();
  files['Api.Core/Platform/ApiPlatformApplicationExtensions.cs'] = shared()
    .replace('app.UseRateLimiter();', '').replace('app.UseRequestTimeouts();', '');
  assert.equal(codes(evaluate(files)).filter(x => x === 'api-pipeline-step-missing').length, 2);
});
test('C# comments cannot forge missing pipeline calls', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseAuthorization();', '// app.UseAuthorization();');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('C# string literals cannot forge missing pipeline calls', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] = files['Api.Admin/Program.cs']
    .replace('app.MapControllers();', 'var fake = "app.MapControllers();";');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('C# verbatim string literals cannot forge middleware', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseAuthorization();', 'var fake = @"app.UseAuthorization();";');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('block comments cannot forge middleware', () => {
  const files = fixture();
  files['Api.User/Program.cs'] = files['Api.User/Program.cs']
    .replace('app.UseAuthorization();', '/* app.UseAuthorization(); */');
  assert.ok(codes(evaluate(files)).includes('api-pipeline-step-missing'));
});
test('trivia removal preserves executable code and newlines', () => {
  const source = 'app.UseRouting(); // app.Run();\n/* app.MapControllers(); */ app.Run();';
  const stripped = stripCSharpTrivia(source);
  assert.match(stripped, /app.UseRouting/);
  assert.match(stripped, /app.Run/);
  assert.doesNotMatch(stripped, /app.MapControllers/);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});
test('missing API source fails closed', () => {
  const files = fixture();
  delete files['Api.Admin/Program.cs'];
  assert.ok(codes(evaluate(files)).includes('api-pipeline-source-missing'));
});
test('report excludes raw startup source and secrets', () => {
  const files = fixture();
  files['Api.Admin/Program.cs'] += '\nvar secret = "do-not-report-this-value";';
  const report = evaluate(files);
  assert.equal(JSON.stringify(report).includes('do-not-report-this-value'), false);
});
test('report is deterministic and fingerprints the pipeline contract', () => {
  const first = evaluate(fixture());
  const reversed = Object.fromEntries(Object.entries(fixture()).reverse());
  assert.equal(first.fingerprint, evaluate(reversed).fingerprint);
});
test('markdown includes gate and diagnostics without source leakage', () => {
  const good = renderApiStartupPipelineMarkdown(evaluate());
  assert.match(good, /Gate: \*\*PASS\*\*/);
  const files = fixture();
  files['Api.User/Program.cs'] = '';
  const bad = renderApiStartupPipelineMarkdown(evaluate(files));
  assert.match(bad, /Gate: \*\*FAIL\*\*/);
  assert.match(bad, /api-pipeline-step-missing/);
  assert.doesNotMatch(bad, /var builder/);
});
