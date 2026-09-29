import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import { workflowFiles, workflowJobBlocks, type WorkflowJobBlock } from './workflow-structure.mts';
import {
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface WorkflowSecretExposureSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly directSecretExpressions: number;
  readonly secretEnvironmentVariables: readonly string[];
  readonly shellTracing: boolean;
  readonly environmentDump: boolean;
  readonly explicitSecretLog: boolean;
  readonly commandFileSecretWrites: number;
}

export interface WorkflowSecretExposureSummary {
  readonly workflowFiles: number;
  readonly secretBearingSteps: number;
  readonly directSecretInterpolations: number;
  readonly tracedSecretSteps: number;
  readonly environmentDumpSteps: number;
  readonly commandFileSecretWrites: number;
  readonly signals: readonly WorkflowSecretExposureSignal[];
  readonly findings: readonly Finding[];
}

const SECRET_EXPR = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gi;
const SECRET_ANY = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i;
const SHELL_TRACE = /(?:^|[;&|]\s*)set\s+-[^\n]*x\b|\bSet-PSDebug\s+-Trace\s+[1-9]\b|\bset\s+-o\s+xtrace\b/im;
const ENV_DUMP = /(?:^|[;&|]\s*)(?:env|printenv)\s*(?:$|[;&|])|\bGet-ChildItem\s+Env:|\bdir\s+env:|(?:^|\n)\s*set\s*$/im;
const COMMAND_FILE = /(?:GITHUB_ENV|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|GITHUB_PATH)/i;
const SUMMARY = /GITHUB_STEP_SUMMARY/i;
const OUTPUT = /GITHUB_OUTPUT/i;
const PATH_FILE = /GITHUB_PATH/i;
const URL_WITH_SECRET = /https?:\/\/[^\s'"`]*\$\{\{\s*secrets\./i;
const HEADER_WITH_SECRET = /(?:authorization|x-api-key|api-key|private-token|token)\s*:[^\n]*\$\{\{\s*secrets\./i;
const CLI_SECRET = /(?:--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key)|-p)\s+(?:['"])?\$\{\{\s*secrets\./i;

function countSecrets(text: string): number {
  const matcher = new RegExp(SECRET_EXPR.source, SECRET_EXPR.flags);
  let count = 0;
  while (matcher.exec(text) !== null) count += 1;
  return count;
}

function secretEnv(step: WorkflowStepBlock): string[] {
  const names: string[] = [];
  for (const [name, value] of stepNestedMapping(step, 'env').entries()) {
    if (SECRET_ANY.test(value)) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, 'en'));
}

function variablePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i');
}

function explicitLog(run: string, envNames: readonly string[]): boolean {
  for (const name of envNames) {
    const variable = variablePattern(name);
    for (const line of run.split('\n')) {
      if (!variable.test(line)) continue;
      if (/\b(?:echo|printf|Write-Host|Write-Output|console\.log|cat)\b/i.test(line)) return true;
    }
  }
  return false;
}

function commandFileSecretWrites(run: string, envNames: readonly string[]): number {
  let count = 0;
  for (const line of run.split('\n')) {
    if (!COMMAND_FILE.test(line)) continue;
    if (SECRET_ANY.test(line) || envNames.some(name => variablePattern(name).test(line))) count += 1;
  }
  return count;
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkflowSecretExposureSignal | undefined {
  const run = stepRunText(step);
  const envNames = secretEnv(step);
  const directSecretExpressions = countSecrets(run);
  if (directSecretExpressions === 0 && envNames.length === 0) return undefined;
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    directSecretExpressions,
    secretEnvironmentVariables: envNames,
    shellTracing: SHELL_TRACE.test(run),
    environmentDump: ENV_DUMP.test(run),
    explicitSecretLog: explicitLog(run, envNames),
    commandFileSecretWrites: commandFileSecretWrites(run, envNames),
  };
}

function where(step: WorkflowStepBlock) {
  return { file: step.job.file.repositoryPath, line: step.startLine };
}

function finding(
  step: WorkflowStepBlock,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: where(step),
    evidence: { excerpt: stepRunText(step).slice(0, 420), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'secrets', 'logs', 'shell', 'least-exposure'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const run = stepRunText(step);
  const envNames = secretEnv(step);
  const direct = countSecrets(run);
  if (direct === 0 && envNames.length === 0) return [];
  const findings: Finding[] = [];

  if (direct > 0) {
    findings.push(finding(
      step,
      'ci-secret-direct-run-interpolation',
      'critical',
      'Secret is interpolated directly into executable shell source',
      `Step ${stepDisplayName(step)} embeds ${direct} secret expression(s) directly in run source. GitHub substitutes expressions before the shell parses the script, so special characters can alter syntax and the value becomes part of generated command text.`,
      'Map the secret into the step env block, then reference the environment variable using the shell’s quoted variable syntax. Never splice secrets directly into run source.',
      true,
    ));
  }

  if (URL_WITH_SECRET.test(run)) {
    findings.push(finding(
      step,
      'ci-secret-url-credential-exposure',
      'critical',
      'Secret is embedded in a URL',
      `Step ${stepDisplayName(step)} places secret material in an HTTP(S) URL. URLs can be retained by process listings, proxies, redirects, diagnostics, shell history, or server logs.`,
      'Use an Authorization header or tool-specific secret input populated from a quoted environment variable. Keep credentials out of URLs and query strings.',
      true,
    ));
  }

  if (HEADER_WITH_SECRET.test(run) || CLI_SECRET.test(run)) {
    findings.push(finding(
      step,
      'ci-secret-direct-argv-exposure',
      'high',
      'Secret is directly substituted into a command argument',
      `Step ${stepDisplayName(step)} inserts secret material directly into a command-line argument/header. The generated command line is harder to audit safely and can leak through process/debug output.`,
      'Pass the secret through step env and use a quoted variable, stdin, credential helper, or tool-specific secure environment variable instead of expression interpolation in argv.',
    ));
  }

  if (envNames.length > 0 && SHELL_TRACE.test(run)) {
    findings.push(finding(
      step,
      'ci-secret-shell-tracing',
      'critical',
      'Shell tracing is enabled in a secret-bearing step',
      `Step ${stepDisplayName(step)} enables command tracing while secret environment variable(s) ${envNames.join(', ')} are in scope. Expanded commands and variables can be emitted to workflow logs.`,
      'Disable xtrace/PowerShell tracing before secrets enter scope. Place diagnostic tracing in a separate non-secret step.',
      true,
    ));
  }

  if (envNames.length > 0 && ENV_DUMP.test(run)) {
    findings.push(finding(
      step,
      'ci-secret-environment-dump',
      'critical',
      'Secret-bearing step dumps process environment',
      `Step ${stepDisplayName(step)} enumerates environment variables while secret-backed variable(s) ${envNames.join(', ')} are present. Masking is defense-in-depth and must not replace least exposure.`,
      'Do not run env/printenv/Env: enumeration in secret-bearing steps. Log only an explicit allowlist of non-sensitive diagnostic values.',
      true,
    ));
  }

  if (envNames.length > 0 && explicitLog(run, envNames)) {
    findings.push(finding(
      step,
      'ci-secret-explicit-log',
      'critical',
      'Secret-backed variable is explicitly written to workflow output',
      `Step ${stepDisplayName(step)} sends a secret-backed environment variable to a console/logging command. Masking can fail after transformation, encoding, truncation, or structured formatting.`,
      'Remove secret logging. Emit only presence/boolean or a non-reversible bounded fingerprint when operationally required.',
      true,
    ));
  }

  const commandWrites = commandFileSecretWrites(run, envNames);
  if (commandWrites > 0) {
    const summary = SUMMARY.test(run);
    const path = PATH_FILE.test(run);
    findings.push(finding(
      step,
      summary ? 'ci-secret-step-summary-write' : path ? 'ci-secret-path-command-write' : 'ci-secret-command-file-propagation',
      summary || path ? 'critical' : 'high',
      summary ? 'Secret is written to human-readable workflow summary' : path ? 'Secret influences executable search path' : 'Secret is propagated through a workflow command file',
      summary
        ? `Step ${stepDisplayName(step)} writes secret material to GITHUB_STEP_SUMMARY, creating persistent human-readable release evidence containing credential data.`
        : path
          ? `Step ${stepDisplayName(step)} writes secret-derived data to GITHUB_PATH, allowing credential content to affect executable search behavior.`
          : `Step ${stepDisplayName(step)} writes secret material through GITHUB_ENV/GITHUB_OUTPUT. This extends secret lifetime and scope to later steps/jobs.`,
      summary
        ? 'Never write secrets to step summaries.'
        : path
          ? 'Never derive PATH entries from secret material.'
          : 'Keep secrets scoped to the consuming step. Avoid command-file propagation; use explicit secret inputs at the narrowest required boundary.',
      summary || path,
    ));
  }

  return findings;
}

export function auditWorkflowSecretExposure(inventory: RepositoryInventory): AuditSection<WorkflowSecretExposureSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is WorkflowSecretExposureSignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'Workflow secret exposure audit',
    summary: {
      workflowFiles: files.length,
      secretBearingSteps: signals.length,
      directSecretInterpolations: signals.reduce((sum, item) => sum + item.directSecretExpressions, 0),
      tracedSecretSteps: signals.filter(item => item.shellTracing).length,
      environmentDumpSteps: signals.filter(item => item.environmentDump).length,
      commandFileSecretWrites: signals.reduce((sum, item) => sum + item.commandFileSecretWrites, 0),
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
