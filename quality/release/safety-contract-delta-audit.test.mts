import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditSafetyContractDelta,
  safetyContractDeltaMarkdown,
  SAFETY_CONTRACT_POLICIES,
} from './safety-contract-delta-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function inv(files: readonly FixtureFileInput[]) {
  return fixtureInventory(files);
}

function audit(before: FixtureFileInput, after: FixtureFileInput) {
  return auditSafetyContractDelta(inv([before]), inv([after]));
}

function has(before: FixtureFileInput, after: FixtureFileInput, id: string): boolean {
  return audit(before, after).findings.some(finding => finding.id === id);
}

test('safety policy identifiers are unique', () => {
  const ids = SAFETY_CONTRACT_POLICIES.map(policy => policy.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('safety policy catalog covers protective and dangerous modes', () => {
  assert.equal(SAFETY_CONTRACT_POLICIES.some(policy => policy.mode === 'protective'), true);
  assert.equal(SAFETY_CONTRACT_POLICIES.some(policy => policy.mode === 'dangerous'), true);
});

test('every safety policy has path ownership and signal patterns', () => {
  for (const policy of SAFETY_CONTRACT_POLICIES) {
    assert.ok(policy.pathPatterns.length > 0);
    assert.ok(policy.signals.length > 0);
    assert.ok(policy.title.length > 8);
    assert.ok(policy.remediation.length > 20);
  }
});

test('unchanged inventories have no safety delta findings', () => {
  const file = { path: 'Api.User/Controllers/HomeController.cs', text: '[Authorize]\npublic class HomeController {}\n' };
  const section = auditSafetyContractDelta(inv([file]), inv([file]));
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.evaluatedChanges, 0);
});

test('removing Authorize from backend controller is high severity', () => {
  const before = { path: 'Api.User/Controllers/HomeController.cs', text: '[Authorize]\npublic class HomeController {}\n' };
  const after = { ...before, text: 'public class HomeController {}\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-auth-guard-loss');
  assert.equal(finding?.severity, 'high');
});

test('adding Authorize does not trigger authorization loss', () => {
  const before = { path: 'Api.User/Controllers/HomeController.cs', text: 'public class HomeController {}\n' };
  const after = { ...before, text: '[Authorize]\npublic class HomeController {}\n' };
  assert.equal(has(before, after, 'safety-delta-auth-guard-loss'), false);
});

test('removing one of multiple Authorize guards is visible', () => {
  const before = {
    path: 'Api.User/Controllers/HomeController.cs',
    text: '[Authorize]\npublic IActionResult A() => Ok();\n[Authorize]\npublic IActionResult B() => Ok();\n',
  };
  const after = {
    ...before,
    text: '[Authorize]\npublic IActionResult A() => Ok();\npublic IActionResult B() => Ok();\n',
  };
  assert.equal(has(before, after, 'safety-delta-auth-guard-loss'), true);
});

test('moving from attribute authorize to RequireAuthorization avoids net guard loss when count preserved', () => {
  const before = { path: 'Api.User/Program.cs', text: 'app.MapGet("/a", A).RequireAuthorization();\n' };
  const after = { ...before, text: 'app.MapGet("/a", A).RequireAuthorization("user");\n' };
  assert.equal(has(before, after, 'safety-delta-auth-guard-loss'), false);
});

test('removing authentication pipeline registration is high severity', () => {
  const before = {
    path: 'Api.User/Program.cs',
    text: 'builder.Services.AddAuthentication();\nbuilder.Services.AddAuthorization();\napp.UseAuthentication();\napp.UseAuthorization();\n',
  };
  const after = { ...before, text: 'builder.Services.AddAuthorization();\napp.UseAuthorization();\n' };
  assert.equal(has(before, after, 'safety-delta-authentication-pipeline-loss'), true);
});

test('adding authentication middleware does not trigger pipeline loss', () => {
  const before = { path: 'Api.User/Program.cs', text: 'app.UseAuthorization();\n' };
  const after = { ...before, text: 'app.UseAuthentication();\napp.UseAuthorization();\n' };
  assert.equal(has(before, after, 'safety-delta-authentication-pipeline-loss'), false);
});

test('removing HttpOnly cookie evidence is high severity', () => {
  const before = {
    path: 'Api.User/Auth/CookiePolicy.cs',
    text: 'options.HttpOnly = true;\noptions.SecurePolicy = CookieSecurePolicy.Always;\noptions.SameSite = SameSiteMode.Strict;\n',
  };
  const after = {
    ...before,
    text: 'options.SecurePolicy = CookieSecurePolicy.Always;\noptions.SameSite = SameSiteMode.Strict;\n',
  };
  assert.equal(has(before, after, 'safety-delta-cookie-hardening-loss'), true);
});

test('strengthening cookie policy does not trigger hardening loss', () => {
  const before = { path: 'Api.User/Auth/CookiePolicy.cs', text: 'options.HttpOnly = true;\n' };
  const after = {
    ...before,
    text: 'options.HttpOnly = true;\noptions.SecurePolicy = CookieSecurePolicy.Always;\noptions.SameSite = SameSiteMode.Strict;\n',
  };
  assert.equal(has(before, after, 'safety-delta-cookie-hardening-loss'), false);
});

test('removing AbortSignal from request runtime is high severity', () => {
  const before = {
    path: 'Webclient.app/src/platform/http/requestRuntime.ts',
    text: 'export async function run(signal: AbortSignal) { return signal.aborted; }\n',
  };
  const after = { ...before, text: 'export async function run() { return false; }\n' };
  assert.equal(has(before, after, 'safety-delta-cancellation-contract-loss'), true);
});

test('removing CancellationToken from backend client is high severity', () => {
  const before = {
    path: 'Api.Core/Http/Client.cs',
    text: 'public Task Send(CancellationToken cancellationToken) => Task.CompletedTask;\n',
  };
  const after = { ...before, text: 'public Task Send() => Task.CompletedTask;\n' };
  assert.equal(has(before, after, 'safety-delta-cancellation-contract-loss'), true);
});

test('adding AbortController does not trigger cancellation loss', () => {
  const before = { path: 'Webclient.app/src/platform/http/requestRuntime.ts', text: 'export const run = () => 1;\n' };
  const after = { ...before, text: 'export const run = () => new AbortController();\n' };
  assert.equal(has(before, after, 'safety-delta-cancellation-contract-loss'), false);
});

test('removing timeoutMs is high severity', () => {
  const before = { path: 'Webclient.app/src/search/addressRuntime.ts', text: 'const timeoutMs = 5000;\n' };
  const after = { ...before, text: 'const requestBudget = 5000;\n' };
  assert.equal(has(before, after, 'safety-delta-timeout-contract-loss'), true);
});

test('replacing timeoutMs with AbortSignal timeout preserves timeout count', () => {
  const before = { path: 'Webclient.app/src/search/addressRuntime.ts', text: 'const timeoutMs = 5000;\n' };
  const after = { ...before, text: 'const signal = AbortSignal.timeout(5000);\n' };
  assert.equal(has(before, after, 'safety-delta-timeout-contract-loss'), false);
});

test('removing maxConcurrent capacity bound is high severity', () => {
  const before = { path: 'Webclient.app/src/platform/queue/requestQueue.ts', text: 'const maxConcurrent = 6;\nconst maxQueue = 64;\n' };
  const after = { ...before, text: 'const maxQueue = 64;\n' };
  assert.equal(has(before, after, 'safety-delta-capacity-bound-loss'), true);
});

test('adding queue capacity is not a loss', () => {
  const before = { path: 'Webclient.app/src/platform/queue/requestQueue.ts', text: 'export const queue = [];\n' };
  const after = { ...before, text: 'const maxQueue = 64; export const queue = [];\n' };
  assert.equal(has(before, after, 'safety-delta-capacity-bound-loss'), false);
});

test('removing singleFlight evidence is medium severity', () => {
  const before = { path: 'Webclient.app/src/search/requestRuntime.ts', text: 'const singleFlight = new Map();\n' };
  const after = { ...before, text: 'const requests = new Map();\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-dedupe-contract-loss');
  assert.equal(finding?.severity, 'medium');
});

test('renaming dedupe variable to inFlight preserves dedupe signal count', () => {
  const before = { path: 'Webclient.app/src/search/requestRuntime.ts', text: 'const dedupeMap = new Map();\n' };
  const after = { ...before, text: 'const inFlight = new Map();\n' };
  assert.equal(has(before, after, 'safety-delta-dedupe-contract-loss'), false);
});

test('removing GIS maxFeatures budget is high severity', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'const maxFeatures = 2000;\nconst maxPages = 10;\n' };
  const after = { ...before, text: 'const maxPages = 10;\n' };
  assert.equal(has(before, after, 'safety-delta-gis-feature-budget-loss'), true);
});

