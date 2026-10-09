import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const POLICY_PATH = path.join(ROOT, 'scripts', 'dependency-policy.json');
const ISSUE_TYPES = new Set(['unused-runtime', 'deprecated-direct', 'install-script-direct']);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const FORBIDDEN_SPEC_PREFIXES = ['file:', 'link:', 'git:', 'git+http:', 'git+https:', 'http:', 'https:'];
const COMMAND_BOUNDARY_OPERATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')']);
const COMMAND_PREFIX_WORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
const COMMAND_WRAPPERS = new Set(['command', 'exec', 'builtin', 'nohup', 'time', 'sudo']);
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const UNREVIEWABLE_SHELL_EVALUATORS = new Set(['eval', 'source', '.', 'xargs']);
const PACKAGE_EXEC_BINARIES = new Set(['pnpx', 'bunx', 'corepack']);
// Root scripts must not acquire packages, mutate the lock graph, or execute
// dependency lifecycle hooks outside the reviewed dependency-governance gate.
const PACKAGE_EXEC_SUBCOMMANDS = Object.freeze({
  npm: new Set([
    'exec', 'x', 'create', 'init', 'install', 'i', 'ci', 'update', 'up',
    'upgrade', 'rebuild', 'link', 'ln', 'uninstall', 'un', 'remove', 'rm',
    'publish', 'pack',
  ]),
  pnpm: new Set([
    'dlx', 'create', 'install', 'i', 'add', 'update', 'up', 'upgrade',
    'rebuild', 'link', 'remove', 'rm', 'publish', 'pack', 'fetch', 'deploy',
  ]),
  yarn: new Set([
    'dlx', 'create', 'install', 'add', 'up', 'upgrade', 'rebuild',
    'link', 'remove', 'publish', 'pack',
  ]),
  bun: new Set([
    'x', 'create', 'install', 'i', 'add', 'update', 'upgrade',
    'link', 'remove', 'rm', 'publish',
  ]),
});
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  '--prefix', '--workspace', '-w', '--filter', '-F', '--dir', '-C',
  '--cwd', '--config', '--registry', '--userconfig', '--cache', '--location',
]);
const PACKAGE_MANAGER_FLAG_OPTIONS = new Set([
  '--silent', '-s', '--yes', '-y', '--offline', '--no-audit',
  '--no-fund', '--ignore-scripts', '--color', '--no-color',
]);
const MAX_NESTED_SHELL_DEPTH = 4;

export class DependencySurfacePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DependencySurfacePolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function assertObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DependencySurfacePolicyError(code, `${label} must be an object`);
  }
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function packageNameValid(name) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(name);
}

function specKind(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return 'invalid';
  const value = spec.trim();
  if (FORBIDDEN_SPEC_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'external-source';
  if (value === '*' || value === 'latest' || value === 'next') return 'floating';
  if (/^(?:workspace:|npm:)/.test(value)) return 'alias';
  return 'registry-range';
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DependencySurfacePolicyError('invalid-date', `${label} must use YYYY-MM-DD`, { value });
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new DependencySurfacePolicyError('invalid-date', `${label} is not a real date`, { value });
  }
  return timestamp;
}

function shellBasename(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).trim();
}

