import {
  stableSortFindings,
  uniqueStrings,
  type AuditSection,
  type ExternalReference,
  type Finding,
  type NetworkSummary,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, selectWebSource, snippetAround } from './inventory.mts';

const URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>)}\]]+/gi;
const URL_IN_TEMPLATE_PATTERN = /https?:\/\/[^\s`$<>)}\]]+/gi;
const REMOTE_STYLE_PATTERN = /@import\s+(?:url\()?\s*['"]?(https?:\/\/[^'"\s)]+)/gi;
const NETWORK_CALL_PATTERN = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|XMLHttpRequest|QueryTask)\b/g;
const DIRECT_FETCH_PATTERN = /\bfetch\s*\(/g;
const ABSOLUTE_FETCH_PATTERN = /\bfetch\s*\(\s*['"`]https?:\/\//gi;

const ALLOWED_DOCUMENTATION_HOSTS = new Set([
  'github.com',
  'docs.github.com',
  'nodejs.org',
  'react.dev',
  'vite.dev',
  'typescriptlang.org',
  'learn.microsoft.com',
]);

export interface NetworkCallSignal {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly excerpt: string;
}

export interface NetworkAuditDetails extends NetworkSummary {
  readonly calls: readonly NetworkCallSignal[];
  readonly directFetchCalls: number;
  readonly absoluteFetchCalls: number;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(stripTrailingPunctuation(raw));
  } catch {
    return null;
  }
}

function classifyReference(file: SourceFile, url: URL): ExternalReference['category'] {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (/fonts\.(?:googleapis|gstatic)\.com$/.test(host)) return 'font';
  if (/analytics|telemetry|segment|mixpanel|hotjar|clarity|gtag|google-analytics/.test(host + path)) return 'analytics';
  if (/arcgis|esri|map|tiles?|scene|terrain/.test(host + path)) return 'map';
  if (/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|woff2?|ttf|otf)(?:$|\?)/i.test(path + url.search)) return 'asset';
  if (file.repositoryPath.includes('/Business/') || file.repositoryPath.includes('/api/')) return 'api';
  return 'unknown';
}

