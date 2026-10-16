import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fixtureFile } from './test-helpers.mts';
import {
  blockScalarLines,
  fieldWithContinuation,
  firstWorkflowField,
  workflowJobBlocks,
} from './workflow-structure.mts';

function job(text: string) {
  const file = fixtureFile({ path: '.github/workflows/ci.yml', text });
  const block = workflowJobBlocks(file)[0];
  assert.ok(block);
  return block;
}

test('block scalar continuation stops at the first sibling key', () => {
  const block = job(`jobs:
  build:
    runs-on:
      - self-hosted
      - linux
    steps:
      - run: echo \${{ inputs.untrusted }}
`);
  const field = firstWorkflowField(block, 'runs-on');
  assert.ok(field);
  assert.deepEqual(blockScalarLines(block, field).map(line => line.trimmed), ['- self-hosted', '- linux']);
  assert.equal(fieldWithContinuation(block, 'runs-on'), '- self-hosted - linux');
  assert.equal(/inputs\.untrusted/.test(fieldWithContinuation(block, 'runs-on')), false);
});

test('block scalar continuation ignores blank lines but retains nested values', () => {
  const block = job(`jobs:
  build:
    runs-on:

      - self-hosted
      - linux

    timeout-minutes: 20
`);
  assert.equal(fieldWithContinuation(block, 'runs-on'), '- self-hosted - linux');
});

test('block scalar continuation does not absorb a later strategy block', () => {
  const block = job(`jobs:
  build:
    runs-on:
      - ubuntu-24.04
    strategy:
      matrix:
        runner: [self-hosted]
`);
  assert.equal(fieldWithContinuation(block, 'runs-on'), '- ubuntu-24.04');
});

test('block scalar continuation preserves CRLF behavior', () => {
  const source = `jobs:
  build:
    runs-on:
      - self-hosted
      - linux
    steps:
      - run: echo test
`;
  const lf = fieldWithContinuation(job(source), 'runs-on');
  const crlf = fieldWithContinuation(job(source.replace(/\n/g, '\r\n')), 'runs-on');
  assert.equal(lf, crlf);
});

test('first-push strict lint baseline is ancestry-aware and fails closed to full validation', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release-qa.yml'), 'utf8');
  const start = workflow.indexOf('name: Strict lint on changed Webclient sources');
  const end = workflow.indexOf('name: Full TypeScript diagnostic visibility', start);
  assert.ok(start >= 0 && end > start, 'strict lint workflow step must remain present');
  const step = workflow.slice(start, end);

  const baselineScript = readFileSync(
    resolve(process.cwd(), 'Webclient.app/scripts/resolve-changed-lint-baseline.sh'),
    'utf8',
  );
  assert.ok(step.includes('bash scripts/resolve-changed-lint-baseline.sh "$GITHUB_EVENT_NAME" "$GITHUB_REF"'));
  assert.ok(baselineScript.includes('set -euo pipefail'));
  assert.ok(baselineScript.includes('git -C .. fetch --no-tags --unshallow origin "$github_ref"'));
  assert.ok(baselineScript.includes('git -C .. merge-base "$main_sha" HEAD'));
  assert.ok(baselineScript.includes('git -C .. merge-base --is-ancestor'));
  assert.ok(baselineScript.includes('npm run lint:strict --if-present >&2'));
  assert.ok(baselineScript.includes('git -C .. rev-parse HEAD'));
  assert.equal(baselineScript.includes('exit 0'), false);
  assert.equal(baselineScript.includes('set +e'), false);
  assert.equal(baselineScript.includes('|| true'), false);
});
