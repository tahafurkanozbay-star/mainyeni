import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepositoryInventory, SourceFile } from './contracts.mts';
import { auditDeploymentBoundaries } from './deployment-boundary-audit.mts';

function source(repositoryPath: string, text: string): SourceFile {
  return {
    absolutePath: `/repo/${repositoryPath}`,
    repositoryPath,
    extension: '.yml',
    kind: 'yaml',
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
    text,
  };
}

function inventory(...files: SourceFile[]): RepositoryInventory {
  return {
    root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-27T00:00:00.000Z',
  };
}

const checkoutSha = '11'.repeat(20);
const downloadSha = '22'.repeat(20);

function workflow(job: string, trigger = 'push:\n    branches: [main]'): string {
  return `name: deploy\non:\n  ${trigger}\npermissions:\n  contents: read\njobs:\n${job}\n`;
}

describe('deployment boundary audit', () => {
  it('accepts a fixed protected environment deployment', () => {
    const text = workflow(`  deploy-production:\n    runs-on: ubuntu-latest\n    environment: production\n    permissions:\n      contents: read\n    steps:\n      - run: echo deploy release`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.deepEqual(section.findings, []);
    assert.equal(section.summary.deploymentJobs, 1);
    assert.equal(section.summary.protectedJobs, 1);
  });

  it('blocks privileged deployment without environment protection', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n      contents: read\n    steps:\n      - run: aws ecs update-service --cluster prod`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-missing-protected-environment' && f.blocking), true);
  });

  it('blocks dynamic environment selection for privileged deployment', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: \${{ inputs.environment }}\n    permissions:\n      id-token: write\n    steps:\n      - run: gcloud run deploy app`, 'workflow_dispatch:\n    inputs:\n      environment:\n        required: true');
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-dynamic-environment'), true);
    assert.equal(section.summary.mutableEnvironmentJobs, 1);
  });

  it('blocks privileged deployment reachable from pull_request_target', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    permissions:\n      contents: write\n    steps:\n      - run: helm upgrade app ./chart`, 'pull_request_target:');
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-untrusted-trigger-privilege' && f.severity === 'critical'), true);
  });

  it('blocks secret-bearing deployment reachable from issue_comment', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n        run: kubectl apply -f deployment.yml`, 'issue_comment:\n    types: [created]');
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-untrusted-trigger-privilege'), true);
  });

  it('blocks attacker-controlled input ref in privileged deployment', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    permissions:\n      packages: write\n    steps:\n      - uses: actions/checkout@${checkoutSha}\n        with:\n          ref: \${{ inputs.ref }}\n      - run: helm upgrade app ./chart`, 'workflow_dispatch:');
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-attacker-controlled-ref' && f.blocking), true);
  });

  it('blocks pull request head checkout in secret-bearing deployment', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/checkout@${checkoutSha}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n        run: aws lambda update-function-code --function-name app`, 'pull_request_target:');
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-privileged-pr-head-checkout'), true);
  });

  it('flags credential-shaped vars in deployment', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - env:\n          API_KEY: \${{ vars.DEPLOY_API_KEY }}\n        run: az webapp deploy --name app`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-secret-like-value-outside-secrets'), true);
  });

  it('flags downloaded deployment artifact without verification', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/download-artifact@${downloadSha}\n        with:\n          name: release\n      - run: kubectl apply -f release/deployment.yml`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.equal(section.findings.some(f => f.id === 'deployment-artifact-unverified-before-promotion'), true);
  });

  it('accepts downloaded artifact with digest verification', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/download-artifact@${downloadSha}\n      - run: sha256sum -c release.sha256\n      - run: kubectl apply -f release/deployment.yml`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.deepEqual(section.findings, []);
  });

  it('accepts downloaded artifact with GitHub attestation verification', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    environment:\n      name: production\n    steps:\n      - uses: actions/download-artifact@${downloadSha}\n      - run: gh attestation verify release.tgz --repo owner/repo\n      - run: helm upgrade app ./chart`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    assert.deepEqual(section.findings, []);
  });

  it('ignores non-workflow yaml files', () => {
    const section = auditDeploymentBoundaries(inventory(source('config/deploy.yml', 'deploy: kubectl apply -f app.yml')));
    assert.equal(section.summary.workflowFiles, 0);
    assert.deepEqual(section.findings, []);
  });

  it('does not treat ordinary build jobs as deployments', () => {
    const text = workflow(`  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/ci.yml', text)));
    assert.equal(section.summary.deploymentJobs, 0);
    assert.deepEqual(section.findings, []);
  });

  it('reports deterministic source locations', () => {
    const text = workflow(`  deploy:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: terraform apply -auto-approve`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    const finding = section.findings.find(f => f.id === 'deployment-missing-protected-environment');
    assert.equal(finding?.location?.file, '.github/workflows/deploy.yml');
    assert.ok((finding?.location?.line ?? 0) > 1);
  });

  it('keeps read-only trusted deployment finding non-critical', () => {
    const text = workflow(`  deploy-preview:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy preview`);
    const section = auditDeploymentBoundaries(inventory(source('.github/workflows/deploy.yml', text)));
    const finding = section.findings.find(f => f.id === 'deployment-missing-protected-environment');
    assert.equal(finding?.severity, 'high');
    assert.notEqual(finding?.blocking, true);
  });
});
