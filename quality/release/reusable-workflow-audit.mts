import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface ReusableWorkflowSignal {
  readonly file: string;
  readonly callable: boolean;
  readonly inheritedSecretJobs: number;
  readonly dynamicReusableCalls: number;
  readonly mutableReusableCalls: number;
  readonly writePermissionJobs: number;
  readonly pullRequestTarget: boolean;
}

export interface ReusableWorkflowSummary {
  readonly workflows: readonly ReusableWorkflowSignal[];
  readonly callableWorkflows: number;
  readonly inheritedSecretJobs: number;
  readonly dynamicReusableCalls: number;
  readonly mutableReusableCalls: number;
  readonly findings: readonly Finding[];
}

interface PhysicalLine {
  readonly text: string;
  readonly offset: number;
  readonly line: number;
}

interface JobBlock {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly indent: number;
  readonly text: string;
}

const WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[^\s#]+\.ya?ml$/i;
const REUSABLE_REFERENCE = /^([^\s#@]+\/[^\s#@]+\/\.github\/workflows\/[^\s#@]+\.ya?ml)@([^\s#]+)$/i;
const WRITE_PERMISSION = /^(?:write|write-all)$/i;

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function physicalLines(text: string): PhysicalLine[] {
  const result: PhysicalLine[] = [];
  let offset = 0;
  const rawLines = text.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? '';
    result.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset, line: index + 1 });
    offset += raw.length + 1;
  }
  return result;
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function uncommented(line: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single && line[index - 1] !== '\\') double = !double;
    else if (char === '#' && !single && !double) return line.slice(0, index);
  }
  return line;
}

function scalarValue(line: string): string {
  const colon = line.indexOf(':');
  if (colon < 0) return '';
  return uncommented(line.slice(colon + 1)).trim().replace(/^['"]|['"]$/g, '');
}

function topLevelSection(lines: readonly PhysicalLine[], name: string): { start: number; end: number; indent: number } | undefined {
  const matcher = new RegExp(`^\\s*${name}\\s*:\\s*(?:#.*)?$`, 'i');
  const start = lines.findIndex(item => matcher.test(item.text));
  if (start < 0) return undefined;
  const indent = indentation(lines[start]!.text);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.text;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentation(line) <= indent && /^\s*[A-Za-z0-9_-]+\s*:/.test(line)) { end = index; break; }
  }
  return { start, end, indent };
}

function hasEvent(lines: readonly PhysicalLine[], event: string): boolean {
  const on = topLevelSection(lines, 'on');
  if (!on) return lines.some(item => new RegExp(`^\\s*on\\s*:\\s*${event}\\s*(?:#.*)?$`, 'i').test(item.text));
  const matcher = new RegExp(`^\\s*${event}\\s*:`, 'i');
  return lines.slice(on.start + 1, on.end).some(item => matcher.test(item.text));
}

function jobBlocks(lines: readonly PhysicalLine[]): JobBlock[] {
  const jobs = topLevelSection(lines, 'jobs');
  if (!jobs) return [];
  const blocks: JobBlock[] = [];
  let current: { name: string; start: number; indent: number } | undefined;
  for (let index = jobs.start + 1; index < jobs.end; index += 1) {
    const line = lines[index]!.text;
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/);
    if (!match) continue;
    const indent = match[1]!.length;
    if (indent <= jobs.indent) continue;
    if (current && indent === current.indent) {
      blocks.push({ ...current, end: index, text: lines.slice(current.start, index).map(item => item.text).join('\n') });
      current = { name: match[2]!, start: index, indent };
    } else if (!current) current = { name: match[2]!, start: index, indent };
  }
  if (current) blocks.push({ ...current, end: jobs.end, text: lines.slice(current.start, jobs.end).map(item => item.text).join('\n') });
  return blocks;
}

function finding(file: SourceFile, index: number, values: Omit<Finding, 'location' | 'evidence'>): Finding {
  const lineIndex = createLineIndex(file.text);
  return {
    ...values,
    location: { file: file.repositoryPath, line: lineIndex.lineAt(index) },
    evidence: { excerpt: snippetAround(file.text, index, 180) },
  };
}

function indexInFile(file: SourceFile, lines: readonly PhysicalLine[], lineIndex: number): number {
  return lines[lineIndex]?.offset ?? Math.max(0, file.text.length - 1);
}

