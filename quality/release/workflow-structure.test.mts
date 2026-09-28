import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFile, fixtureInventory } from './test-helpers.mts';
import {
  blockScalarLines,
  expressionSources,
  fieldWithContinuation,
  firstWorkflowField,
  hasExpression,
  hasSecretReference,
  hasUntrustedExpression,
  hasWritePermission,
  indentation,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  physicalLines,
  stripYamlComment,
  unquoteYamlScalar,
  workflowFields,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
} from './workflow-structure.mts';

function workflow(text: string, path = '.github/workflows/ci.yml') {
  return fixtureFile({ path, text });
}

const base = `name: CI
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: npm test
  deploy:
    permissions:
      contents: write
    environment: production
    runs-on: [self-hosted, linux, x64]
    steps:
      - run: echo deploy
`;

test('physicalLines preserves offsets while normalizing LF terminators', () => {
  const lines = physicalLines('a\nbb\nccc');
  assert.deepEqual(lines.map(line => line.text), ['a', 'bb', 'ccc']);
  assert.deepEqual(lines.map(line => line.offset), [0, 2, 5]);
  assert.deepEqual(lines.map(line => line.line), [1, 2, 3]);
});

test('physicalLines normalizes CRLF without corrupting offsets', () => {
  const lines = physicalLines('a\r\nbb\r\nccc');
  assert.deepEqual(lines.map(line => line.text), ['a', 'bb', 'ccc']);
  assert.deepEqual(lines.map(line => line.offset), [0, 3, 7]);
});

