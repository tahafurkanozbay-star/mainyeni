import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCompositeActions } from './composite-action-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/actions/release/action.yml') {
  return auditCompositeActions(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

const sha = '0123456789abcdef0123456789abcdef01234567';
const header = `name: Release helper\ndescription: Safe release helper\ninputs:\n  value:\n    description: value\n    required: true\nruns:\n  using: composite\n  steps:\n`;

test('blocks composite input interpolation into run', () => {
  const result = finding(`${header}    - shell: bash\n      run: echo "\${{ inputs.value }}"\n`, 'ci-composite-shell-injection');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('blocks multiline composite input interpolation into run', () => {
  const result = finding(`${header}    - shell: bash\n      run: |\n        printf '%s\\n' "\${{ inputs.value }}"\n        npm test\n`, 'ci-composite-shell-injection');
  assert.equal(result?.blocking, true);
});

test('blocks pull request title interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.pull_request.title }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks pull request body interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.pull_request.body }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks issue title interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.issue.title }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks issue comment interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.comment.body }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks review interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.review.body }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks review comment interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.review_comment.body }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks discussion body interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: echo "\${{ github.event.discussion.body }}"\n`, 'ci-composite-shell-injection'));
});

test('blocks head ref interpolation inside composite run', () => {
  assert.ok(finding(`${header}    - shell: bash\n      run: git checkout "\${{ github.head_ref }}"\n`, 'ci-composite-shell-injection'));
});

test('accepts composite input passed as environment data', () => {
  const result = audit(`${header}    - shell: bash\n      run: printf '%s\\n' "$VALUE"\n      env:\n        VALUE: \${{ inputs.value }}\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-composite-shell-injection'), false);
});

test('accepts attacker event text passed as environment data', () => {
  const result = audit(`${header}    - shell: bash\n      run: printf '%s\\n' "$TITLE"\n      env:\n        TITLE: \${{ github.event.pull_request.title }}\n`);
  assert.deepEqual(result.findings, []);
});

test('blocks dynamic action identity from composite input', () => {
  const result = finding(`${header}    - uses: \${{ inputs.value }}\n`, 'ci-composite-dynamic-action');
  assert.equal(result?.blocking, true);
});

test('blocks expression embedded in action identity', () => {
  assert.ok(finding(`${header}    - uses: vendor/action@\${{ github.sha }}\n`, 'ci-composite-dynamic-action'));
});

test('accepts literal SHA pinned action identity', () => {
  const result = audit(`${header}    - uses: actions/checkout@${sha}\n`);
  assert.deepEqual(result.findings, []);
});

test('blocks dynamic shell selection from composite input', () => {
  assert.ok(finding(`${header}    - shell: \${{ inputs.value }}\n      run: echo ok\n`, 'ci-composite-dynamic-shell'));
});

test('blocks dynamic image selection in action metadata', () => {
  const docker = `name: Docker helper\ndescription: Docker helper\ninputs:\n  image:\n    description: image\nruns:\n  using: docker\n  image: \${{ inputs.image }}\n`;
  assert.ok(finding(docker, 'ci-composite-dynamic-container'));
});

test('blocks composite input spliced into pinned github-script source', () => {
  const text = `${header}    - uses: actions/github-script@${sha}\n      with:\n        script: |\n          const value = "\${{ inputs.value }}";\n          console.log(value);\n`;
  const result = finding(text, 'ci-composite-github-script-injection');
  assert.equal(result?.blocking, true);
});

test('blocks attacker event text spliced into pinned github-script source', () => {
  const text = `${header}    - uses: actions/github-script@${sha}\n      with:\n        script: |\n          const title = "\${{ github.event.pull_request.title }}";\n          console.log(title);\n`;
  assert.ok(finding(text, 'ci-composite-github-script-injection'));
});

test('accepts github-script reading composite input through process env', () => {
  const text = `${header}    - uses: actions/github-script@${sha}\n      env:\n        VALUE: \${{ inputs.value }}\n      with:\n        script: |\n          const value = process.env.VALUE;\n          console.log(value);\n`;
  assert.equal(audit(text).findings.some(item => item.id === 'ci-composite-github-script-injection'), false);
});

test('does not leak github-script state into a sibling step', () => {
  const text = `${header}    - uses: actions/github-script@${sha}\n      with:\n        script: |\n          console.log('safe');\n    - name: unrelated\n      with:\n        script: \${{ inputs.value }}\n      shell: bash\n      run: echo safe\n`;
  assert.equal(audit(text).findings.some(item => item.id === 'ci-composite-github-script-injection'), false);
});

test('ignores workflow yaml because workflow auditor owns that boundary', () => {
  const result = audit(`${header}    - shell: bash\n      run: echo "\${{ inputs.value }}"\n`, '.github/workflows/release.yml');
  assert.equal(result.summary.actionFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores ordinary repository yaml', () => {
  const result = audit('run: echo "${{ inputs.value }}"\n', 'config/release.yml');
  assert.equal(result.summary.actionFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores action metadata outside canonical github actions directory', () => {
  const result = audit(`${header}    - shell: bash\n      run: echo "\${{ inputs.value }}"\n`, 'tools/actions/release/action.yml');
  assert.equal(result.summary.actionFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('recognizes action.yaml extension', () => {
  const result = audit(`${header}    - shell: bash\n      run: echo "\${{ inputs.value }}"\n`, '.github/actions/release/action.yaml');
  assert.equal(result.summary.actionFiles, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-composite-shell-injection'));
});

test('reports expression counters deterministically', () => {
  const text = `${header}    - shell: \${{ inputs.value }}\n      run: echo \${{ inputs.value }}\n    - uses: vendor/action@\${{ github.sha }}\n`;
  const result = audit(text);
  assert.equal(result.summary.actionFiles, 1);
  assert.equal(result.summary.executableExpressions, 3);
  assert.equal(result.summary.actions[0]?.runExpressions, 1);
  assert.equal(result.summary.actions[0]?.dynamicShells, 1);
  assert.equal(result.summary.actions[0]?.dynamicUses, 1);
});

test('sorts findings deterministically for multiple executable boundaries', () => {
  const text = `${header}    - shell: \${{ inputs.value }}\n      run: echo \${{ inputs.value }}\n    - uses: vendor/action@\${{ github.sha }}\n`;
  const ids = audit(text).findings.map(item => item.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => left.localeCompare(right, 'en')));
});
