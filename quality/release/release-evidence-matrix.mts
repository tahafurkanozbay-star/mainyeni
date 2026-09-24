import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  parseWorkflowEvidence,
  type WorkflowDocumentEvidence,
  type WorkflowStepEvidence,
} from './workflow-evidence-audit.mts';

export type ReleaseEvidenceDomain =
  | 'dependencies'
  | 'static-analysis'
  | 'testing'
  | 'regression'
  | 'build'
  | 'backend'
  | 'architecture'
  | 'security';

export interface ReleaseEvidenceRequirement {
  readonly id: string;
  readonly domain: ReleaseEvidenceDomain;
  readonly workflow: string;
  readonly job?: string;
  readonly step: string;
  readonly critical: boolean;
  readonly purpose: string;
}

export interface ReleaseEvidenceObservation {
  readonly requirement: ReleaseEvidenceRequirement;
  readonly present: boolean;
  readonly workflow: string | null;
  readonly job: string | null;
  readonly line: number | null;
  readonly command: string | null;
}

export interface ReleaseLaneSummary {
  readonly workflow: string;
  readonly requirements: number;
  readonly satisfied: number;
  readonly criticalRequirements: number;
  readonly criticalSatisfied: number;
}

export interface ReleaseEvidenceMatrixSummary {
  readonly observations: readonly ReleaseEvidenceObservation[];
  readonly lanes: readonly ReleaseLaneSummary[];
  readonly requiredEvidence: number;
  readonly satisfiedEvidence: number;
  readonly criticalEvidence: number;
  readonly criticalSatisfied: number;
  readonly coverageRatio: number;
  readonly fingerprint: string;
  readonly findings: readonly Finding[];
}

