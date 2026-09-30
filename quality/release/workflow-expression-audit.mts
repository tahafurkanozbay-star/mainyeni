import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';
import { auditActionCredentialBoundaries } from './action-credential-boundary-audit.mts';
import { auditActionInputBoundaries } from './action-input-boundary-audit.mts';
import { auditArchiveExtractionBoundaries } from './archive-extraction-boundary-audit.mts';
import { auditArtifactExecutionBoundaries } from './artifact-execution-boundary-audit.mts';
import { auditArtifactProducerProvenance } from './artifact-producer-provenance-audit.mts';
import { auditCheckoutBoundaries } from './checkout-boundary-audit.mts';
import { auditConcurrencyBoundaries } from './concurrency-boundary-audit.mts';
import { auditDependencyLifecycle } from './dependency-lifecycle-audit.mts';
import { auditGitOperationBoundaries } from './git-operation-boundary-audit.mts';
import { auditGitHubMutationBoundaries } from './github-mutation-boundary-audit.mts';
import { auditJobResourceBoundaries } from './job-resource-boundary-audit.mts';
import { auditOidcAuthority } from './oidc-authority-audit.mts';
import { auditPackageRegistryBoundaries } from './package-registry-boundary-audit.mts';
import { auditPrivilegedConditions } from './privileged-condition-audit.mts';
import { auditProcessEnvironmentBoundaries } from './process-env-boundary-audit.mts';
import { auditPublicationRefBoundaries } from './publication-ref-boundary-audit.mts';
import { reusableWorkflowContractFindings } from './reusable-workflow-contracts.mts';
import { auditRunnerTrustBoundaries } from './runner-trust-boundary-audit.mts';
import { auditShellBoundaries } from './shell-boundary-audit.mts';
import { auditTokenPermissionBoundaries } from './token-permission-boundary-audit.mts';
import { auditUntrustedEnvExecution } from './untrusted-env-execution-audit.mts';
import { auditWorkingDirectoryBoundaries } from './working-directory-boundary-audit.mts';
import { auditWorkflowAuthority } from './workflow-authority-audit.mts';
import { auditWorkflowCommandFiles } from './workflow-command-file-audit.mts';
import { auditWorkflowEnvironmentApprovals } from './workflow-environment-approval-audit.mts';
import { auditWorkflowFailureIntegrity } from './workflow-failure-integrity-audit.mts';
import { auditWorkflowManualInputBoundaries } from './workflow-manual-input-boundary-audit.mts';
import { auditWorkflowNetworkProvenance } from './workflow-network-provenance-audit.mts';
import { auditWorkflowOutputProvenance } from './workflow-output-provenance-audit.mts';
import { auditWorkflowPromotionIntegrity } from './workflow-promotion-integrity-audit.mts';
import { auditWorkflowRunEventChains } from './workflow-run-event-chain-audit.mts';
import { auditWorkflowRunSourceProvenance } from './workflow-run-source-provenance-audit.mts';
import { auditWorkflowSecretExposure } from './workflow-secret-exposure-audit.mts';

export interface WorkflowExpressionSignal {
  readonly file: string;
  readonly executableExpressions: number;
  readonly attackerControlledExpressions: number;
  readonly dynamicUses: number;
  readonly dynamicShells: number;
  readonly dynamicContainers: number;
  readonly githubScriptExpressions: number;
}

export interface WorkflowExpressionSummary {
  readonly workflows: readonly WorkflowExpressionSignal[];
  readonly workflowFiles: number;
  readonly executableExpressions: number;
  readonly attackerControlledExpressions: number;
  readonly findings: readonly Finding[];
}

type ExecutableKey = 'run' | 'shell' | 'uses' | 'image' | 'script';

interface ExecutableExpression {
  readonly key: ExecutableKey;
  readonly expression: string;
  readonly index: number;
  readonly attackerControlled: boolean;
}