test('replacing maxFeatures with featureBudget preserves GIS budget evidence', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'const maxFeatures = 2000;\n' };
  const after = { ...before, text: 'const featureBudget = 2000;\n' };
  assert.equal(has(before, after, 'safety-delta-gis-feature-budget-loss'), false);
});

test('removing GIS dispose evidence is high severity', () => {
  const before = { path: 'Webclient.app/src/gis/layer/lifecycle.ts', text: 'layer.destroy();\nhandle.remove();\n' };
  const after = { ...before, text: 'handle.remove();\n' };
  assert.equal(has(before, after, 'safety-delta-gis-ownership-cleanup-loss'), true);
});

test('switching destroy to dispose preserves cleanup count', () => {
  const before = { path: 'Webclient.app/src/gis/layer/lifecycle.ts', text: 'layer.destroy();\n' };
  const after = { ...before, text: 'layer.dispose();\n' };
  assert.equal(has(before, after, 'safety-delta-gis-ownership-cleanup-loss'), false);
});

test('removing keyboard handler from interactive UI is high severity', () => {
  const before = { path: 'Webclient.app/src/components/Toolbar.tsx', text: '<div role="button" tabIndex={0} onKeyDown={onKey}>Open</div>\n' };
  const after = { ...before, text: '<div role="button" tabIndex={0}>Open</div>\n' };
  assert.equal(has(before, after, 'safety-delta-keyboard-accessibility-loss'), true);
});

