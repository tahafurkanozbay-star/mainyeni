import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type DependencyCommandKind = 'install' | 'rebuild' | 'global-install' | 'remote-install';

export interface DependencyLifecycleSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly manager: PackageManager;
  readonly kind: DependencyCommandKind;
  readonly command: string;
  readonly ignoreScripts: boolean;
  readonly explicitlyEnablesScripts: boolean;
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly protectedEnvironment: boolean;
}

export interface DependencyLifecycleSummary {
  readonly workflowFiles: number;
  readonly dependencyCommands: number;
  readonly lifecycleEnabledInstalls: number;
  readonly privilegedLifecycleInstalls: number;
  readonly externalLifecycleInstalls: number;
  readonly signals: readonly DependencyLifecycleSignal[];
  readonly findings: readonly Finding[];
}

const COMMAND = /(?:^|\n|&&|;|\|\|)\s*(?:sudo\s+)?(npm|pnpm|yarn|bun)\s+([^\n;&|]+)/gi;
const INSTALL_WORD = /^(?:ci|install|i|add)\b/i;
const REBUILD_WORD = /^(?:rebuild|rebuild-all)\b/i;
const GLOBAL_FLAG = /(?:^|\s)(?:-g|--global)(?:\s|$)/i;
const IGNORE_SCRIPTS = /(?:^|\s)--ignore-scripts(?:=true)?(?:\s|$)/i;
const ENABLE_SCRIPTS = /(?:--ignore-scripts=false|--foreground-scripts|--enable-scripts|enable-pre-post-scripts)/i;
const REMOTE_SPEC = /(?:https?:\/\/|git\+https?:\/\/|git\+ssh:\/\/|github:|gitlab:|bitbucket:|git@github\.com:)/i;
const ENV_FALSE = /^(?:false|0|no|off)$/i;
const ENV_TRUE = /^(?:true|1|yes|on)$/i;

interface ParsedCommand {
  readonly manager: PackageManager;
  readonly args: string;
  readonly command: string;
}

function parseCommands(run: string): ParsedCommand[] {
  const result: ParsedCommand[] = [];
  const matcher = new RegExp(COMMAND.source, COMMAND.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(run)) !== null) {
    const manager = (match[1] ?? '').toLowerCase() as PackageManager;
    const args = (match[2] ?? '').trim();
    result.push({ manager, args, command: `${manager} ${args}`.trim() });
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return result;
}

