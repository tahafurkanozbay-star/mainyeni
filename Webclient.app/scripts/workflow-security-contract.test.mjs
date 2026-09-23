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

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function lines(text) {
  return text.split(/\r?\n/);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function checkoutBlocks(text) {
  const source = lines(text);
  const blocks = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (!/^\s*uses:\s*actions\/checkout@/.test(line)) continue;

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

    blocks.push(Object.freeze({
      line: start + 1,
      text: source.slice(start, end).join('\n'),
    }));
  }

  return blocks;
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

function checkoutUsesPinnedMajor(block) {
  const match = block.text.match(/uses:\s*actions\/checkout@([^\s#]+)/);
  if (!match) return false;
  const ref = match[1];
  return /^v\d+$/.test(ref) || /^[0-9a-f]{40}$/i.test(ref);
}

function checkoutDisablesCredentialPersistence(block) {
  return /^\s*persist-credentials:\s*false\s*$/m.test(block.text);
}

function checkoutDoesNotRequestWriteToken(block) {
  return !/^\s*token:\s*(?!['"]?\s*['"]?\s*$).+/m.test(block.text);
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

  test(`${workflow} keeps checkout action references immutable by major or SHA`, () => {
    const blocks = checkoutBlocks(readWorkflow(workflow));
    for (const block of blocks) {
      assert.equal(
        checkoutUsesPinnedMajor(block),
        true,
        `${workflow}:${block.line} must pin actions/checkout to a major version or full SHA`,
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
}

test('checkout parser isolates sibling steps', () => {
  const fixture = `steps:\n  - uses: actions/checkout@v4\n    with:\n      persist-credentials: false\n  - name: sibling\n    run: echo persist-credentials: true\n`;
  const blocks = checkoutBlocks(fixture);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /persist-credentials:\s*false/);
  assert.doesNotMatch(blocks[0].text, /sibling/);
});

test('checkout parser detects missing credential hardening', () => {
  const fixture = `steps:\n  - uses: actions/checkout@v4\n    with:\n      fetch-depth: 0\n`;
  const [block] = checkoutBlocks(fixture);
  assert.equal(checkoutDisablesCredentialPersistence(block), false);
});

test('checkout parser rejects floating action references', () => {
  const [block] = checkoutBlocks('  - uses: actions/checkout@main');
  assert.equal(checkoutUsesPinnedMajor(block), false);
});

test('permission parser rejects write access', () => {
  assert.equal(topLevelPermissionsAreReadOnly('permissions:\n  contents: write\njobs: {}\n'), false);
});

test('permission parser rejects missing explicit contents permission', () => {
  assert.equal(topLevelPermissionsAreReadOnly('permissions: {}\njobs: {}\n'), false);
});