test('switching keydown to keyup preserves keyboard evidence count', () => {
  const before = { path: 'Webclient.app/src/components/Toolbar.tsx', text: '<div role="button" onKeyDown={onKey}>Open</div>\n' };
  const after = { ...before, text: '<div role="button" onKeyUp={onKey}>Open</div>\n' };
  assert.equal(has(before, after, 'safety-delta-keyboard-accessibility-loss'), false);
});

test('removing reduced-motion evidence is medium severity', () => {
  const before = { path: 'Webclient.app/src/gis/camera/navigation.ts', text: 'const reducedMotion = true;\n' };
  const after = { ...before, text: 'const animate = true;\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-reduced-motion-loss');
  assert.equal(finding?.severity, 'medium');
});

test('reduced motion signal replacement stays covered', () => {
  const before = { path: 'Webclient.app/src/components/Dialog.tsx', text: 'const reducedMotion = true;\n' };
  const after = { ...before, text: 'const motionPolicy = "reduce";\n' };
  assert.equal(has(before, after, 'safety-delta-reduced-motion-loss'), false);
});

test('removing request correlation evidence is medium severity', () => {
  const before = { path: 'Api.Core/Http/RequestRuntime.cs', text: 'var correlationId = request.TraceIdentifier;\n' };
  const after = { ...before, text: 'var id = request.TraceIdentifier;\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-correlation-evidence-loss');
  assert.equal(finding?.severity, 'medium');
});

test('introducing dangerouslySetInnerHTML is high severity', () => {
  const before = { path: 'Webclient.app/src/components/HtmlPanel.tsx', text: 'return <div>{html}</div>;\n' };
  const after = { ...before, text: 'return <div dangerouslySetInnerHTML={{ __html: html }} />;\n' };
  assert.equal(has(before, after, 'safety-delta-unsafe-html-introduction'), true);
});