function isAssignmentWord(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

function isOptionWord(value) {
  return /^-[^-]|^--/.test(value);
}

function freezeToken(type, value) {
  return Object.freeze({ type, value });
}

/**
 * Tokenizes the subset of POSIX shell syntax used by package scripts.
 *
 * This is deliberately not a command executor and does not perform expansion.
 * Its sole purpose is to distinguish actual command-position words from
 * arguments and file names so supply-chain rules do not report false positives.
 */
export function tokenizePackageScript(command) {
  if (typeof command !== 'string') {
    throw new DependencySurfacePolicyError('invalid-script-command', 'script command must be a string');
  }

  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  const flushWord = () => {
    if (current.length > 0) {
      tokens.push(freezeToken('word', current));
      current = '';
    }
  };

  const pushOperator = (operator) => {
    flushWord();
    tokens.push(freezeToken('operator', operator));
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }

    // Expansions can synthesize an executable; do not emulate shell evaluation.
    if (character === '$' || character === '`' ||
        (quote === null && (
          ((character === '<' || character === '>') && command[index + 1] === '(') ||
          (character === '<' && command.slice(index, index + 3) === '<<<')
        ))) {
      throw new DependencySurfacePolicyError('dynamic-shell-expansion', 'package script contains unreviewable shell expansion');
    }
    // POSIX redirections may precede the executable (e.g. >log npm install).
    // The command-position parser does not model redirect operands; reject them
    // rather than accidentally treating the redirect as the executable.
    if (quote === null && (character === '<' || character === '>')) {
      throw new DependencySurfacePolicyError('unreviewable-shell-redirection', 'package script contains shell redirection outside the reviewed grammar');
    }
    // Unquoted glob, brace and leading tilde expansion can change command identity.
    if (quote === null && ('*?[{'.includes(character) || (character === '~' && current.length === 0))) {
      throw new DependencySurfacePolicyError('dynamic-shell-expansion', 'package script contains unreviewable pathname expansion');
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\') {
        escaped = true;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === '\r') continue;
    if (character === '\n') {
      pushOperator('\n');
      continue;
    }

    if (/\s/.test(character)) {
      flushWord();
      continue;
    }

    if ((character === '&' || character === '|') && command[index + 1] === character) {
      pushOperator(`${character}${character}`);
      index += 1;
      continue;
    }

    if (';|&()'.includes(character)) {
      pushOperator(character);
      continue;
    }

    current += character;
  }

  if (escaped) current += '\\';
  if (quote !== null) {
    throw new DependencySurfacePolicyError('malformed-script-shell', 'script command contains an unterminated quote');
  }

  flushWord();
  return Object.freeze(tokens);
}

function segmentEnd(tokens, startIndex) {
  let index = startIndex;
  while (index < tokens.length && tokens[index].type !== 'operator') index += 1;
  return index;
}

// Operand-taking wrapper options must not hide the command that follows.
// Unknown options fail closed instead of silently changing command identity.
const WRAPPER_VALUE_OPTIONS = Object.freeze({
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-C', '--close-from', '-D', '--chdir']),
  time: new Set(['-f', '--format', '-o', '--output']),
  exec: new Set(['-a']),
});
const WRAPPER_FLAG_OPTIONS = Object.freeze({
  env: new Set(['-i', '-0', '-v', '--ignore-environment', '--null', '--debug']),
  sudo: new Set(['-n', '-E', '-H', '-k', '-K', '-S', '-b', '-v', '-V', '-l', '-i', '--non-interactive', '--preserve-env', '--login', '--background', '--validate']),
  time: new Set(['-p', '-v', '-q', '--portability', '--verbose', '--quiet']),
  exec: new Set(['-c', '-l']),
  command: new Set(['-p', '-v', '-V']),
  builtin: new Set(),
  nohup: new Set(),
});

function skipWrapperOptions(tokens, index, end, wrapper) {
  let cursor = index;
  const takesValue = WRAPPER_VALUE_OPTIONS[wrapper] ?? new Set();
  const flags = WRAPPER_FLAG_OPTIONS[wrapper] ?? new Set();
  while (cursor < end && tokens[cursor].type === 'word') {
    const option = tokens[cursor].value;
    if (option === '--') return cursor + 1;
    if (!isOptionWord(option)) break;
    // env -S/--split-string executes text not represented by a command word.
    if (wrapper === 'env' && (/^-S/.test(option) || /^--split-string(?:=|$)/.test(option))) {
      throw new DependencySurfacePolicyError('malformed-script-shell', 'env split-string cannot be reviewed');
    }
    if (takesValue.has(option)) {
      if (tokens[cursor + 1]?.type !== 'word') {
        throw new DependencySurfacePolicyError('malformed-script-shell', `${wrapper} option requires an operand`);
      }
      cursor += 2;
      continue;
    }
    const shortValue = wrapper === 'env' ? /^-[uC].+$/ :
      wrapper === 'sudo' ? /^-[ughprtCD].+$/ :
      wrapper === 'time' ? /^-[fo].+$/ :
      wrapper === 'exec' ? /^-a.+$/ : /^$/;
    const longValue = wrapper === 'env' ? /^--(?:unset|chdir)=.+$/ :
      wrapper === 'sudo' ? /^--(?:user|group|host|prompt|role|type|close-from|chdir)=.+$/ :
      wrapper === 'time' ? /^--(?:format|output)=.+$/ : /^$/;
    if (shortValue.test(option) || longValue.test(option) ||
        (wrapper === 'sudo' && /^--preserve-env=.+$/.test(option))) {
      cursor += 1;
      continue;
    }
    if (!flags.has(option)) {
      throw new DependencySurfacePolicyError('malformed-script-shell', `unreviewable ${wrapper} option`);
    }
    cursor += 1;
  }
  return cursor;
}

