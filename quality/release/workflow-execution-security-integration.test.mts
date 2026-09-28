import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReleaseContext } from './contracts.mts';
import { runReleaseEngine } from './release-engine.mts';
import { fixtureInventory } from './test-helpers.mts';

const context: ReleaseContext = {
  repository: 'owner/repo',
  branch: 'agent/security-integration',
  commit: 'deadbeef',
  generatedAt: '2026-09-28T00:00:00.000Z',
};

const workflow = `name: Unsafe execution topology
on:
  pull_request:
permissions:
  contents: write
jobs:
  test:
    runs-on: self-hosted
    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(github.event.pull_request.body) }}
    container:
      image: node:24
      options: --privileged
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
    steps:
      - run: npm test
`;

test('release engine includes runner matrix and container trust sections', async () => {
  const execution = await runReleaseEngine(fixtureInventory([
    { path: '.github/workflows/unsafe.yml', text: workflow },
  ]), context, {
    thresholds: { maxHighFindings: 1000, maxMediumFindings: 1000, maxRiskScore: 1_000_000 },
  });
  const titles = new Set(execution.report.sections.map(section => section.title));
  assert.ok(titles.has('CI runner identity and self-hosted trust-boundary audit'));
  assert.ok(titles.has('CI matrix provenance and bounded fan-out audit'));
  assert.ok(titles.has('CI container image and host-isolation boundary audit'));
});

test('release engine surfaces blocking execution-boundary finding ids', async () => {
  const execution = await runReleaseEngine(fixtureInventory([
    { path: '.github/workflows/unsafe.yml', text: workflow },
  ]), context, {
    thresholds: { maxHighFindings: 1000, maxMediumFindings: 1000, maxRiskScore: 1_000_000 },
  });
  const ids = new Set(execution.report.findings.map(finding => finding.id));
  assert.ok(ids.has('ci-self-hosted-external-trigger'));
  assert.ok(ids.has('ci-matrix-untrusted-definition'));
  assert.ok(ids.has('ci-container-privileged'));
});

test('release gate blocks explicit execution-boundary violations even with permissive thresholds', async () => {
  const execution = await runReleaseEngine(fixtureInventory([
    { path: '.github/workflows/unsafe.yml', text: workflow },
  ]), context, {
    thresholds: {
      blockOnCritical: false,
      maxHighFindings: 10_000,
      maxMediumFindings: 10_000,
      maxRiskScore: 10_000_000,
    },
  });
  assert.equal(execution.report.decision.state, 'block');
  assert.ok(execution.report.decision.blockingFindingIds.length > 0);
});

test('fixed hosted runner with bounded static matrix and digest-pinned container avoids new blockers', async () => {
  const safe = `name: Safe execution topology
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    strategy:
      max-parallel: 2
      matrix:
        node: [22, 24]
    container: node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    steps:
      - run: npm test
`;
  const execution = await runReleaseEngine(fixtureInventory([
    { path: '.github/workflows/safe.yml', text: safe },
  ]), context, {
    thresholds: { maxHighFindings: 1000, maxMediumFindings: 1000, maxRiskScore: 1_000_000 },
  });
  const ids = new Set(execution.report.findings.map(finding => finding.id));
  assert.equal(ids.has('ci-self-hosted-external-trigger'), false);
  assert.equal(ids.has('ci-matrix-untrusted-definition'), false);
  assert.equal(ids.has('ci-container-mutable-image'), false);
  assert.equal(ids.has('ci-container-privileged'), false);
});
