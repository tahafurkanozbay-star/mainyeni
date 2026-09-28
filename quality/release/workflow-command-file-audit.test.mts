import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowCommandFiles } from './workflow-command-file-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowCommandFiles(fixtureInventory([
    { path: '.github/workflows/command-files.yml', text },
  ]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('static literal GITHUB_ENV write is not reported', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "MODE=release" >> "$GITHUB_ENV"
`);
  assert.equal(result.length, 0);
});

test('event text written directly to GITHUB_ENV is blocking', () => {
  const result = finding(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "TITLE=\${{ github.event.pull_request.title }}" >> "$GITHUB_ENV"
`, 'ci-command-env-untrusted-write');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('workflow input written to ordinary GITHUB_ENV variable is high review', () => {
  const result = finding(`on:
  workflow_dispatch:
    inputs:
      channel:
        required: true
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "CHANNEL=\${{ inputs.channel }}" >> "$GITHUB_ENV"
`, 'ci-command-env-untrusted-write');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('workflow input cannot control NODE_OPTIONS through GITHUB_ENV', () => {
  const result = finding(`on:
  workflow_dispatch:
    inputs:
      options:
        required: true
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "NODE_OPTIONS=\${{ inputs.options }}" >> "$GITHUB_ENV"
`, 'ci-command-env-sensitive-taint');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('event data cannot append executable search directories to GITHUB_PATH', () => {
  const result = finding(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ github.event.pull_request.head.ref }}" >> "$GITHUB_PATH"
`, 'ci-command-path-untrusted-write');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('tainted env indirection remains tainted when written to GITHUB_ENV', () => {
  const result = finding(`on:
  issue_comment:
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      COMMENT: \${{ github.event.comment.body }}
    steps:
      - run: echo "COMMENT_COPY=$COMMENT" >> "$GITHUB_ENV"
`, 'ci-command-env-untrusted-write');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('tainted env indirection works with braced shell variables', () => {
  const result = finding(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      PR_TITLE: \${{ github.event.pull_request.title }}
    steps:
      - run: echo "TITLE=\${PR_TITLE}" >> "\${GITHUB_ENV}"
`, 'ci-command-env-untrusted-write');
  assert.ok(result);
});

test('PowerShell tainted env indirection is detected for GITHUB_OUTPUT', () => {
  const result = finding(`on:
  workflow_dispatch:
    inputs:
      value:
        required: true
jobs:
  build:
    runs-on: windows-2025
    env:
      REQUESTED_VALUE: \${{ inputs.value }}
    steps:
      - shell: pwsh
        run: '"value=$env:REQUESTED_VALUE" >> $env:GITHUB_OUTPUT'
`, 'ci-command-output-untrusted-write');
  assert.equal(result?.severity, 'medium');
});

test('event-derived step output is high severity provenance taint', () => {
  const result = finding(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "ref=\${{ github.head_ref }}" >> "$GITHUB_OUTPUT"
`, 'ci-command-output-untrusted-write');
  assert.equal(result?.severity, 'high');
});

test('untrusted step summary content is visible as evidence spoofing risk', () => {
  const result = finding(`on:
  issue_comment:
jobs:
  report:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ github.event.comment.body }}" >> "$GITHUB_STEP_SUMMARY"
`, 'ci-command-summary-untrusted-content');
  assert.equal(result?.severity, 'low');
});

test('legacy set-env command is a blocking finding', () => {
  const result = finding(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "::set-env name=MODE::release"
`, 'ci-legacy-workflow-command-dangerous');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('legacy add-path command is a blocking finding', () => {
  const result = finding(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "::add-path::/tmp/tools"
`, 'ci-legacy-workflow-command-dangerous');
  assert.equal(result?.severity, 'critical');
});

test('legacy set-output command is high severity', () => {
  const result = finding(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "::set-output name=result::ok"
`, 'ci-legacy-workflow-command-deprecated');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('legacy save-state command is medium severity', () => {
  const result = finding(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "::save-state name=result::ok"
`, 'ci-legacy-workflow-command-deprecated');
  assert.equal(result?.severity, 'medium');
});

test('untainted GITHUB_OUTPUT write remains allowed', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "digest=abc123" >> "$GITHUB_OUTPUT"
`);
  assert.equal(result.length, 0);
});

test('untainted GITHUB_PATH literal remains allowed', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "$GITHUB_WORKSPACE/tools" >> "$GITHUB_PATH"
`);
  assert.equal(result.length, 0);
});

test('taint collection does not confuse unrelated YAML keys with env variables', () => {
  const result = ids(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: \${{ github.event.pull_request.title }}
      - run: echo "MODE=release" >> "$GITHUB_ENV"
`);
  assert.equal(result.includes('ci-command-env-untrusted-write'), false);
});

test('summary exposes command-file and taint counts', () => {
  const section = audit(`on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "TITLE=\${{ github.event.pull_request.title }}" >> "$GITHUB_ENV"
      - run: echo "digest=abc" >> "$GITHUB_OUTPUT"
      - run: echo "::set-output name=legacy::yes"
`);
  assert.equal(section.summary.commandFileWrites, 2);
  assert.equal(section.summary.taintedWrites, 1);
  assert.equal(section.summary.legacyCommands, 1);
});

test('command-file audit is stable across LF and CRLF', () => {
  const source = `on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TITLE: \${{ github.event.pull_request.title }}
    steps:
      - run: echo "TITLE=$TITLE" >> "$GITHUB_ENV"
`;
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  assert.deepEqual(lf, crlf);
});
