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

const TRUSTED_ACTIONS = Object.freeze({
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

function lines(text) {
  return text.split(/\r?\n/);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function actionBlocks(text) {
  const source = lines(text);
  const blocks = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const actionMatch = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/);
    if (!actionMatch) continue;

    const usesIndent = indentation(line);
    const start = index;
    let end = source.length;

    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const candidate = source[cursor];
      if (!candidate.trim()) continue;
      const candidateIndent = indentation(candidate);
      if (candidateIndent < usesIndent) {
        end = cursor;
        break;
      }
      if (candidateIndent === usesIndent && /^\s*(?:-|uses:|run:|name:)/.test(candidate)) {
        end = cursor;
        break;
      }
    }

    const [ownerRepo, ref = ''] = actionMatch[1].split('@');
    blocks.push(Object.freeze({
      line: start + 1,
      ownerRepo,
      ref,
      comment: actionMatch[2]?.trim() ?? '',
      text: source.slice(start, end).join('\n'),
    }));
  }

  return blocks;
}

function checkoutBlocks(text) {
  return actionBlocks(text).filter((block) => block.ownerRepo === 'actions/checkout');
}

function topLevelPermissionsAreReadOnly(text) {
  const source = lines(text);
  const permissionsIndex = source.findIndex((line) => /^permissions:\s*$/.test(line));
  if (permissionsIndex < 0) return false;

  let sawContentsRead = false;
  for (let index = permissionsIndex + 1; index < source.length; index += 1) {
    const line = source[index];
    if (!line.trim()) continue;
    if (indentation(line) === 0) break;
    if (/^\s+contents:\s*read\s*$/.test(line)) sawContentsRead = true;
    if (/^\s+contents:\s*(?:write|write-all)\s*$/.test(line)) return false;
  }
  return sawContentsRead;
}

function actionUsesFullCommitSha(block) {
  return /^[0-9a-f]{40}$/i.test(block.ref);
}

function actionMatchesTrustedProvenance(block) {
  const trusted = TRUSTED_ACTIONS[block.ownerRepo];
  if (!trusted) return true;
  return block.ref === trusted.sha && block.comment === trusted.release;
}

function checkoutDisablesCredentialPersistence(block) {
  return /^\s*persist-credentials:\s*false\s*$/m.test(block.text);
}

