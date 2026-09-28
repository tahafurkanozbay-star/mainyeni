import assert from 'node:assert/strict';
import test from 'node:test';
import { auditContainerBoundaries } from './container-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function audit(text: string, path = '.github/workflows/containers.yml') {
  return auditContainerBoundaries(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

function workflow(job: string, trigger = 'push') {
  return `name: Containers
on:
  ${trigger}:
permissions:
  contents: read
jobs:
  test:
${job}
`;
}

test('accepts digest-pinned job container', () => {
  const result = audit(workflow(`    container: ghcr.io/example/build@${digest}
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.containers, 1);
  assert.equal(result.summary.mutableImages, 0);
});

test('accepts digest-pinned block-style job container', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.findings.length, 0);
});

test('flags mutable job container tag', () => {
  const finding = audit(workflow(`    container: node:24
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`)).findings.find(item => item.id === 'ci-container-mutable-image');
  assert.equal(finding?.severity, 'medium');
});

test('raises mutable image severity on external trigger', () => {
  const finding = audit(workflow(`    container: node:24
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request')).findings.find(item => item.id === 'ci-container-mutable-image');
  assert.equal(finding?.severity, 'high');
});

test('blocks event-controlled job container image', () => {
  const finding = audit(workflow(`    container: \${{ github.event.pull_request.title }}
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request')).findings.find(item => item.id === 'ci-container-untrusted-image');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks input-controlled job container image', () => {
  const result = audit(workflow(`    container:
      image: \${{ inputs.image }}
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'workflow_dispatch'));
  assert.ok(result.findings.some(item => item.id === 'ci-container-untrusted-image'));
});

test('blocks matrix-controlled container image even when matrix itself is trusted', () => {
  const result = audit(workflow(`    container: \${{ matrix.image }}
    strategy:
      matrix:
        image: [node:24]
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  const finding = result.findings.find(item => item.id === 'ci-container-dynamic-image');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('detects digest-pinned service container', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres@${digest}
    steps:
      - run: npm test`));
  assert.equal(result.summary.services, 1);
  assert.equal(result.findings.length, 0);
});

test('flags mutable service image', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres:17
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-mutable-image'));
  assert.equal(result.summary.services, 1);
});

test('handles multiple services independently', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres@${digest}
      redis:
        image: redis:7
    steps:
      - run: npm test`));
  assert.equal(result.summary.services, 2);
  assert.equal(result.findings.filter(item => item.id === 'ci-container-mutable-image').length, 1);
});

test('blocks dynamic service image', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      database:
        image: \${{ inputs.database_image }}
    steps:
      - run: npm test`, 'workflow_dispatch'));
  assert.ok(result.findings.some(item => item.id === 'ci-container-untrusted-image'));
});

test('reports missing block-style job container image', () => {
  const result = audit(workflow(`    container:
      env:
        NODE_ENV: test
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-image-missing'));
});

test('blocks privileged job container', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      options: --privileged
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  const finding = result.findings.find(item => item.id === 'ci-container-privileged');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks privileged service container', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      docker:
        image: docker@${digest}
        options: --privileged
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-privileged'));
});

test('blocks host network sharing', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      options: --network host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-host-network'));
});

test('blocks equals-form host network sharing', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      options: --network=host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-host-network'));
});

test('blocks host pid namespace sharing', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      options: --pid=host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-host-pid'));
});

test('blocks Docker socket mount in job container', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-docker-socket'));
});

test('blocks Docker socket mount in service container', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      docker:
        image: docker@${digest}
        volumes:
          - /var/run/docker.sock:/var/run/docker.sock
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-docker-socket'));
});

test('blocks host root filesystem mount', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      volumes:
        - /:/host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.ok(result.findings.some(item => item.id === 'ci-container-root-mount'));
});

test('does not confuse workspace subdirectory mount with host root mount', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      volumes:
        - ./cache:/cache
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.findings.some(item => item.id === 'ci-container-root-mount'), false);
});

test('blocks secrets in externally triggered job container', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      env:
        TOKEN: \${{ secrets.TEST_TOKEN }}
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request_target'));
  const finding = result.findings.find(item => item.id === 'ci-container-external-secret-exposure');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks secrets in externally triggered service container', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    services:
      database:
        image: postgres@${digest}
        env:
          PASSWORD: \${{ secrets.DB_PASSWORD }}
    steps:
      - run: npm test`, 'pull_request'));
  assert.ok(result.findings.some(item => item.id === 'ci-container-external-secret-exposure'));
});