export const RELEASE_EVIDENCE_REQUIREMENTS: readonly ReleaseEvidenceRequirement[] = Object.freeze([
  Object.freeze({
    id: 'web-lockfile-install',
    domain: 'dependencies',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Install from lockfile',
    critical: true,
    purpose: 'Reproducible Webclient dependency installation from the committed lockfile.',
  }),
  Object.freeze({
    id: 'web-dependency-contract',
    domain: 'dependencies',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Dependency and lockfile contract',
    critical: true,
    purpose: 'Repository dependency policy and lockfile coherence.',
  }),
  Object.freeze({
    id: 'web-production-audit',
    domain: 'dependencies',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Production dependency audit',
    critical: true,
    purpose: 'High-severity production dependency vulnerability audit.',
  }),
  Object.freeze({
    id: 'web-full-lint',
    domain: 'static-analysis',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Full lint visibility',
    critical: false,
    purpose: 'Whole-Webclient lint visibility during staged modernization.',
  }),
  Object.freeze({
    id: 'web-changed-strict-lint',
    domain: 'static-analysis',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Strict lint on changed Webclient sources',
    critical: true,
    purpose: 'No new lint warnings in changed Webclient code.',
  }),
  Object.freeze({
    id: 'web-full-typecheck',
    domain: 'static-analysis',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Full TypeScript diagnostic visibility',
    critical: false,
    purpose: 'Whole-code TypeScript diagnostic visibility.',
  }),
  Object.freeze({
    id: 'web-exact-base-typecheck',
    domain: 'regression',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Exact-base TypeScript regression gate',
    critical: true,
    purpose: 'No TypeScript diagnostics introduced relative to the exact pull-request base.',
  }),
  Object.freeze({
    id: 'web-full-tests',
    domain: 'testing',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Full Vitest diagnostic visibility',
    critical: false,
    purpose: 'Whole-suite test diagnostic visibility.',
  }),
  Object.freeze({
    id: 'web-exact-base-tests',
    domain: 'regression',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Exact-base Vitest regression gate',
    critical: true,
    purpose: 'No test failures introduced relative to the exact pull-request base.',
  }),
  Object.freeze({
    id: 'web-tooling-tests',
    domain: 'testing',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Native tooling regression suite',
    critical: true,
    purpose: 'Native Node QA tooling and release-contract regression coverage.',
  }),
  Object.freeze({
    id: 'web-production-build',
    domain: 'build',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Production Vite build and integrity manifest',
    critical: true,
    purpose: 'Production Vite compilation and integrity-manifest generation.',
  }),
  Object.freeze({
    id: 'web-build-integrity',
    domain: 'build',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Verify production bundle integrity',
    critical: true,
    purpose: 'Generated bundle integrity verification.',
  }),
  Object.freeze({
    id: 'web-build-budget',
    domain: 'build',
    workflow: '.github/workflows/webclient-quality.yml',
    job: 'quality',
    step: 'Enforce production build budgets',
    critical: true,
    purpose: 'Production bundle budget enforcement.',
  }),
  Object.freeze({
    id: 'typed-release-typecheck',
    domain: 'static-analysis',
    workflow: '.github/workflows/release-qa.yml',
    job: 'typed-release-audit',
    step: 'TypeScript 7.0.2 strict typecheck',
    critical: true,
    purpose: 'Strict TypeScript validation of the typed release engine.',
  }),
  Object.freeze({
    id: 'typed-release-tests',
    domain: 'testing',
    workflow: '.github/workflows/release-qa.yml',
    job: 'typed-release-audit',
    step: 'Typed QA unit and regression tests',
    critical: true,
    purpose: 'Release engine unit and regression tests.',
  }),
  Object.freeze({
    id: 'typed-release-scorecard',
    domain: 'security',
    workflow: '.github/workflows/release-qa.yml',
    job: 'typed-release-audit',
    step: 'Generate whole-repository release scorecard',
    critical: true,
    purpose: 'Whole-repository release/security/performance/GIS/UX scorecard generation.',
  }),
  Object.freeze({
    id: 'typed-release-exact-base',
    domain: 'regression',
    workflow: '.github/workflows/release-qa.yml',
    job: 'typed-release-audit',
    step: 'Enforce exact-base PR regression gate',
    critical: true,
    purpose: 'Typed release findings are compared with the exact PR base.',
  }),
  Object.freeze({
    id: 'backend-tests',
    domain: 'backend',
    workflow: '.github/workflows/release-qa.yml',
    job: 'backend-release-validation',
    step: 'Run xUnit v3 tests through Microsoft.Testing.Platform',
    critical: true,
    purpose: '.NET 10 backend security and regression test execution.',
  }),
  Object.freeze({
    id: 'backend-user-publish',
    domain: 'backend',
    workflow: '.github/workflows/release-qa.yml',
    job: 'backend-release-validation',
    step: 'Publish User API',
    critical: true,
    purpose: 'User API release publishability evidence.',
  }),
  Object.freeze({
    id: 'backend-admin-publish',
    domain: 'backend',
    workflow: '.github/workflows/release-qa.yml',
    job: 'backend-release-validation',
    step: 'Publish Admin API',
    critical: true,
    purpose: 'Admin API release publishability evidence.',
  }),
  Object.freeze({
    id: 'architecture-module-graph',
    domain: 'architecture',
    workflow: '.github/workflows/platform-architecture-audit.yml',
    job: 'audit',
    step: 'Enforce typed module graph',
    critical: true,
    purpose: 'Typed module graph, duplicate implementation and cycle governance.',
  }),
  Object.freeze({
    id: 'architecture-language-ratchet',
    domain: 'architecture',
    workflow: '.github/workflows/platform-architecture-audit.yml',
    job: 'audit',
    step: 'Enforce language modernization ratchet',
    critical: true,
    purpose: 'No regression toward legacy source-language debt.',
  }),
  Object.freeze({
    id: 'architecture-platform-boundary',
    domain: 'architecture',
    workflow: '.github/workflows/platform-architecture-audit.yml',
    job: 'audit',
    step: 'Enforce Platform responsibility boundaries',
    critical: true,
    purpose: 'Platform dependency-direction and ownership boundary enforcement.',
  }),
  Object.freeze({
    id: 'architecture-browser-boundary',
    domain: 'security',
    workflow: '.github/workflows/platform-architecture-audit.yml',
    job: 'audit',
    step: 'Enforce browser runtime boundary',
    critical: true,
    purpose: 'Browser runtime network/secret/persistence boundary enforcement.',
  }),
  Object.freeze({
    id: 'platform-tests-typecheck',
    domain: 'testing',
    workflow: '.github/workflows/platform-typed-test-validation.yml',
    job: 'typed-platform-tests',
    step: 'Strict Platform test TypeScript',
    critical: true,
    purpose: 'Strict typed Platform test boundary.',
  }),
  Object.freeze({
    id: 'platform-focused-tests',
    domain: 'testing',
    workflow: '.github/workflows/platform-typed-test-validation.yml',
    job: 'typed-platform-tests',
    step: 'Focused migrated Platform tests',
    critical: true,
    purpose: 'Focused Platform bootstrap/network/performance/runtime regression suite.',
  }),
  Object.freeze({
    id: 'release-contract-adversarial',
    domain: 'security',
    workflow: '.github/workflows/release-evidence-contract.yml',
    job: 'contract',
    step: 'Audit adversarial fixture suite',
    critical: true,
    purpose: 'Self-hosting release-evidence parser adversarial coverage.',
  }),
  Object.freeze({
    id: 'release-contract-supply-chain',
    domain: 'security',
    workflow: '.github/workflows/release-evidence-contract.yml',
    job: 'contract',
    step: 'Workflow supply-chain security contract',
    critical: true,
    purpose: 'Immutable CI action provenance and checkout-token policy.',
  }),
  Object.freeze({
    id: 'release-contract-shell',
    domain: 'security',
    workflow: '.github/workflows/release-evidence-contract.yml',
    job: 'contract',
    step: 'Workflow shell security contract',
    critical: true,
    purpose: 'No dynamic download, privilege escalation or unsafe shell mutation in release workflows.',
  }),
  Object.freeze({
    id: 'release-contract-permissions',
    domain: 'security',
    workflow: '.github/workflows/release-evidence-contract.yml',
    job: 'contract',
    step: 'Workflow permission and trigger contract',
    critical: true,
    purpose: 'Least privilege and safe trigger/checkout selection.',
  }),
  Object.freeze({
    id: 'release-contract-reliability',
    domain: 'security',
    workflow: '.github/workflows/release-evidence-contract.yml',
    job: 'contract',
    step: 'Workflow bounded-execution reliability contract',
    critical: true,
    purpose: 'Bounded timeout, reviewed runner and superseded-run cancellation.',
  }),
]);

