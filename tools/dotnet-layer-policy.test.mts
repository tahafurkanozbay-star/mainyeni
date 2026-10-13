import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYER_EDGES, evaluateDotnetLayerPolicy, renderDotnetLayerPolicyMarkdown } from './dotnet-layer-policy.mts';

const project = (name, refs = []) => ({
  path: name,
  xml: '<Project><ItemGroup>' + refs.map(ref =>
    '<ProjectReference Include="' + ref + '" />').join('') + '</ItemGroup></Project>',
});
const base = () => [
  project('Toolbox/Toolbox.csproj'),
  project('Business/Business.csproj', ['../Toolbox/Toolbox.csproj']),
  project('Api.Core/Api.Core.csproj', ['../Business/Business.csproj', '../Toolbox/Toolbox.csproj']),
  project('Api.User/Api.User.csproj', ['../Api.Core/Api.Core.csproj', '../Business/Business.csproj', '../Toolbox/Toolbox.csproj']),
  project('Api.Admin/Api.Admin.csproj', ['../Api.Core/Api.Core.csproj', '../Business/Business.csproj', '../Toolbox/Toolbox.csproj']),
  project('tests/Platform.Security.Tests/Platform.Security.Tests.csproj', [
    '../../Api.Core/Api.Core.csproj', '../../Api.User/Api.User.csproj',
    '../../Business/Business.csproj', '../../Toolbox/Toolbox.csproj',
  ]),
];
const evaluate = (projects = base(), requireComplete = true) =>
  evaluateDotnetLayerPolicy({ projects, requireComplete });
const codes = report => report.findings.map(x => x.code);

