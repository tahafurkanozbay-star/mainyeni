import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowExpressions } from './workflow-expression-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const githubScript = 'actions/github-script@0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditWorkflowExpressions(fixtureInventory([
    { path: '.github/workflows/release-qa.yml', text },
  ] as readonly FixtureFileInput[]));
}

function ids(text: string): Set<string> {
  return new Set(audit(text).findings.map(item => item.id));
}

test('canonical workflow audit includes deployment request provenance findings', () => {
  const result = ids(`name: Release QA\non:\n  pull_request:\npermissions:\n  deployments: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${githubScript}\n        with:\n          script: |\n            await github.rest.repos.createDeployment({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              ref: '\${{ inputs.ref }}',\n              environment: 'production'\n            });\n`);
  assert.equal(result.has('ci-deployment-request-untrusted-ref'), true);
});

test('canonical workflow audit includes reusable secret inheritance findings', () => {
  const result = ids(`name: Release QA\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  release:\n    uses: vendor/automation/.github/workflows/release.yml@0123456789abcdef0123456789abcdef01234567\n    secrets: inherit\n`);
  assert.equal(result.has('ci-reusable-external-secrets-inherit'), true);
});

test('canonical workflow audit includes validation trigger integrity findings', () => {
  const result = ids(`name: Release QA\non:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test quality/release/*.test.mts\n`);
  assert.equal(result.has('ci-validation-pr-path-filter'), true);
});

test('canonical workflow audit stays clean for the new boundaries when contracts are safe', () => {
  const result = ids(`name: Release QA\non:\n  pull_request:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test quality/release/*.test.mts\n  reusable:\n    uses: ./.github/workflows/reusable.yml\n    secrets:\n      release-token: \${{ secrets.RELEASE_TOKEN }}\n`);
  assert.equal(result.has('ci-deployment-request-untrusted-ref'), false);
  assert.equal(result.has('ci-reusable-external-secrets-inherit'), false);
  assert.equal(result.has('ci-validation-pr-path-filter'), false);
});
