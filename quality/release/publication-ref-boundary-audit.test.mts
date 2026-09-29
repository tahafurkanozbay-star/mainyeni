import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPublicationRefBoundaries } from './publication-ref-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string, path = '.github/workflows/release.yml') {
  return auditPublicationRefBoundaries(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  trigger: string,
  step: string,
  options: {
    readonly permissions?: string;
    readonly environment?: string;
    readonly jobIf?: string;
  } = {},
): string {
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  const jobIf = options.jobIf ? `    if: ${options.jobIf}\n` : '';
  return `name: release\non:\n${trigger}\npermissions:\n  ${options.permissions ?? 'contents: write'}\njobs:\n  publish:\n${environment}${jobIf}    runs-on: ubuntu-24.04\n    steps:\n${step}`;
}

function run(command: string, stepIf?: string): string {
  return `      - name: publish\n${stepIf ? `        if: ${stepIf}\n` : ''}        run: ${command}\n`;
}

function action(uses: string, withBody = '', stepIf?: string): string {
  return `      - name: publish\n${stepIf ? `        if: ${stepIf}\n` : ''}        uses: ${uses}\n${withBody ? `        with:\n${withBody}` : ''}`;
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('tag-only push GitHub release is accepted', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, run('gh release create ${{ github.ref_name }} ./dist/app.zip'));
  const result = audit(source);
  assert.equal(result.summary.publicationSteps, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-publication-push-ref-unbounded'), false);
});

test('ordinary branch push publication is high review', () => {
  const source = workflow(`  push:\n    branches:\n      - main`, run('npm publish'));
  const issue = finding(source, 'ci-publication-push-ref-unbounded');
  assert.equal(issue?.severity, 'high');
});

test('push without filters publication is high review', () => {
  const source = workflow(`  push:`, run('dotnet nuget push ./pkg.nupkg'));
  assert.ok(finding(source, 'ci-publication-push-ref-unbounded'));
});

test('trusted tag condition removes unbounded push finding', () => {
  const source = workflow(`  push:`, run('npm publish'), {
    jobIf: "${{ github.ref_type == 'tag' }}",
  });
  assert.equal(audit(source).findings.some(item => item.id === 'ci-publication-push-ref-unbounded'), false);
});

test('trusted main branch condition is recognized', () => {
  const source = workflow(`  push:`, run('npm publish'), {
    jobIf: "${{ github.ref == 'refs/heads/main' }}",
  });
  assert.equal(audit(source).findings.some(item => item.id === 'ci-publication-push-ref-unbounded'), false);
});

test('pull request publication is blocking', () => {
  const source = workflow(`  pull_request:`, run('npm publish'));
  const issue = finding(source, 'ci-publication-external-trigger');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('pull_request_target publication is blocking', () => {
  const source = workflow(`  pull_request_target:`, run('gh release create v1.0.0'));
  assert.equal(finding(source, 'ci-publication-external-trigger')?.blocking, true);
});

test('issue comment publication is blocking', () => {
  const source = workflow(`  issue_comment:`, run('docker push ghcr.io/example/app:latest'), {
    permissions: 'packages: write',
  });
  assert.ok(finding(source, 'ci-publication-external-trigger'));
});

test('event-controlled release target is blocking', () => {
  const source = workflow(`  pull_request_target:`, run('gh release create ${{ github.head_ref }}'));
  const issue = finding(source, 'ci-publication-target-event-controlled');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('pull request title cannot be action release tag', () => {
  const source = workflow(`  pull_request_target:`, action(
    `softprops/action-gh-release@${sha}`,
    '          tag_name: ${{ github.event.pull_request.title }}\n',
  ));
  assert.ok(finding(source, 'ci-publication-target-event-controlled'));
});

test('manual input release tag is high review in privileged job', () => {
  const source = workflow(`  workflow_dispatch:`, action(
    `softprops/action-gh-release@${sha}`,
    '          tag_name: ${{ inputs.tag }}\n',
  ));
  const issue = finding(source, 'ci-publication-target-input-controlled');
  assert.equal(issue?.severity, 'high');
});

test('manual publication without environment is high review', () => {
  const source = workflow(`  workflow_dispatch:`, run('npm publish'));
  assert.equal(finding(source, 'ci-publication-manual-unprotected')?.severity, 'high');
});

test('manual publication with protected environment avoids manual unprotected finding', () => {
  const source = workflow(`  workflow_dispatch:`, run('npm publish'), {
    environment: 'production',
  });
  assert.equal(audit(source).findings.some(item => item.id === 'ci-publication-manual-unprotected'), false);
});

test('manual publication with trusted ref guard avoids manual unprotected finding', () => {
  const source = workflow(`  workflow_dispatch:`, run('npm publish'), {
    jobIf: "${{ github.ref == 'refs/heads/main' }}",
  });
  assert.equal(audit(source).findings.some(item => item.id === 'ci-publication-manual-unprotected'), false);
});

test('callable publication requires independent trust guard', () => {
  const source = workflow(`  workflow_call:`, run('npm publish'));
  assert.equal(finding(source, 'ci-publication-callable-unprotected')?.severity, 'high');
});

test('protected callable publication avoids unprotected finding', () => {
  const source = workflow(`  workflow_call:`, run('npm publish'), {
    environment: 'production',
  });
  assert.equal(audit(source).findings.some(item => item.id === 'ci-publication-callable-unprotected'), false);
});

test('needs output release target is high review', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, action(
    `softprops/action-gh-release@${sha}`,
    '          tag_name: ${{ needs.version.outputs.tag }}\n',
  ));
  assert.equal(finding(source, 'ci-publication-target-indirect')?.severity, 'high');
});

test('github ref name on tag-only push is not indirect target', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, action(
    `softprops/action-gh-release@${sha}`,
    '          tag_name: ${{ github.ref_name }}\n',
  ));
  assert.equal(audit(source).findings.some(item => item.id.startsWith('ci-publication-target-')), false);
});

