import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDeploymentMetadataProvenance } from './deployment-metadata-provenance-audit.mts';
import { auditWorkflowExpressions } from './workflow-expression-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function audit(body: string, trigger = 'push:\n    branches: [main]') {
  return auditDeploymentMetadataProvenance(fixtureInventory([{
    path: '.github/workflows/deploy.yml',
    text: `name: Deploy\non:\n  ${trigger}\npermissions:\n  contents: read\njobs:\n${body}`,
  }]));
}

function ids(result: ReturnType<typeof auditDeploymentMetadataProvenance>): string[] {
  return result.findings.map(item => item.id);
}

test('accepts a literal HTTPS environment URL', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: https://app.example.gov.tr/releases/current\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.environmentUrls, 1);
  assert.equal(result.summary.dynamicEnvironmentUrls, 0);
});

test('accepts a trusted deployment step output URL', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: \${{ steps.publish.outputs.url }}\n    runs-on: ubuntu-latest\n    steps:\n      - id: publish\n        run: echo "url=https://app.example.gov.tr" >> "$GITHUB_OUTPUT"\n`);

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.summary.signals[0]?.environmentUrlSources, ['steps']);
});

test('accepts a trusted needs output URL without classifying it as attacker data', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: \${{ needs.publish.outputs.url }}\n    needs: publish\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.summary.signals[0]?.environmentUrlSources, ['needs']);
});

test('accepts a repository variable based URL as reviewed configuration metadata', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: \${{ vars.PRODUCTION_URL }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.summary.signals[0]?.environmentUrlSources, ['vars']);
});

test('blocks an input-controlled environment URL', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: \${{ inputs.environment_url }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-deployment-url-untrusted-provenance'));
  const finding = result.findings.find(item => item.id === 'ci-deployment-url-untrusted-provenance');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks an event-controlled environment URL in a pull request workflow', () => {
  const result = audit(`  deploy:\n    environment:\n      name: preview\n      url: https://\${{ github.event.pull_request.head.ref }}.preview.example.test\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`, 'pull_request:');

  assert.ok(ids(result).includes('ci-deployment-url-untrusted-provenance'));
  assert.equal(result.summary.signals[0]?.externalContribution, true);
});

test('blocks github head_ref in deployment URL authority', () => {
  const result = audit(`  deploy:\n    environment:\n      name: preview\n      url: https://\${{ github.head_ref }}.preview.example.test\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`, 'pull_request:');

  assert.ok(ids(result).includes('ci-deployment-url-untrusted-provenance'));
});

test('blocks secret interpolation into environment URL metadata', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: https://deploy.example.test/?token=\${{ secrets.DEPLOY_TOKEN }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.ok(ids(result).includes('ci-deployment-url-secret-exposure'));
  assert.equal(result.findings.find(item => item.id === 'ci-deployment-url-secret-exposure')?.blocking, true);
});

test('blocks literal userinfo credentials in an environment URL', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: https://operator:password@app.example.test/dashboard\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.ok(ids(result).includes('ci-deployment-url-embedded-credentials'));
});

test('blocks dangerous URL schemes', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'vbscript:msgbox(1)']) {
    const result = audit(`  deploy:\n    environment:\n      name: production\n      url: ${value}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);
    assert.ok(ids(result).includes('ci-deployment-url-dangerous-scheme'), value);
  }
});

test('flags plaintext HTTP environment URLs as blocking on protected deployments', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: http://app.example.test\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  const finding = result.findings.find(item => item.id === 'ci-deployment-url-plaintext-http');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('reviews relative deployment URLs without treating them as code execution', () => {
  const result = audit(`  deploy:\n    environment:\n      name: staging\n      url: /deployments/latest\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  const finding = result.findings.find(item => item.id === 'ci-deployment-url-noncanonical');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('does not invent URL findings for scalar environment declarations', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.equal(result.summary.environmentUrls, 0);
  assert.deepEqual(result.findings, []);
});

test('detects untrusted gh api deployment status URL metadata', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - name: publish status\n        run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=success \\\n            -f environment_url=\${{ inputs.environment_url }}\n`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-deployment-status-untrusted-metadata'));
  assert.equal(result.summary.statusMutations, 1);
  assert.equal(result.summary.untrustedStatusMutations, 1);
});

test('allows gh api deployment status with literal success and trusted URL', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - name: publish status\n        run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=success \\\n            -f environment_url=https://app.example.test\n`);

  assert.equal(result.summary.statusMutations, 1);
  assert.equal(result.summary.untrustedStatusMutations, 0);
  assert.deepEqual(result.findings, []);
});

