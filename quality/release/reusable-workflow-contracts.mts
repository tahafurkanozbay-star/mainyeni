import type { Finding, RepositoryInventory, SourceFile } from './contracts.mts';
import {
  blockScalarLines,
  firstWorkflowField,
  hasSecretReference,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  physicalLines,
  unquoteYamlScalar,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';
import { parseUsesIdentity } from './workflow-step-structure.mts';

export interface ReusableContractSummary {
  readonly callableWorkflows: number;
  readonly declaredInputs: number;
  readonly declaredSecrets: number;
  readonly declaredOutputs: number;
  readonly reusableCallJobs: number;
  readonly secretInputMappings: number;
  readonly mixedTrustCallJobs: number;
  readonly findings: readonly Finding[];
}

interface DeclaredField {
  readonly name: string;
  readonly line: number;
  readonly text: string;
}

interface CallContract {
  readonly file: SourceFile;
  readonly callable: boolean;
  readonly inputs: readonly DeclaredField[];
  readonly secrets: readonly DeclaredField[];
  readonly outputs: readonly DeclaredField[];
}

const MAPPING = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const SENSITIVE_NAME = /(?:^|[-_.])(?:secret|token|password|passwd|credential|private[-_]?key|api[-_]?key|access[-_]?key|client[-_]?secret)(?:$|[-_.])/i;
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\.[A-Za-z0-9_.-]+[\s\S]*?\}\}/i;
const UNTRUSTED_VALUE = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.)/i;
const JOB_OUTPUT = /\$\{\{\s*jobs\.[A-Za-z0-9_.-]+\.outputs\.[A-Za-z0-9_.-]+\s*\}\}/i;
const DIRECT_SECRET_OUTPUT = /\$\{\{[\s\S]*?secrets\./i;

function childIndent(lines: readonly WorkflowLine[], parentIndent: number): number | undefined {
  let result: number | undefined;
  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('#') || line.indent <= parentIndent) continue;
    if (!MAPPING.test(line.text)) continue;
    if (result === undefined || line.indent < result) result = line.indent;
  }
  return result;
}

function nestedBlock(
  lines: readonly WorkflowLine[],
  key: string,
  parentIndent: number,
): { readonly header: WorkflowLine; readonly lines: readonly WorkflowLine[] } | undefined {
  const indent = childIndent(lines, parentIndent);
  if (indent === undefined) return undefined;
  const header = lines.find(line => line.indent === indent && new RegExp(`^\\s*${key}\\s*:\\s*(?:#.*)?$`, 'i').test(line.text));
  if (!header) return undefined;
  const nested: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= header.line) continue;
    if (line.trimmed && line.indent <= header.indent) break;
    nested.push(line);
  }
  return { header, lines: nested };
}

function workflowCallBlock(file: SourceFile): { readonly header: WorkflowLine; readonly lines: readonly WorkflowLine[] } | undefined {
  const on = workflowTopLevelBlock(file, 'on');
  if (!on || on.value) return undefined;
  return nestedBlock(on.lines, 'workflow_call', on.line.indent);
}

function declaredFields(
  call: { readonly header: WorkflowLine; readonly lines: readonly WorkflowLine[] },
  key: string,
): DeclaredField[] {
  const block = nestedBlock(call.lines, key, call.header.indent);
  if (!block) return [];
  const indent = childIndent(block.lines, block.header.indent);
  if (indent === undefined) return [];
  const result: DeclaredField[] = [];
  for (const line of block.lines) {
    if (line.indent !== indent) continue;
    const match = line.text.match(MAPPING);
    const name = match?.[1];
    if (!name) continue;
    const nested: string[] = [line.text];
    for (const candidate of block.lines) {
      if (candidate.line <= line.line) continue;
      if (candidate.trimmed && candidate.indent <= line.indent) break;
      nested.push(candidate.text);
    }
    result.push({ name, line: line.line, text: nested.join('\n') });
  }
  return result;
}

function contract(file: SourceFile): CallContract {
  const call = workflowCallBlock(file);
  if (!call) return { file, callable: false, inputs: [], secrets: [], outputs: [] };
  return {
    file,
    callable: true,
    inputs: declaredFields(call, 'inputs'),
    secrets: declaredFields(call, 'secrets'),
    outputs: declaredFields(call, 'outputs'),
  };
}

