import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFile } from './test-helpers.mts';
import { workflowJobBlocks } from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  parseUsesIdentity,
  stepDisplayName,
  stepNestedBlockLines,
  stepNestedMapping,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  workflowStepFields,
} from './workflow-step-structure.mts';

function job(text: string) {
  return workflowJobBlocks(fixtureFile({ path: '.github/workflows/ci.yml', text }))[0]!;
}

const fixture = `name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
        with:
          persist-credentials: false
          fetch-depth: 0
      - id: build
        env:
          MODE: release
        run: |
          npm ci
          npm test
      - uses: ./local-action
      - run: echo done
`;

test('extracts only direct step entries from a job steps block', () => {
  const steps = workflowStepBlocks(job(fixture));
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map(step => step.startLine), [7, 12, 18, 19]);
});

test('does not confuse nested with/env mappings for sibling steps', () => {
  const steps = workflowStepBlocks(job(fixture));
  assert.equal(steps.length, 4);
  assert.equal(stepDisplayName(steps[0]!), 'Checkout');
  assert.equal(stepDisplayName(steps[1]!), 'build');
});

test('first step fields include inline list-item fields', () => {
  const checkout = workflowStepBlocks(job(fixture))[0]!;
  assert.equal(firstWorkflowStepField(checkout, 'name')?.value, 'Checkout');
  assert.equal(firstWorkflowStepField(checkout, 'uses')?.value, 'actions/checkout@0123456789abcdef0123456789abcdef01234567');
});

test('direct step field parser ignores nested with keys', () => {
  const checkout = workflowStepBlocks(job(fixture))[0]!;
  assert.equal(firstWorkflowStepField(checkout, 'persist-credentials'), undefined);
  assert.deepEqual([...stepNestedMapping(checkout, 'with')], [
    ['persist-credentials', 'false'],
    ['fetch-depth', '0'],
  ]);
});

test('nested mapping parser ignores sibling step fields', () => {
  const build = workflowStepBlocks(job(fixture))[1]!;
  assert.deepEqual([...stepNestedMapping(build, 'env')], [['MODE', 'release']]);
  assert.equal(stepNestedMapping(build, 'env').has('run'), false);
});

test('block scalar run body is extracted without following steps', () => {
  const build = workflowStepBlocks(job(fixture))[1]!;
  assert.equal(stepRunText(build), 'npm ci\nnpm test');
  assert.equal(stepRunText(build).includes('./local-action'), false);
});

test('single-line run field is returned as data', () => {
  const step = workflowStepBlocks(job(fixture))[3]!;
  assert.equal(stepRunText(step), 'echo done');
});

test('step display name falls back to uses identity', () => {
  const local = workflowStepBlocks(job(fixture))[2]!;
  assert.equal(stepDisplayName(local), './local-action');
});

test('step display name has deterministic positional fallback', () => {
  const source = `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - env:\n          A: B\n`;
  const step = workflowStepBlocks(job(source))[0]!;
  assert.equal(stepDisplayName(step), 'step-1');
});

test('SHA pinned remote action identity is immutable', () => {
  const identity = parseUsesIdentity('actions/checkout@0123456789abcdef0123456789abcdef01234567');
  assert.equal(identity.remote, true);
  assert.equal(identity.local, false);
  assert.equal(identity.immutable, true);
  assert.equal(identity.owner, 'actions');
  assert.equal(identity.repository, 'checkout');
});

test('mutable remote action tag is not immutable', () => {
  const identity = parseUsesIdentity('vendor/action@v4');
  assert.equal(identity.remote, true);
  assert.equal(identity.immutable, false);
  assert.equal(identity.ref, 'v4');
});

test('remote action without a ref is not immutable', () => {
  const identity = parseUsesIdentity('vendor/action');
  assert.equal(identity.remote, true);
  assert.equal(identity.immutable, false);
});