function workflowFiles(inventory: RepositoryInventory) {
  return inventory.files.filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(file.repositoryPath));
}

function parsedWorkflows(inventory: RepositoryInventory): readonly WorkflowDocumentEvidence[] {
  return Object.freeze(workflowFiles(inventory).map(parseWorkflowEvidence));
}

function findStep(
  workflows: readonly WorkflowDocumentEvidence[],
  requirement: ReleaseEvidenceRequirement,
): { readonly workflow: WorkflowDocumentEvidence; readonly job: string; readonly step: WorkflowStepEvidence } | null {
  const workflow = workflows.find(item => item.file === requirement.workflow);
  if (!workflow) return null;
  for (const job of workflow.jobs) {
    if (requirement.job && job.name !== requirement.job) continue;
    const step = job.steps.find(candidate => candidate.name === requirement.step);
    if (step) return Object.freeze({ workflow, job: job.name, step });
  }
  return null;
}

function observe(
  workflows: readonly WorkflowDocumentEvidence[],
  requirement: ReleaseEvidenceRequirement,
): ReleaseEvidenceObservation {
  const match = findStep(workflows, requirement);
  return Object.freeze({
    requirement,
    present: match !== null,
    workflow: match?.workflow.file ?? null,
    job: match?.job ?? null,
    line: match?.step.line ?? null,
    command: match?.step.run?.command ?? null,
  });
}