function resolveInvocation(tokens, startIndex) {
  const end = segmentEnd(tokens, startIndex);
  let index = startIndex;

  while (index < end && tokens[index].type === 'word' && COMMAND_PREFIX_WORDS.has(tokens[index].value)) index += 1;
  while (index < end && tokens[index].type === 'word' && isAssignmentWord(tokens[index].value)) index += 1;

  let wrapperDepth = 0;
  while (index < end && wrapperDepth < 8) {
    const word = tokens[index].value;
    const basename = shellBasename(word);

    if (basename === 'env') {
      index = skipWrapperOptions(tokens, index + 1, end, basename);
      while (index < end && isAssignmentWord(tokens[index].value)) index += 1;
      wrapperDepth += 1;
      continue;
    }

    if (COMMAND_WRAPPERS.has(basename)) {
      index = skipWrapperOptions(tokens, index + 1, end, basename);
      wrapperDepth += 1;
      continue;
    }

    break;
  }

  if (index < end && tokens[index].type === 'word') {
    const unresolved = shellBasename(tokens[index].value);
    if (unresolved === 'env' || COMMAND_WRAPPERS.has(unresolved)) {
      throw new DependencySurfacePolicyError('shell-wrapper-depth', 'package script exceeds the reviewed command-wrapper depth');
    }
  }
  if (index >= end || tokens[index].type !== 'word') return null;
  return Object.freeze({ index, end, word: tokens[index].value, command: shellBasename(tokens[index].value) });
}

function nestedShellCommand(tokens, invocation) {
  if (!SHELL_INTERPRETERS.has(invocation.command)) return null;

  for (let index = invocation.index + 1; index < invocation.end; index += 1) {
    const value = tokens[index].value;
    // A shell's -c can be grouped with other short options (bash -lc,
    // sh -ec). The following word is executable source, not a data argument.
    if (value === '--command' || (/^-[A-Za-z]+$/.test(value) && value.slice(1).includes('c'))) {
      // -o/-O consume an operand, and their ordering with -c is
      // shell-dependent. Reject mixed groups rather than guess.
      if (value !== '--command' && /[oO]/.test(value.slice(1))) {
        throw new DependencySurfacePolicyError('malformed-script-shell', 'ambiguous grouped shell command and option flags');
      }
      const nested = tokens[index + 1];
      if (nested?.type !== 'word') {
        throw new DependencySurfacePolicyError('malformed-script-shell', 'shell command option requires source');
      }
      return nested.value;
    }
    // -o/-O consume a separate option name even when grouped with other
    // short options, e.g. bash -eo pipefail -c '...'.
    if (/^[-+][oO]$/.test(value) || /^-[A-Za-z]*[oO]$/.test(value)) {
      if (tokens[index + 1]?.type !== 'word') {
        throw new DependencySurfacePolicyError('malformed-script-shell', 'shell option requires an argument');
      }
      index += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(value) && /[oO]/.test(value.slice(1))) {
      throw new DependencySurfacePolicyError('malformed-script-shell', 'unreviewable grouped shell option');
    }
    if (!isOptionWord(value)) break;
  }
  return null;
}

// Unreviewed package launchers can acquire code outside the reviewed lockfile.
// Unknown option forms fail closed instead of hiding a subcommand in an operand.
function isUnreviewedPackageExecution(tokens, invocation) {
  if (PACKAGE_EXEC_BINARIES.has(invocation.command)) return true;
  const forbidden = PACKAGE_EXEC_SUBCOMMANDS[invocation.command];
  if (!forbidden) return false;

  let index = invocation.index + 1;
  while (index < invocation.end) {
    const option = tokens[index].value;
    if (option === '--') {
      index += 1;
      break;
    }
    if (!isOptionWord(option)) break;
    if (PACKAGE_MANAGER_VALUE_OPTIONS.has(option)) {
      if (tokens[index + 1]?.type !== 'word' || index + 1 >= invocation.end ||
          isOptionWord(tokens[index + 1].value)) {
        throw new DependencySurfacePolicyError('malformed-script-shell', 'package manager option requires an operand');
      }
      index += 2;
      continue;
    }
    if (PACKAGE_MANAGER_FLAG_OPTIONS.has(option) ||
        /^--(?:prefix|workspace|filter|dir|cwd|config|registry|userconfig|cache|location)=.+$/.test(option)) {
      index += 1;
      continue;
    }
    throw new DependencySurfacePolicyError('malformed-script-shell', 'unreviewable package manager option');
  }
  // npm audit is read-only, but "npm audit fix" rewrites the dependency
  // graph and can run install lifecycle scripts.
  if (invocation.command === 'npm' && tokens[index]?.value === 'audit' &&
      tokens[index + 1]?.value === 'fix') return true;
  return forbidden.has(tokens[index]?.value);
}