function auditFile(file: SourceFile): { signal: ReusableWorkflowSignal; findings: Finding[] } {
  const lines = physicalLines(file.text);
  const jobs = jobBlocks(lines);
  const findings: Finding[] = [];
  const callable = hasEvent(lines, 'workflow_call');
  const pullRequestTarget = hasEvent(lines, 'pull_request_target');
  let inheritedSecretJobs = 0;
  let dynamicReusableCalls = 0;
  let mutableReusableCalls = 0;
  let writePermissionJobs = 0;

  for (const job of jobs) {
    const jobLines = lines.slice(job.start, job.end);
    const inherited = jobLines.findIndex(item => /^\s*secrets\s*:\s*inherit\s*(?:#.*)?$/i.test(item.text));
    if (inherited >= 0) {
      inheritedSecretJobs += 1;
      const absoluteLine = job.start + inherited;
      findings.push(finding(file, indexInFile(file, lines, absoluteLine), {
        id: 'ci-reusable-secrets-inherit', domain: 'security', severity: 'high', blocking: true,
        title: 'Reusable workflow job inherits the caller secret set',
        message: `Job ${job.name} uses secrets: inherit, widening secret exposure beyond an explicit reviewed contract.`,
        remediation: 'Declare the minimum named secrets required by the called workflow and map only those secrets at the caller.',
        tags: ['ci', 'reusable-workflow', 'secrets', 'least-privilege'],
      }));
    }

    const usesIndex = jobLines.findIndex(item => /^\s*uses\s*:/.test(item.text));
    if (usesIndex >= 0) {
      const absoluteLine = job.start + usesIndex;
      const reference = scalarValue(jobLines[usesIndex]!.text);
      if (EXPRESSION.test(reference)) {
        dynamicReusableCalls += 1;
        findings.push(finding(file, indexInFile(file, lines, absoluteLine), {
          id: 'ci-reusable-dynamic-identity', domain: 'security', severity: 'critical', blocking: true,
          title: 'Reusable workflow identity is expression-derived',
          message: `Job ${job.name} constructs its reusable workflow identity dynamically, bypassing immutable source review.`,
          remediation: 'Use a literal local workflow path or an external owner/repository workflow pinned to a full commit SHA.',
          tags: ['ci', 'reusable-workflow', 'supply-chain', 'expression-injection'],
        }));
      } else if (!LOCAL_WORKFLOW.test(reference)) {
        const parsed = reference.match(REUSABLE_REFERENCE);
        if (parsed && !FULL_SHA.test(parsed[2] ?? '')) {
          mutableReusableCalls += 1;
          findings.push(finding(file, indexInFile(file, lines, absoluteLine), {
            id: 'ci-reusable-mutable-ref', domain: 'security', severity: 'critical', blocking: true,
            title: 'External reusable workflow uses a mutable reference',
            message: `Job ${job.name} calls ${parsed[1]} using mutable ref ${parsed[2]}.`,
            remediation: 'Pin external reusable workflows to an immutable 40-character commit SHA.',
            tags: ['ci', 'reusable-workflow', 'supply-chain', 'immutable-pin'],
          }));
        }
      }
    }

    const permissionHeader = jobLines.findIndex(item => /^\s*permissions\s*:/.test(item.text));
    if (permissionHeader >= 0) {
      const headerLine = jobLines[permissionHeader]!;
      const inline = scalarValue(headerLine.text);
      let writes = WRITE_PERMISSION.test(inline);
      if (!writes && inline === '') {
        const baseIndent = indentation(headerLine.text);
        for (let offset = permissionHeader + 1; offset < jobLines.length; offset += 1) {
          const candidate = jobLines[offset]!.text;
          if (!candidate.trim() || candidate.trimStart().startsWith('#')) continue;
          if (indentation(candidate) <= baseIndent) break;
          if (/^\s*[A-Za-z0-9_-]+\s*:\s*write\s*(?:#.*)?$/i.test(candidate)) { writes = true; break; }
        }
      }
      if (writes) {
        writePermissionJobs += 1;
        if (callable || pullRequestTarget) {
          const absoluteLine = job.start + permissionHeader;
          findings.push(finding(file, indexInFile(file, lines, absoluteLine), {
            id: 'ci-reusable-privileged-job', domain: 'security', severity: pullRequestTarget ? 'critical' : 'high', blocking: true,
            title: 'Externally triggerable workflow grants job write permission',
            message: `Job ${job.name} grants write permission in a workflow callable from another workflow or pull_request_target.`,
            remediation: 'Default to read-only permissions and isolate the minimal write operation behind a separately reviewed trusted workflow.',
            tags: ['ci', 'reusable-workflow', 'permissions', 'least-privilege'],
          }));
        }
      }
    }
  }

  if (pullRequestTarget) {
    const checkout = lines.findIndex(item => /^\s*-?\s*uses\s*:\s*actions\/checkout@/i.test(item.text));
    const headRef = lines.findIndex(item => /github\.event\.pull_request\.head\.(?:sha|ref)/.test(item.text));
    if (checkout >= 0 && headRef >= 0) {
      findings.push(finding(file, indexInFile(file, lines, Math.min(checkout, headRef)), {
        id: 'ci-pr-target-untrusted-checkout', domain: 'security', severity: 'critical', blocking: true,
        title: 'pull_request_target workflow checks out attacker-controlled pull request code',
        message: 'pull_request_target executes in a privileged base-repository context; checking out pull-request head code can expose write tokens or secrets to attacker-controlled code.',
        remediation: 'Do not execute pull-request head code in pull_request_target. Use pull_request for untrusted validation and a separate trusted workflow for privileged actions.',
        tags: ['ci', 'pull-request-target', 'checkout', 'privilege-boundary'],
      }));
    }
  }

  return {
    signal: { file: file.repositoryPath, callable, inheritedSecretJobs, dynamicReusableCalls, mutableReusableCalls, writePermissionJobs, pullRequestTarget },
    findings,
  };
}

export function auditReusableWorkflows(inventory: RepositoryInventory): AuditSection<ReusableWorkflowSummary> {
  const start = performance.now();
  const results = workflowFiles(inventory).map(auditFile);
  const workflows = results.map(result => result.signal);
  const findings = stableSortFindings(results.flatMap(result => result.findings));
  return {
    domain: 'security',
    title: 'Reusable workflow trust-boundary audit',
    summary: {
      workflows,
      callableWorkflows: workflows.filter(item => item.callable).length,
      inheritedSecretJobs: workflows.reduce((sum, item) => sum + item.inheritedSecretJobs, 0),
      dynamicReusableCalls: workflows.reduce((sum, item) => sum + item.dynamicReusableCalls, 0),
      mutableReusableCalls: workflows.reduce((sum, item) => sum + item.mutableReusableCalls, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