test('physicalLines represents trailing newline deterministically', () => {
  const lines = physicalLines('a\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.line, 2);
  assert.equal(lines[1]?.offset, 2);
});

test('physicalLines handles empty files', () => {
  assert.deepEqual(physicalLines(''), [{ text: '', offset: 0, line: 1, indent: 0, trimmed: '' }]);
});

test('indentation measures leading spaces', () => {
  assert.equal(indentation('    runs-on: ubuntu-latest'), 4);
  assert.equal(indentation('runs-on: ubuntu-latest'), 0);
});

test('stripYamlComment removes unquoted comments', () => {
  assert.equal(stripYamlComment('ubuntu-latest # hosted runner'), 'ubuntu-latest');
});

test('stripYamlComment preserves hashes inside single quotes', () => {
  assert.equal(stripYamlComment("'value # literal' # comment"), "'value # literal'");
});

test('stripYamlComment preserves hashes inside double quotes', () => {
  assert.equal(stripYamlComment('"value # literal" # comment'), '"value # literal"');
});

test('stripYamlComment respects escaped quotes', () => {
  assert.equal(stripYamlComment('"value \\"quoted\\" # literal" # comment'), '"value \\"quoted\\" # literal"');
});

test('unquoteYamlScalar removes matching quotes only', () => {
  assert.equal(unquoteYamlScalar('"ubuntu-latest" # comment'), 'ubuntu-latest');
  assert.equal(unquoteYamlScalar("'production'"), 'production');
  assert.equal(unquoteYamlScalar('ubuntu-latest'), 'ubuntu-latest');
});

test('workflowFiles includes only canonical workflow yaml paths', () => {
  const inventory = fixtureInventory([
    { path: '.github/workflows/ci.yml', text: base },
    { path: '.github/workflows/release.yaml', text: base },
    { path: '.github/actions/build/action.yml', text: base },
    { path: 'docs/workflow.yml', text: base },
  ]);
  assert.deepEqual(workflowFiles(inventory).map(file => file.repositoryPath), [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yaml',
  ]);
});

test('workflowJobBlocks extracts top-level jobs and boundaries', () => {
  const jobs = workflowJobBlocks(workflow(base));
  assert.deepEqual(jobs.map(job => job.name), ['test', 'deploy']);
  assert.equal(jobs[0]?.startLine, 9);
  assert.ok((jobs[0]?.endLine ?? 0) < (jobs[1]?.startLine ?? 0));
});

test('workflowJobBlocks ignores nested mapping keys as jobs', () => {
  const jobs = workflowJobBlocks(workflow(base));
  assert.equal(jobs.some(job => job.name === 'steps'), false);
  assert.equal(jobs.some(job => job.name === 'permissions'), false);
});

test('workflowJobBlocks returns empty when jobs mapping is absent', () => {
  assert.deepEqual(workflowJobBlocks(workflow('name: metadata\non: push\n')), []);
});

test('workflowJobBlocks handles comments and blank lines before first job', () => {
  const text = `name: CI
on: push
jobs:
  # comment

  build:
    runs-on: ubuntu-latest
`;
  assert.deepEqual(workflowJobBlocks(workflow(text)).map(job => job.name), ['build']);
});

test('workflowFields reads scalar fields with locations', () => {
  const deploy = workflowJobBlocks(workflow(base))[1]!;
  const field = firstWorkflowField(deploy, 'runs-on');
  assert.equal(field?.value, '[self-hosted, linux, x64]');
  assert.equal(field?.line, 20);
  assert.ok((field?.offset ?? -1) > 0);
});

test('workflowFields supports quoted field values and comments', () => {
  const text = `jobs:
  build:
    runs-on: "ubuntu-24.04" # pinned image
`;
  const build = workflowJobBlocks(workflow(text))[0]!;
  assert.equal(firstWorkflowField(build, 'runs-on')?.value, 'ubuntu-24.04');
});

test('workflowFields returns every matching nested field', () => {
  const text = `jobs:
  build:
    env:
      TARGET: one
    steps:
      - name: first
        env:
          TARGET: two
`;
  const build = workflowJobBlocks(workflow(text))[0]!;
  assert.equal(workflowFields(build, 'TARGET').length, 2);
});

test('blockScalarLines returns indented continuation lines', () => {
  const text = `jobs:
  build:
    runs-on:
      - self-hosted
      - linux
    steps:
      - run: true
`;
  const build = workflowJobBlocks(workflow(text))[0]!;
  const runsOn = firstWorkflowField(build, 'runs-on')!;
  assert.deepEqual(blockScalarLines(build, runsOn).slice(0, 2).map(line => line.trimmed), ['- self-hosted', '- linux']);
});

test('fieldWithContinuation combines block-style lists', () => {
  const text = `jobs:
  build:
    runs-on:
      - self-hosted
      - linux
`;
  const build = workflowJobBlocks(workflow(text))[0]!;
  assert.equal(fieldWithContinuation(build, 'runs-on'), '- self-hosted - linux');
});

test('workflowTriggerProfile detects pull request and dispatch triggers', () => {
  const profile = workflowTriggerProfile(workflow(base));
  assert.equal(profile.pullRequest, true);
  assert.equal(profile.workflowDispatch, true);
  assert.equal(profile.externalContribution, true);
});

test('workflowTriggerProfile detects inline trigger arrays', () => {
  const profile = workflowTriggerProfile(workflow('on: [push, pull_request]\njobs: {}\n'));
  assert.equal(profile.push, true);
  assert.equal(profile.pullRequest, true);
});

test('workflowTriggerProfile treats issue and review events as external', () => {
  for (const trigger of ['issue_comment', 'issues', 'pull_request_review', 'discussion']) {
    const profile = workflowTriggerProfile(workflow(`on:\n  ${trigger}:\njobs: {}\n`));
    assert.equal(profile.externalContribution, true, trigger);
  }
});

test('workflowTriggerProfile distinguishes trusted scheduled workflows', () => {
  const profile = workflowTriggerProfile(workflow('on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n'));
  assert.equal(profile.schedule, true);
  assert.equal(profile.externalContribution, false);
});

test('hasWritePermission recognizes named write scopes', () => {
  assert.equal(hasWritePermission('permissions:\n  contents: write\n'), true);
  assert.equal(hasWritePermission('permissions:\n  contents: read\n'), false);
});

test('hasWritePermission recognizes write-all', () => {
  assert.equal(hasWritePermission('permissions: write-all\n'), true);
});

test('hasSecretReference finds workflow secret expressions', () => {
  assert.equal(hasSecretReference('TOKEN: ${{ secrets.RELEASE_TOKEN }}'), true);
  assert.equal(hasSecretReference('TOKEN: safe'), false);
});

test('expression helpers classify executable expressions', () => {
  assert.equal(hasExpression('${{ matrix.runner }}'), true);
  assert.equal(hasExpression('ubuntu-24.04'), false);
  assert.equal(hasUntrustedExpression('${{ github.event.pull_request.title }}'), true);
  assert.equal(hasUntrustedExpression('${{ inputs.runner }}'), true);
  assert.equal(hasUntrustedExpression('${{ matrix.runner }}'), false);
});

test('expressionSources returns deterministic distinct provenance', () => {
  const sources = expressionSources('${{ github.event.pull_request.title }}-${{ matrix.os }}-${{ needs.plan.outputs.runner }}-${{ vars.REGION }}');
  assert.deepEqual(sources, ['github.event', 'matrix', 'needs', 'vars']);
});

test('jobUsesProtectedEnvironment accepts literal environment names', () => {
  const deploy = workflowJobBlocks(workflow(base))[1]!;
  assert.equal(jobUsesProtectedEnvironment(deploy), true);
});

test('jobUsesProtectedEnvironment rejects dynamic environment names', () => {
  const text = `jobs:
  deploy:
    environment: ${{ inputs.environment }}
    runs-on: ubuntu-latest
`;
  const deploy = workflowJobBlocks(workflow(text))[0]!;
  assert.equal(jobUsesProtectedEnvironment(deploy), false);
});

test('jobHasWriteAuthority scopes permissions inside the job block', () => {
  const jobs = workflowJobBlocks(workflow(base));
  assert.equal(jobHasWriteAuthority(jobs[0]!), false);
  assert.equal(jobHasWriteAuthority(jobs[1]!), true);
});

test('jobHasSecrets scopes secret usage inside the job block', () => {
  const text = `jobs:
  build:
    runs-on: ubuntu-latest
  deploy:
    runs-on: ubuntu-latest
    env:
      TOKEN: ${{ secrets.RELEASE_TOKEN }}
`;
  const jobs = workflowJobBlocks(workflow(text));
  assert.equal(jobHasSecrets(jobs[0]!), false);
  assert.equal(jobHasSecrets(jobs[1]!), true);
});

test('parser remains deterministic across LF and CRLF', () => {
  const lf = workflowJobBlocks(workflow(base));
  const crlf = workflowJobBlocks(workflow(base.replace(/\n/g, '\r\n')));
  assert.deepEqual(lf.map(job => ({ name: job.name, start: job.startLine, end: job.endLine })), crlf.map(job => ({ name: job.name, start: job.startLine, end: job.endLine })));
});