/**
 * Returns command-position invocations from a package script without executing
 * or expanding the shell. Nested `sh -c` / `bash -c` commands are inspected to
 * a bounded depth so policy cannot be bypassed by a trivial shell wrapper.
 */
export function collectPackageScriptInvocations(command, options = {}) {
  const depth = Number(options.depth ?? 0);
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_NESTED_SHELL_DEPTH) {
    throw new DependencySurfacePolicyError('invalid-shell-depth', 'shell inspection depth is outside the supported range');
  }

  const tokens = tokenizePackageScript(command);
  const invocations = [];
  let expectCommand = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type === 'operator') {
      expectCommand = COMMAND_BOUNDARY_OPERATORS.has(token.value);
      continue;
    }

    if (!expectCommand) continue;

    const invocation = resolveInvocation(tokens, index);
    if (!invocation) {
      expectCommand = false;
      continue;
    }

    // Evaluators execute source or commands from arguments or stdin.
    if (UNREVIEWABLE_SHELL_EVALUATORS.has(invocation.command)) {
      throw new DependencySurfacePolicyError('dynamic-shell-expansion', 'package script executes unreviewable dynamic shell source');
    }

    if (isUnreviewedPackageExecution(tokens, invocation)) {
      throw new DependencySurfacePolicyError('unreviewed-package-exec-script', 'package script may acquire and execute an unreviewed package');
    }

    invocations.push(Object.freeze({
      command: invocation.command,
      word: invocation.word,
      depth,
    }));

    const nested = nestedShellCommand(tokens, invocation);
    if (nested) {
      if (depth >= MAX_NESTED_SHELL_DEPTH) {
        throw new DependencySurfacePolicyError('shell-nesting-depth', 'package script exceeds the reviewed nested-shell depth');
      }
      invocations.push(...collectPackageScriptInvocations(nested, { depth: depth + 1 }));
    }

    index = invocation.end - 1;
    expectCommand = false;
  }

  return Object.freeze(invocations);
}

function scriptInvocationNames(command) {
  return new Set(collectPackageScriptInvocations(command).map((entry) => entry.command));
}

export function collectManifestSurface(manifest) {
  assertObject(manifest, 'invalid-manifest', 'manifest');
  const seen = new Map();
  const entries = [];
  for (const section of DEP_SECTIONS) {
    const deps = manifest[section];
    if (deps === undefined) continue;
    assertObject(deps, 'invalid-section', section);
    for (const [name, spec] of Object.entries(deps)) {
      if (!packageNameValid(name)) {
        throw new DependencySurfacePolicyError('invalid-package-name', `Invalid package name: ${name}`, { section, name });
      }
      if (seen.has(name)) {
        throw new DependencySurfacePolicyError('duplicate-direct-dependency', `${name} appears in multiple dependency sections`, {
          name,
          firstSection: seen.get(name),
          secondSection: section,
        });
      }
      seen.set(name, section);
      entries.push(Object.freeze({ name, section, spec, specKind: specKind(spec) }));
    }
  }
  return Object.freeze(entries.sort((a, b) => a.name.localeCompare(b.name)));
}

