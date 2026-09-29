import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowManualInputBoundaries } from './workflow-manual-input-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowManualInputBoundaries(fixtureInventory([{ path: '.github/workflows/manual.yml', text }] as readonly FixtureFileInput[]));
}

test('accepts boolean input used only as condition', () => {
  const result = audit(`name: manual\non:\n  workflow_dispatch:\n    inputs:\n      dry_run:\n        type: boolean\n        required: true\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    if: \${{ inputs.dry_run }}\n    steps:\n      - run: echo ok\n`);
  assert.deepEqual(result.findings, []);
});

test('accepts environment typed input as environment selector', () => {
  const result = audit(`name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: environment\n        required: true\npermissions:\n  contents: read\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: \${{ inputs.target }}\n    steps:\n      - run: echo ok\n`);
  assert.deepEqual(result.findings, []);
});

test('blocks free-form input interpolated into privileged run source', () => {
  const result = audit(`name: manual\non:\n  workflow_dispatch:\n    inputs:\n      command:\n        type: string\n        required: true\npermissions:\n  contents: write\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ inputs.command }}\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-privileged-execution' && item.blocking));
});

test('flags free-form input in read-only run source', () => {
  const result = audit(`name: manual\non:\n  workflow_dispatch:\n    inputs:\n      command:\n        type: string\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ inputs.command }}\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source' && item.severity === 'high'));
});

test('blocks free-form input selecting runner for privileged job', () => {
  const result = audit(`name: runner\non:\n  workflow_dispatch:\n    inputs:\n      runner:\n        type: string\npermissions:\n  contents: write\njobs:\n  run:\n    runs-on: \${{ inputs.runner }}\n    steps:\n      - run: echo ok\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-privileged-execution'));
});

test('flags input selecting checkout ref', () => {
  const result = audit(`name: ref\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n        type: string\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n        with:\n          ref: \${{ inputs.ref }}\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-identity-selector'));
});

test('flags input selecting action identity', () => {
  const result = audit(`name: action\non:\n  workflow_dispatch:\n    inputs:\n      action:\n        type: string\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: \${{ inputs.action }}\n`);
  const finding = result.findings.find(item => item.id === 'ci-manual-input-identity-selector');
  assert.ok(finding);
  assert.equal(finding.evidence?.metadata?.context, 'uses');
});

test('parses choice input options', () => {
  const result = audit(`name: choice\non:\n  workflow_dispatch:\n    inputs:\n      lane:\n        type: choice\n        options:\n          - web\n          - api\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`);
  assert.equal(result.summary.choiceInputs, 1);
  assert.deepEqual(result.findings, []);
});

test('flags choice input when directly interpolated into shell source', () => {
  const result = audit(`name: choice\non:\n  workflow_dispatch:\n    inputs:\n      lane:\n        type: choice\n        options:\n          - web\n          - api\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ inputs.lane }}\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source'));
});

test('supports github.event.inputs compatibility expression', () => {
  const result = audit(`name: compat\non:\n  workflow_dispatch:\n    inputs:\n      value:\n        type: string\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ github.event.inputs.value }}\n`);
  assert.ok(result.summary.signals.some(item => item.input === 'value'));
});

test('undeclared input reference is treated as unknown', () => {
  const result = audit(`name: build\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ inputs.missing }}"\n`);
  assert.equal(result.summary.signals[0]?.declared, false);
  assert.equal(result.summary.signals[0]?.kind, 'unknown');
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source'));
});

test('number input passed through env remains data', () => {
  const result = audit(`name: scale\non:\n  workflow_dispatch:\n    inputs:\n      count:\n        type: number\n        required: true\npermissions:\n  contents: read\njobs:\n  scale:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          COUNT: \${{ inputs.count }}\n        run: printf '%s\\n' "$COUNT"\n`);
  assert.deepEqual(result.findings, []);
});

test('workflow_call string input controlling script is flagged', () => {
  const result = audit(`name: reusable\non:\n  workflow_call:\n    inputs:\n      script:\n        type: string\n        required: true\npermissions:\n  contents: read\njobs:\n  call:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567\n        with:\n          script: \${{ inputs.script }}\n`);
  assert.ok(result.summary.signals.some(item => item.context === 'script'));
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source'));
});

test('does not inspect ordinary repository yaml', () => {
  const result = auditWorkflowManualInputBoundaries(fixtureInventory([{ path: 'config/manual.yml', text: 'run: echo ${{ inputs.x }}' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
