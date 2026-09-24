import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEBCLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(WEBCLIENT_ROOT, '..');

const WORKFLOWS = Object.freeze([
  '.github/workflows/webclient-quality.yml',
  '.github/workflows/release-evidence-contract.yml',
]);

const REVIEWED_ACTIONS = Object.freeze({
  'actions/checkout': Object.freeze({
    sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
    release: 'v7',
  }),
  'actions/setup-node': Object.freeze({
    sha: '820762786026740c76f36085b0efc47a31fe5020',
    release: 'v7',
  }),
});

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function parseActionReference(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return Object.freeze({ kind: 'invalid', value });
  if (value.startsWith('./') || value.startsWith('../')) {
    return Object.freeze({ kind: 'local', value });
  }
  if (value.startsWith('docker://')) {
    return Object.freeze({ kind: 'docker', value });
  }
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return Object.freeze({ kind: 'invalid', value });
  }
  return Object.freeze({
    kind: 'remote',
    value,
    action: value.slice(0, at),
    ref: value.slice(at + 1),
  });
}

function workflowActionReferences(text) {
  const references = [];
  const source = String(text ?? '').split(/\r?\n/);
  for (const [index, line] of source.entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/);
    if (!match) continue;
    references.push(Object.freeze({
      line: index + 1,
      comment: match[2]?.trim() ?? '',
      ...parseActionReference(match[1]),
    }));
  }
  return references;
}

function validateActionReference(reference) {
  const errors = [];
  if (reference.kind !== 'remote') {
    errors.push(`unsupported-${reference.kind}-action`);
    return errors;
  }

  const reviewed = REVIEWED_ACTIONS[reference.action];
  if (!reviewed) {
    errors.push('unreviewed-action');
    return errors;
  }

  if (!/^[0-9a-f]{40}$/i.test(reference.ref)) {
    errors.push('mutable-action-ref');
  }
  if (reference.ref !== reviewed.sha) {
    errors.push('unreviewed-action-sha');
  }
  if (reference.comment !== reviewed.release) {
    errors.push('release-provenance-mismatch');
  }
  return errors;
}

function validateWorkflowActions(text) {
  const findings = [];
  for (const reference of workflowActionReferences(text)) {
    for (const code of validateActionReference(reference)) {
      findings.push(Object.freeze({ code, line: reference.line, value: reference.value }));
    }
  }
  return findings;
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} only executes explicitly reviewed remote actions`, () => {
    const findings = validateWorkflowActions(readWorkflow(workflow));
    assert.deepEqual(findings, [], `${workflow} contains unreviewed or mutable action provenance`);
  });
}

test('accepts the reviewed checkout SHA and release provenance', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - uses: actions/checkout@${REVIEWED_ACTIONS['actions/checkout'].sha} # v7\n`,
  );
  assert.deepEqual(validateActionReference(reference), []);
});

test('accepts the reviewed setup-node SHA and release provenance', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - uses: actions/setup-node@${REVIEWED_ACTIONS['actions/setup-node'].sha} # v7\n`,
  );
  assert.deepEqual(validateActionReference(reference), []);
});

test('rejects an unknown marketplace action even when pinned to a full SHA', () => {
  const [reference] = workflowActionReferences(
    'steps:\n  - uses: attacker/looks-safe@0000000000000000000000000000000000000000 # v1\n',
  );
  assert.deepEqual(validateActionReference(reference), ['unreviewed-action']);
});

test('rejects an unknown action under the trusted actions organization', () => {
  const [reference] = workflowActionReferences(
    'steps:\n  - uses: actions/cache@0000000000000000000000000000000000000000 # v4\n',
  );
  assert.deepEqual(validateActionReference(reference), ['unreviewed-action']);
});

test('rejects a mutable major tag for an otherwise reviewed action', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: actions/checkout@v7 # v7\n');
  assert.deepEqual(validateActionReference(reference), ['mutable-action-ref', 'unreviewed-action-sha']);
});

test('rejects a branch reference for an otherwise reviewed action', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: actions/setup-node@main # v7\n');
  assert.deepEqual(validateActionReference(reference), ['mutable-action-ref', 'unreviewed-action-sha']);
});

test('rejects an abbreviated commit SHA', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: actions/checkout@3d3c42e5 # v7\n');
  assert.deepEqual(validateActionReference(reference), ['mutable-action-ref', 'unreviewed-action-sha']);
});

test('rejects a different full SHA for a reviewed action', () => {
  const [reference] = workflowActionReferences(
    'steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000 # v7\n',
  );
  assert.deepEqual(validateActionReference(reference), ['unreviewed-action-sha']);
});

test('rejects a misleading release comment for the reviewed SHA', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - uses: actions/checkout@${REVIEWED_ACTIONS['actions/checkout'].sha} # v99\n`,
  );
  assert.deepEqual(validateActionReference(reference), ['release-provenance-mismatch']);
});

test('rejects a reviewed SHA with no release provenance comment', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - uses: actions/setup-node@${REVIEWED_ACTIONS['actions/setup-node'].sha}\n`,
  );
  assert.deepEqual(validateActionReference(reference), ['release-provenance-mismatch']);
});

test('rejects docker actions because image digest provenance is not reviewed here', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: docker://node:24\n');
  assert.deepEqual(validateActionReference(reference), ['unsupported-docker-action']);
});

test('rejects local composite actions until their transitive provenance is audited', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: ./.github/actions/build\n');
  assert.deepEqual(validateActionReference(reference), ['unsupported-local-action']);
});

test('rejects parent-relative local action references', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: ../shared/action\n');
  assert.deepEqual(validateActionReference(reference), ['unsupported-local-action']);
});

test('rejects malformed remote references without an at-sign', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: actions/checkout\n');
  assert.deepEqual(validateActionReference(reference), ['unsupported-invalid-action']);
});

test('rejects malformed remote references with an empty ref', () => {
  const [reference] = workflowActionReferences('steps:\n  - uses: actions/checkout@\n');
  assert.deepEqual(validateActionReference(reference), ['unsupported-invalid-action']);
});

test('parser isolates the release comment from the action ref', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - uses: actions/checkout@${REVIEWED_ACTIONS['actions/checkout'].sha} # v7\n`,
  );
  assert.equal(reference.ref, REVIEWED_ACTIONS['actions/checkout'].sha);
  assert.equal(reference.comment, 'v7');
});

test('parser supports named action steps without swallowing the step name', () => {
  const [reference] = workflowActionReferences(
    `steps:\n  - name: Checkout\n    uses: actions/checkout@${REVIEWED_ACTIONS['actions/checkout'].sha} # v7\n`,
  );
  assert.equal(reference.action, 'actions/checkout');
  assert.equal(reference.line, 3);
});

test('validator reports every unreviewed action in a workflow', () => {
  const findings = validateWorkflowActions(
    'steps:\n  - uses: evil/one@0000000000000000000000000000000000000000 # v1\n  - uses: evil/two@1111111111111111111111111111111111111111 # v1\n',
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.code), ['unreviewed-action', 'unreviewed-action']);
});

test('validator remains fail-closed when reviewed and unreviewed actions are mixed', () => {
  const findings = validateWorkflowActions(
    `steps:\n  - uses: actions/checkout@${REVIEWED_ACTIONS['actions/checkout'].sha} # v7\n  - uses: evil/post-checkout@2222222222222222222222222222222222222222 # v1\n`,
  );
  assert.deepEqual(findings.map((finding) => finding.code), ['unreviewed-action']);
});
