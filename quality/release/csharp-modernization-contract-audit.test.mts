import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCSharpModernizationContracts } from './csharp-modernization-contract-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function props(overrides = ''): FixtureFileInput {
  return {
    path: 'Directory.Build.props',
    text: `<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>annotations</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisLevel>latest</AnalysisLevel><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode><RestoreAuditLevel>moderate</RestoreAuditLevel>${overrides}</PropertyGroup></Project>`,
  };
}

function audit(files: readonly FixtureFileInput[]) {
  return auditCSharpModernizationContracts(fixtureInventory([props(), ...files]));
}

test('accepts modern async backend code', () => {
  const result = audit([{
    path: 'Business/QueryService.cs',
    text: `
      public sealed class QueryService {
        private readonly IHttpClientFactory _factory;
        public QueryService(IHttpClientFactory factory) => _factory = factory;
        public async Task<string> QueryAsync(CancellationToken cancellationToken) {
          using var client = _factory.CreateClient("query");
          return await client.GetStringAsync("/api/query", cancellationToken);
        }
      }
    `,
  }]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.compiler.targetFramework, 'net10.0');
});

test('reports Task.Result sync-over-async', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'var value = task.Result;' }]);
  assert.ok(result.findings.some(item => item.id === 'csharp-sync-over-async'));
});

test('does not classify MVC action result assignment as Task.Result blocking', () => {
  const result = audit([{
    path: 'Api.Admin/Filters/AdminRequestFilterAttribute.cs',
    text: 'public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next) { context.Result = new UnauthorizedResult(); await next(); }',
  }]);
  assert.equal(result.summary.syncOverAsync, 0);
  assert.ok(!result.findings.some(item => item.id === 'csharp-sync-over-async'));
});

test('does not suppress real Task.Result reads alongside MVC result assignments', () => {
  const result = audit([{
    path: 'Api.Admin/Filters/AdminRequestFilterAttribute.cs',
    text: 'context.Result = new UnauthorizedResult(); var blocked = authenticationTask.Result; authenticationTask.Wait();',
  }]);
  assert.equal(result.summary.syncOverAsync, 2);
  assert.equal(result.findings.filter(item => item.id === 'csharp-sync-over-async').length, 2);
});

test('reports Task.Wait sync-over-async', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'task.Wait();' }]);
  assert.equal(result.summary.syncOverAsync, 1);
});

test('reports GetAwaiter GetResult sync bridge', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'var value = task.GetAwaiter().GetResult();' }]);
  assert.ok(result.findings.some(item => item.id === 'csharp-getawaiter-getresult'));
});

test('blocks async void method that is not an event handler', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'public async void RefreshAsync() { await Task.Delay(1); }' }]);
  const finding = result.findings.find(item => item.id === 'csharp-async-void');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('allows conventional async void event handler', () => {
  const result = audit([{
    path: 'Business/UiBridge.cs',
    text: 'private async void OnChanged(object? sender, EventArgs e) { await RefreshAsync(); }',
  }]);
  assert.ok(!result.findings.some(item => item.id === 'csharp-async-void'));
});

test('reports direct HttpClient construction', () => {
  const result = audit([{ path: 'Business/RemoteService.cs', text: 'using var client = new HttpClient();' }]);
  assert.equal(result.summary.directHttpClient, 1);
  assert.ok(result.findings.some(item => item.id === 'csharp-direct-httpclient'));
});

test('reports Thread.Sleep', () => {
  const result = audit([{ path: 'Business/LegacyService.cs', text: 'Thread.Sleep(500);' }]);
  assert.equal(result.summary.blockingSleep, 1);
});

test('blocks forced GC', () => {
  const result = audit([{ path: 'Business/CacheManager.cs', text: 'GC.Collect();' }]);
  const finding = result.findings.find(item => item.id === 'csharp-forced-gc');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('reports throw variable', () => {
  const result = audit([{
    path: 'Business/QueryService.cs',
    text: 'try { Work(); } catch (Exception ex) { throw ex; }',
  }]);
  assert.equal(result.summary.throwEx, 1);
});

test('does not report bare throw', () => {
  const result = audit([{
    path: 'Business/QueryService.cs',
    text: 'try { Work(); } catch (Exception) { throw; }',
  }]);
  assert.ok(!result.findings.some(item => item.id === 'csharp-throw-variable'));
});

test('does not report throw new domain exception as throw-variable', () => {
  const result = audit([{
    path: 'Business/QueryService.cs',
    text: 'throw new InvalidOperationException("x", ex);',
  }]);
  assert.ok(!result.findings.some(item => item.id === 'csharp-throw-variable'));
});

test('reports empty catch', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'try { Work(); } catch (Exception) { }' }]);
  assert.equal(result.summary.emptyCatch, 1);
});

test('reports lock this', () => {
  const result = audit([{ path: 'Business/CacheManager.cs', text: 'lock (this) { _value++; }' }]);
  assert.ok(result.findings.some(item => item.id === 'csharp-lock-this'));
});

test('reports Task.Run in controller request path', () => {
  const result = audit([{
    path: 'Api.User/Controllers/SearchController.cs',
    text: 'public Task<string> Get() => Task.Run(() => Search());',
  }]);
  assert.ok(result.findings.some(item => item.id === 'csharp-task-run-request-path'));
});

