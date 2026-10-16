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

  assert.match(workflow, /Checkout with ancestry for exact changed-file lint[\\s\\S]*?fetch-depth: 0/u);
  assert.match(step, /GITHUB_EVENT_NAME/u);
  assert.match(step, /git -C \.\. fetch --no-tags origin main/u);
  assert.match(step, /git -C \.\. merge-base "\\$MAIN_SHA" HEAD/u);
  assert.match(step, /git -C \.\. diff --name-only "\\$BASE_SHA" HEAD/u);
  assert.match(step, /npm run lint:strict --if-present/u);
  assert.match(step, /No trustworthy ancestry baseline; running full strict lint/u);
});