function blockMapping(block: WorkflowJobBlock, key: string): ReadonlyMap<string, string> {
  const field = firstWorkflowField(block, key);
  if (!field) return new Map<string, string>();
  const lines = blockScalarLines(block, field);
  const indent = childIndent(lines, field.indent);
  const result = new Map<string, string>();
  if (indent === undefined) return result;
  for (const line of lines) {
    if (line.indent !== indent) continue;
    const match = line.text.match(MAPPING);
    const name = match?.[1];
    if (!name) continue;
    result.set(name, unquoteYamlScalar(match?.[2] ?? ''));
  }
  return result;
}

function reusableCall(block: WorkflowJobBlock): boolean {
  const uses = firstWorkflowField(block, 'uses')?.value ?? '';
  return /\.github\/workflows\/[^\s#]+\.ya?ml(?:@[^\s#]+)?$/i.test(uses);
}

function localCall(block: WorkflowJobBlock): boolean {
  const uses = firstWorkflowField(block, 'uses')?.value ?? '';
  return parseUsesIdentity(uses).local;
}

function location(file: SourceFile, line: number) {
  return { file: file.repositoryPath, line };
}

function finding(
  file: SourceFile,
  line: number,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
  value?: string,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: location(file, line),
    ...(value ? { evidence: { value } } : {}),
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'reusable-workflow', 'contract', 'least-privilege'],
  };
}

