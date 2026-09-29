import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowSecretExposure } from './workflow-secret-exposure-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowSecretExposure(fixtureInventory([{ path: '.github/workflows/secrets.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(step: string): string {
  return `name: secret\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
}

test('accepts secret passed through step env and quoted variable use', () => {
  const result = audit(workflow(`      - name: publish\n        env:\n          TOKEN: \${{ secrets.RELEASE_TOKEN }}\n        run: curl -H "Authorization: Bearer $TOKEN" https://example.test/release\n`));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.secretBearingSteps, 1);
  assert.deepEqual(result.summary.signals[0]?.secretEnvironmentVariables, ['TOKEN']);
});

test('blocks direct secret interpolation in run source', () => {
  const result = audit(workflow(`      - run: curl -H "Authorization: Bearer \${{ secrets.RELEASE_TOKEN }}" https://example.test/release\n`));
  const finding = result.findings.find(item => item.id === 'ci-secret-direct-run-interpolation');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks secret embedded in URL', () => {
  const result = audit(workflow(`      - run: curl "https://user:\${{ secrets.PASSWORD }}@example.test/release"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-url-credential-exposure' && item.blocking));
});

test('flags direct token command argument', () => {
  const result = audit(workflow(`      - run: tool publish --token \${{ secrets.API_TOKEN }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-direct-argv-exposure'));
});

test('blocks xtrace in secret-bearing step', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: |\n          set -x\n          tool publish --token "$TOKEN"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-shell-tracing' && item.blocking));
});

test('blocks PowerShell tracing in secret-bearing step', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        shell: pwsh\n        run: |\n          Set-PSDebug -Trace 1\n          ./publish.ps1 $env:TOKEN\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-shell-tracing'));
});

test('blocks env dump in secret-bearing step', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: |\n          printenv\n          ./publish "$TOKEN"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-environment-dump' && item.blocking));
});

test('blocks PowerShell environment enumeration', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        shell: pwsh\n        run: |\n          Get-ChildItem Env:\n          ./publish.ps1 $env:TOKEN\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-environment-dump'));
});

test('blocks explicit echo of secret-backed environment variable', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: echo "$TOKEN"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-explicit-log' && item.blocking));
});

test('blocks Write-Host of secret-backed environment variable', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        shell: pwsh\n        run: Write-Host $env:TOKEN\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-explicit-log'));
});

test('blocks secret written to workflow summary', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: echo "$TOKEN" >> "$GITHUB_STEP_SUMMARY"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-step-summary-write' && item.blocking));
});

test('flags secret propagated through GITHUB_OUTPUT', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: echo "token=$TOKEN" >> "$GITHUB_OUTPUT"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-command-file-propagation'));
});

test('flags secret propagated through GITHUB_ENV', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: echo "NEXT_TOKEN=$TOKEN" >> "$GITHUB_ENV"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-command-file-propagation'));
});

test('blocks secret-derived GITHUB_PATH write', () => {
  const result = audit(workflow(`      - env:\n          SECRET_DIR: \${{ secrets.TOOL_DIR }}\n        run: echo "$SECRET_DIR" >> "$GITHUB_PATH"\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-secret-path-command-write' && item.blocking));
});

test('does not treat non-secret env as secret-bearing', () => {
  const result = audit(workflow(`      - env:\n          MODE: production\n        run: echo "$MODE"\n`));
  assert.equal(result.summary.secretBearingSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('keeps secret scope isolated between sibling steps', () => {
  const result = audit(workflow(`      - env:\n          TOKEN: \${{ secrets.API_TOKEN }}\n        run: ./publish "$TOKEN"\n      - run: printenv\n`));
  assert.equal(result.summary.secretBearingSteps, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-secret-environment-dump'), false);
});

test('counts multiple direct secret expressions deterministically', () => {
  const result = audit(workflow(`      - run: tool --token \${{ secrets.A }} --password \${{ secrets.B }}\n`));
  assert.equal(result.summary.directSecretInterpolations, 2);
});

test('ignores secret input to pinned action because action credential audit owns that boundary', () => {
  const result = audit(workflow(`      - uses: vendor/action@0123456789abcdef0123456789abcdef01234567\n        with:\n          token: \${{ secrets.API_TOKEN }}\n`));
  assert.equal(result.summary.secretBearingSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow files', () => {
  const result = auditWorkflowSecretExposure(fixtureInventory([{ path: 'scripts/example.yml', text: 'run: echo ${{ secrets.X }}' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
