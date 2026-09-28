import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFile, fixtureInventory } from './test-helpers.mts';
import {
  expressionSources,
  fieldWithContinuation,
  firstWorkflowField,
  hasExpression,
  hasSecretReference,
  hasUntrustedExpression,
  hasWritePermission,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  physicalLines,
  stripYamlComment,
  unquoteYamlScalar,
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
    runs-on: ubuntu-24.04
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

test('physical lines preserve offsets for LF and CRLF', () => {
  const lf = physicalLines('a\nbb\nccc');
  const crlf = physicalLines('a\r\nbb\r\nccc');
  assert.deepEqual(lf.map(line => [line.text, line.offset]), [['a', 0], ['bb', 2], ['ccc', 5]]);
  assert.deepEqual(crlf.map(line => [line.text, line.offset]), [['a', 0], ['bb', 3], ['ccc', 7]]);
});

test('physical lines handle empty and trailing-newline files', () => {
  assert.equal(physicalLines('').length, 1);
  const trailing = physicalLines('a\n');
  assert.equal(trailing.length, 2);
  assert.equal(trailing[1]?.offset, 2);
});

test('YAML comment stripping respects quoted hashes', () => {
  assert.equal(stripYamlComment('ubuntu-24.04 # runner'), 'ubuntu-24.04');
  assert.equal(stripYamlComment('"value # literal" # comment'), '"value # literal"');
  assert.equal(stripYamlComment("'value # literal' # comment"), "'value # literal'");
});

test('YAML scalar unquoting removes matching quotes and comments', () => {
  assert.equal(unquoteYamlScalar('"ubuntu-24.04" # runner'), 'ubuntu-24.04');
  assert.equal(unquoteYamlScalar("'production'"), 'production');
  assert.equal(unquoteYamlScalar('ubuntu-24.04'), 'ubuntu-24.04');
});

test('workflow file selector accepts only canonical workflow paths', () => {
  const inventory = fixtureInventory([
    { path: '.github/workflows/a.yml', text: base },
    { path: '.github/workflows/b.yaml', text: base },
    { path: '.github/actions/a/action.yml', text: base },
    { path: 'docs/a.yml', text: base },
  ]);
  assert.deepEqual(workflowFiles(inventory).map(file => file.repositoryPath), ['.github/workflows/a.yml', '.github/workflows/b.yaml']);
});

test('job parser extracts top-level jobs but not nested mappings', () => {
  const jobs = workflowJobBlocks(workflow(base));
  assert.deepEqual(jobs.map(job => job.name), ['test', 'deploy']);
  assert.equal(jobs.some(job => job.name === 'permissions'), false);
  assert.equal(jobs.some(job => job.name === 'steps'), false);
});

test('job parser returns no blocks when jobs mapping is absent', () => {
  assert.deepEqual(workflowJobBlocks(workflow('name: metadata\non: push\n')), []);
});

test('field parser returns value and source line', () => {
  const deploy = workflowJobBlocks(workflow(base))[1]!;
  const runsOn = firstWorkflowField(deploy, 'runs-on');
  assert.equal(runsOn?.value, '[self-hosted, linux, x64]');
  assert.ok((runsOn?.line ?? 0) > deploy.startLine);
});

test('block-style field continuation remains within its YAML field', () => {
  const source = `jobs:
  build:
    runs-on:
      - self-hosted
      - linux
    steps:
      - run: echo \${{ inputs.value }}
`;
  const build = workflowJobBlocks(workflow(source))[0]!;
  assert.equal(fieldWithContinuation(build, 'runs-on'), '- self-hosted - linux');
});

test('trigger profile recognizes contribution-controlled events', () => {
  for (const trigger of ['pull_request', 'pull_request_target', 'issue_comment', 'issues', 'pull_request_review', 'discussion']) {
    const profile = workflowTriggerProfile(workflow(`on:\n  ${trigger}:\njobs: {}\n`));
    assert.equal(profile.externalContribution, true, trigger);
  }
});

test('trigger profile recognizes inline arrays', () => {
  const profile = workflowTriggerProfile(workflow('on: [push, pull_request]\njobs: {}\n'));
  assert.equal(profile.push, true);
  assert.equal(profile.pullRequest, true);
});

test('scheduled workflow is not contribution-controlled by itself', () => {
  const profile = workflowTriggerProfile(workflow('on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n'));
  assert.equal(profile.schedule, true);
  assert.equal(profile.externalContribution, false);
});

test('permission helpers distinguish read-only and write authority', () => {
  assert.equal(hasWritePermission('permissions:\n  contents: read\n'), false);
  assert.equal(hasWritePermission('permissions:\n  contents: write\n'), true);
  assert.equal(hasWritePermission('permissions: write-all\n'), true);
});

test('secret helper detects GitHub secret expressions', () => {
  assert.equal(hasSecretReference('TOKEN: ${{ secrets.RELEASE_TOKEN }}'), true);
  assert.equal(hasSecretReference('TOKEN: safe'), false);
});

test('expression helpers distinguish trusted and untrusted sources', () => {
  assert.equal(hasExpression('${{ matrix.runner }}'), true);
  assert.equal(hasExpression('ubuntu-24.04'), false);
  assert.equal(hasUntrustedExpression('${{ github.event.pull_request.title }}'), true);
  assert.equal(hasUntrustedExpression('${{ inputs.runner }}'), true);
  assert.equal(hasUntrustedExpression('${{ matrix.runner }}'), false);
});

test('expression provenance is unique and deterministic', () => {
  const value = '${{ github.event.pull_request.title }}-${{ matrix.os }}-${{ needs.plan.outputs.runner }}-${{ vars.REGION }}';
  assert.deepEqual(expressionSources(value), ['github.event', 'matrix', 'needs', 'vars']);
});

test('literal deployment environment is protected while dynamic environment is not', () => {
  const literal = workflowJobBlocks(workflow(base))[1]!;
  assert.equal(jobUsesProtectedEnvironment(literal), true);
  const dynamic = workflowJobBlocks(workflow(`jobs:
  deploy:
    environment: \${{ inputs.environment }}
    runs-on: ubuntu-24.04
`))[0]!;
  assert.equal(jobUsesProtectedEnvironment(dynamic), false);
});

test('job write authority is scoped to the current job block', () => {
  const jobs = workflowJobBlocks(workflow(base));
  assert.equal(jobHasWriteAuthority(jobs[0]!), false);
  assert.equal(jobHasWriteAuthority(jobs[1]!), true);
});

test('job secrets are scoped to the current job block', () => {
  const source = `jobs:
  build:
    runs-on: ubuntu-24.04
  deploy:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
`;
  const jobs = workflowJobBlocks(workflow(source));
  assert.equal(jobHasSecrets(jobs[0]!), false);
  assert.equal(jobHasSecrets(jobs[1]!), true);
});

test('job parsing is line-stable across LF and CRLF', () => {
  const lf = workflowJobBlocks(workflow(base)).map(job => [job.name, job.startLine, job.endLine]);
  const crlf = workflowJobBlocks(workflow(base.replace(/\n/g, '\r\n'))).map(job => [job.name, job.startLine, job.endLine]);
  assert.deepEqual(lf, crlf);
});
