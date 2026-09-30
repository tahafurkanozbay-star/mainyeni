import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDeploymentRequestProvenance } from './deployment-request-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const githubScript = 'actions/github-script@0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditDeploymentRequestProvenance(fixtureInventory([
    { path: '.github/workflows/deploy.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(step: string, options: { trigger?: string; permissions?: string; environment?: string } = {}): string {
  const trigger = options.trigger ?? 'push:\n    branches: [main]';
  const permissions = options.permissions ?? 'contents: read\n  deployments: write';
  const environment = options.environment ? `\n    environment: ${options.environment}` : '';
  return `name: deploy\non:\n  ${trigger}\npermissions:\n  ${permissions.replace(/\n/g, '\n  ')}\njobs:\n  deploy:\n    runs-on: ubuntu-latest${environment}\n    steps:\n${step}`;
}

function script(body: string, env = ''): string {
  return `      - name: deployment request\n        uses: ${githubScript}\n${env ? `        env:\n${env}` : ''}        with:\n          script: |\n${body.split('\n').map(line => `            ${line}`).join('\n')}\n`;
}

function cli(command: string, env = ''): string {
  return `      - name: deployment request\n${env ? `        env:\n${env}` : ''}        run: |\n          ${command}\n`;
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

test('accepts a github-script deployment bound to github.sha and literal metadata', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  task: 'deploy',\n  environment: 'production',\n  auto_merge: false,\n  production_environment: true\n});`)));
  assert.equal(result.summary.deploymentRequests, 1);
  assert.equal(result.summary.githubScriptRequests, 1);
  assert.equal(result.summary.ghApiRequests, 0);
  assert.equal(result.findings.some(item => item.blocking), false);
});

test('blocks a deployment request without an explicit ref', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  environment: 'production'\n});`)));
  const finding = result.findings.find(item => item.id === 'ci-deployment-request-missing-ref');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks pull request input as deployment ref', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.event.pull_request.head.sha }}',\n  environment: 'production'\n});`), { trigger: 'pull_request:' }));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-untrusted-ref' && item.blocking));
});

test('reviews needs output used as deployment ref', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ needs.build.outputs.sha }}',\n  environment: 'production'\n});`)));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-indirect-ref-review'));
});

test('blocks secret-derived deployment metadata', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  payload: '\${{ secrets.DEPLOY_TOKEN }}'\n});`)));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-secret-payload' && item.blocking));
});

test('blocks attacker-controlled deployment environment metadata', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  environment: '\${{ inputs.environment }}'\n});`), { trigger: 'workflow_dispatch:' }));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-untrusted-metadata' && item.blocking));
});

test('rejects an opaque nonliteral environment identity', () => {
  const result = audit(workflow(script(`const environment = chooseEnvironment();\nawait github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  environment\n});`)));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-opaque-environment'));
});

test('rejects dynamic deployment task identity', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  task: process.env.DEPLOY_TASK,\n  environment: 'production'\n});`, '          DEPLOY_TASK: deploy\n')));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-opaque-task'));
});

test('blocks untrusted required-context guard selection', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  required_contexts: '\${{ inputs.required_contexts }}'\n});`), { trigger: 'workflow_dispatch:' }));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-untrusted-guard' && item.blocking));
});

test('blocks explicit empty required contexts bypass', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  required_contexts: []\n});`)));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-required-contexts-bypass' && item.blocking));
  assert.equal(result.summary.requiredContextBypasses, 1);
});

test('blocks deployment creation from external contribution with write authority', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  environment: 'preview'\n});`), { trigger: 'pull_request:' }));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-external-write-authority' && item.blocking));
});

test('detects gh api deployment requests', () => {
  const result = audit(workflow(cli(`gh api --method POST repos/owner/repo/deployments -f ref='\${{ github.sha }}' -f environment=production -F auto_merge=false`)));
  assert.equal(result.summary.deploymentRequests, 1);
  assert.equal(result.summary.ghApiRequests, 1);
  assert.equal(result.summary.githubScriptRequests, 0);
});