test('existing unsafe HTML is not reported as newly introduced when unchanged count remains', () => {
  const before = { path: 'Webclient.app/src/components/HtmlPanel.tsx', text: 'return <div dangerouslySetInnerHTML={{ __html: html }} />;\n' };
  const after = { ...before, text: 'return <section dangerouslySetInnerHTML={{ __html: html }} />;\n' };
  assert.equal(has(before, after, 'safety-delta-unsafe-html-introduction'), false);
});

test('introducing eval is critical and blocking', () => {
  const before = { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = JSON.parse;\n' };
  const after = { ...before, text: 'export const parse = (value) => eval(value);\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-dynamic-code-introduction');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('introducing new Function is critical and blocking', () => {
  const before = { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = JSON.parse;\n' };
  const after = { ...before, text: 'export const parse = (value) => new Function(value)();\n' };
  assert.equal(has(before, after, 'safety-delta-dynamic-code-introduction'), true);
});

test('introducing token localStorage persistence is critical', () => {
  const before = { path: 'Webclient.app/src/auth/session.ts', text: 'export const token = null;\n' };
  const after = { ...before, text: 'localStorage.setItem("token", token);\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-credential-storage-introduction');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('ordinary preference storage is not credential persistence', () => {
  const before = { path: 'Webclient.app/src/preferences/theme.ts', text: 'export const theme = "dark";\n' };
  const after = { ...before, text: 'localStorage.setItem("theme", theme);\n' };
  assert.equal(has(before, after, 'safety-delta-credential-storage-introduction'), false);
});

test('introducing AllowAnyOrigin is critical', () => {
  const before = { path: 'Api.User/Program.cs', text: 'builder.Services.AddCors();\n' };
  const after = { ...before, text: 'builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin()));\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-wildcard-cors-introduction');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('explicit CORS origin does not trigger wildcard finding', () => {
  const before = { path: 'Api.User/Program.cs', text: 'builder.Services.AddCors();\n' };
  const after = { ...before, text: 'builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("https://example.test")));\n' };
  assert.equal(has(before, after, 'safety-delta-wildcard-cors-introduction'), false);
});

test('introducing dangerous certificate validator is critical', () => {
  const before = { path: 'Api.Core/Http/Client.cs', text: 'var handler = new HttpClientHandler();\n' };
  const after = { ...before, text: 'handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-tls-bypass-introduction');
  assert.equal(finding?.severity, 'critical');
});

test('introducing lambda certificate always true is critical', () => {
  const before = { path: 'Api.Core/Http/Client.cs', text: 'var handler = new HttpClientHandler();\n' };
  const after = { ...before, text: 'handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;\n' };
  assert.equal(has(before, after, 'safety-delta-tls-bypass-introduction'), true);
});

test('introducing remote plain HTTP is high severity', () => {
  const before = { path: 'Webclient.app/src/platform/config/runtime.ts', text: 'export const endpoint = "/api";\n' };
  const after = { ...before, text: 'export const endpoint = "http://remote.example/api";\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-plain-http-introduction');
  assert.equal(finding?.severity, 'high');
});

test('localhost HTTP fixture does not trigger remote transport finding', () => {
  const before = { path: 'Webclient.app/src/platform/config/runtime.ts', text: 'export const endpoint = "/api";\n' };
  const after = { ...before, text: 'export const endpoint = "http://localhost:5000/api";\n' };
  assert.equal(has(before, after, 'safety-delta-plain-http-introduction'), false);
});

test('introducing FromSqlRaw is high severity', () => {
  const before = { path: 'Business/ParcelRepository.cs', text: 'return db.Parcels.ToList();\n' };
  const after = { ...before, text: 'return db.Parcels.FromSqlRaw(sql).ToList();\n' };
  assert.equal(has(before, after, 'safety-delta-raw-sql-introduction'), true);
});

test('parameterized non-raw query does not trigger raw SQL introduction', () => {
  const before = { path: 'Business/ParcelRepository.cs', text: 'return db.Parcels.ToList();\n' };
  const after = { ...before, text: 'return db.Parcels.Where(x => x.Id == id).ToList();\n' };
  assert.equal(has(before, after, 'safety-delta-raw-sql-introduction'), false);
});

test('introducing GIS wildcard outFields is high severity', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'query.outFields = ["OBJECTID"];\n' };
  const after = { ...before, text: 'query.outFields = ["*"];\n' };
  assert.equal(has(before, after, 'safety-delta-gis-wildcard-fields-introduction'), true);
});

test('explicit GIS outFields do not trigger wildcard finding', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'query.outFields = ["OBJECTID"];\n' };
  const after = { ...before, text: 'query.outFields = ["OBJECTID", "NAME"];\n' };
  assert.equal(has(before, after, 'safety-delta-gis-wildcard-fields-introduction'), false);
});

test('introducing returnGeometry true is medium severity', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'query.returnGeometry = false;\n' };
  const after = { ...before, text: 'query.returnGeometry = true;\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-gis-geometry-payload-introduction');
  assert.equal(finding?.severity, 'medium');
});

test('keeping returnGeometry false does not trigger payload finding', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'query.returnGeometry = false;\n' };
  const after = { ...before, text: 'query.returnGeometry = false;\nquery.outFields = ["ID"];\n' };
  assert.equal(has(before, after, 'safety-delta-gis-geometry-payload-introduction'), false);
});