function checkoutDoesNotRequestWriteToken(block) {
  return !/^\s*token:\s*(?!['"]?\s*['"]?\s*$).+/m.test(block.text);
}

function setupNodeUsesRequiredRuntime(block) {
  return /^\s*node-version:\s*(?:['"]?24['"]?)\s*$/m.test(block.text);
}

function setupNodeCacheIsLockfileScoped(block) {
  if (!/^\s*cache:\s*npm\s*$/m.test(block.text)) return true;
  return /^\s*cache-dependency-path:\s*Webclient\.app\/package-lock\.json\s*$/m.test(block.text);
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} keeps top-level repository contents read-only`, () => {
    const text = readWorkflow(workflow);
    assert.equal(
      topLevelPermissionsAreReadOnly(text),
      true,
      `${workflow} must declare top-level permissions with contents: read`,
    );
  });

  test(`${workflow} has at least one checkout step`, () => {
    const blocks = checkoutBlocks(readWorkflow(workflow));
    assert.ok(blocks.length > 0, `${workflow} unexpectedly has no actions/checkout step`);
  });

  test(`${workflow} disables persisted credentials on every checkout`, () => {
    const blocks = checkoutBlocks(readWorkflow(workflow));
    for (const block of blocks) {
      assert.equal(
        checkoutDisablesCredentialPersistence(block),
        true,
        `${workflow}:${block.line} must set persist-credentials: false`,
      );
    }
  });

  test(`${workflow} pins every third-party action to a full commit SHA`, () => {
    const blocks = actionBlocks(readWorkflow(workflow));
    for (const block of blocks) {
      assert.equal(
        actionUsesFullCommitSha(block),
        true,
        `${workflow}:${block.line} ${block.ownerRepo} must use an immutable 40-character commit SHA`,
      );
    }
  });

  test(`${workflow} keeps trusted action SHAs tied to reviewed release provenance`, () => {
    const blocks = actionBlocks(readWorkflow(workflow));
    for (const block of blocks) {
      assert.equal(
        actionMatchesTrustedProvenance(block),
        true,
        `${workflow}:${block.line} ${block.ownerRepo} does not match the reviewed action SHA/release pair`,
      );
    }
  });

  test(`${workflow} does not inject an explicit token into checkout`, () => {
    const blocks = checkoutBlocks(readWorkflow(workflow));
    for (const block of blocks) {
      assert.equal(
        checkoutDoesNotRequestWriteToken(block),
        true,
        `${workflow}:${block.line} must not override checkout token under the read-only QA contract`,
      );
    }
  });

  test(`${workflow} keeps setup-node on the required Node 24 runtime`, () => {
    const blocks = actionBlocks(readWorkflow(workflow)).filter(
      (block) => block.ownerRepo === 'actions/setup-node',
    );
    assert.ok(blocks.length > 0, `${workflow} unexpectedly has no actions/setup-node step`);
    for (const block of blocks) {
      assert.equal(
        setupNodeUsesRequiredRuntime(block),
        true,
        `${workflow}:${block.line} must explicitly select Node 24`,
      );
    }
  });

  test(`${workflow} scopes npm cache provenance to the Webclient lockfile when caching`, () => {
    const blocks = actionBlocks(readWorkflow(workflow)).filter(
      (block) => block.ownerRepo === 'actions/setup-node',
    );
    for (const block of blocks) {
      assert.equal(
        setupNodeCacheIsLockfileScoped(block),
        true,
        `${workflow}:${block.line} npm cache must be keyed from Webclient.app/package-lock.json`,
      );
    }
  });
}

test('action parser recognizes YAML list-item action steps', () => {
  const blocks = actionBlocks('steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n    with:\n      persist-credentials: false\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].ownerRepo, 'actions/checkout');
  assert.equal(blocks[0].ref, TRUSTED_ACTIONS['actions/checkout'].sha);
  assert.equal(blocks[0].comment, 'v7');
});

test('action parser isolates sibling steps', () => {
  const fixture = `steps:\n  - uses: actions/checkout@${TRUSTED_ACTIONS['actions/checkout'].sha} # v7\n    with:\n      persist-credentials: false\n  - name: sibling\n    run: echo persist-credentials: true\n`;
  const blocks = checkoutBlocks(fixture);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /persist-credentials:\s*false/);
  assert.doesNotMatch(blocks[0].text, /sibling/);
});

test('checkout parser detects missing credential hardening', () => {
  const fixture = `steps:\n  - uses: actions/checkout@${TRUSTED_ACTIONS['actions/checkout'].sha} # v7\n    with:\n      fetch-depth: 0\n`;
  const [block] = checkoutBlocks(fixture);
  assert.equal(checkoutDisablesCredentialPersistence(block), false);
});

test('immutable action contract rejects floating major tags', () => {
  const [block] = actionBlocks('  - uses: actions/checkout@v7');
  assert.equal(actionUsesFullCommitSha(block), false);
});

test('immutable action contract rejects branch references', () => {
  const [block] = actionBlocks('  - uses: actions/setup-node@main');
  assert.equal(actionUsesFullCommitSha(block), false);
});

test('immutable action contract rejects abbreviated SHAs', () => {
  const [block] = actionBlocks('  - uses: actions/checkout@3d3c42e');
  assert.equal(actionUsesFullCommitSha(block), false);
});

test('trusted provenance rejects a different full SHA', () => {
  const [block] = actionBlocks('  - uses: actions/checkout@0000000000000000000000000000000000000000 # v7');
  assert.equal(actionUsesFullCommitSha(block), true);
  assert.equal(actionMatchesTrustedProvenance(block), false);
});

test('trusted provenance rejects a misleading release comment', () => {
  const [block] = actionBlocks(`  - uses: actions/checkout@${TRUSTED_ACTIONS['actions/checkout'].sha} # v6`);
  assert.equal(actionMatchesTrustedProvenance(block), false);
});

test('permission parser rejects write access', () => {
  assert.equal(topLevelPermissionsAreReadOnly('permissions:\n  contents: write\njobs: {}\n'), false);
});

test('permission parser rejects missing explicit contents permission', () => {
  assert.equal(topLevelPermissionsAreReadOnly('permissions: {}\njobs: {}\n'), false);
});

test('setup-node runtime contract rejects an unpinned Node major', () => {
  const [block] = actionBlocks(`  - uses: actions/setup-node@${TRUSTED_ACTIONS['actions/setup-node'].sha} # v7\n    with:\n      node-version: node\n`);
  assert.equal(setupNodeUsesRequiredRuntime(block), false);
});

test('setup-node cache contract rejects an unrelated lockfile', () => {
  const [block] = actionBlocks(`  - uses: actions/setup-node@${TRUSTED_ACTIONS['actions/setup-node'].sha} # v7\n    with:\n      node-version: 24\n      cache: npm\n      cache-dependency-path: package-lock.json\n`);
  assert.equal(setupNodeCacheIsLockfileScoped(block), false);
});

test('setup-node cache contract allows no cache', () => {
  const [block] = actionBlocks(`  - uses: actions/setup-node@${TRUSTED_ACTIONS['actions/setup-node'].sha} # v7\n    with:\n      node-version: 24\n`);
  assert.equal(setupNodeCacheIsLockfileScoped(block), true);
});
