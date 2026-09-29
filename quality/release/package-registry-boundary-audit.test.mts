import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPackageRegistryBoundaries } from './package-registry-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditPackageRegistryBoundaries(fixtureInventory([{ path: '.github/workflows/package.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(on: string, run: string, permissions = 'contents: read', env = ''): string {
  const body = run.split('\n').map(line => `          ${line}`).join('\n');
  return `name: package\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - name: package\n${env}        run: |\n${body}\n`;
}

test('accepts literal HTTPS npm registry with env scoped token', () => {
  const env = `        env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'npm publish --registry https://registry.npmjs.org/', 'contents: read', env));
  assert.equal(result.summary.registrySteps, 1);
  assert.equal(result.summary.dynamicRegistryTargets, 0);
  assert.equal(result.summary.plaintextRegistryTargets, 0);
});

test('blocks input controlled npm registry on publish', () => {
  const result = audit(workflow('[workflow_dispatch]', 'npm publish --registry "${{ inputs.registry }}"'));
  const finding = result.findings.find(item => item.id === 'ci-package-registry-dynamic-origin');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks plaintext npm registry', () => {
  const result = audit(workflow('[push]', 'npm publish --registry http://registry.example.test/'));
  assert.ok(result.findings.some(item => item.id === 'ci-package-registry-plaintext-origin' && item.blocking));
});

test('blocks clear text NuGet credential store', () => {
  const env = `        env:\n          NUGET_PASSWORD: \${{ secrets.NUGET_PASSWORD }}\n`;
  const result = audit(workflow('[push]', 'dotnet nuget add source https://nuget.example.test/v3/index.json --name private --username ci --password "$NUGET_PASSWORD" --store-password-in-clear-text', 'contents: read', env));
  assert.ok(result.findings.some(item => item.id === 'ci-package-nuget-cleartext-store' && item.blocking));
});

test('blocks persistent npmrc secret write in privileged job', () => {
  const env = `        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >> ~/.npmrc\nnpm publish', 'contents: write', env));
  assert.ok(result.findings.some(item => item.id === 'ci-package-persistent-credential-config' && item.blocking));
});

test('flags persistent pypirc secret write', () => {
  const env = `        env:\n          PYPI_TOKEN: \${{ secrets.PYPI_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'echo "password=$PYPI_TOKEN" >> ~/.pypirc\npython -m twine upload dist/*', 'contents: read', env));
  assert.ok(result.findings.some(item => item.id === 'ci-package-persistent-credential-config'));
});

test('flags cargo login with secret-backed argument', () => {
  const env = `        env:\n          CARGO_TOKEN: \${{ secrets.CARGO_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'cargo login "$CARGO_TOKEN"\ncargo publish', 'contents: read', env));
  assert.ok(result.findings.some(item => item.id === 'ci-package-persistent-credential-config'));
});

test('flags package credential command argument', () => {
  const env = `        env:\n          PYPI_TOKEN: \${{ secrets.PYPI_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'twine upload -u __token__ -p "$PYPI_TOKEN" dist/*', 'contents: read', env));
  assert.ok(result.findings.some(item => item.id === 'ci-package-credential-command-argument'));
});

test('blocks external npm publication', () => {
  const result = audit(workflow('[pull_request]', 'npm publish --registry https://registry.npmjs.org/', 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-package-external-publication' && item.blocking));
});

test('blocks external NuGet publication', () => {
  const result = audit(workflow('[issue_comment]', 'dotnet nuget push package.nupkg --source https://api.nuget.org/v3/index.json', 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-package-external-publication'));
});

test('detects twine publish step', () => {
  const result = audit(workflow('[push]', 'python -m twine upload dist/*'));
  assert.equal(result.summary.publishSteps, 1);
});

test('detects cargo publish step', () => {
  const result = audit(workflow('[push]', 'cargo publish'));
  assert.equal(result.summary.publishSteps, 1);
});

test('detects Maven deploy step', () => {
  const result = audit(workflow('[push]', './mvnw deploy'));
  assert.equal(result.summary.publishSteps, 1);
});

test('reports deterministic registry target counts', () => {
  const result = audit(workflow('[workflow_dispatch]', 'npm publish --registry "http://${{ inputs.registry }}/"'));
  assert.equal(result.summary.dynamicRegistryTargets, 1);
  assert.equal(result.summary.plaintextRegistryTargets, 1);
});

test('does not classify ordinary npm ci as registry boundary step finding', () => {
  const result = audit(workflow('[push]', 'npm ci'));
  assert.equal(result.summary.publishSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow package script', () => {
  const result = auditPackageRegistryBoundaries(fixtureInventory([{ path: 'scripts/package.yml', text: 'run: npm publish --registry http://bad.test' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
