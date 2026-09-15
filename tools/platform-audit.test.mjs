import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from './platform-audit.mjs';

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-platform-audit-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test('counts code and package manifests', async t => {
  const root = await fixture({ 'package.json': JSON.stringify({ name: 'fixture', dependencies: { react: '^17.0.2', axios: '^0.21.1' } }), 'src/a.js': 'export const a = 1;\n', 'src/b.cs': 'namespace Demo;\npublic class B {}\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  assert.equal(report.summary.codeFiles, 2);
  assert.equal(report.summary.packageManifests, 1);
  assert.equal(report.summary.packageRiskCount, 2);
});

test('detects network boundaries and remote assets', async t => {
  const root = await fixture({ 'src/network.js': "fetch('https://example.com/api');\nconst x = new WebSocket('wss://example.com');\n", 'src/site.css': "@import url('https://fonts.googleapis.com/css2?family=Mukta');\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  assert.ok(report.network.some(x => x.kind === 'fetch'));
  assert.ok(report.network.some(x => x.kind === 'websocket'));
  assert.ok(report.network.some(x => x.kind === 'absolute-http'));
  assert.ok(report.externalAssets.some(x => x.kind === 'remote-google-font'));
});

test('detects security-sensitive browser APIs', async t => {
  const root = await fixture({ 'src/risky.js': "node.innerHTML = input;\neval(input);\nlocalStorage.setItem('token', input);\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  const kinds = new Set(report.security.map(x => x.kind));
  assert.ok(kinds.has('innerHTML')); assert.ok(kinds.has('eval')); assert.ok(kinds.has('local-storage-token'));
  assert.ok(report.summary.securityWeightedScore >= 10);
});

test('detects legacy React and polyfill patterns', async t => {
  const root = await fixture({ 'src/index.js': "import 'promise-polyfill';\nReactDOM.render(<App />, root);\n", 'src/legacy.js': 'class X { componentWillMount() {} }\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  const kinds = new Set(report.legacy.map(x => x.kind));
  assert.ok(kinds.has('reactdom-render')); assert.ok(kinds.has('component-will-mount')); assert.ok(kinds.has('promise-polyfill'));
});

test('parses centralized and project target frameworks', async t => {
  const root = await fixture({ 'Directory.Build.props': '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>', 'Api/Api.csproj': '<Project><PropertyGroup><TargetFrameworks>net10.0;net9.0</TargetFrameworks></PropertyGroup><ItemGroup><PackageReference Include="Example" Version="1.2.3" /></ItemGroup></Project>' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  assert.ok(report.dotnet.some(x => x.frameworks.includes('net10.0')));
  assert.ok(report.dotnet.some(x => x.packages.some(p => p.name === 'Example')));
});

test('skips node_modules and build output', async t => {
  const root = await fixture({ 'src/a.js': 'export default 1;\n', 'node_modules/pkg/index.js': 'eval("bad")\n', 'build/generated.js': 'eval("bad")\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  assert.equal(report.summary.codeFiles, 1); assert.equal(report.security.length, 0);
});

test('does not classify modern baseline packages as risks', async t => {
  const root = await fixture({ 'package.json': JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', axios: '^1.12.0', jspdf: '^3.0.0' } }) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root); assert.equal(report.summary.packageRiskCount, 0);
});

test('reports wildcard CORS as high severity', async t => {
  const root = await fixture({ 'config.json': 'Access-Control-Allow-Origin: *\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runAudit(root);
  const finding = report.security.find(x => x.kind === 'wildcard-cors');
  assert.equal(finding?.severity, 'high');
});