test('introducing while true is critical and blocking', () => {
  const before = { path: 'Webclient.app/src/platform/queue/runner.ts', text: 'for (const item of items) run(item);\n' };
  const after = { ...before, text: 'while (true) { run(next()); }\n' };
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'safety-delta-infinite-loop-introduction');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('introducing for empty loop is critical', () => {
  const before = { path: 'Api.Core/Workers/Poller.cs', text: 'foreach (var item in items) Run(item);\n' };
  const after = { ...before, text: 'for (;;) { Run(); }\n' };
  assert.equal(has(before, after, 'safety-delta-infinite-loop-introduction'), true);
});

test('workflow continue-on-error introduction is high severity', () => {
  const before = { path: '.github/workflows/release-qa.yml', text: 'jobs:\n  qa:\n    steps:\n      - run: npm test\n' };
  const after = { ...before, text: 'jobs:\n  qa:\n    steps:\n      - run: npm test\n        continue-on-error: true\n' };
  assert.equal(has(before, after, 'safety-delta-workflow-failure-bypass-introduction'), true);
});

test('workflow forced success introduction is high severity', () => {
  const before = { path: '.github/workflows/release-qa.yml', text: 'run: npm test\n' };
  const after = { ...before, text: 'run: npm test || true\n' };
  assert.equal(has(before, after, 'safety-delta-workflow-failure-bypass-introduction'), true);
});

test('tests are excluded from safety delta evaluation', () => {
  const before = { path: 'Webclient.app/src/runtime/expression.test.ts', text: 'const value = "safe";\n' };
  const after = { ...before, text: 'eval("fixture");\n' };
  const section = audit(before, after);
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.evaluatedChanges, 0);
});

test('documentation is excluded from safety delta evaluation', () => {
  const before = { path: 'docs/security.md', text: 'avoid eval\n' };
  const after = { ...before, text: 'eval(example)\n' };
  const section = audit(before, after);
  assert.equal(section.findings.length, 0);
});

test('generated output is excluded from safety delta evaluation', () => {
  const before = { path: 'Webclient.app/build/runtime.js', text: 'safe();\n' };
  const after = { ...before, text: 'eval(code);\n' };
  const section = audit(before, after);
  assert.equal(section.findings.length, 0);
});

test('exact-content rename is excluded from safety signal loss', () => {
  const before = { path: 'Webclient.app/src/gis/old/lifecycle.ts', text: 'layer.destroy();\n' };
  const after = { path: 'Webclient.app/src/gis/new/lifecycle.ts', text: before.text };
  const section = auditSafetyContractDelta(inv([before]), inv([after]));
  assert.equal(section.findings.length, 0);
});

