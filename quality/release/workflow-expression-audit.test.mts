import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowExpressions } from './workflow-expression-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/qa.yml') {
  return auditWorkflowExpressions(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

const sha = '0123456789abcdef0123456789abcdef01234567';
const header = `name: QA\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  qa:\n    runs-on: ubuntu-latest\n    steps:\n`;

test('blocks pull request title interpolation into run', () => {
  const result = finding(`${header}      - run: echo "\${{ github.event.pull_request.title }}"\n`, 'ci-expression-shell-injection');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('blocks pull request body interpolation into multiline run', () => {
  const result = finding(`${header}      - run: |\n          printf '%s\\n' "\${{ github.event.pull_request.body }}"\n          npm test\n`, 'ci-expression-shell-injection');
  assert.equal(result?.blocking, true);
});

test('blocks head ref interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: git branch "\${{ github.head_ref }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks issue title interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.issue.title }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks issue body interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.issue.body }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks issue comment body interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.comment.body }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks review body interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.review.body }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks review comment body interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.review_comment.body }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks discussion title interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.discussion.title }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks discussion body interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.discussion.body }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks head commit message interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: echo "\${{ github.event.head_commit.message }}"\n`, 'ci-expression-shell-injection'));
});

test('blocks workflow input interpolation into shell command', () => {
  assert.ok(finding(`${header}      - run: deploy "\${{ inputs.environment }}"\n`, 'ci-expression-shell-injection'));
});

test('accepts attacker-controlled values passed as environment data', () => {
  const result = audit(`${header}      - run: printf '%s\\n' "$PR_TITLE"\n        env:\n          PR_TITLE: \${{ github.event.pull_request.title }}\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-expression-shell-injection'), false);
});

test('accepts trusted immutable pull request head sha in run', () => {
  const result = audit(`${header}      - run: git cat-file -e \${{ github.event.pull_request.head.sha }}\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-expression-shell-injection'), false);
});

test('accepts github sha in run', () => {
  const result = audit(`${header}      - run: echo \${{ github.sha }}\n`);
  assert.deepEqual(result.findings, []);
});

test('blocks dynamic action identity even for trusted sha expression', () => {
  const result = finding(`${header}      - uses: vendor/action@\${{ github.sha }}\n`, 'ci-expression-dynamic-action');
  assert.equal(result?.blocking, true);
});

test('blocks dynamic action identity from workflow input', () => {
  assert.ok(finding(`${header}      - uses: \${{ inputs.action }}\n`, 'ci-expression-dynamic-action'));
});

test('accepts literal SHA pinned action identity', () => {
  const result = audit(`${header}      - uses: actions/checkout@${sha}\n`);
  assert.deepEqual(result.findings, []);
});

test('blocks dynamic shell selection', () => {
  assert.ok(finding(`${header}      - shell: \${{ inputs.shell }}\n        run: echo ok\n`, 'ci-expression-dynamic-shell'));
});

test('blocks dynamic container image selection', () => {
  const workflow = `name: Container\non: [push]\npermissions:\n  contents: read\njobs:\n  qa:\n    runs-on: ubuntu-latest\n    container:\n      image: \${{ inputs.image }}\n    steps:\n      - run: echo ok\n`;
  assert.ok(finding(workflow, 'ci-expression-dynamic-container'));
});

test('blocks pull request title spliced into github-script source', () => {
  const workflow = `${header}      - uses: actions/github-script@${sha}\n        with:\n          script: |\n            const title = "\${{ github.event.pull_request.title }}";\n            console.log(title);\n`;
  const result = finding(workflow, 'ci-expression-github-script-injection');
  assert.equal(result?.blocking, true);
});

test('accepts github-script reading attacker data through process env', () => {
  const workflow = `${header}      - uses: actions/github-script@${sha}\n        env:\n          PR_TITLE: \${{ github.event.pull_request.title }}\n        with:\n          script: |\n            const title = process.env.PR_TITLE;\n            console.log(title);\n`;
  assert.equal(audit(workflow).findings.some(item => item.id === 'ci-expression-github-script-injection'), false);
});

test('ignores expressions in ordinary env assignments', () => {
  const result = audit(`${header}      - run: npm test\n        env:\n          MESSAGE: \${{ github.event.head_commit.message }}\n`);
  assert.deepEqual(result.findings, []);
});

test('ignores non workflow yaml', () => {
  const result = auditWorkflowExpressions(fixtureInventory([{ path: 'config/app.yml', text: 'run: echo ${{ inputs.value }}\n' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('reports executable expression counts deterministically', () => {
  const result = audit(`${header}      - run: echo \${{ github.sha }}\n      - shell: \${{ inputs.shell }}\n        run: echo ok\n      - uses: vendor/action@\${{ github.sha }}\n`);
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.executableExpressions, 3);
  assert.equal(result.summary.attackerControlledExpressions, 1);
  assert.equal(result.summary.workflows[0]?.dynamicUses, 1);
  assert.equal(result.summary.workflows[0]?.dynamicShells, 1);
});