test('blocks untrusted shell env ref passed to gh api', () => {
  const result = audit(workflow(cli(
    'gh api --method POST repos/owner/repo/deployments -f ref=$TARGET_SHA -f environment=production',
    '          TARGET_SHA: \${{ github.event.pull_request.head.sha }}\n',
  ), { trigger: 'pull_request:' }));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-untrusted-ref'));
});

test('blocks secret shell env persisted as gh api payload', () => {
  const result = audit(workflow(cli(
    'gh api --method POST repos/owner/repo/deployments -f ref=$GITHUB_SHA -f payload=$DEPLOY_PAYLOAD',
    '          DEPLOY_PAYLOAD: \${{ secrets.DEPLOY_PAYLOAD }}\n          GITHUB_SHA: \${{ github.sha }}\n',
  )));
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-request-secret-payload'));
});

test('does not treat a deployment status endpoint as a deployment creation request', () => {
  const result = audit(workflow(cli(`gh api --method POST repos/owner/repo/deployments/123/statuses -f state=success`)));
  assert.equal(result.summary.deploymentRequests, 0);
});

test('does not treat an ordinary github script call as deployment creation', () => {
  const result = audit(workflow(script(`await github.rest.issues.createComment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  issue_number: 1,\n  body: 'done'\n});`)));
  assert.equal(result.summary.deploymentRequests, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow yaml documents', () => {
  const result = auditDeploymentRequestProvenance(fixtureInventory([
    { path: 'config/deploy.yml', text: `jobs:\n  deploy:\n    steps:\n      - run: gh api --method POST repos/o/r/deployments -f ref=main\n` },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.summary.deploymentRequests, 0);
});

test('tracks multiple deployment requests independently', () => {
  const text = workflow(`${script(`await github.rest.repos.createDeployment({ owner: context.repo.owner, repo: context.repo.repo, ref: '\${{ github.sha }}', environment: 'staging' });`)}${cli(`gh api --method POST repos/owner/repo/deployments -f ref='\${{ github.sha }}' -f environment=production`)}`);
  const result = audit(text);
  assert.equal(result.summary.deploymentRequests, 2);
  assert.equal(result.summary.githubScriptRequests, 1);
  assert.equal(result.summary.ghApiRequests, 1);
});

test('records deployment signal location and privilege facts', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  environment: 'production'\n});`), { environment: 'production' }));
  const signal = result.summary.signals[0];
  assert.equal(signal?.writeAuthority, true);
  assert.equal(signal?.protectedEnvironment, true);
  assert.ok((signal?.line ?? 0) > 0);
});

test('keeps literal production and transient flags reviewable', () => {
  const result = audit(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ github.sha }}',\n  environment: 'staging',\n  transient_environment: false,\n  production_environment: false,\n  auto_merge: false\n});`)));
  const badIds = new Set(['ci-deployment-request-untrusted-guard', 'ci-deployment-request-required-contexts-bypass']);
  assert.equal(result.findings.some(item => badIds.has(item.id)), false);
});

test('reports summary counts for untrusted and secret-bearing requests', () => {
  const text = workflow(`${script(`await github.rest.repos.createDeployment({ owner: context.repo.owner, repo: context.repo.repo, ref: '\${{ inputs.ref }}', environment: 'preview' });`)}${script(`await github.rest.repos.createDeployment({ owner: context.repo.owner, repo: context.repo.repo, ref: '\${{ github.sha }}', payload: '\${{ secrets.PAYLOAD }}' });`)}`, { trigger: 'workflow_dispatch:' });
  const result = audit(text);
  assert.equal(result.summary.deploymentRequests, 2);
  assert.ok(result.summary.untrustedRequests >= 1);
  assert.ok(result.summary.secretBearingRequests >= 1);
});

test('finding ids remain stable for the principal deployment request threats', () => {
  const resultIds = new Set(ids(workflow(script(`await github.rest.repos.createDeployment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: '\${{ inputs.ref }}',\n  payload: '\${{ secrets.PAYLOAD }}',\n  required_contexts: []\n});`), { trigger: 'workflow_dispatch:' })));
  assert.equal(resultIds.has('ci-deployment-request-untrusted-ref'), true);
  assert.equal(resultIds.has('ci-deployment-request-secret-payload'), true);
  assert.equal(resultIds.has('ci-deployment-request-required-contexts-bypass'), true);
});
