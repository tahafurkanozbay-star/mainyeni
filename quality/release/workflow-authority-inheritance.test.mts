import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFile } from './test-helpers.mts';
import {
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFieldBlockText,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
} from './workflow-structure.mts';

function workflow(text: string) {
  return fixtureFile({ path: '.github/workflows/authority.yml', text });
}

function firstJob(text: string) {
  const block = workflowJobBlocks(workflow(text))[0];
  assert.ok(block);
  return block;
}

test('trigger parsing is scoped to the root on block', () => {
  const file = workflow(`name: scoped
on:
  push:
env:
  pull_request: not-a-trigger
  issue_comment: also-not-a-trigger
jobs:
  build:
    runs-on: ubuntu-24.04
`);
  const profile = workflowTriggerProfile(file);
  assert.equal(profile.push, true);
  assert.equal(profile.pullRequest, false);
  assert.equal(profile.issueComment, false);
  assert.equal(profile.externalContribution, false);
});

test('trigger parsing ignores event-shaped keys inside jobs and steps', () => {
  const file = workflow(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      pull_request_target: no
    steps:
      - name: issue_comment
        run: echo safe
`);
  const profile = workflowTriggerProfile(file);
  assert.equal(profile.push, true);
  assert.equal(profile.pullRequestTarget, false);
  assert.equal(profile.issueComment, false);
});

test('trigger parsing supports scalar, array and inline mapping forms', () => {
  const scalar = workflowTriggerProfile(workflow('on: push\njobs: {}\n'));
  assert.equal(scalar.push, true);

  const array = workflowTriggerProfile(workflow('on: [push, pull_request, merge_group]\njobs: {}\n'));
  assert.equal(array.push, true);
  assert.equal(array.pullRequest, true);
  assert.equal(array.mergeGroup, true);

  const inlineMap = workflowTriggerProfile(workflow('on: {push: {}, workflow_dispatch: {}}\njobs: {}\n'));
  assert.equal(inlineMap.push, true);
  assert.equal(inlineMap.workflowDispatch, true);
});

test('workflow_run and repository_dispatch remain explicit trigger facts', () => {
  const profile = workflowTriggerProfile(workflow(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  repository_dispatch:
    types: [promote]
jobs: {}
`));
  assert.equal(profile.workflowRun, true);
  assert.equal(profile.repositoryDispatch, true);
  assert.equal(profile.externalContribution, false);
});

test('top-level block extraction stops at the next root key', () => {
  const file = workflow(`permissions:
  contents: write
  actions: read
env:
  SAFE: yes
jobs:
  build:
    runs-on: ubuntu-24.04
`);
  const permissions = workflowTopLevelBlock(file, 'permissions');
  assert.ok(permissions);
  assert.equal(permissions?.lines.length, 2);
  assert.equal(permissions?.text.includes('SAFE'), false);
});

test('job inherits top-level write permission when it has no override', () => {
  const job = firstJob(`permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-24.04
`);
  assert.equal(jobHasWriteAuthority(job), true);
});

test('job-level read-only permissions override top-level write permission', () => {
  const job = firstJob(`permissions:
  contents: write
jobs:
  build:
    permissions:
      contents: read
    runs-on: ubuntu-24.04
`);
  assert.equal(jobHasWriteAuthority(job), false);
});

test('job-level empty permissions override inherited write permission', () => {
  const job = firstJob(`permissions: write-all
jobs:
  build:
    permissions: {}
    runs-on: ubuntu-24.04
`);
  assert.equal(jobHasWriteAuthority(job), false);
});

test('nested permission-shaped data does not become job authority', () => {
  const job = firstJob(`permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      contents: write
    steps:
      - run: echo safe
`);
  assert.equal(jobHasWriteAuthority(job), false);
});

test('workflow-level secret env is inherited by jobs', () => {
  const job = firstJob(`env:
  RELEASE_TOKEN: \${{ secrets.RELEASE_TOKEN }}
jobs:
  build:
    runs-on: ubuntu-24.04
`);
  assert.equal(jobHasSecrets(job), true);
});

test('unrelated workflow env does not mark a job secret-bearing', () => {
  const job = firstJob(`env:
  REGION: tr-central
jobs:
  build:
    runs-on: ubuntu-24.04
`);
  assert.equal(jobHasSecrets(job), false);
});

test('reusable-workflow secrets inherit marks the caller job privileged', () => {
  const job = firstJob(`on: workflow_dispatch
jobs:
  deploy:
    uses: owner/reusable/.github/workflows/deploy.yml@0123456789012345678901234567890123456789
    secrets: inherit
`);
  assert.equal(jobHasSecrets(job), true);
});

test('direct job secret expressions remain privileged', () => {
  const job = firstJob(`jobs:
  deploy:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
`);
  assert.equal(jobHasSecrets(job), true);
});

test('direct job field parsing ignores nested keys with the same name', () => {
  const job = firstJob(`jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      runs-on: attacker-controlled-label
    steps:
      - run: echo safe
`);
  const runsOn = firstWorkflowField(job, 'runs-on');
  assert.equal(runsOn?.value, 'ubuntu-24.04');
});

test('field block text remains bounded to the selected direct field', () => {
  const job = firstJob(`jobs:
  deploy:
    permissions:
      contents: write
    env:
      contents: read
    runs-on: ubuntu-24.04
`);
  const permissions = workflowFieldBlockText(job, 'permissions');
  assert.equal(permissions.includes('contents: write'), true);
  assert.equal(permissions.includes('contents: read'), false);
});

test('authority helpers are line-ending stable', () => {
  const source = `permissions:
  contents: write
env:
  TOKEN: \${{ secrets.RELEASE_TOKEN }}
jobs:
  build:
    runs-on: ubuntu-24.04
`;
  const lf = firstJob(source);
  const crlf = firstJob(source.replace(/\n/g, '\r\n'));
  assert.equal(jobHasWriteAuthority(lf), jobHasWriteAuthority(crlf));
  assert.equal(jobHasSecrets(lf), jobHasSecrets(crlf));
  assert.deepEqual(workflowTriggerProfile(lf.file), workflowTriggerProfile(crlf.file));
});
