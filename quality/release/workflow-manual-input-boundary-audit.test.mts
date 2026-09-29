import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowManualInputBoundaries } from './workflow-manual-input-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowManualInputBoundaries(fixtureInventory([{ path: '.github/workflows/manual.yml', text }] as readonly FixtureFileInput[]));
}

test('accepts boolean input used only as condition', () => {
  const result = audit(`name: manual\non:\n  workflow_dispatch:\n    inputs:\n      dry_run:\n        type: boolean\n        required: true\n        default: true\npermissions:\n  contents: read\njobs:\n  test:\n    if: \${{ inputs.dry_run }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo dry\n`);
  assert.equal(result.summary.declaredInputs, 1);
  assert.deepEqual(result.findings, []);
});

test('accepts environment typed input as environment selector', () => {
  const result = audit(`name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: environment\n        required: true\npermissions:\n  deployments: write\njobs:\n  deploy:\n    environment: \${{ inputs.target }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);
  assert.equal(result.summary.signals[0]?.kind, 'environment');
  assert.equal(result.summary.signals[0]?.context, 'environment');
  assert.deepEqual(result.findings, []);
});

test('blocks free-form input interpolated into privileged run source', () => {
  const result = audit(`name: release\non:\n  workflow_dispatch:\n    inputs:\n      tag:\n        type: string\n        required: true\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create "\${{ inputs.tag }}"\n`);
  const finding = result.findings.find(item => item.id === 'ci-manual-input-privileged-execution');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('flags free-form input in read-only run source', () => {
  const result = audit(`name: test\non:\n  workflow_dispatch:\n    inputs:\n      pattern:\n        type: string\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test -- "\${{ inputs.pattern }}"\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source'));
});

test('blocks free-form input selecting runner for privileged job', () => {
  const result = audit(`name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      runner:\n        type: string\npermissions:\n  deployments: write\njobs:\n  deploy:\n    environment: production\n    runs-on: \${{ inputs.runner }}\n    steps:\n      - run: echo deploy\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-privileged-execution'));
});

test('flags input selecting checkout ref', () => {
  const result = audit(`name: build\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n        type: string\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n        with:\n          ref: \${{ inputs.ref }}\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-identity-selector'));
});

test('flags input selecting action identity', () => {
  const result = audit(`name: build\non:\n  workflow_call:\n    inputs:\n      action:\n        type: string\n        required: true\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: \${{ inputs.action }}\n`);
  assert.equal(result.summary.signals[0]?.context, 'uses');
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-identity-selector'));
});

test('parses choice input options', () => {
  const result = audit(`name: build\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: choice\n        required: true\n        options:\n          - web\n          - api\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          TARGET: \${{ inputs.target }}\n        run: echo "$TARGET"\n`);
  assert.equal(result.summary.choiceInputs, 1);
  assert.equal(result.summary.declaredInputs, 1);
  assert.deepEqual(result.findings, []);
});

test('flags choice input when directly interpolated into shell source', () => {
  const result = audit(`name: build\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: choice\n        options:\n          - web\n          - api\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ inputs.target }}"\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-shell-source'));
});

test('supports github.event.inputs compatibility expression', () => {
  const result = audit(`name: build\non:\n  workflow_dispatch:\n    inputs:\n      ref:\n        type: string\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - working-directory: \${{ github.event.inputs.ref }}\n        run: echo ok\n`);
  assert.equal(result.summary.signals[0]?.input, 'ref');
  assert.equal(result.summary.signals[0]?.context, 'working-directory');
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
  assert.ok(result.findings.some(item => item.id === 'ci-manual-input-identity-selector'));
});

test('does not inspect ordinary repository yaml', () => {
  const result = auditWorkflowManualInputBoundaries(fixtureInventory([{ path: 'config/manual.yml', text: 'run: echo ${{ inputs.x }}' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
