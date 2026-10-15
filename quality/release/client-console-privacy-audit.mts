import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex } from './inventory.mts';
import { maskNonExecutableNetworkText } from './network-lexical.mts';
import {
  callArguments,
  createClientPrivacyClassifier,
  isClientRuntimeSource,
} from './client-log-privacy-audit.mts';

export interface ClientConsolePrivacySummary {
  readonly runtimeFiles: number;
  readonly consoleCalls: number;
  readonly unsafeCalls: number;
  readonly retainedFindings: number;
}
interface ConsoleCall {
  readonly offset: number;
  readonly method: string;
  readonly arguments: readonly string[] | null;
}
const CONSOLE_SINK =
  /\bconsole\s*(?:\.|\?\.)\s*(log|info|debug|warn|error|table)\s*(?:\?\.)?\s*\(/g;

function locateConsoleCalls(text: string): readonly ConsoleCall[] {
  const searchable = maskNonExecutableNetworkText(text);
  const pattern = new RegExp(CONSOLE_SINK.source, 'g');
  const calls: ConsoleCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(searchable)) !== null) {
    const open = match.index + match[0].length - 1;
    calls.push({
      offset: match.index,
      method: match[1] ?? 'unknown',
      arguments: callArguments(text, open),
    });
    if (calls.length >= 8_192) break;
  }
  return calls;
}
function issue(file: SourceFile, line: number, reason: string): Finding {
  return {
    id: 'client-console-sensitive-payload',
    domain: 'security',
    severity: 'high',
    title: 'Sensitive client data may reach browser console output',
    message: 'Runtime console messages must not include raw queries, locations, addresses or records.',
    location: { file: file.repositoryPath, line },
    evidence: { metadata: { reason } },
    remediation: 'Use a bounded non-identifying event marker or count; never forward query, service response, coordinates, user data or request payloads.',
    tags: ['privacy', 'logging', 'console', 'data-minimization'],
  };
}
function overflowIssue(file: SourceFile, line: number, total: number): Finding {
  return {
    id: 'client-console-sensitive-payload-overflow',
    domain: 'security',
    severity: 'high',
    title: 'Additional console privacy risks exceed the evidence budget',
    message: 'The release report retains at most eight findings per file while counting all unsafe console calls.',
    location: { file: file.repositoryPath, line },
    evidence: { value: total - 7, metadata: { retainedIndividualFindings: 7 } },
    remediation: 'Remove all unsafe console payloads and keep bounded diagnostics.',
    tags: ['privacy', 'logging', 'console', 'overflow'],
  };
}
/**
 * Console output is a separate data sink from the first-party safeClientLog
 * helper. Both share one alias-aware classifier, including closure scoping,
 * destructured private fields and mutable local assignments.
 *
 * This audit deliberately reports only reason codes and scalar counts.
 * Neither original argument text nor source snippets are stored in findings.
 */
export function auditClientConsolePrivacy(
  inventory: RepositoryInventory,
): AuditSection<ClientConsolePrivacySummary> {
  const started = performance.now();
  const files = inventory.files.filter(isClientRuntimeSource);
  const findings: Finding[] = [];
  let consoleCalls = 0;
  let unsafeCalls = 0;
  for (const file of files) {
    const index = createLineIndex(file.text);
    const classify = createClientPrivacyClassifier(file.text);
    const calls = locateConsoleCalls(file.text);
    consoleCalls += calls.length;
    const firstFinding = findings.length;
    let fileUnsafe = 0;
    let overflowLine = 1;
    for (const call of calls) {
      const reason = call.arguments === null
        ? 'unreviewable-console-call'
        : call.arguments.map(argument => classify(argument, call.offset)).find(Boolean) ?? null;
      if (!reason) continue;
      fileUnsafe += 1;
      unsafeCalls += 1;
      const line = index.lineAt(call.offset);
      if (fileUnsafe === 8) overflowLine = line;
      if (fileUnsafe <= 8) findings.push(issue(file, line, reason));
    }
    if (fileUnsafe > 8) {
      // The eighth retained finding becomes a redacted aggregate. Other
      // unbounded call payloads are neither serialized nor accumulated.
      findings[firstFinding + 7] = overflowIssue(file, overflowLine, fileUnsafe);
    }
  }
  return {
    domain: 'security',
    title: 'Browser console payload privacy boundary',
    summary: {
      runtimeFiles: files.length,
      consoleCalls,
      unsafeCalls,
      retainedFindings: findings.length,
    },
    findings: stableSortFindings(findings),
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