test('active six-project topology passes the explicit layer contract', () => {
  const report = evaluate();
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.summary, { projects: 6, references: 13, violations: 0 });
  assert.equal(report.fingerprint.length, 64);
});
test('every expected project has a named explicit dependency policy', () => {
  assert.deepEqual(Object.keys(LAYER_EDGES).sort(), base().map(x => x.path).sort());
});
test('Toolbox is the foundation with no direct project dependencies', () => {
  assert.deepEqual(LAYER_EDGES['Toolbox/Toolbox.csproj'], []);
});
test('business domain cannot reference the API composition layer', () => {
  const items = base();
  items[1] = project(items[1].path, ['../Api.Core/Api.Core.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('API composition cannot depend on a concrete executable host', () => {
  const items = base();
  items[2] = project(items[2].path, ['../Api.User/Api.User.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('user and admin executable hosts cannot reference each other', () => {
  const items = base();
  items[3] = project(items[3].path, ['../Api.Admin/Api.Admin.csproj']);
  items[4] = project(items[4].path, ['../Api.User/Api.User.csproj']);
  assert.equal(codes(evaluate(items)).filter(x => x === 'layer-reference-forbidden').length, 2);
});
test('production projects cannot depend on test assemblies', () => {
  const items = base();
  items[0] = project(items[0].path, ['../tests/Platform.Security.Tests/Platform.Security.Tests.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('security test assembly cannot depend on the admin executable host', () => {
  const items = base();
  items[5] = project(items[5].path, ['../../Api.Admin/Api.Admin.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('unclassified new projects fail closed rather than silently widening layers', () => {
  const report = evaluate([...base(), project('Other/Other.csproj')]);
  assert.ok(codes(report).includes('layer-project-unclassified'));
});
test('missing required projects fail the full repository gate', () => {
  const report = evaluate(base().slice(1));
  assert.ok(codes(report).includes('layer-required-project-missing'));
});
test('small focused inventories can opt out of completeness, not classification', () => {
  assert.equal(evaluate([project('Toolbox/Toolbox.csproj')], false).ok, true);
  assert.ok(codes(evaluate([project('Unknown/Unknown.csproj')], false)).includes('layer-project-unclassified'));
});
test('duplicate inventory paths are rejected', () => {
  assert.ok(codes(evaluate([...base(), base()[0]])).includes('layer-project-duplicate'));
});
test('duplicate references are rejected even if target is otherwise permitted', () => {
  const items = base();
  items[1] = project(items[1].path, ['../Toolbox/Toolbox.csproj', '../Toolbox/Toolbox.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-duplicate'));
});
test('Windows separators resolve to canonical project identities', () => {
  const items = base();
  items[1] = project(items[1].path, ['..\\Toolbox\\Toolbox.csproj']);
  assert.equal(evaluate(items).ok, true);
});
test('conditional project references are conservatively governed', () => {
  const items = base();
  items[0] = { path: items[0].path,
    xml: '<Project><ItemGroup><ProjectReference Include="../Api.User/Api.User.csproj" Condition="false" /></ItemGroup></Project>' };
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('reference traversal outside repository is rejected', () => {
  const items = base();
  items[0] = project(items[0].path, ['../../Outside/Outside.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-invalid'));
});
test('absolute POSIX and drive-qualified references are rejected', () => {
  const items = base();
  items[0] = project(items[0].path, ['/tmp/Outside.csproj', 'C:/Outside.csproj']);
  assert.equal(codes(evaluate(items)).filter(x => x === 'layer-reference-invalid').length, 2);
});
test('reference targets must be .csproj files', () => {
  const items = base();
  items[0] = project(items[0].path, ['../Business/Business.props']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-invalid'));
});
test('self-reference is forbidden by the layer contract', () => {
  const items = base();
  items[0] = project(items[0].path, ['Toolbox.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-forbidden'));
});
test('project inventory rejects root-absolute paths', () => {
  assert.ok(codes(evaluate([{ path: '/Toolbox/Toolbox.csproj', xml: '<Project />' }], false))
    .includes('layer-project-path-invalid'));
});
test('project inventory rejects path traversal', () => {
  assert.ok(codes(evaluate([{ path: '../Toolbox/Toolbox.csproj', xml: '<Project />' }], false))
    .includes('layer-project-path-invalid'));
});
test('project inventory rejects empty and non-csproj paths', () => {
  for (const path of ['', 'Toolbox/Toolbox.props', 'Toolbox//Toolbox.csproj']) {
    assert.ok(codes(evaluate([{ path, xml: '<Project />' }], false))
      .includes('layer-project-path-invalid'));
  }
});
test('duplicate references after canonical path normalization are rejected', () => {
  const items = base();
  items[1] = project(items[1].path, ['../Toolbox/Toolbox.csproj', '../Toolbox/./Toolbox.csproj']);
  assert.ok(codes(evaluate(items)).includes('layer-reference-duplicate'));
});
test('findings are deterministic independent of project enumeration order', () => {
  const items = base();
  items[0] = project(items[0].path, ['../Api.User/Api.User.csproj']);
  const first = evaluate(items), second = evaluate([...items].reverse());
  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.fingerprint, second.fingerprint);
});
test('inventory does not retain project XML, secrets, or build property values', () => {
  const items = base();
  items[0].xml = '<Project><PropertyGroup><Password>never-log-this-value</Password></PropertyGroup></Project>';
  const report = evaluate(items);
  assert.equal(JSON.stringify(report).includes('never-log-this-value'), false);
});
test('report fingerprint changes when project edges change', () => {
  const items = base();
  const before = evaluate(items).fingerprint;
  items[1] = project(items[1].path);
  assert.notEqual(evaluate(items).fingerprint, before);
});
test('markdown includes gate, fingerprint and stable inventory', () => {
  const markdown = renderDotnetLayerPolicyMarkdown(evaluate());
  assert.match(markdown, /Gate: \*\*PASS\*\*/);
  assert.match(markdown, /Fingerprint: [0-9a-f]{64}/);
  assert.match(markdown, /Toolbox\/Toolbox.csproj/);
  assert.match(markdown, /## Findings/);
});
test('markdown reports failures without exposing raw XML', () => {
  const items = base();
  items[0] = project(items[0].path, ['../Api.User/Api.User.csproj']);
  const markdown = renderDotnetLayerPolicyMarkdown(evaluate(items));
  assert.match(markdown, /Gate: \*\*FAIL\*\*/);
  assert.match(markdown, /layer-reference-forbidden/);
  assert.equal(markdown.includes('<ProjectReference'), false);
});
test('layer policy has no allowed reference to a test assembly from production', () => {
  for (const [name, edges] of Object.entries(LAYER_EDGES)) {
    if (name.startsWith('tests/')) continue;
    assert.equal(edges.some(edge => edge.startsWith('tests/')), false, name);
  }
});
test('all declared dependency targets are themselves classified projects', () => {
  for (const edges of Object.values(LAYER_EDGES)) {
    for (const edge of edges) assert.ok(Object.hasOwn(LAYER_EDGES, edge), edge);
  }
});
