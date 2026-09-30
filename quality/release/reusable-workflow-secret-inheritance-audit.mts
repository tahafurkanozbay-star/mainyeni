import type { AuditSection, Finding, RepositoryInventory, SourceFile } from './contracts.mts';
import { stableSortFindings } from './contracts.mts';

export interface ReusableSecretInheritanceSignal {
  readonly file: string;
  readonly job: string;
  readonly line: number;
  readonly target: string;
  readonly local: boolean;
  readonly inheritsSecrets: boolean;
  readonly hasUntrustedInputs: boolean;
  readonly hasWritePermission: boolean;
}

export interface ReusableSecretInheritanceSummary {
  readonly workflowFiles: number;
  readonly reusableCalls: number;
  readonly inheritedSecretCalls: number;
  readonly signals: readonly ReusableSecretInheritanceSignal[];
  readonly findings: readonly Finding[];
}

interface PhysicalLine {
  readonly text: string;
  readonly line: number;
  readonly indent: number;
}

interface JobBlock {
  readonly file: SourceFile;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly indent: number;
  readonly lines: readonly PhysicalLine[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const JOBS = /^\s*jobs\s*:\s*(?:#.*)?$/i;
const MAPPING = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const USES = /^\s*uses\s*:\s*([^#]+?)(?:\s+#.*)?$/i;
const SECRETS_INHERIT = /^\s*secrets\s*:\s*inherit\s*(?:#.*)?$/i;
const REUSABLE = /(?:^\.\/\.github\/workflows\/[^\s#]+\.ya?ml$|^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[^\s#]+\.ya?ml@[^\s#]+$)/i;
const LOCAL = /^\.\/\.github\/workflows\//i;
const UNTRUSTED = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|github\.event\.inputs\.|inputs\.)/i;
const WRITE_PERMISSION = /\b(?:actions|attestations|checks|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|repository-projects|security-events|statuses)\s*:\s*write\b/i;

function indentOf(text: string): number {
  return text.match(/^\s*/)?.[0].length ?? 0;
}

function physicalLines(text: string): PhysicalLine[] {
  return text.split(/\r?\n/).map((line, index) => ({ text: line, line: index + 1, indent: indentOf(line) }));
}

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function jobBlocks(file: SourceFile): JobBlock[] {
  const lines = physicalLines(file.text);
  const jobsIndex = lines.findIndex(line => JOBS.test(line.text));
  if (jobsIndex < 0) return [];
  const jobsLine = lines[jobsIndex]!;
  let jobIndent: number | undefined;
  const headers: Array<{ name: string; index: number; indent: number }> = [];

  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const current = lines[index]!;
    if (current.text.trim() && current.indent <= jobsLine.indent) break;
    const match = current.text.match(MAPPING);
    if (!match || !current.text.trim() || current.text.trim().startsWith('#')) continue;
    if (jobIndent === undefined) jobIndent = current.indent;
    if (current.indent !== jobIndent) continue;
    const name = match[1];
    if (name) headers.push({ name, index, indent: current.indent });
  }

  return headers.map((header, position) => {
    const next = headers[position + 1];
    const end = next?.index ?? lines.length;
    return {
      file,
      name: header.name,
      start: header.index,
      end,
      indent: header.indent,
      lines: lines.slice(header.index, end),
    };
  });
}

function field(block: JobBlock, key: string): PhysicalLine | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*:`, 'i');
  return block.lines.find((line, index) => index > 0 && line.indent > block.indent && pattern.test(line.text));
}

function usesTarget(block: JobBlock): string | undefined {
  const line = field(block, 'uses');
  const value = line?.text.match(USES)?.[1]?.trim();
  return value && REUSABLE.test(value) ? value : undefined;
}

function inheritedSecrets(block: JobBlock): boolean {
  return block.lines.some(line => line.indent > block.indent && SECRETS_INHERIT.test(line.text));
}

function blockForField(block: JobBlock, key: string): readonly PhysicalLine[] {
  const header = field(block, key);
  if (!header) return [];
  const result: PhysicalLine[] = [];
  for (const line of block.lines) {
    if (line.line <= header.line) continue;
    if (line.text.trim() && line.indent <= header.indent) break;
    result.push(line);
  }
  return result;
}

function untrustedInputs(block: JobBlock): boolean {
  return blockForField(block, 'with').some(line => UNTRUSTED.test(line.text));
}

function writeAuthority(block: JobBlock): boolean {
  const permission = field(block, 'permissions');
  if (!permission) return false;
  if (/permissions\s*:\s*write-all\b/i.test(permission.text)) return true;
  return blockForField(block, 'permissions').some(line => WRITE_PERMISSION.test(line.text));
}

function signal(block: JobBlock): ReusableSecretInheritanceSignal | undefined {
  const target = usesTarget(block);
  if (!target) return undefined;
  const uses = field(block, 'uses');
  return {
    file: block.file.repositoryPath,
    job: block.name,
    line: uses?.line ?? block.lines[0]?.line ?? 1,
    target,
    local: LOCAL.test(target),
    inheritsSecrets: inheritedSecrets(block),
    hasUntrustedInputs: untrustedInputs(block),
    hasWritePermission: writeAuthority(block),
  };
}

function finding(
  current: ReusableSecretInheritanceSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: current.file, line: current.line },
    evidence: { value: `${current.job} -> ${current.target}` },
    remediation,
    tags: ['ci', 'reusable-workflow', 'secrets', 'least-privilege', 'supply-chain'],
  };
}

function findingsFor(current: ReusableSecretInheritanceSignal): Finding[] {
  if (!current.inheritsSecrets) return [];
  const findings: Finding[] = [];
  if (!current.local) {
    findings.push(finding(
      current,
      'ci-reusable-external-secrets-inherit',
      'critical',
      'External reusable workflow inherits the caller secret namespace',
      `Job ${current.job} forwards every caller-visible secret to external reusable workflow ${current.target}. The callee receives credentials that were not explicitly reviewed at this call boundary.`,
      'Never use secrets: inherit for an external reusable workflow. Declare a narrow workflow_call secret contract and map only the exact named credentials required by the callee.',
      true,
    ));
  } else {
    findings.push(finding(
      current,
      'ci-reusable-local-secrets-inherit',
      current.hasWritePermission || current.hasUntrustedInputs ? 'critical' : 'high',
      'Reusable workflow inherits the entire caller secret namespace',
      `Job ${current.job} uses secrets: inherit instead of an explicit named secret contract. Repository-local reuse reduces supply-chain distance but does not provide least-privilege credential scoping.`,
      'Replace secrets: inherit with explicitly named secret mappings. Keep each reusable workflow credential contract purpose-specific and minimal.',
      current.hasWritePermission || current.hasUntrustedInputs,
    ));
  }

  if (current.hasUntrustedInputs) {
    findings.push(finding(
      current,
      'ci-reusable-inherited-secrets-untrusted-input',
      'critical',
      'Inherited secret namespace crosses an untrusted input boundary',
      `Job ${current.job} combines secrets: inherit with caller/event-controlled reusable-workflow inputs. A broad credential namespace is exposed to a callee processing externally influenced data.`,
      'Split untrusted input processing into a secretless read-only job. Pass only a validated closed identifier into a separate privileged workflow with explicit named secrets.',
      true,
    ));
  }

  if (current.hasWritePermission) {
    findings.push(finding(
      current,
      'ci-reusable-inherited-secrets-write-authority',
      'critical',
      'Inherited secret namespace is combined with repository write authority',
      `Job ${current.job} combines broad inherited credentials with explicit write permission, increasing blast radius if the called workflow or its inputs are compromised.`,
      'Use least-privilege permissions and explicit named secret mappings. Separate read/validate and mutate/publish stages across independently governed jobs.',
      true,
    ));
  }
  return findings;
}

export function auditReusableWorkflowSecretInheritance(
  inventory: RepositoryInventory,
): AuditSection<ReusableSecretInheritanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = files.flatMap(file => jobBlocks(file)).map(signal).filter((item): item is ReusableSecretInheritanceSignal => item !== undefined);
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Reusable workflow secret inheritance audit',
    summary: {
      workflowFiles: files.length,
      reusableCalls: signals.length,
      inheritedSecretCalls: signals.filter(item => item.inheritsSecrets).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