test('detects deploy-pages action as publication', () => {
  const source = workflow(`  push:\n    branches:\n      - main`, action(`actions/deploy-pages@${sha}`), {
    permissions: 'pages: write',
    environment: 'github-pages',
  });
  const result = audit(source);
  assert.equal(result.summary.publicationSteps, 1);
  assert.equal(result.summary.signals[0]?.kind, 'pages');
});

test('detects docker build-push action only when push true', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, action(
    `docker/build-push-action@${sha}`,
    '          push: true\n          tags: ghcr.io/example/app:${{ github.ref_name }}\n',
  ), { permissions: 'packages: write' });
  assert.equal(audit(source).summary.signals[0]?.kind, 'container');
});

test('docker build action with push false is not publication', () => {
  const source = workflow(`  push:`, action(
    `docker/build-push-action@${sha}`,
    '          push: false\n',
  ));
  assert.equal(audit(source).summary.publicationSteps, 0);
});

test('detects pypi publish action', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, action(`pypa/gh-action-pypi-publish@${sha}`));
  assert.equal(audit(source).summary.signals[0]?.kind, 'package');
});

test('detects container push command', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, run('docker push ghcr.io/example/app:${{ github.ref_name }}'), {
    permissions: 'packages: write',
  });
  assert.equal(audit(source).summary.signals[0]?.kind, 'container');
});

test('detects cargo publish command', () => {
  const source = workflow(`  push:\n    tags:\n      - 'v*'`, run('cargo publish'));
  assert.equal(audit(source).summary.signals[0]?.kind, 'package');
});

test('ordinary build commands are not publication', () => {
  const source = workflow(`  pull_request:`, run('npm run build'), {
    permissions: 'contents: read',
  });
  assert.equal(audit(source).summary.publicationSteps, 0);
  assert.deepEqual(audit(source).findings, []);
});

test('summary counts manual and callable publication separately', () => {
  const manual = audit(workflow(`  workflow_dispatch:`, run('npm publish')));
  assert.equal(manual.summary.manualPublications, 1);
  assert.equal(manual.summary.callablePublications, 0);
  const callable = audit(workflow(`  workflow_call:`, run('npm publish')));
  assert.equal(callable.summary.callablePublications, 1);
});

test('non-workflow publication text is ignored', () => {
  const result = audit('run: npm publish\n', 'docs/release.yml');
  assert.equal(result.summary.workflowFiles, 0);
});

test('finding location points to publication step', () => {
  const result = audit(workflow(`  pull_request:`, run('npm publish')));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit remains stable across LF and CRLF', () => {
  const source = workflow(`  workflow_dispatch:`, action(
    `softprops/action-gh-release@${sha}`,
    '          tag_name: ${{ inputs.tag }}\n',
  ));
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