export function validateManifestSurface(manifest, policy, options = {}) {
  const now = options.now ?? new Date();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new DependencySurfacePolicyError('invalid-now', 'now must be a valid Date or timestamp');

  const entries = collectManifestSurface(manifest);
  const policyObject = assertObject(policy, 'invalid-policy', 'policy');
  const exceptions = policyObject.exceptions === undefined ? [] : policyObject.exceptions;
  if (!Array.isArray(exceptions)) {
    throw new DependencySurfacePolicyError('invalid-policy-exceptions', 'policy.exceptions must be an array');
  }
  const findings = [];
  const directNames = new Set(entries.map((entry) => entry.name));
  const exceptionKeys = new Set();

  for (const entry of entries) {
    if (entry.specKind === 'invalid') {
      findings.push({ severity: 'error', code: 'invalid-version-spec', package: entry.name, section: entry.section });
    } else if (entry.specKind === 'external-source') {
      findings.push({ severity: 'error', code: 'external-source-spec', package: entry.name, section: entry.section, spec: entry.spec });
    } else if (entry.specKind === 'floating') {
      findings.push({ severity: 'error', code: 'floating-version-spec', package: entry.name, section: entry.section, spec: entry.spec });
    }
  }

  for (const exception of exceptions) {
    assertObject(exception, 'invalid-exception', 'exception');
    const name = exception.package;
    if (typeof name !== 'string' || !packageNameValid(name)) {
      findings.push({ severity: 'error', code: 'invalid-exception-package', package: String(name ?? '') });
      continue;
    }
    if (!directNames.has(name)) findings.push({ severity: 'error', code: 'stale-exception-package', package: name });
    if (!Array.isArray(exception.issues) || exception.issues.length === 0) {
      findings.push({ severity: 'error', code: 'empty-exception-issues', package: name });
      continue;
    }
    for (const issue of exception.issues) {
      if (!ISSUE_TYPES.has(issue)) findings.push({ severity: 'error', code: 'unknown-exception-issue', package: name, issue });
      const key = `${name}:${issue}`;
      if (exceptionKeys.has(key)) findings.push({ severity: 'error', code: 'duplicate-exception-issue', package: name, issue });
      exceptionKeys.add(key);
    }
    if (typeof exception.owner !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(exception.owner)) {
      findings.push({ severity: 'error', code: 'invalid-exception-owner', package: name });
    }
    if (typeof exception.reason !== 'string' || exception.reason.trim().length < 24) {
      findings.push({ severity: 'error', code: 'weak-exception-reason', package: name });
    }
    try {
      const expiry = parseDate(exception.expiresOn, `${name}.expiresOn`);
      if (expiry < nowMs) findings.push({ severity: 'error', code: 'expired-exception', package: name, expiresOn: exception.expiresOn });
    } catch {
      findings.push({ severity: 'error', code: 'invalid-exception-expiry', package: name });
    }
  }

  const scripts = assertObject(manifest.scripts ?? {}, 'invalid-scripts', 'scripts');
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || !command.trim()) {
      findings.push({ severity: 'error', code: 'invalid-script-command', script: name });
      continue;
    }

    let invocationNames;
    try {
      invocationNames = scriptInvocationNames(command);
    } catch (error) {
      if (error instanceof DependencySurfacePolicyError &&
          ['malformed-script-shell', 'shell-wrapper-depth', 'shell-nesting-depth', 'dynamic-shell-expansion', 'unreviewed-package-exec-script'].includes(error.code)) {
        findings.push({ severity: 'error', code: error.code, script: name });
        continue;
      }
      throw error;
    }

    if (invocationNames.has('npx')) findings.push({ severity: 'error', code: 'unreviewed-npx-script', script: name });
    if (invocationNames.has('curl') || invocationNames.has('wget')) findings.push({ severity: 'error', code: 'network-bootstrap-script', script: name });
    if (/^(?:preinstall|postinstall)$/.test(name)) findings.push({ severity: 'error', code: 'root-install-lifecycle-script', script: name });
  }

  const engines = assertObject(manifest.engines ?? {}, 'invalid-engines', 'engines');
  if (!engines.node || !engines.npm) findings.push({ severity: 'error', code: 'missing-runtime-engine-contract' });

  const sectionCounts = Object.fromEntries(DEP_SECTIONS.map((section) => [section, entries.filter((entry) => entry.section === section).length]));
  const fingerprint = entries.map(({ name, section, spec }) => `${section}:${name}@${spec}`).join('\n');
  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    dependencyCount: entries.length,
    sectionCounts: Object.freeze(sectionCounts),
    externalSourceCount: entries.filter((entry) => entry.specKind === 'external-source').length,
    floatingSpecCount: entries.filter((entry) => entry.specKind === 'floating').length,
    exceptionPackageCount: sortedUnique(exceptions.map((entry) => entry?.package).filter((value) => typeof value === 'string')).length,
    fingerprint,
  });
}

export function formatReport(report) {
  const lines = [
    `Dependency surface: ${report.dependencyCount} direct packages`,
    `Exceptions: ${report.exceptionPackageCount}`,
    `External sources: ${report.externalSourceCount}`,
    `Floating specs: ${report.floatingSpecCount}`,
  ];
  for (const finding of report.findings) lines.push(`ERROR ${finding.code}: ${finding.package ?? finding.script ?? 'manifest'}`);
  return lines.join('\n');
}

export function runCli({ manifestPath = PACKAGE_PATH, policyPath = POLICY_PATH, now = new Date() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const report = validateManifestSurface(manifest, policy, { now });
  process.stdout.write(`${formatReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) runCli();