function declarationFindings(current: CallContract): Finding[] {
  const findings: Finding[] = [];
  for (const input of current.inputs) {
    if (SENSITIVE_NAME.test(input.name)) {
      findings.push(finding(
        current.file,
        input.line,
        'ci-reusable-sensitive-input-channel',
        'high',
        'Reusable workflow declares a credential-shaped ordinary input',
        `workflow_call input ${input.name} looks credential-sensitive but ordinary inputs are caller data, not the dedicated secret contract.`,
        'Declare credentials under workflow_call.secrets and map only explicitly named secrets from the caller. Keep workflow_call.inputs for non-sensitive configuration.',
        false,
        input.name,
      ));
    }
    if (/\bdefault\s*:\s*\$\{\{/i.test(input.text)) {
      findings.push(finding(
        current.file,
        input.line,
        'ci-reusable-dynamic-input-default',
        'medium',
        'Reusable workflow input default is expression-derived',
        `Input ${input.name} uses a dynamic default, making caller contract behavior depend on ambient context rather than a literal schema default.`,
        'Use a literal default or require the caller to provide the value explicitly and validate it inside the called workflow.',
      ));
    }
  }

  for (const secret of current.secrets) {
    if (!SENSITIVE_NAME.test(secret.name)) {
      findings.push(finding(
        current.file,
        secret.line,
        'ci-reusable-secret-contract-review',
        'low',
        'Reusable workflow secret has a generic contract name',
        `Secret ${secret.name} does not communicate credential purpose clearly, making least-privilege caller review harder.`,
        'Use a purpose-specific secret contract name such as registry-token, deploy-key, or release-client-secret.',
      ));
    }
  }

  for (const output of current.outputs) {
    if (SENSITIVE_NAME.test(output.name) || DIRECT_SECRET_OUTPUT.test(output.text)) {
      findings.push(finding(
        current.file,
        output.line,
        'ci-reusable-sensitive-output',
        'critical',
        'Reusable workflow exposes a credential-shaped output',
        `workflow_call output ${output.name} can propagate sensitive material into caller-visible job outputs and logs.`,
        'Never return secrets, credentials, private keys, or tokens as reusable workflow outputs. Keep sensitive material inside the protected called workflow.',
        true,
        output.name,
      ));
    } else if (!JOB_OUTPUT.test(output.text)) {
      findings.push(finding(
        current.file,
        output.line,
        'ci-reusable-output-provenance-review',
        'medium',
        'Reusable workflow output lacks explicit job-output provenance',
        `Output ${output.name} is not visibly bound to jobs.<job>.outputs.<name>, making its producer and validation boundary harder to audit.`,
        'Bind workflow_call outputs to explicit job outputs whose producing step validates a narrow non-secret value schema.',
      ));
    }
  }
  return findings;
}

function callerFindings(block: WorkflowJobBlock): Finding[] {
  if (!reusableCall(block)) return [];
  const findings: Finding[] = [];
  const withMap = blockMapping(block, 'with');
  const secretsMap = blockMapping(block, 'secrets');
  const usesLine = firstWorkflowField(block, 'uses')?.line ?? block.startLine;
  const isLocal = localCall(block);

  for (const [name, value] of withMap) {
    if (SECRET_EXPRESSION.test(value) || hasSecretReference(value)) {
      findings.push(finding(
        block.file,
        usesLine,
        'ci-reusable-secret-through-input',
        isLocal ? 'high' : 'critical',
        'Secret is passed through reusable workflow ordinary input channel',
        `Caller job ${block.name} maps secret material into with.${name}. Ordinary workflow inputs can be logged, echoed, or returned as outputs by the callee.`,
        'Pass sensitive values through an explicitly declared named secrets contract, never through with inputs.',
        !isLocal,
        `${name}=${value}`,
      ));
    }
  }

  const untrustedInputs = [...withMap.entries()].filter(([, value]) => UNTRUSTED_VALUE.test(value) || hasUntrustedExpression(value));
  const secretBearing = secretsMap.size > 0 || jobHasSecrets(block);
  if (untrustedInputs.length > 0 && secretBearing) {
    findings.push(finding(
      block.file,
      usesLine,
      'ci-reusable-untrusted-input-secret-context',
      isLocal ? 'high' : 'critical',
      'Reusable workflow call combines untrusted inputs with secrets',
      `Caller job ${block.name} forwards contribution/caller-controlled data (${untrustedInputs.map(([name]) => name).join(', ')}) into the same reusable workflow call that receives secret material.`,
      'Separate untrusted data processing from secret-bearing reusable workflows. Validate and reduce inputs to a closed identifier schema before crossing the secret boundary.',
      !isLocal,
    ));
  }

  if (jobHasWriteAuthority(block) && untrustedInputs.length > 0) {
    findings.push(finding(
      block.file,
      usesLine,
      'ci-reusable-untrusted-input-write-context',
      isLocal ? 'high' : 'critical',
      'Reusable workflow call combines untrusted inputs with write authority',
      `Caller job ${block.name} has effective write permission while forwarding untrusted values into the called workflow.`,
      'Keep externally influenced caller jobs read-only. Perform mutations only after the called workflow independently validates trusted repository/ref/environment facts.',
      !isLocal,
    ));
  }

  return findings;
}

export function reusableWorkflowContractFindings(inventory: RepositoryInventory): {
  readonly summary: ReusableContractSummary;
  readonly findings: readonly Finding[];
} {
  const files = workflowFiles(inventory);
  const contracts = files.map(contract);
  const callJobs = files.flatMap(file => workflowJobBlocks(file)).filter(reusableCall);
  const findings = [
    ...contracts.flatMap(declarationFindings),
    ...callJobs.flatMap(callerFindings),
  ];
  const secretInputMappings = callJobs.reduce((count, block) =>
    count + [...blockMapping(block, 'with').values()].filter(value => SECRET_EXPRESSION.test(value)).length, 0);
  const mixedTrustCallJobs = callJobs.filter(block => {
    const untrusted = [...blockMapping(block, 'with').values()].some(value => UNTRUSTED_VALUE.test(value));
    return untrusted && jobHasSecrets(block);
  }).length;
  return {
    summary: {
      callableWorkflows: contracts.filter(item => item.callable).length,
      declaredInputs: contracts.reduce((sum, item) => sum + item.inputs.length, 0),
      declaredSecrets: contracts.reduce((sum, item) => sum + item.secrets.length, 0),
      declaredOutputs: contracts.reduce((sum, item) => sum + item.outputs.length, 0),
      reusableCallJobs: callJobs.length,
      secretInputMappings,
      mixedTrustCallJobs,
      findings,
    },
    findings,
  };
}