function matrixFinding(observation: ReleaseEvidenceObservation): Finding {
  const { requirement } = observation;
  return Object.freeze({
    id: requirement.critical ? 'release-critical-evidence-missing' : 'release-evidence-missing',
    domain: 'release',
    severity: requirement.critical ? 'high' : 'medium',
    title: requirement.critical ? 'Critical release evidence is missing' : 'Release evidence is missing',
    message: `${requirement.id} is not produced by ${requirement.workflow}${requirement.job ? ` job ${requirement.job}` : ''}. ${requirement.purpose}`,
    location: { file: requirement.workflow, line: 1 },
    evidence: {
      metadata: Object.freeze({
        requirement: requirement.id,
        evidenceDomain: requirement.domain,
        expectedStep: requirement.step,
      }),
    },
    remediation: `Restore the “${requirement.step}” evidence in its canonical lane without weakening failure propagation.`,
    tags: Object.freeze(['release', 'evidence-matrix', requirement.domain]),
  });
}

function coverageRatio(satisfied: number, required: number): number {
  if (required === 0) return 1;
  return Math.round((satisfied / required) * 10_000) / 10_000;
}

function stableFingerprint(observations: readonly ReleaseEvidenceObservation[]): string {
  const source = observations
    .map(item => `${item.requirement.id}:${item.present ? '1' : '0'}:${item.workflow ?? '-'}:${item.job ?? '-'}:${item.line ?? 0}`)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .join('|');
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function laneSummaries(observations: readonly ReleaseEvidenceObservation[]): readonly ReleaseLaneSummary[] {
  const workflows = [...new Set(RELEASE_EVIDENCE_REQUIREMENTS.map(item => item.workflow))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  return Object.freeze(workflows.map(workflow => {
    const lane = observations.filter(item => item.requirement.workflow === workflow);
    const critical = lane.filter(item => item.requirement.critical);
    return Object.freeze({
      workflow,
      requirements: lane.length,
      satisfied: lane.filter(item => item.present).length,
      criticalRequirements: critical.length,
      criticalSatisfied: critical.filter(item => item.present).length,
    });
  }));
}

function separationFindings(workflows: readonly WorkflowDocumentEvidence[]): Finding[] {
  const release = workflows.find(workflow => workflow.file === '.github/workflows/release-qa.yml');
  if (!release) return [];
  const requiredJobs = ['typed-release-audit', 'webclient-release-validation', 'backend-release-validation'];
  const present = new Set(release.jobs.map(job => job.name));
  const findings: Finding[] = [];
  for (const job of requiredJobs) {
    if (present.has(job)) continue;
    findings.push({
      id: 'release-lane-separation-missing',
      domain: 'release',
      severity: 'high',
      title: 'Release validation lane separation is incomplete',
      message: `Release QA is missing independent ${job} execution. Typed, Webclient and backend evidence must not collapse into a single failure domain.`,
      location: { file: release.file, line: 1 },
      remediation: 'Restore the missing independent release validation job with its own bounded timeout and read-only checkout.',
      tags: Object.freeze(['release', 'evidence-matrix', 'isolation']),
    });
  }
  return findings;
}

function commandEvidenceFindings(observations: readonly ReleaseEvidenceObservation[]): Finding[] {
  const findings: Finding[] = [];
  const commandById = new Map(observations.map(item => [item.requirement.id, item.command]));
  const commandRequired = (id: string, pattern: RegExp, description: string): void => {
    const command = commandById.get(id);
    if (command === null || command === undefined) return;
    if (pattern.test(command)) return;
    const requirement = RELEASE_EVIDENCE_REQUIREMENTS.find(item => item.id === id);
    if (!requirement) return;
    findings.push({
      id: 'release-evidence-command-drift',
      domain: 'release',
      severity: 'high',
      title: 'Release evidence step no longer executes its required proof',
      message: `${id} exists by name but its command no longer proves ${description}.`,
      location: { file: requirement.workflow, line: 1 },
      evidence: { excerpt: command.slice(0, 240), metadata: { requirement: id } },
      remediation: `Restore command-level proof for ${description}; do not satisfy the matrix by retaining only the step name.`,
      tags: Object.freeze(['release', 'evidence-matrix', 'command-integrity']),
    });
  };

  commandRequired('web-lockfile-install', /\bnpm\s+ci\b/u, 'lockfile-based dependency installation');
  commandRequired('web-production-audit', /\bnpm\s+audit\b[^\n]*--omit=dev[^\n]*--audit-level=high/u, 'production dependency vulnerability audit');
  commandRequired('web-exact-base-typecheck', /pull_request\.base\.sha|BASE_SHA/u, 'exact-base TypeScript regression comparison');
  commandRequired('web-exact-base-tests', /pull_request\.base\.sha|BASE_SHA/u, 'exact-base test regression comparison');
  commandRequired('web-production-build', /\bnpm\s+run\s+build\b/u, 'production build execution');
  commandRequired('web-build-integrity', /\bnpm\s+run\s+build:verify\b/u, 'bundle integrity verification');
  commandRequired('typed-release-tests', /node\s+--test\s+quality\/release/u, 'typed release test execution');
  commandRequired('typed-release-scorecard', /quality\/release\/cli\.mts/u, 'whole-repository typed release scorecard generation');
  commandRequired('typed-release-exact-base', /pull_request\.base\.sha|BASE_SHA/u, 'exact-base typed release regression comparison');
  commandRequired('backend-tests', /dotnet\s+run\b[^\n]*Platform\.Security\.Tests/u, '.NET security/regression test execution');
  commandRequired('backend-user-publish', /dotnet\s+publish\s+Api\.User/u, 'User API publishability');
  commandRequired('backend-admin-publish', /dotnet\s+publish\s+Api\.Admin/u, 'Admin API publishability');
  return findings;
}

export function auditReleaseEvidenceMatrix(
  inventory: RepositoryInventory,
): AuditSection<ReleaseEvidenceMatrixSummary> {
  const startedAt = performance.now();
  const workflows = parsedWorkflows(inventory);
  const observations = Object.freeze(RELEASE_EVIDENCE_REQUIREMENTS.map(requirement => observe(workflows, requirement)));
  const missing = observations.filter(item => !item.present);
  const findings = stableSortFindings([
    ...missing.map(matrixFinding),
    ...separationFindings(workflows),
    ...commandEvidenceFindings(observations),
  ]);
  const critical = observations.filter(item => item.requirement.critical);
  const satisfied = observations.filter(item => item.present).length;
  const criticalSatisfied = critical.filter(item => item.present).length;
  return {
    domain: 'release',
    title: 'Cross-lane release evidence coverage matrix',
    summary: {
      observations,
      lanes: laneSummaries(observations),
      requiredEvidence: observations.length,
      satisfiedEvidence: satisfied,
      criticalEvidence: critical.length,
      criticalSatisfied,
      coverageRatio: coverageRatio(satisfied, observations.length),
      fingerprint: stableFingerprint(observations),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - startedAt),
  };
}

export function releaseEvidenceMatrixMarkdown(section: AuditSection<ReleaseEvidenceMatrixSummary>): string {
  const { summary } = section;
  const lines: string[] = [
    '# Release Evidence Matrix',
    '',
    `- Required evidence: ${summary.requiredEvidence}`,
    `- Satisfied evidence: ${summary.satisfiedEvidence}`,
    `- Critical evidence: ${summary.criticalSatisfied}/${summary.criticalEvidence}`,
    `- Coverage: ${(summary.coverageRatio * 100).toFixed(2)}%`,
    `- Fingerprint: \`${summary.fingerprint}\``,
    '',
    '## Lanes',
    '',
  ];
  for (const lane of summary.lanes) {
    lines.push(`- \`${lane.workflow}\`: ${lane.satisfied}/${lane.requirements}; critical ${lane.criticalSatisfied}/${lane.criticalRequirements}`);
  }
  lines.push('', '## Evidence', '');
  for (const observation of summary.observations) {
    const status = observation.present ? 'PASS' : 'MISSING';
    lines.push(`- **${status}** \`${observation.requirement.id}\` — ${observation.requirement.purpose}`);
  }
  if (summary.findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const finding of summary.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.id}\` — ${finding.title}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
