import assert from 'node:assert/strict';
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
