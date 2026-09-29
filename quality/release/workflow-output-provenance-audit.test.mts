import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowOutputProvenance } from './workflow-output-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowOutputProvenance(fixtureInventory([{ path: '.github/workflows/output.yml', text }] as readonly FixtureFileInput[]));
}

const safe = `name: output
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.version.outputs.value }}
    steps:
      - id: version
        run: echo "value=1.2.3" >> "$GITHUB_OUTPUT"
  report:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - env:
          VERSION: \${{ needs.build.outputs.version }}
        run: printf '%s\\n' "$VERSION"
`;

test('accepts job output consumed only as step environment data', () => {
  const result = audit(safe);
  assert.equal(result.summary.outputProducerJobs, 1);
  assert.equal(result.summary.outputReferences, 0);
  assert.deepEqual(result.findings, []);
});

test('flags job output interpolated directly into run source', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    outputs:\n      value: \${{ steps.make.outputs.value }}\n    steps:\n      - id: make\n        run: echo "value=safe" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: tool --value "\${{ needs.build.outputs.value }}"\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-output-executable-provenance-review'));
});

test('blocks tainted producer output entering privileged run source', () => {
  const result = audit(`name: output\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    outputs:\n      value: \${{ steps.make.outputs.value }}\n    steps:\n      - id: make\n        env:\n          USER_VALUE: \${{ inputs.value }}\n        run: echo "value=$USER_VALUE" >> "$GITHUB_OUTPUT"\n  publish:\n    needs: build\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create "\${{ needs.build.outputs.value }}"\n`);
  const finding = result.findings.find(item => item.id === 'ci-output-privileged-execution-provenance');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
  assert.equal(result.summary.taintedProducerJobs, 1);
});

test('tracks direct event expression written to GITHUB_OUTPUT', () => {
  const result = audit(`name: output\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    outputs:\n      name: \${{ steps.make.outputs.name }}\n    steps:\n      - id: make\n        run: echo "name=\${{ github.event.pull_request.title }}" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ needs.build.outputs.name }}"\n`);
  assert.equal(result.summary.taintedProducerJobs, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-output-tainted-execution'));
});

test('blocks tainted output selecting runner for privileged consumer', () => {
  const result = audit(`name: output\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      runner: \${{ steps.make.outputs.runner }}\n    steps:\n      - id: make\n        env:\n          RUNNER: \${{ inputs.runner }}\n        run: echo "runner=$RUNNER" >> "$GITHUB_OUTPUT"\n  deploy:\n    needs: choose\n    permissions:\n      deployments: write\n    environment: production\n    runs-on: \${{ needs.choose.outputs.runner }}\n    steps:\n      - run: echo deploy\n`);
  assert.ok(result.findings.some(item => item.context === undefined));
  const signal = result.summary.signals.find(item => item.context === 'runs-on');
  assert.equal(signal?.producerTainted, true);
  assert.equal(signal?.consumerPrivileged, true);
  assert.ok(result.findings.some(item => item.id === 'ci-output-privileged-execution-provenance'));
});

test('tracks output selecting deployment environment', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      environment: \${{ steps.make.outputs.environment }}\n    steps:\n      - id: make\n        run: echo "environment=production" >> "$GITHUB_OUTPUT"\n  deploy:\n    needs: choose\n    permissions:\n      deployments: write\n    environment: \${{ needs.choose.outputs.environment }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);
  assert.equal(result.summary.signals.find(item => item.context === 'environment')?.consumerPrivileged, true);
});

test('tracks output used as action identity', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      action: \${{ steps.make.outputs.action }}\n    steps:\n      - id: make\n        run: echo "action=owner/repo@0123456789abcdef0123456789abcdef01234567" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: choose\n    runs-on: ubuntu-latest\n    steps:\n      - uses: \${{ needs.choose.outputs.action }}\n`);
  assert.equal(result.summary.signals[0]?.context, 'uses');
});

test('tracks output used as shell selector', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      shell: \${{ steps.make.outputs.shell }}\n    steps:\n      - id: make\n        run: echo "shell=bash" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: choose\n    runs-on: ubuntu-latest\n    steps:\n      - shell: \${{ needs.choose.outputs.shell }}\n        run: echo ok\n`);
  assert.equal(result.summary.signals[0]?.context, 'shell');
});

test('tracks output used as working directory', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      dir: \${{ steps.make.outputs.dir }}\n    steps:\n      - id: make\n        run: echo "dir=Webclient.app" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: choose\n    runs-on: ubuntu-latest\n    steps:\n      - working-directory: \${{ needs.choose.outputs.dir }}\n        run: npm test\n`);
  assert.equal(result.summary.signals[0]?.context, 'working-directory');
});

test('tracks output used as checkout ref', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      ref: \${{ steps.make.outputs.ref }}\n    steps:\n      - id: make\n        run: echo "ref=main" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: choose\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n        with:\n          ref: \${{ needs.choose.outputs.ref }}\n`);
  assert.equal(result.summary.signals.some(item => item.context === 'checkout-ref'), true);
});

test('tracks output used as repository selector', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  choose:\n    runs-on: ubuntu-latest\n    outputs:\n      repository: \${{ steps.make.outputs.repository }}\n    steps:\n      - id: make\n        run: echo "repository=owner/repo" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: choose\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n        with:\n          repository: \${{ needs.choose.outputs.repository }}\n`);
  assert.equal(result.summary.signals.some(item => item.context === 'checkout-repository'), true);
});

test('does not mark static producer output as tainted', () => {
  const result = audit(`name: output\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    outputs:\n      version: \${{ steps.make.outputs.version }}\n    steps:\n      - id: make\n        run: echo "version=1.0.0" >> "$GITHUB_OUTPUT"\n  consume:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ needs.build.outputs.version }}"\n`);
  assert.equal(result.summary.taintedProducerJobs, 0);
  assert.equal(result.summary.signals[0]?.producerTainted, false);
});

test('does not inspect needs output used only in env mapping', () => {
  const result = audit(safe);
  assert.equal(result.summary.outputReferences, 0);
});

test('keeps producer identity scoped to same workflow file', () => {
  const inventory = fixtureInventory([
    { path: '.github/workflows/a.yml', text: `name: a\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    outputs:\n      x: \${{ steps.s.outputs.x }}\n    steps:\n      - id: s\n        run: echo "x=one" >> "$GITHUB_OUTPUT"\n` },
    { path: '.github/workflows/b.yml', text: `name: b\non: [push]\npermissions:\n  contents: read\njobs:\n  consume:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ needs.build.outputs.x }}"\n` },
  ] as readonly FixtureFileInput[]);
  const result = auditWorkflowOutputProvenance(inventory);
  assert.equal(result.summary.signals[0]?.producerTainted, false);
});

test('ignores non workflow YAML', () => {
  const result = auditWorkflowOutputProvenance(fixtureInventory([{ path: 'config/output.yml', text: 'run: echo ${{ needs.build.outputs.x }}' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