test('added file with dangerous signal is evaluated', () => {
  const after = { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const run = (x) => eval(x);\n' };
  const section = auditSafetyContractDelta(inv([]), inv([after]));
  assert.equal(section.findings.some(item => item.id === 'safety-delta-dynamic-code-introduction'), true);
});

test('removed file does not create dangerous-introduction finding', () => {
  const before = { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const run = (x) => eval(x);\n' };
  const section = auditSafetyContractDelta(inv([before]), inv([]));
  assert.equal(section.findings.some(item => item.id === 'safety-delta-dynamic-code-introduction'), false);
});

test('summary counts protective losses and dangerous introductions independently', () => {
  const before = [
    { path: 'Api.User/Controllers/HomeController.cs', text: '[Authorize]\npublic class HomeController {}\n' },
    { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = JSON.parse;\n' },
  ];
  const after = [
    { path: 'Api.User/Controllers/HomeController.cs', text: 'public class HomeController {}\n' },
    { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = (x) => eval(x);\n' },
  ];
  const section = auditSafetyContractDelta(inv(before), inv(after));
  assert.equal(section.summary.protectiveLosses > 0, true);
  assert.equal(section.summary.dangerousIntroductions > 0, true);
});

test('summary findingsByPolicy is deterministic', () => {
  const before = [
    { path: 'Api.User/Controllers/HomeController.cs', text: '[Authorize]\npublic class HomeController {}\n' },
    { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = JSON.parse;\n' },
  ];
  const after = [
    { path: 'Api.User/Controllers/HomeController.cs', text: 'public class HomeController {}\n' },
    { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = (x) => eval(x);\n' },
  ];
  const first = auditSafetyContractDelta(inv(before), inv(after));
  const second = auditSafetyContractDelta(inv(before), inv(after));
  assert.deepEqual(first.summary.findingsByPolicy, second.summary.findingsByPolicy);
  assert.deepEqual(first.findings, second.findings);
});

test('observations retain before and after counts', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'const maxFeatures = 10;\nconst maxPages = 2;\n' };
  const after = { ...before, text: 'const maxPages = 2;\n' };
  const section = audit(before, after);
  const observation = section.summary.observations.find(item => item.policyId === 'gis-feature-budget-loss');
  assert.equal(observation?.beforeCount, 2);
  assert.equal(observation?.afterCount, 1);
  assert.equal(observation?.delta, -1);
  assert.equal(observation?.triggered, true);
});

test('unmatched policies still emit non-triggered observations for owned path', () => {
  const before = { path: 'Webclient.app/src/gis/query/queryRuntime.ts', text: 'const maxFeatures = 10;\n' };
  const after = { ...before, text: 'const maxFeatures = 20;\n' };
  const section = audit(before, after);
  const observation = section.summary.observations.find(item => item.policyId === 'gis-feature-budget-loss');
  assert.equal(observation?.triggered, false);
});

test('markdown exposes protective and dangerous delta totals', () => {
  const before = { path: 'Webclient.app/src/runtime/expression.ts', text: 'export const parse = JSON.parse;\n' };
  const after = { ...before, text: 'export const parse = (x) => eval(x);\n' };
  const markdown = safetyContractDeltaMarkdown(audit(before, after));
  assert.match(markdown, /Safety Contract Delta/u);
  assert.match(markdown, /Dangerous introductions: 1/u);
  assert.match(markdown, /safety-delta-dynamic-code-introduction/u);
});

test('markdown clean path states no safety regressions', () => {
  const before = { path: 'Webclient.app/src/runtime/safe.ts', text: 'export const value = 1;\n' };
  const after = { ...before, text: 'export const value = 2;\n' };
  const markdown = safetyContractDeltaMarkdown(audit(before, after));
  assert.match(markdown, /No exact-base safety contract regressions/u);
});

test('elapsed time remains non-negative', () => {
  const section = auditSafetyContractDelta(inv([]), inv([]));
  assert.equal(section.elapsedMs >= 0, true);
});