test('blocks secret-derived gh api status metadata', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=success \\\n            -f description=\${{ secrets.STATUS_DESCRIPTION }}\n`);

  assert.ok(ids(result).includes('ci-deployment-status-secret-metadata'));
});

test('blocks dynamic deployment status state selected by input', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=\${{ inputs.state }}\n`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-deployment-status-untrusted-metadata'));
  assert.ok(ids(result).includes('ci-deployment-status-dynamic-state'));
});

test('tracks untrusted status metadata through step env indirection', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - env:\n          DEPLOY_DESCRIPTION: \${{ github.event.pull_request.title }}\n        run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=success \\\n            -f description=process.env.DEPLOY_DESCRIPTION\n`, 'pull_request:');

  assert.ok(ids(result).includes('ci-deployment-status-untrusted-metadata'));
});

test('tracks secret status metadata through step env indirection', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - env:\n          STATUS_NOTE: \${{ secrets.STATUS_NOTE }}\n        run: |\n          gh api --method POST repos/acme/app/deployments/42/statuses \\\n            -f state=success \\\n            -f description=process.env.STATUS_NOTE\n`);

  assert.ok(ids(result).includes('ci-deployment-status-secret-metadata'));
});

test('detects attacker-controlled github-script createDeploymentStatus metadata', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567\n        with:\n          script: |\n            await github.rest.repos.createDeploymentStatus({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              deployment_id: 42,\n              state: 'success',\n              description: context.payload.pull_request.title\n            })\n`, 'pull_request:');

  assert.ok(ids(result).includes('ci-deployment-status-untrusted-metadata'));
  assert.equal(result.summary.statusMutations, 1);
});

test('detects secret-derived github-script deployment metadata through env', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567\n        env:\n          STATUS_NOTE: \${{ secrets.STATUS_NOTE }}\n        with:\n          script: |\n            await github.rest.repos.createDeploymentStatus({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              deployment_id: 42,\n              state: 'success',\n              description: process.env.STATUS_NOTE\n            })\n`);

  assert.ok(ids(result).includes('ci-deployment-status-secret-metadata'));
});

test('allows github-script deployment status with literal reviewed metadata', () => {
  const result = audit(`  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    permissions:\n      deployments: write\n    steps:\n      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567\n        with:\n          script: |\n            await github.rest.repos.createDeploymentStatus({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              deployment_id: 42,\n              state: 'success',\n              environment_url: 'https://app.example.test'\n            })\n`);

  assert.equal(result.summary.statusMutations, 1);
  assert.deepEqual(result.findings, []);
});

test('ignores gh api reads against deployment status collections', () => {
  const result = audit(`  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh api repos/acme/app/deployments/42/statuses\n`);

  assert.equal(result.summary.statusMutations, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores unrelated gh api writes', () => {
  const result = audit(`  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh api --method POST repos/acme/app/issues/42/comments -f body=ok\n`);

  assert.equal(result.summary.statusMutations, 0);
});

test('summarizes multiple deployment jobs deterministically', () => {
  const result = audit(`  deploy-a:\n    environment:\n      name: staging\n      url: https://staging.example.test\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo a\n  deploy-b:\n    environment:\n      name: production\n      url: \${{ inputs.url }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo b\n`, 'workflow_dispatch:');

  assert.equal(result.summary.deploymentJobs, 2);
  assert.equal(result.summary.environmentUrls, 2);
  assert.equal(result.summary.dynamicEnvironmentUrls, 1);
  assert.deepEqual(result.summary.signals.map(item => item.job), ['deploy-a', 'deploy-b']);
});

test('reports precise environment URL source metadata', () => {
  const result = audit(`  deploy:\n    environment:\n      name: production\n      url: https://\${{ github.repository }}-\${{ github.sha }}.example.test\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);

  assert.deepEqual(result.summary.signals[0]?.environmentUrlSources, ['github']);
  assert.deepEqual(result.findings, []);
});

test('canonical workflow expression gate includes deployment metadata findings', () => {
  const inventory = fixtureInventory([{
    path: '.github/workflows/deploy.yml',
    text: `name: Deploy\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  deploy:\n    environment:\n      name: production\n      url: \${{ inputs.environment_url }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`,
  }]);

  const result = auditWorkflowExpressions(inventory);
  assert.ok(result.findings.some(item => item.id === 'ci-deployment-url-untrusted-provenance'));
});
