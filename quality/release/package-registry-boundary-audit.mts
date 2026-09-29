import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
  jobHasWriteAuthority,
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

export type PackageRegistryKind = 'npm' | 'nuget' | 'python' | 'cargo' | 'maven' | 'generic';

export interface PackageRegistrySignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly kind: PackageRegistryKind;
  readonly registryCommands: number;
  readonly publishCommands: number;
  readonly dynamicRegistryTargets: number;
  readonly plaintextRegistryTargets: number;
  readonly persistentCredentialWrites: number;
  readonly cleartextCredentialStores: number;
  readonly credentialArgUses: number;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
}

export interface PackageRegistryBoundarySummary {
  readonly workflowFiles: number;
  readonly registrySteps: number;
  readonly publishSteps: number;
  readonly dynamicRegistryTargets: number;
  readonly plaintextRegistryTargets: number;
  readonly persistentCredentialWrites: number;
  readonly cleartextCredentialStores: number;
  readonly signals: readonly PackageRegistrySignal[];
  readonly findings: readonly Finding[];
}

const NPM = /\b(?:npm|pnpm|yarn)\b/i;
const NPM_PUBLISH = /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b/i;
const NUGET = /\b(?:dotnet\s+nuget|nuget)\b/i;
const NUGET_PUSH = /\b(?:dotnet\s+nuget\s+push|nuget\s+push)\b/i;
const PYTHON = /\b(?:twine\s+upload|python\s+-m\s+twine\s+upload|pip\s+config)\b/i;
const PYTHON_PUBLISH = /\b(?:twine\s+upload|python\s+-m\s+twine\s+upload)\b/i;
const CARGO = /\bcargo\s+(?:publish|login)\b/i;
const CARGO_PUBLISH = /\bcargo\s+publish\b/i;
const MAVEN = /\b(?:mvn|mvnw|gradle|gradlew)\b[^\n]*(?:deploy|publish)\b/i;
const REGISTRY_FLAG = /(?:--registry|--source|-s|--repository-url|--repository|--index-url)\s+(?:['"])?([^\s'"`]+)/gi;
const REGISTRY_ASSIGN = /(?:registry|repository-url|index-url)\s*=\s*([^\s'"`]+)/gi;
const UNTRUSTED = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.|needs\.[A-Za-z0-9_-]+\.outputs\.|steps\.[A-Za-z0-9_-]+\.outputs\.|matrix\.)[\s\S]*?\}\}/i;
const HTTP_REGISTRY = /http:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i;
const SECRET_EXPR = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i;
const NPMRC_WRITE = /(?:>|>>|tee\s+(?:-a\s+)?)\s*['"]?(?:~\/)?\.npmrc\b|\bnpm\s+config\s+set\b[^\n]*(?:_authToken|_auth|password|username)/i;
const PYPIRC_WRITE = /(?:>|>>|tee\s+(?:-a\s+)?)\s*['"]?(?:~\/)?\.pypirc\b|\btwine\b[^\n]*(?:--password|-p)\b/i;
const NUGET_CONFIG_WRITE = /\b(?:dotnet\s+nuget|nuget)\s+(?:add|update)\s+source\b/i;
const NUGET_CLEAR_TEXT = /--store-password-in-clear-text\b/i;
const CARGO_LOGIN = /\bcargo\s+login\b/i;
const CLI_CREDENTIAL = /(?:--?(?:token|password|passwd|api[-_]?key)|-p)\s+(?:['"])?(?:\$\{\{\s*secrets\.|\$[A-Za-z_]|\$env:|%[A-Za-z_])/i;
const REDIRECT_CREDENTIAL = /(?:_authToken|_auth|password|passwd|token|api[-_]?key)\s*[=:][^\n]*(?:\$\{\{\s*secrets\.|\$[A-Za-z_]|\$env:|%[A-Za-z_])/i;

function secretEnvNames(step: WorkflowStepBlock): string[] {
  return [...stepNestedMapping(step, 'env').entries()]
    .filter(([, value]) => SECRET_EXPR.test(value))
    .map(([name]) => name);
}

function referencesSecretEnv(text: string, step: WorkflowStepBlock): boolean {
  return secretEnvNames(step).some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i').test(text);
  });
}

function kindFor(run: string): PackageRegistryKind | undefined {
  if (NPM.test(run)) return 'npm';
  if (NUGET.test(run)) return 'nuget';
  if (PYTHON.test(run)) return 'python';
  if (CARGO.test(run)) return 'cargo';
  if (MAVEN.test(run)) return 'maven';
  return undefined;
}

function publishCount(run: string): number {
  return [NPM_PUBLISH, NUGET_PUSH, PYTHON_PUBLISH, CARGO_PUBLISH, MAVEN].filter(pattern => pattern.test(run)).length;
}

function registryTargets(run: string): string[] {
  const targets: string[] = [];
  for (const pattern of [REGISTRY_FLAG, REGISTRY_ASSIGN]) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(run)) !== null) {
      const target = match[1];
      if (target) targets.push(target);
    }
  }
  return targets;
}

function persistentCredentialWrites(run: string): number {
  return [NPMRC_WRITE, PYPIRC_WRITE, NUGET_CONFIG_WRITE, CARGO_LOGIN].filter(pattern => pattern.test(run)).length;
}

function credentialArgUses(run: string, step: WorkflowStepBlock): number {
  let count = 0;
  for (const line of run.split('\n')) {
    if (CLI_CREDENTIAL.test(line) || (/(?:--?(?:token|password)|-p)\b/i.test(line) && referencesSecretEnv(line, step))) count += 1;
  }
  return count;
}

function persistentSecretWrite(run: string, step: WorkflowStepBlock): boolean {
  for (const line of run.split('\n')) {
    if (!NPMRC_WRITE.test(line) && !PYPIRC_WRITE.test(line) && !NUGET_CONFIG_WRITE.test(line) && !CARGO_LOGIN.test(line)) continue;
    if (SECRET_EXPR.test(line) || referencesSecretEnv(line, step) || REDIRECT_CREDENTIAL.test(line)) return true;
  }
  return false;
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block);
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): PackageRegistrySignal | undefined {
  const run = stepRunText(step);
  const kind = kindFor(run);
  if (!kind) return undefined;
  const targets = registryTargets(run);
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    kind,
    registryCommands: run.split('\n').filter(line => kindFor(line) !== undefined).length,
    publishCommands: publishCount(run),
    dynamicRegistryTargets: targets.filter(target => UNTRUSTED.test(target)).length,
    plaintextRegistryTargets: targets.filter(target => HTTP_REGISTRY.test(target)).length,
    persistentCredentialWrites: persistentCredentialWrites(run),
    cleartextCredentialStores: NUGET_CLEAR_TEXT.test(run) ? 1 : 0,
    credentialArgUses: credentialArgUses(run, step),
    externalContribution: trigger.externalContribution,
    privileged: privileged(block),
  };
}

