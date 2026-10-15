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

export type BrowserTransferSink = 'message' | 'beacon' | 'storage' | 'url-history';

export interface ClientBrowserTransferPrivacySummary {
  readonly runtimeFiles: number;
  readonly transferCalls: number;
  readonly sensitiveCalls: number;
  readonly messageCalls: number;
  readonly beaconCalls: number;
  readonly storageCalls: number;
  readonly urlHistoryCalls: number;
  readonly retainedFindings: number;
}

interface TransferCall {
  readonly position: number;
  readonly kind: BrowserTransferSink;
  readonly dataArgument: number;
  readonly arguments: readonly string[] | null;
}

interface SinkRule {
  readonly pattern: RegExp;
  readonly kind: BrowserTransferSink;
  readonly dataArgument: number;
}

/**
 * Direct browser transfer surfaces are distinct from safeClientLog and the
 * browser console. They can make private GIS records or coordinates available
 * to other origins, windows, service workers, storage readers or URL history.
 * Source code is never reflected into release findings.
 */
const SINKS: readonly SinkRule[] = [
  {
    pattern: /\b(?:window\s*(?:\.|\?\.)\s*|parent\s*(?:\.|\?\.)\s*|opener\s*(?:\.|\?\.)\s*)?postMessage\s*(?:\?\.)?\s*\(/g,
    kind: 'message', dataArgument: 0,
  },
  {
    pattern: /\b(?:navigator\s*(?:\.|\?\.)\s*)?sendBeacon\s*(?:\?\.)?\s*\(/g,
    kind: 'beacon', dataArgument: 1,
  },
  {
    pattern: /\b(?:localStorage|sessionStorage)\s*(?:\.|\?\.)\s*setItem\s*(?:\?\.)?\s*\(/g,
    kind: 'storage', dataArgument: 1,
  },
  {
    pattern: /\b(?:window\s*(?:\.|\?\.)\s*)?history\s*(?:\.|\?\.)\s*(?:pushState|replaceState)\s*(?:\?\.)?\s*\(/g,
    kind: 'url-history', dataArgument: 2,
  },
];

function findTransferCalls(source: string): readonly TransferCall[] {
  const masked = maskNonExecutableNetworkText(source);
  const found: TransferCall[] = [];
  const seen = new Set<number>();
  for (const rule of SINKS) {
    const expression = new RegExp(rule.pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = expression.exec(masked)) !== null) {
      if (seen.has(match.index)) continue;
      seen.add(match.index);
      const openParen = match.index + match[0].length - 1;
      found.push({
        position: match.index,
        kind: rule.kind,
        dataArgument: rule.dataArgument,
        arguments: callArguments(source, openParen),
      });
      if (found.length >= 8_192) break;
    }
  }
  return found.sort((a, b) => a.position - b.position);
}

function finding(
  file: SourceFile,
  line: number,
  kind: BrowserTransferSink,
  reason: string,
): Finding {
  return {
    id: 'client-browser-sensitive-transfer',
    domain: 'security',
    severity: 'high',
    title: 'Sensitive client data may cross a browser transfer boundary',
    message: 'Browser messaging, beacon, storage and history sinks can expose address, coordinate or query payloads outside their owning component.',
    location: { file: file.repositoryPath, line },
    evidence: { metadata: { sink: kind, reason } },
    remediation: 'Transfer only approved bounded non-identifying metadata, avoid persisting or broadcasting raw GIS records, and enforce target-origin/authorization on legitimate messages.',
    tags: ['privacy', 'browser', 'data-minimization', kind],
  };
}

function overflowFinding(
  file: SourceFile,
  line: number,
  total: number,
): Finding {
  return {
    id: 'client-browser-sensitive-transfer-overflow',
    domain: 'security',
    severity: 'high',
    title: 'Additional browser privacy transfers exceed the evidence budget',
    message: 'Unsafe browser transfer calls are counted beyond the eight retained evidence entries.',
    location: { file: file.repositoryPath, line },
    evidence: { value: total - 7, metadata: { retainedIndividualFindings: 7 } },
    remediation: 'Eliminate every privacy-bearing transfer and retain bounded source-free evidence.',
    tags: ['privacy', 'browser', 'overflow'],
  };
}

/**
 * Fail-closed on unreviewable calls but do not treat a missing optional payload
 * as an active transfer. Bounded scopes and hashes are shared with client log
 * audit; no independent dataflow authority is introduced.
 */
export function auditClientBrowserTransferPrivacy(
  inventory: RepositoryInventory,
): AuditSection<ClientBrowserTransferPrivacySummary> {
  const started = performance.now();
  const files = inventory.files.filter(isClientRuntimeSource);
  const findings: Finding[] = [];
  const counts: Record<BrowserTransferSink, number> = {
    message: 0,
    beacon: 0,
    storage: 0,
    'url-history': 0,
  };
  let sensitiveCalls = 0;
  for (const file of files) {
    const lineIndex = createLineIndex(file.text);
    const classify = createClientPrivacyClassifier(file.text);
    const transfers = findTransferCalls(file.text);
    const firstFinding = findings.length;
    let fileUnsafe = 0;
    let overflowLine = 1;
    for (const call of transfers) {
      counts[call.kind] += 1;
      const data = call.arguments?.[call.dataArgument];
      const reason = call.arguments === null
        ? 'unreviewable-transfer-call'
        : data ? classify(data, call.position) : null;
      if (!reason) continue;
      sensitiveCalls += 1;
      fileUnsafe += 1;
      const line = lineIndex.lineAt(call.position);
      if (fileUnsafe === 8) overflowLine = line;
      if (fileUnsafe <= 8) {
        findings.push(finding(file, line, call.kind, reason));
      }
    }
    if (fileUnsafe > 8) {
      findings[firstFinding + 7] = overflowFinding(file, overflowLine, fileUnsafe);
    }
  }
  return {
    domain: 'security',
    title: 'Client browser transfer payload privacy',
    summary: {
      runtimeFiles: files.length,
      transferCalls: Object.values(counts).reduce((sum, count) => sum + count, 0),
      sensitiveCalls,
      messageCalls: counts.message,
      beaconCalls: counts.beacon,
      storageCalls: counts.storage,
      urlHistoryCalls: counts['url-history'],
      retainedFindings: findings.length,
    },
    findings: stableSortFindings(findings),
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