interface PhysicalLine {
  readonly text: string;
  readonly offset: number;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const ATTACKER_SOURCE = /\b(?:github\.event\.(?:pull_request\.(?:title|body|head\.ref)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.message|commits|inputs\.)|github\.head_ref|inputs\.)\b/i;
const EXECUTABLE_KEY = /^\s*(?:-\s+)?(run|shell|uses|image)\s*:\s*(.*)$/i;
const GITHUB_SCRIPT_STEP = /^\s*-\s+uses\s*:\s*actions\/github-script@[0-9a-f]{40}(?:\s*(?:#.*)?)$/i;
const SCRIPT_KEY = /^\s*script\s*:\s*(.*)$/i;
const BLOCK_SCALAR = /^[>|][+-]?\s*(?:#.*)?$/;

function workflowSourceFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function physicalLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text: line, offset });
    offset += raw.length + 1;
  }
  return lines;
}

function expressionsIn(text: string, offset: number, key: ExecutableKey): ExecutableExpression[] {
  const results: ExecutableExpression[] = [];
  const matcher = new RegExp(EXPRESSION.source, EXPRESSION.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const expression = (match[1] ?? '').trim();
    results.push({
      key,
      expression,
      index: offset + match.index,
      attackerControlled: ATTACKER_SOURCE.test(expression),
    });
  }
  return results;
}

function blockExpressions(
  lines: readonly PhysicalLine[],
  lineNumber: number,
  indent: number,
  key: ExecutableKey,
): ExecutableExpression[] {
  let block = '';
  let blockOffset: number | undefined;
  for (let next = lineNumber + 1; next < lines.length; next += 1) {
    const candidate = lines[next]!;
    if (candidate.text.trim() && indentation(candidate.text) <= indent) break;
    if (blockOffset === undefined) blockOffset = candidate.offset;
    block += `${candidate.text}\n`;
  }
  return blockOffset === undefined ? [] : expressionsIn(block, blockOffset, key);
}

function executableExpressions(file: SourceFile): ExecutableExpression[] {
  const lines = physicalLines(file.text);
  const results: ExecutableExpression[] = [];
  let githubScriptStepIndent: number | undefined;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const current = lines[lineNumber]!;
    const line = current.text;
    const trimmed = line.trim();
    const indent = indentation(line);

    if (GITHUB_SCRIPT_STEP.test(line)) {
      githubScriptStepIndent = indent;
    } else if (
      githubScriptStepIndent !== undefined
      && trimmed
      && indent <= githubScriptStepIndent
      && /^\s*-\s+/.test(line)
    ) {
      githubScriptStepIndent = undefined;
    }

    const executable = line.match(EXECUTABLE_KEY);
    if (executable) {
      const key = (executable[1] ?? '').toLowerCase() as Exclude<ExecutableKey, 'script'>;
      const value = executable[2] ?? '';
      results.push(...expressionsIn(value, current.offset + line.indexOf(value), key));
      if (BLOCK_SCALAR.test(value.trim())) {
        results.push(...blockExpressions(lines, lineNumber, indent, key));
      }
    }

    if (githubScriptStepIndent !== undefined) {
      const script = line.match(SCRIPT_KEY);
      if (script && indent > githubScriptStepIndent) {
        const value = script[1] ?? '';
        results.push(...expressionsIn(value, current.offset + line.indexOf(value), 'script'));
        if (BLOCK_SCALAR.test(value.trim())) {
          results.push(...blockExpressions(lines, lineNumber, indent, 'script'));
        }
      }
    }
  }

  return results;
}

function findingFor(file: SourceFile, expression: ExecutableExpression): Finding | undefined {
  const location = {
    file: file.repositoryPath,
    line: createLineIndex(file.text).lineAt(expression.index),
  };
  const evidence = { excerpt: snippetAround(file.text, expression.index, 140) };

  if (expression.key === 'uses') {
    return {
      id: 'ci-workflow-dynamic-action',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Workflow dynamically constructs an action identity',
      message: 'Expression-derived uses values can redirect execution outside the reviewed immutable action identity.',
      location,
      evidence,
      remediation: 'Use a literal immutable action identity.',
      tags: ['ci', 'workflow', 'supply-chain'],
    };
  }

  if (expression.key === 'shell') {
    return {
      id: 'ci-workflow-dynamic-shell',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Workflow dynamically selects its shell',
      message: 'Expression-derived shell selection changes the interpreter.',
      location,
      evidence,
      remediation: 'Use a literal reviewed shell.',
      tags: ['ci', 'workflow', 'shell'],
    };
  }

  if (expression.key === 'image') {
    return {
      id: 'ci-workflow-dynamic-container',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Workflow dynamically selects a container image',
      message: 'Expression-derived image identity replaces the reviewed environment.',
      location,
      evidence,
      remediation: 'Use a literal immutable digest.',
      tags: ['ci', 'workflow', 'container'],
    };
  }

  if (!expression.attackerControlled) return undefined;
  return {
    id: expression.key === 'script'
      ? 'ci-workflow-github-script-injection'
      : 'ci-workflow-shell-injection',
    domain: 'security',
    severity: 'critical',
    blocking: true,
    title: 'Workflow interpolates attacker-controlled data into executable source',
    message: 'Attacker-controlled event/input text is expanded before executable parsing.',
    location,
    evidence,
    remediation: 'Pass untrusted values through env and consume them as data.',
    tags: ['ci', 'workflow', 'expression-injection'],
  };
}