test('reports Task.Run in service path', () => {
  const result = audit([{
    path: 'Business/SearchService.cs',
    text: 'public Task<int> CountAsync() => Task.Run(() => 1);',
  }]);
  assert.ok(result.findings.some(item => item.id === 'csharp-task-run-request-path'));
});

test('does not report Task.Run in unrelated utility filename', () => {
  const result = audit([{
    path: 'Utilities/OfflineBatch.cs',
    text: 'public Task<int> RunAsync() => Task.Run(() => 1);',
  }]);
  assert.ok(!result.findings.some(item => item.id === 'csharp-task-run-request-path'));
});

test('ignores test projects and generated migrations', () => {
  const result = audit([
    { path: 'tests/Platform.Security.Tests/UnsafeTests.cs', text: 'GC.Collect(); Thread.Sleep(1);' },
    { path: 'Data/Migrations/20260101_Initial.cs', text: 'var x = task.Result;' },
    { path: 'Entity/Model.Designer.cs', text: 'new HttpClient();' },
  ]);
  assert.equal(result.summary.files, 0);
});

test('blocks non-net10 target framework', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>enable</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  const finding = result.findings.find(item => item.id === 'csharp-target-framework-modernization');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('reports language version below CSharp 14', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>13.0</LangVersion><Nullable>enable</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  assert.ok(result.findings.some(item => item.id === 'csharp-language-version-modernization'));
});

test('reports nullable disabled', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>disable</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  assert.ok(result.findings.some(item => item.id === 'csharp-nullable-contract-missing'));
});

test('blocks disabled analyzers', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>annotations</Nullable><EnableNETAnalyzers>false</EnableNETAnalyzers><Deterministic>true</Deterministic><RestoreAuditMode>all</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  assert.ok(result.findings.some(item => item.id === 'csharp-analyzers-disabled' && item.blocking === true));
});

test('reports non-deterministic build', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>annotations</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><Deterministic>false</Deterministic><RestoreAuditMode>all</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  assert.ok(result.findings.some(item => item.id === 'csharp-deterministic-build-disabled'));
});

test('reports incomplete restore audit mode', () => {
  const result = auditCSharpModernizationContracts(fixtureInventory([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><Nullable>annotations</Nullable><EnableNETAnalyzers>true</EnableNETAnalyzers><Deterministic>true</Deterministic><RestoreAuditMode>direct</RestoreAuditMode></PropertyGroup></Project>',
  }]));
  assert.ok(result.findings.some(item => item.id === 'csharp-restore-audit-incomplete'));
});

test('accepts annotations nullable mode as an incremental modern baseline', () => {
  const result = audit([]);
  assert.ok(!result.findings.some(item => item.id === 'csharp-nullable-contract-missing'));
});

test('caps repeated findings per rule', () => {
  const repeated = Array.from({ length: 30 }, () => 'GC.Collect();').join('\n');
  const result = audit([{ path: 'Business/CacheManager.cs', text: repeated }]);
  assert.equal(result.summary.forcedGc, 8);
});

test('keeps findings deterministic regardless of file order', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'Business/ZService.cs', text: 'Thread.Sleep(1);' },
    { path: 'Business/AService.cs', text: 'new HttpClient();' },
  ];
  const left = audit(files);
  const right = audit([...files].reverse());
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, file: item.location?.file, line: item.location?.line })),
    right.findings.map(item => ({ id: item.id, file: item.location?.file, line: item.location?.line })),
  );
});

test('summary remains stable across repeated audits', () => {
  const inventory = fixtureInventory([
    props(),
    { path: 'Business/QueryService.cs', text: 'var value = task.Result; new HttpClient();' },
  ]);
  const first = auditCSharpModernizationContracts(inventory);
  const second = auditCSharpModernizationContracts(inventory);
  assert.deepEqual(first.summary.compiler, second.summary.compiler);
  assert.deepEqual(first.summary.signals, second.summary.signals);
});

test('MVC ActionExecutingContext.Result response assignment is not Task.Result blocking', () => {
  const result = audit([{
    path: 'Api.Admin/Filters/AdminRequestFilterAttribute.cs',
    text: [
      'public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next) {',
      '  context.Result = new ObjectResult(new { message = "Unauthorized" }) { StatusCode = 401 };',
      '  await next().ConfigureAwait(false);',
      '}',
    ].join('\n'),
  }]);
  assert.equal(result.summary.syncOverAsync, 0);
  assert.ok(!result.findings.some(item => item.id === 'csharp-sync-over-async'));
});

test('ordinary property assignment does not fabricate a blocked async result', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'response.Result = 42;' }]);
  assert.equal(result.summary.syncOverAsync, 0);
});

test('Task.Result reads remain detected after excluding assignment syntax', () => {
  const result = audit([{
    path: 'Api.Admin/Filters/AdminRequestFilterAttribute.cs',
    text: 'context.Result = new ObjectResult(); var blocked = task.Result;',
  }]);
  assert.equal(result.summary.syncOverAsync, 1);
});

test('Task.Result comparison is still a read, not a response assignment', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'if (task.Result == 42) return;' }]);
  assert.equal(result.summary.syncOverAsync, 1);
});

test('Task.Wait synchronous blocking remains a high severity finding', () => {
  const result = audit([{ path: 'Business/QueryService.cs', text: 'task.Wait();' }]);
  assert.equal(result.summary.syncOverAsync, 1);
  assert.ok(result.findings.some(item => item.id === 'csharp-sync-over-async' && item.severity === 'high'));
});
