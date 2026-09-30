import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArtifactJobLineage } from './artifact-job-lineage-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const UPLOAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const DOWNLOAD_SHA = '1111111111111111111111111111111111111111';

function audit(text: string) {
  return auditArtifactJobLineage(fixtureInventory([
    { path: '.github/workflows/ci.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(jobs: string, trigger = 'push') {
  return `name: CI
on: ${trigger}
permissions:
  contents: read
jobs:
${jobs}`;
}

function producer(job = 'build', name = 'bundle') {
  return `  ${job}:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
      - uses: actions/upload-artifact@${UPLOAD_SHA}
        with:
          name: ${name}
          path: dist/app.zip
`;
}

function consumer(needs: string, name = 'bundle', extra = '') {
  return `  consume:
${needs}    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: ${name}
          path: dist
${extra}`;
}

test('accepts a literal artifact produced by a direct needs dependency', () => {
  const result = audit(workflow(
    producer() + consumer('    needs: build\n'),
  ));

  assert.equal(result.summary.artifactProducers, 1);
  assert.equal(result.summary.sameWorkflowConsumers, 1);
  assert.equal(result.summary.lineageViolations, 0);
  assert.deepEqual(result.findings, []);
});

test('accepts a producer in transitive needs ancestry', () => {
  const result = audit(workflow(`${producer()}
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: npm test
${consumer('    needs: test\n')}`));

  assert.deepEqual(result.summary.consumers[0]?.directNeeds, ['test']);
  assert.deepEqual(result.summary.consumers[0]?.transitiveNeeds, ['build', 'test']);
  assert.deepEqual(result.findings, []);
});

test('parses inline needs lists and preserves producer ancestry', () => {
  const jobs = `${producer()}
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
${consumer('    needs: [build, lint]\n')}`;
  const result = audit(workflow(jobs));

  assert.deepEqual(result.summary.consumers[0]?.directNeeds, ['build', 'lint']);
  assert.deepEqual(result.findings, []);
});

test('parses block-list needs dependencies', () => {
  const jobs = `${producer()}
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
${consumer('    needs:\n      - build\n      - lint\n')}`;
  const result = audit(workflow(jobs));

  assert.deepEqual(result.summary.consumers[0]?.directNeeds, ['build', 'lint']);
  assert.deepEqual(result.findings, []);
});

test('flags a literal producer outside the consumer needs ancestry', () => {
  const result = audit(workflow(
    producer() + consumer(''),
  ));

  const finding = result.findings.find(item => item.id === 'ci-artifact-lineage-needs-missing');
  assert.equal(finding?.severity, 'high');
  assert.notEqual(finding?.blocking, true);
});

test('blocks missing needs when the consumer has write authority', () => {
  const text = `name: CI
on: push
permissions:
  contents: read
jobs:
${producer()}  consume:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: bundle
`;
  const result = audit(text);

  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-needs-missing' && item.blocking));
});

test('reports an unresolved same-workflow literal artifact producer', () => {
  const result = audit(workflow(
    consumer('', 'missing'),
  ));

  assert.equal(result.summary.unresolvedConsumers, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-producer-unresolved'));
});

test('blocks unresolved producer for a protected environment consumer', () => {
  const text = `name: deploy
on: push
jobs:
  consume:
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: missing
`;
  const result = audit(text);

  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-producer-unresolved' && item.blocking));
});

test('flags duplicate producer steps using the same artifact name', () => {
  const jobs = `${producer('build-a')}${producer('build-b')}
  consume:
    needs: [build-a, build-b]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: bundle
`;
  const result = audit(workflow(jobs));

  assert.equal(result.summary.ambiguousConsumers, 1);
  assert.deepEqual(result.summary.consumers[0]?.producerJobs, ['build-a', 'build-b']);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-producer-ambiguous'));
});

test('treats duplicate uploads from the same job as ambiguous lineage too', () => {
  const jobs = `  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@${UPLOAD_SHA}
        with:
          name: bundle
          path: one.zip
      - uses: actions/upload-artifact@${UPLOAD_SHA}
        with:
          name: bundle
          path: two.zip
${consumer('    needs: build\n')}`;
  const result = audit(workflow(jobs));

  assert.equal(result.summary.consumers[0]?.producerCount, 2);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-producer-ambiguous'));
});

test('flags a dynamic download selector', () => {
  const result = audit(workflow(
    producer() + consumer('    needs: build\n', '${{ inputs.artifact }}'),
  ));

  assert.equal(result.summary.consumers[0]?.dynamicSelector, true);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-dynamic-selector'));
});

test('blocks dynamic selector on a privileged consumer', () => {
  const text = `name: deploy
on: workflow_dispatch
permissions:
  contents: read
jobs:
${producer()}  consume:
    needs: build
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: \${{ inputs.artifact }}
`;
  const result = audit(text);

  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-dynamic-selector' && item.blocking));
});

test('flags omitted artifact name as a broad selector', () => {
  const result = audit(workflow(`${producer()}
  consume:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
`));

  assert.equal(result.summary.consumers[0]?.broadSelector, true);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-broad-selector'));
});

test('flags a pattern selector as broad even when it resembles one producer', () => {
  const result = audit(workflow(`${producer()}
  consume:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          pattern: bundle-*
`));

  assert.equal(result.summary.consumers[0]?.broadSelector, true);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-broad-selector'));
});

test('excludes cross-run artifact downloads from same-workflow lineage findings', () => {
  const result = audit(workflow(`  consume:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: bundle
          run-id: \${{ github.event.workflow_run.id }}
          github-token: \${{ secrets.GITHUB_TOKEN }}
`));

  assert.equal(result.summary.crossRunConsumersExcluded, 1);
  assert.deepEqual(result.findings, []);
});

test('uses default upload-artifact name when name is omitted', () => {
  const jobs = `  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@${UPLOAD_SHA}
        with:
          path: dist
  consume:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: artifact
`;
  const result = audit(workflow(jobs));

  assert.equal(result.summary.producers[0]?.artifactName, 'artifact');
  assert.deepEqual(result.findings, []);
});

test('does not match a dynamic producer name to a literal consumer', () => {
  const jobs = `${producer('build', '${{ matrix.artifact }}')}${consumer('    needs: build\n', 'bundle')}`;
  const result = audit(workflow(jobs));

  assert.equal(result.summary.producers[0]?.dynamicName, true);
  assert.equal(result.summary.unresolvedConsumers, 1);
});

test('blocks contribution-produced artifact entering a write-capable consumer', () => {
  const text = `name: PR CI
on: pull_request
permissions:
  contents: read
jobs:
${producer()}  consume:
    needs: build
    permissions:
      issues: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: bundle
`;
  const result = audit(text);

  assert.ok(result.findings.some(item => item.id === 'ci-artifact-lineage-external-to-privileged' && item.blocking));
});

test('reports needs graph cycles deterministically', () => {
  const text = workflow(`  a:
    needs: b
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
  const result = audit(text);

  const cycles = result.findings.filter(item => item.id === 'ci-artifact-lineage-needs-cycle');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles.map(item => item.location.file), ['.github/workflows/ci.yml', '.github/workflows/ci.yml']);
  assert.ok(cycles.every(item => item.blocking));
});

test('keeps same-job literal upload/download lineage self-contained', () => {
  const text = workflow(`  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@${UPLOAD_SHA}
        with:
          name: bundle
          path: dist
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          name: bundle
`);
  const result = audit(text);

  assert.equal(result.summary.consumers[0]?.producerInNeedsAncestry, true);
  assert.deepEqual(result.findings, []);
});

test('ignores similarly shaped actions outside workflow files', () => {
  const result = auditArtifactJobLineage(fixtureInventory([
    { path: 'config/ci.yml', text: `uses: actions/download-artifact@${DOWNLOAD_SHA}` },
  ] as readonly FixtureFileInput[]));

  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