function expressionSignal(file: SourceFile): WorkflowExpressionSignal {
  const expressions = executableExpressions(file);
  return {
    file: file.repositoryPath,
    executableExpressions: expressions.length,
    attackerControlledExpressions: expressions.filter(item => item.attackerControlled).length,
    dynamicUses: expressions.filter(item => item.key === 'uses').length,
    dynamicShells: expressions.filter(item => item.key === 'shell').length,
    dynamicContainers: expressions.filter(item => item.key === 'image').length,
    githubScriptExpressions: expressions.filter(item => item.key === 'script').length,
  };
}

export function auditWorkflowExpressions(
  inventory: RepositoryInventory,
): AuditSection<WorkflowExpressionSummary> {
  const started = performance.now();
  const files = workflowSourceFiles(inventory);
  const workflows = files.map(expressionSignal);
  const expressionFindings = files.flatMap(file => executableExpressions(file)
    .map(expression => findingFor(file, expression))
    .filter((item): item is Finding => item !== undefined));

  const findings = stableSortFindings([
    ...expressionFindings,
    ...auditWorkflowAuthority(inventory).findings,
    ...auditWorkflowCommandFiles(inventory).findings,
    ...auditCheckoutBoundaries(inventory).findings,
    ...auditConcurrencyBoundaries(inventory).findings,
    ...auditActionCredentialBoundaries(inventory).findings,
    ...auditActionInputBoundaries(inventory).findings,
    ...auditArchiveExtractionBoundaries(inventory).findings,
    ...auditArtifactExecutionBoundaries(inventory).findings,
    ...auditArtifactProducerProvenance(inventory).findings,
    ...auditProcessEnvironmentBoundaries(inventory).findings,
    ...auditWorkingDirectoryBoundaries(inventory).findings,
    ...auditPrivilegedConditions(inventory).findings,
    ...auditDependencyLifecycle(inventory).findings,
    ...auditPublicationRefBoundaries(inventory).findings,
    ...auditGitOperationBoundaries(inventory).findings,
    ...auditGitHubMutationBoundaries(inventory).findings,
    ...auditJobResourceBoundaries(inventory).findings,
    ...auditOidcAuthority(inventory).findings,
    ...auditPackageRegistryBoundaries(inventory).findings,
    ...auditRunnerTrustBoundaries(inventory).findings,
    ...auditShellBoundaries(inventory).findings,
    ...auditTokenPermissionBoundaries(inventory).findings,
    ...auditUntrustedEnvExecution(inventory).findings,
    ...auditWorkflowNetworkProvenance(inventory).findings,
    ...auditWorkflowSecretExposure(inventory).findings,
    ...auditWorkflowOutputProvenance(inventory).findings,
    ...auditWorkflowManualInputBoundaries(inventory).findings,
    ...auditWorkflowFailureIntegrity(inventory).findings,
    ...auditWorkflowPromotionIntegrity(inventory).findings,
    ...auditWorkflowRunSourceProvenance(inventory).findings,
    ...auditWorkflowRunEventChains(inventory).findings,
    ...auditWorkflowEnvironmentApprovals(inventory).findings,
    ...reusableWorkflowContractFindings(inventory).findings,
  ]);

  return {
    domain: 'security',
    title: 'Workflow executable expression boundary audit',
    summary: {
      workflows,
      workflowFiles: workflows.length,
      executableExpressions: workflows.reduce((sum, item) => sum + item.executableExpressions, 0),
      attackerControlledExpressions: workflows.reduce((sum, item) => sum + item.attackerControlledExpressions, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