function envIgnoreScripts(block: WorkflowJobBlock, step: WorkflowStepBlock): boolean | undefined {
  const stepEnv = stepNestedMapping(step, 'env');
  const direct = stepEnv.get('NPM_CONFIG_IGNORE_SCRIPTS')
    ?? stepEnv.get('npm_config_ignore_scripts');
  if (direct !== undefined) {
    if (ENV_TRUE.test(direct.trim())) return true;
    if (ENV_FALSE.test(direct.trim())) return false;
  }
  const jobMatch = block.text.match(/^\s*NPM_CONFIG_IGNORE_SCRIPTS\s*:\s*([^\n#]+)/im);
  if (jobMatch) {
    const value = (jobMatch[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (ENV_TRUE.test(value)) return true;
    if (ENV_FALSE.test(value)) return false;
  }
  const workflowMatch = block.file.text.slice(0, block.startOffset).match(/^\s{0,2}NPM_CONFIG_IGNORE_SCRIPTS\s*:\s*([^\n#]+)/im);
  if (workflowMatch) {
    const value = (workflowMatch[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (ENV_TRUE.test(value)) return true;
    if (ENV_FALSE.test(value)) return false;
  }
  return undefined;
}

function commandKind(parsed: ParsedCommand): DependencyCommandKind | undefined {
  if (REBUILD_WORD.test(parsed.args)) return 'rebuild';
  if (!INSTALL_WORD.test(parsed.args)) return undefined;
  if (GLOBAL_FLAG.test(parsed.args)) return 'global-install';
  if (REMOTE_SPEC.test(parsed.args)) return 'remote-install';
  return 'install';
}

function signalFor(
  block: WorkflowJobBlock,
  step: WorkflowStepBlock,
  parsed: ParsedCommand,
): DependencyLifecycleSignal | undefined {
  const kind = commandKind(parsed);
  if (!kind) return undefined;
  const trigger = workflowTriggerProfile(block.file);
  const envPolicy = envIgnoreScripts(block, step);
  const ignoreScripts = IGNORE_SCRIPTS.test(parsed.args) || (envPolicy === true && !ENABLE_SCRIPTS.test(parsed.args));
  const explicitlyEnablesScripts = ENABLE_SCRIPTS.test(parsed.args) || envPolicy === false || kind === 'rebuild';
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: step.startLine,
    manager: parsed.manager,
    kind,
    command: parsed.command,
    ignoreScripts,
    explicitlyEnablesScripts,
    externalContribution: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
    protectedEnvironment: jobUsesProtectedEnvironment(block),
  };
}

function signalsFor(block: WorkflowJobBlock): DependencyLifecycleSignal[] {
  const result: DependencyLifecycleSignal[] = [];
  for (const step of workflowStepBlocks(block)) {
    const run = stepRunText(step);
    if (!run) continue;
    for (const parsed of parseCommands(run)) {
      const signal = signalFor(block, step, parsed);
      if (signal) result.push(signal);
    }
  }
  return result;
}

function privileged(item: DependencyLifecycleSignal): boolean {
  return item.writeAuthority || item.secrets || item.protectedEnvironment;
}

function location(item: DependencyLifecycleSignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: DependencyLifecycleSignal,
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
    title,
    message,
    location: location(item),
    evidence: { value: item.command, metadata: { job: item.job, step: item.step, manager: item.manager, kind: item.kind } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'dependencies', 'lifecycle-scripts', 'supply-chain', 'trust-boundary'],
  };
}

function findingsFor(item: DependencyLifecycleSignal): Finding[] {
  const findings: Finding[] = [];
  const privilegedContext = privileged(item);

  if (!item.ignoreScripts) {
    const critical = item.externalContribution && privilegedContext;
    const severity: Finding['severity'] = critical
      ? 'critical'
      : privilegedContext
        ? 'high'
        : item.externalContribution
          ? 'medium'
          : 'low';
    findings.push(finding(
      item,
      'ci-dependency-lifecycle-enabled',
      severity,
      'Dependency installation can execute lifecycle scripts',
      `${item.command} can execute package lifecycle/install scripts in job ${item.job}. Those scripts run before later validation and inherit the job process environment and token context.`,
      'Use lockfile-exact installation with lifecycle scripts disabled for validation/bootstrap. If lifecycle scripts are required, run them explicitly after provenance checks in an unprivileged isolated job.',
      critical,
    ));
  }

  if (item.explicitlyEnablesScripts) {
    const critical = item.externalContribution || privilegedContext;
    findings.push(finding(
      item,
      'ci-dependency-lifecycle-explicit-enable',
      critical ? 'critical' : 'high',
      'Workflow explicitly enables dependency lifecycle execution',
      `${item.command} or its environment explicitly enables package lifecycle execution, expanding the executable supply-chain surface.`,
      'Remove explicit lifecycle enabling from authoritative CI. Prefer --ignore-scripts and invoke only reviewed repository-owned build steps explicitly.',
      critical,
    ));
  }

  if (item.kind === 'remote-install') {
    const critical = item.externalContribution || privilegedContext;
    findings.push(finding(
      item,
      'ci-dependency-remote-install',
      critical ? 'critical' : 'high',
      'Workflow installs a dependency directly from a remote source',
      `${item.command} bypasses normal lockfile/package-registry provenance by installing a URL or VCS dependency directly in CI.`,
      'Declare the dependency in the reviewed manifest and lockfile with approved integrity metadata. Avoid ad-hoc URL/VCS installation in release workflows.',
      critical,
    ));
  }

  if (item.kind === 'global-install') {
    findings.push(finding(
      item,
      'ci-dependency-global-install',
      privilegedContext ? 'high' : 'medium',
      'Workflow installs package tooling globally',
      `${item.command} mutates runner-global executable search state and makes subsequent command identity depend on mutable package installation.`,
      'Use project-local locked tooling and invoke it from the package manager or node_modules/.bin. Avoid global installs in authoritative CI.',
    ));
  }

  if (item.kind === 'rebuild') {
    const critical = item.externalContribution && privilegedContext;
    findings.push(finding(
      item,
      'ci-dependency-rebuild-lifecycle',
      critical ? 'critical' : privilegedContext ? 'high' : 'medium',
      'Package rebuild re-executes dependency lifecycle scripts',
      `${item.command} can execute install/build hooks after the original dependency installation boundary.`,
      'Avoid rebuild in privileged/external workflows. Reinstall from immutable lockfiles in an isolated job and keep lifecycle execution explicit and least-privileged.',
      critical,
    ));
  }

  return findings;
}

export function auditDependencyLifecycle(
  inventory: RepositoryInventory,
): AuditSection<DependencyLifecycleSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = files.flatMap(file => workflowJobBlocks(file).flatMap(signalsFor));
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Dependency lifecycle execution-boundary audit',
    summary: {
      workflowFiles: files.length,
      dependencyCommands: signals.length,
      lifecycleEnabledInstalls: signals.filter(item => !item.ignoreScripts).length,
      privilegedLifecycleInstalls: signals.filter(item => !item.ignoreScripts && privileged(item)).length,
      externalLifecycleInstalls: signals.filter(item => !item.ignoreScripts && item.externalContribution).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
