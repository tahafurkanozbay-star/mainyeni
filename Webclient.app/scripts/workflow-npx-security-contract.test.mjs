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

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function multilineBody(lines, startIndex, runIndent) {
  const body = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      body.push(line);
      continue;
    }
    if (indentation(line) <= runIndent) break;
    body.push(line);
  }
  const nonBlank = body.filter((line) => line.trim());
  if (!nonBlank.length) return '';
  const contentIndent = Math.min(...nonBlank.map(indentation));
  return body.map((line) => (line.trim() ? line.slice(contentIndent) : '')).join('\n').replace(/\n+$/, '');
}

function isStepRun(lines, index, runIndent, compact) {
  if (compact) return true;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor];
    if (!line.trim()) continue;
    const indent = indentation(line);
    if (indent < runIndent) return /^\s*-\s+(?:name|uses|id|if|env|continue-on-error|timeout-minutes|shell|working-directory):/.test(line);
    if (indent === runIndent && /^\s*-\s+/.test(line)) return true;
  }
  return false;
}

function shellBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(-\s*)?run:\s*(.*)$/);
    if (!match) continue;
    const runIndent = indentation(lines[index]);
    if (!isStepRun(lines, index, runIndent, Boolean(match[2]))) continue;
    const value = match[3].trim();
    const command = ['|', '>', '|-', '>-'].includes(value)
      ? multilineBody(lines, index + 1, runIndent)
      : value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    blocks.push(Object.freeze({ line: index + 1, command }));
  }
  return blocks;
}

function executableLines(command) {
  return String(command ?? '')
    .split(/\r?\n/)
    .map((line, index) => Object.freeze({ offset: index, text: line.trim() }))
    .filter(({ text }) => text && !text.startsWith('#'));
}

function npxInvocations(command) {
  const findings = [];
  for (const { offset, text } of executableLines(command)) {
    const segments = text.split(/(?:&&|\|\||;|\|)/).map((part) => part.trim()).filter(Boolean);
    for (const segment of segments) {
      const match = segment.match(/^(?:command\s+)?npx\b([\s\S]*)$/);
      if (!match) continue;
      const args = match[1].trim();
      const noInstall = /(?:^|\s)--no-install(?:\s|$)/.test(args);
      const yes = /(?:^|\s)(?:--yes|-y)(?:\s|$)/.test(args);
      findings.push(Object.freeze({ offset, segment, noInstall, yes }));
    }
  }
  return findings;
}

function auditNpx(command) {
  const findings = [];
  for (const invocation of npxInvocations(command)) {
    if (invocation.yes) findings.push(Object.freeze({ code: 'npx-auto-install-enabled', offset: invocation.offset, evidence: invocation.segment }));
    if (!invocation.noInstall) findings.push(Object.freeze({ code: 'npx-local-only-missing', offset: invocation.offset, evidence: invocation.segment }));
  }
  return findings;
}

function auditWorkflow(text) {
  return shellBlocks(text).flatMap((block) =>
    auditNpx(block.command).map((finding) => Object.freeze({
      ...finding,
      line: block.line + finding.offset,
    })),
  );
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} never permits npx to resolve an unreviewed remote package`, () => {
    assert.deepEqual(auditWorkflow(read(workflow)), []);
  });
}

test('accepts local-only npx execution', () => {
  assert.deepEqual(auditNpx('npx --no-install tsc --noEmit'), []);
});

test('rejects ordinary npx because it may install a missing package', () => {
  assert.deepEqual(auditNpx('npx tsc --noEmit').map(({ code }) => code), ['npx-local-only-missing']);
});

test('rejects explicit automatic installation even when local-only is also present', () => {
  assert.deepEqual(
    auditNpx('npx --yes --no-install tool').map(({ code }) => code),
    ['npx-auto-install-enabled'],
  );
});

test('rejects short -y automatic installation', () => {
  assert.deepEqual(
    auditNpx('npx -y tool').map(({ code }) => code),
    ['npx-auto-install-enabled', 'npx-local-only-missing'],
  );
});

test('finds npx after fail-fast command separators', () => {
  assert.deepEqual(
    auditNpx('npm ci && npx vitest run').map(({ code }) => code),
    ['npx-local-only-missing'],
  );
});

test('finds npx after semicolon and pipeline separators', () => {
  assert.equal(auditNpx('echo ready; npx tool | cat').length, 1);
});

test('does not confuse package scripts with direct npx execution', () => {
  assert.deepEqual(auditNpx('npm run test:ci'), []);
});

test('does not confuse filenames containing npx', () => {
  assert.deepEqual(auditNpx('node scripts/npx-policy.mjs'), []);
});

test('ignores comments mentioning npx', () => {
  assert.deepEqual(auditNpx('# npx tool\nnpm ci'), []);
});

test('preserves source line evidence for compact steps', () => {
  assert.deepEqual(
    auditWorkflow('steps:\n  - run: npx tool\n').map(({ code, line }) => ({ code, line })),
    [{ code: 'npx-local-only-missing', line: 2 }],
  );
});

test('preserves source line evidence inside multiline steps', () => {
  assert.deepEqual(
    auditWorkflow('steps:\n  - run: |\n      npm ci\n      npx tool\n').map(({ code, line }) => ({ code, line })),
    [{ code: 'npx-local-only-missing', line: 3 }],
  );
});

test('ignores workflow defaults.run configuration', () => {
  assert.deepEqual(
    auditWorkflow('defaults:\n  run:\n    shell: bash\nsteps:\n  - run: npm ci\n'),
    [],
  );
});

test('audits named run steps', () => {
  assert.deepEqual(
    auditWorkflow('steps:\n  - name: Test\n    run: npx vitest run\n').map(({ code }) => code),
    ['npx-local-only-missing'],
  );
});

test('reports each unsafe invocation independently', () => {
  assert.deepEqual(
    auditNpx('npx tool-a\nnpx tool-b').map(({ code }) => code),
    ['npx-local-only-missing', 'npx-local-only-missing'],
  );
});

test('accepts multiple reviewed local-only invocations', () => {
  assert.deepEqual(auditNpx('npx --no-install tsc\nnpx --no-install vitest run'), []);
});
