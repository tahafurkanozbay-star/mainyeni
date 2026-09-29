import assert from 'node:assert/strict';
import test from 'node:test';
import { auditUntrustedEnvExecution } from './untrusted-env-execution-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditUntrustedEnvExecution(fixtureInventory([{ path: '.github/workflows/env.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(env: string, run: string): string {
  const body = run.split('\n').map(line => `          ${line}`).join('\n');
  return `name: env\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          VALUE: ${env}\n        run: |\n${body}\n`;
}

test('accepts quoted untrusted env value used only as data', () => {
  const result = audit(workflow('\${{ github.event.pull_request.title }}', 'printf \'%s\\n\' "$VALUE"'));
  assert.equal(result.summary.taintedVariables, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks eval of event-backed env value', () => {
  const result = audit(workflow('\${{ github.event.pull_request.body }}', 'eval "$VALUE"'));
  const finding = result.findings.find(item => item.id === 'ci-untrusted-env-evaluator');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks Invoke-Expression of input-backed env value', () => {
  const result = audit(`name: env\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: windows-latest\n    steps:\n      - env:\n          VALUE: \${{ inputs.command }}\n        shell: pwsh\n        run: Invoke-Expression $env:VALUE\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-evaluator'));
});

test('blocks bash -c of untrusted env value', () => {
  const result = audit(workflow('\${{ inputs.command }}', 'bash -c "$VALUE"'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-interpreter-command'));
});

test('blocks node -e of output-backed env value', () => {
  const result = audit(workflow('\${{ needs.prepare.outputs.script }}', 'node -e "$VALUE"'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-interpreter-command'));
});

test('blocks env variable in command position', () => {
  const result = audit(workflow('\${{ github.event.pull_request.title }}', '$VALUE --version'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-command-position'));
});

test('blocks PowerShell env variable invoked with call operator', () => {
  const result = audit(`name: env\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: windows-latest\n    steps:\n      - env:\n          VALUE: \${{ inputs.command }}\n        shell: pwsh\n        run: '& $env:VALUE'\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-command-position'));
});

test('flags dynamic git checkout selector from env', () => {
  const result = audit(workflow('\${{ github.head_ref }}', 'git checkout "$VALUE"'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-dangerous-selector'));
});

test('flags dynamic curl URL from env', () => {
  const result = audit(workflow('\${{ inputs.url }}', 'curl -fsSL "$VALUE" -o data.json'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-dangerous-selector'));
});

test('flags dynamic rm path from env', () => {
  const result = audit(workflow('\${{ needs.prepare.outputs.path }}', 'rm -rf "$VALUE"'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-dangerous-selector'));
});

test('flags matrix controlled docker image from env', () => {
  const result = audit(workflow('\${{ matrix.image }}', 'docker pull "$VALUE"'));
  assert.ok(result.findings.some(item => item.id === 'ci-untrusted-env-dangerous-selector'));
});

test('does not inspect trusted literal environment values', () => {
  const result = audit(workflow('production', 'printf \'%s\\n\' "$VALUE"'));
  assert.equal(result.summary.taintedVariables, 0);
  assert.deepEqual(result.findings, []);
});

test('does not carry taint across sibling steps', () => {
  const result = audit(`name: env\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          VALUE: \${{ github.event.pull_request.title }}\n        run: printf '%s\\n' "$VALUE"\n      - run: eval "$VALUE"\n`);
  assert.equal(result.summary.taintedVariables, 1);
  assert.deepEqual(result.findings, []);
});

test('reports multiple source kinds on expression', () => {
  const result = audit(workflow('\${{ inputs.prefix }}-\${{ matrix.name }}', 'eval "$VALUE"'));
  assert.deepEqual(result.summary.signals[0]?.sources, ['input', 'matrix']);
});

test('reports deterministic reexecution counts', () => {
  const result = audit(workflow('\${{ github.event.pull_request.body }}', 'eval "$VALUE"\ngit checkout "$VALUE"'));
  assert.equal(result.summary.reexecutedVariables, 1);
  assert.equal(result.summary.evaluatorUses, 1);
  assert.equal(result.summary.dangerousSelectorUses, 1);
});

test('ignores non-workflow env content', () => {
  const result = auditUntrustedEnvExecution(fixtureInventory([{ path: 'config/env.yml', text: 'env:\n  VALUE: ${{ inputs.x }}\nrun: eval "$VALUE"' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