function finding(step: WorkflowStepBlock, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: step.job.file.repositoryPath, line: step.startLine },
    evidence: { excerpt: stepRunText(step).slice(0, 440), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'package-registry', 'credentials', 'publication', 'supply-chain'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const current = signal(block, step);
  if (!current) return [];
  const run = stepRunText(step);
  const findings: Finding[] = [];

  if (current.dynamicRegistryTargets > 0) {
    findings.push(finding(
      step,
      'ci-package-registry-dynamic-origin',
      current.privileged || current.publishCommands > 0 ? 'critical' : 'high',
      'Package registry origin is expression-controlled',
      `Step ${current.step} allows event/input/output data to select a package registry or repository endpoint. Credentials and published artifacts can be redirected to an attacker-controlled service.`,
      'Use a literal approved registry origin or map a closed identifier to a repository-owned allowlist. Never accept arbitrary registry URLs from workflow inputs/events/outputs.',
      current.privileged || current.publishCommands > 0,
    ));
  }

  if (current.plaintextRegistryTargets > 0) {
    findings.push(finding(
      step,
      'ci-package-registry-plaintext-origin',
      'critical',
      'Package registry uses plaintext HTTP',
      `Step ${current.step} communicates with a package registry over http://. Authentication tokens, package metadata, or published bytes can be intercepted or modified.`,
      'Use HTTPS with normal certificate validation. Prefer the platform/organization package registry and immutable package provenance.',
      true,
    ));
  }

  if (NUGET_CLEAR_TEXT.test(run)) {
    findings.push(finding(
      step,
      'ci-package-nuget-cleartext-store',
      'critical',
      'NuGet source stores package credentials in clear text',
      `Step ${current.step} uses --store-password-in-clear-text, persisting a reusable credential in NuGet configuration on the runner filesystem.`,
      'Avoid persistent package source credentials. Use ephemeral environment/secret injection and remove temporary configuration before the step ends.',
      true,
    ));
  }

  if (persistentSecretWrite(run, step)) {
    findings.push(finding(
      step,
      'ci-package-persistent-credential-config',
      current.privileged ? 'critical' : 'high',
      'Package credential is persisted into runner configuration',
      `Step ${current.step} writes secret-backed registry credentials through .npmrc/.pypirc/NuGet/Cargo configuration. Persistent runner files widen credential lifetime and can be captured by later steps/artifacts/caches.`,
      'Keep credentials scoped to the publishing process via ephemeral environment variables or dedicated action inputs. If a temporary config is unavoidable, create it in a private temp directory and delete it in the same step.',
      current.privileged,
    ));
  }

  if (current.credentialArgUses > 0) {
    findings.push(finding(
      step,
      'ci-package-credential-command-argument',
      'high',
      'Package credential is passed as a command-line argument',
      `Step ${current.step} passes token/password material in package-tool argv. Command lines can appear in tracing, diagnostics, process inspection, or error output.`,
      'Use the package manager’s dedicated environment variable, stdin, or secret-aware action input instead of token/password argv flags.',
    ));
  }

  if (current.externalContribution && current.publishCommands > 0) {
    findings.push(finding(
      step,
      'ci-package-external-publication',
      'critical',
      'Package publication is reachable from external contribution event',
      `Step ${current.step} publishes package artifacts from a contribution-controlled workflow context. Even with token restrictions, same-repository contributions or event-specific authority can expose supply-chain publication rights.`,
      'Run package publication only from trusted protected tag/branch workflows with a protected environment. External workflows must build/test only.',
      true,
    ));
  }

  return findings;
}

export function auditPackageRegistryBoundaries(inventory: RepositoryInventory): AuditSection<PackageRegistryBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is PackageRegistrySignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'Package registry credential and origin boundary audit',
    summary: {
      workflowFiles: files.length,
      registrySteps: signals.length,
      publishSteps: signals.filter(item => item.publishCommands > 0).length,
      dynamicRegistryTargets: signals.reduce((sum, item) => sum + item.dynamicRegistryTargets, 0),
      plaintextRegistryTargets: signals.reduce((sum, item) => sum + item.plaintextRegistryTargets, 0),
      persistentCredentialWrites: signals.reduce((sum, item) => sum + item.persistentCredentialWrites, 0),
      cleartextCredentialStores: signals.reduce((sum, item) => sum + item.cleartextCredentialStores, 0),
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