function extractReferences(file: SourceFile): ExternalReference[] {
  const references: ExternalReference[] = [];
  const lineIndex = createLineIndex(file.text);
  const patterns = [URL_PATTERN, URL_IN_TEMPLATE_PATTERN, REMOTE_STYLE_PATTERN];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(file.text)) !== null) {
      const raw = String(match[1] ?? match[0]);
      const url = safeUrl(raw);
      if (!url) continue;
      const line = lineIndex.lineAt(match.index);
      const key = `${line}|${url.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({
        source: file.repositoryPath,
        line,
        raw,
        protocol: url.protocol,
        host: url.hostname.toLowerCase(),
        path: `${url.pathname}${url.search}`,
        category: classifyReference(file, url),
      });
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return references;
}

function extractCalls(file: SourceFile): NetworkCallSignal[] {
  const calls: NetworkCallSignal[] = [];
  const lineIndex = createLineIndex(file.text);
  const matcher = new RegExp(NETWORK_CALL_PATTERN.source, NETWORK_CALL_PATTERN.flags.includes('g') ? NETWORK_CALL_PATTERN.flags : 'g');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    calls.push({
      file: file.repositoryPath,
      line: lineIndex.lineAt(match.index),
      kind: match[0],
      excerpt: snippetAround(file.text, match.index, 100),
    });
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return calls;
}

function isRuntimeFile(path: string): boolean {
  return /^(?:Webclient\.app\/src|Webclient\.Admin\/src)\//.test(path);
}

function insecureFinding(reference: ExternalReference): Finding | null {
  if (reference.protocol !== 'http:') return null;
  return {
    id: 'network-insecure-http',
    domain: 'network',
    severity: 'high',
    title: 'Plain HTTP external reference',
    message: 'Runtime network traffic must not depend on plain HTTP.',
    location: { file: reference.source, line: reference.line },
    evidence: { value: reference.raw },
    remediation: 'Verify the real service supports HTTPS or route through the existing same-origin backend/proxy.',
    tags: ['transport', reference.category],
  };
}

function remoteAssetFinding(reference: ExternalReference): Finding | null {
  if (!['asset', 'font'].includes(reference.category)) return null;
  if (!isRuntimeFile(reference.source)) return null;
  return {
    id: reference.category === 'font' ? 'network-remote-font' : 'network-remote-runtime-asset',
    domain: 'network',
    severity: reference.category === 'font' ? 'medium' : 'low',
    title: reference.category === 'font' ? 'Remote font dependency' : 'Remote runtime asset',
    message: 'Remote presentation dependencies add privacy, availability, cache and startup risk.',
    location: { file: reference.source, line: reference.line },
    evidence: { value: reference.raw },
    remediation: 'Prefer repository-local optimized assets unless the external dependency is explicitly justified.',
    tags: ['asset', 'privacy', 'performance'],
  };
}

function analyticsFinding(reference: ExternalReference): Finding | null {
  if (reference.category !== 'analytics' || !isRuntimeFile(reference.source)) return null;
  return {
    id: 'network-third-party-analytics',
    domain: 'network',
    severity: 'high',
    title: 'Third-party analytics/telemetry endpoint',
    message: 'Unexpected analytics or telemetry can create privacy, availability and compliance risk.',
    location: { file: reference.source, line: reference.line },
    evidence: { value: reference.raw },
    remediation: 'Use approved first-party bounded telemetry, with explicit data minimization and retention.',
    tags: ['privacy', 'telemetry'],
  };
}

function documentationReferenceFinding(reference: ExternalReference): Finding | null {
  if (isRuntimeFile(reference.source)) return null;
  if (ALLOWED_DOCUMENTATION_HOSTS.has(reference.host)) return null;
  if (reference.category !== 'unknown') return null;
  return null;
}

function countPattern(files: readonly SourceFile[], pattern: RegExp): number {
  let count = 0;
  for (const file of files) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const _match of file.text.matchAll(matcher)) count += 1;
  }
  return count;
}

function directTransportFindings(webFiles: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of webFiles) {
    if (!file.repositoryPath.includes('/src/')) continue;
    if (/platform\/http|apiClient|QueryTask|Business\//.test(file.repositoryPath)) continue;
    const lineIndex = createLineIndex(file.text);
    const matcher = new RegExp(DIRECT_FETCH_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    let emitted = 0;
    while ((match = matcher.exec(file.text)) !== null) {
      findings.push({
        id: 'network-direct-fetch-outside-transport',
        domain: 'network',
        severity: 'medium',
        title: 'Direct fetch outside shared transport',
        message: 'Direct fetch calls can bypass timeout, cancellation, retry, telemetry and error normalization policy.',
        location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
        evidence: { excerpt: snippetAround(file.text, match.index, 100) },
        remediation: 'Route calls through the shared platform transport when semantics are compatible.',
        tags: ['fetch', 'transport'],
      });
      emitted += 1;
      if (emitted >= 8) break;
    }
  }
  return findings;
}

export function auditNetwork(inventory: RepositoryInventory): AuditSection<NetworkAuditDetails> {
  const start = performance.now();
  const webFiles = selectWebSource(inventory).filter(file => !file.repositoryPath.startsWith('quality/release/'));
  const references = webFiles.flatMap(extractReferences);
  const calls = webFiles.flatMap(extractCalls);
  const findings: Finding[] = [];

  for (const reference of references) {
    const insecure = insecureFinding(reference);
    if (insecure) findings.push(insecure);
    const remoteAsset = remoteAssetFinding(reference);
    if (remoteAsset) findings.push(remoteAsset);
    const analytics = analyticsFinding(reference);
    if (analytics) findings.push(analytics);
    const documentation = documentationReferenceFinding(reference);
    if (documentation) findings.push(documentation);
  }
  findings.push(...directTransportFindings(webFiles));

  const absoluteFetchCalls = countPattern(webFiles, ABSOLUTE_FETCH_PATTERN);
  const directFetchCalls = countPattern(webFiles, DIRECT_FETCH_PATTERN);
  if (absoluteFetchCalls > 0) {
    findings.push({
      id: 'network-absolute-fetch-summary',
      domain: 'network',
      severity: 'high',
      title: 'Absolute fetch URL usage',
      message: 'Absolute browser fetch URLs should be reviewed for same-origin/BFF policy compliance.',
      evidence: { value: absoluteFetchCalls },
      remediation: 'Use configured same-origin transport unless the external browser dependency is explicitly required.',
      tags: ['browser-boundary'],
    });
  }

  const sorted = stableSortFindings(findings);
  const hosts = uniqueStrings(references.map(reference => reference.host));
  return {
    domain: 'network',
    title: 'Network boundary and external dependency audit',
    summary: {
      references,
      hosts,
      insecureCount: references.filter(reference => reference.protocol === 'http:').length,
      remoteAssetCount: references.filter(reference => ['asset', 'font'].includes(reference.category)).length,
      findings: sorted,
      calls,
      directFetchCalls,
      absoluteFetchCalls,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