test('allows secret-bearing digest-pinned container on trusted push without external finding', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/publish@${digest}
      env:
        TOKEN: \${{ secrets.RELEASE_TOKEN }}
    runs-on: ubuntu-24.04
    steps:
      - run: ./publish.sh`));
  assert.equal(result.findings.some(item => item.id === 'ci-container-external-secret-exposure'), false);
});

test('blocks external mutable privileged container combination', () => {
  const result = audit(workflow(`    container:
      image: node:24
      options: --privileged
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-container-external-mutable-host-access');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks external mutable container with Docker socket', () => {
  const result = audit(workflow(`    container:
      image: node:24
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request'));
  assert.ok(result.findings.some(item => item.id === 'ci-container-external-mutable-host-access'));
});

test('digest pin prevents mutable image finding even when host option is separately blocked', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest}
      options: --privileged
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request'));
  assert.equal(result.findings.some(item => item.id === 'ci-container-mutable-image'), false);
  assert.equal(result.findings.some(item => item.id === 'ci-container-external-mutable-host-access'), false);
  assert.ok(result.findings.some(item => item.id === 'ci-container-privileged'));
});

test('quoted digest-pinned image is recognized', () => {
  const result = audit(workflow(`    container:
      image: "ghcr.io/example/build@${digest}"
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.findings.length, 0);
});

test('digest-pinned image with comment is recognized', () => {
  const result = audit(workflow(`    container:
      image: ghcr.io/example/build@${digest} # release builder
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.findings.length, 0);
});

test('ignores ordinary docker text in shell steps', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    steps:
      - run: docker run node:24 npm test`));
  assert.equal(result.summary.containers, 0);
  assert.equal(result.summary.services, 0);
});

test('ignores non-workflow yaml container declarations', () => {
  const result = auditContainerBoundaries(fixtureInventory([
    { path: 'deploy/k8s.yml', text: workflow(`    container: node:24
    runs-on: ubuntu-24.04`) },
  ]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.findings.length, 0);
});

test('supports .yaml workflow extension', () => {
  const result = audit(workflow(`    container: node:24
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`), '.github/workflows/containers.yaml');
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.containers, 1);
});

test('summary counts dangerous runtime options', () => {
  const result = audit(workflow(`    container:
      image: node:24
      options: --privileged --network=host --pid=host
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
        - /:/host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.summary.dangerousRuntimeOptions, 5);
});

test('summary distinguishes containers and services', () => {
  const result = audit(workflow(`    container: ghcr.io/example/build@${digest}
    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres@${digest}
      redis:
        image: redis@${digest}
    steps:
      - run: npm test`));
  assert.equal(result.summary.containers, 1);
  assert.equal(result.summary.services, 2);
});

test('summary findings shares canonical array identity', () => {
  const result = audit(workflow(`    container: node:24
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`));
  assert.equal(result.summary.findings, result.findings);
});

test('finding order is deterministic', () => {
  const text = workflow(`    container:
      image: node:24
      options: --privileged --network=host
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request');
  const first = audit(text).findings.map(item => `${item.severity}:${item.id}:${item.location?.line ?? 0}`);
  const second = audit(text).findings.map(item => `${item.severity}:${item.id}:${item.location?.line ?? 0}`);
  assert.deepEqual(first, second);
});

test('CRLF and LF workflows produce the same findings and locations', () => {
  const lf = workflow(`    container:
      image: node:24
      options: --privileged
    runs-on: ubuntu-24.04
    steps:
      - run: npm test`, 'pull_request');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(
    audit(lf).findings.map(item => [item.id, item.location?.line]),
    audit(crlf).findings.map(item => [item.id, item.location?.line]),
  );
});