test('local action is trusted by repository identity parsing', () => {
  const identity = parseUsesIdentity('./.github/actions/release');
  assert.equal(identity.local, true);
  assert.equal(identity.remote, false);
  assert.equal(identity.immutable, true);
});

test('docker action requires digest pin for immutability', () => {
  const mutable = parseUsesIdentity('docker://alpine:3.22');
  assert.equal(mutable.docker, true);
  assert.equal(mutable.immutable, false);
  const pinned = parseUsesIdentity(`docker://alpine@sha256:${'a'.repeat(64)}`);
  assert.equal(pinned.docker, true);
  assert.equal(pinned.immutable, true);
});

test('quoted uses scalar is normalized before identity parsing', () => {
  const identity = parseUsesIdentity('"actions/checkout@0123456789abcdef0123456789abcdef01234567"');
  assert.equal(identity.immutable, true);
});

test('step uses helper reads the direct uses field only', () => {
  const checkout = workflowStepBlocks(job(fixture))[0]!;
  assert.equal(stepUsesIdentity(checkout)?.owner, 'actions');
});

test('nested uses-looking input does not become step action identity', () => {
  const source = `jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - name: Wrapper
        with:
          uses: vendor/action@v1
        run: echo safe
`;
  const step = workflowStepBlocks(job(source))[0]!;
  assert.equal(stepUsesIdentity(step), undefined);
});

test('step field enumeration stays at direct field indentation', () => {
  const checkout = workflowStepBlocks(job(fixture))[0]!;
  assert.deepEqual(workflowStepFields(checkout).map(field => field.key), ['name', 'uses', 'with']);
});

test('nested block lines stop at next direct step field', () => {
  const checkout = workflowStepBlocks(job(fixture))[0]!;
  const lines = stepNestedBlockLines(checkout, 'with');
  assert.equal(lines.some(line => line.trimmed.startsWith('persist-credentials:')), true);
  assert.equal(lines.some(line => line.trimmed.startsWith('id: build')), false);
});

test('parser handles a step beginning with uses', () => {
  const source = `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: vendor/action@0123456789abcdef0123456789abcdef01234567\n        with:\n          value: ok\n`;
  const step = workflowStepBlocks(job(source))[0]!;
  assert.equal(firstWorkflowStepField(step, 'uses')?.value.includes('vendor/action@'), true);
  assert.equal(stepNestedMapping(step, 'with').get('value'), 'ok');
});

test('parser handles a step beginning with run', () => {
  const source = `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n        shell: bash\n`;
  const step = workflowStepBlocks(job(source))[0]!;
  assert.equal(stepRunText(step), 'echo ok');
  assert.equal(firstWorkflowStepField(step, 'shell')?.value, 'bash');
});

test('comments and blank lines inside steps do not create phantom steps', () => {
  const source = `jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      # preface
      - name: One
        run: echo one

      # separator
      - name: Two
        run: echo two
`;
  assert.deepEqual(workflowStepBlocks(job(source)).map(step => stepDisplayName(step)), ['One', 'Two']);
});

test('step parsing stops when job-level sibling resumes', () => {
  const source = `jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo one
    timeout-minutes: 10
  second:
    runs-on: ubuntu-24.04
    steps:
      - run: echo two
`;
  const jobs = workflowJobBlocks(fixtureFile({ path: '.github/workflows/ci.yml', text: source }));
  assert.equal(workflowStepBlocks(jobs[0]!).length, 1);
  assert.equal(stepRunText(workflowStepBlocks(jobs[0]!)[0]!), 'echo one');
});

test('LF and CRLF produce the same step names and run bodies', () => {
  const lf = workflowStepBlocks(job(fixture)).map(step => [stepDisplayName(step), stepRunText(step)]);
  const crlf = workflowStepBlocks(job(fixture.replace(/\n/g, '\r\n'))).map(step => [stepDisplayName(step), stepRunText(step)]);
  assert.deepEqual(crlf, lf);
});
