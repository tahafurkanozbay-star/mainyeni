import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex } from './inventory.mts';

export interface ClientLogPrivacySummary {
  readonly runtimeFiles: number;
  readonly clientLogCalls: number;
  readonly flaggedCalls: number;
}

const RUNTIME_PATH = /^(?:Webclient\.app|Webclient\.admin)\/src\//;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/i;
const IDENTIFIER = /[A-Za-z0-9_$]/;
const SENSITIVE_DIRECT_IDENTIFIER = /^(?:query|path|params|payload|record|item|selection|address|coordinates|location|geometry)$/i;
const SENSITIVE_PATH = /\b(?:pathForLog|numberingPathLabelV\d*)\s*\(/;
const SENSITIVE_SERIALIZATION = /\bJSON\s*\.\s*stringify\s*\(\s*(?:query|path|params|payload|record|item|selection|address|coordinates|location)\b/i;
const SENSITIVE_PROPERTY = /\b(?:item|record|path|query|selection|geometry|point)\s*(?:\?\.|\.)\s*(?:address|adres|latitude|longitude|coordinates|street|sokak|mahalle|door)\b/i;
const SENSITIVE_TEMPLATE = /\$\{[^}]{0,150}\b(?:lat|lon|latitude|longitude|address|adres|street|sokak|mahalle|door)\b[^}]*\}/i;

function isRuntime(file: SourceFile): boolean {
  return RUNTIME_PATH.test(file.repositoryPath)
    && (file.kind === 'typescript' || file.kind === 'javascript')
    && !TEST_PATH.test(file.repositoryPath);
}

// Skip lexical literals and comments before searching for calls. This prevents
// a comment or a user-visible example string from becoming a release finding.
function skipLiteral(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === quote) {
      return index + 1;
    }
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  if (text[start + 1] === '/') {
    const newline = text.indexOf('\n', start + 2);
    return newline === -1 ? text.length : newline + 1;
  }
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

function callArguments(text: string, open: number): readonly string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  // A bounded scan prevents a malformed file from consuming the whole audit.
  const limit = Math.min(text.length, open + 8_192);
  for (let index = open + 1; index < limit; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"' || character === '`') {
      index = skipLiteral(text, index) - 1;
      continue;
    }
    if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipComment(text, index) - 1;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' && depth === 0) {
      args.push(text.slice(start, index).trim());
      return args;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth < 0) return null;
      continue;
    }
    if (character === ',' && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return null;
}

interface ClientLogCall {
  readonly offset: number;
  readonly arguments: readonly string[];
}

function findClientLogCalls(text: string): readonly ClientLogCall[] {
  const calls: ClientLogCall[] = [];
  const name = 'safeClientLog';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"' || character === '`') {
      index = skipLiteral(text, index) - 1;
      continue;
    }
    if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipComment(text, index) - 1;
      continue;
    }
    if (!text.startsWith(name, index) ||
        (index > 0 && IDENTIFIER.test(text[index - 1] ?? '')) ||
        IDENTIFIER.test(text[index + name.length] ?? '')) continue;

    let open = index + name.length;
    while (/\s/.test(text[open] ?? '') && open < text.length) open += 1;
    if (text[open] !== '(') continue;
    const args = callArguments(text, open);
    if (args) calls.push({ offset: index, arguments: args });
    index = open;
  }
  return calls;
}

function riskReason(argument: string): string | null {
  if (SENSITIVE_DIRECT_IDENTIFIER.test(argument.trim())) return 'raw-record-or-query';
  if (SENSITIVE_PATH.test(argument)) return 'address-path-label';
  if (SENSITIVE_SERIALIZATION.test(argument)) return 'serialized-record-or-query';
  if (SENSITIVE_PROPERTY.test(argument)) return 'sensitive-property';
  if (SENSITIVE_TEMPLATE.test(argument)) return 'sensitive-template';
  return null;
}

export function auditClientLogPrivacy(inventory: RepositoryInventory): AuditSection<ClientLogPrivacySummary> {
  const start = performance.now();
  const files = inventory.files.filter(isRuntime);
  const findings: Finding[] = [];
  let clientLogCalls = 0;
  for (const file of files) {
    const index = createLineIndex(file.text);
    let flaggedInFile = 0;
    for (const call of findClientLogCalls(file.text)) {
      clientLogCalls += 1;
      if (flaggedInFile >= 8) continue;
      // The third argument is the payload, not the logger or event name.
      const reason = call.arguments.length >= 3 ? riskReason(call.arguments[2] ?? '') : null;
      if (!reason) continue;
      findings.push({
        id: 'client-log-sensitive-payload',
        domain: 'security',
        severity: 'high',
        title: 'Potential sensitive client-log payload',
        message: 'Client logs should carry bounded, non-identifying event metadata rather than address, location or serialized query content.',
        location: { file: file.repositoryPath, line: index.lineAt(call.offset) },
        evidence: { metadata: { reason } },
        remediation: 'Log a constant event marker or bounded non-identifying count and verify that raw address/query values never reach the logger.',
        tags: ['privacy', 'logging', 'data-minimization'],
      });
      flaggedInFile += 1;
    }
  }
  return {
    domain: 'security',
    title: 'Client log payload privacy',
    summary: { runtimeFiles: files.length, clientLogCalls, flaggedCalls: findings.length },
    findings: stableSortFindings(findings),
    elapsedMs: performance.now() - start,
  };
}
