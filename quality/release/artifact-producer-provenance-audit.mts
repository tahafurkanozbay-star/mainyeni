import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory } from './contracts.mts';
import { jobHasSecrets, jobHasWriteAuthority, jobUsesProtectedEnvironment, workflowFiles, workflowJobBlocks, workflowTriggerProfile, type WorkflowJobBlock } from './workflow-structure.mts';
import { firstWorkflowStepField, stepDisplayName, stepNestedMapping, stepRunText, stepUsesIdentity, workflowStepBlocks, type WorkflowStepBlock } from './workflow-step-structure.mts';

export interface ArtifactProducerSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly artifactName: string;
  readonly repository: string;
  readonly runId: string;
  readonly crossRun: boolean;
  readonly dynamicRunSelector: boolean;
  readonly dynamicRepository: boolean;
  readonly dynamicArtifactSelector: boolean;
  readonly mergesArtifacts: boolean;
  readonly executableConsumer: boolean;
  readonly privileged: boolean;
  readonly externalContribution: boolean;
  readonly workflowRunTrigger: boolean;
}
export interface ArtifactProducerProvenanceSummary {
  readonly workflowFiles: number;
  readonly artifactDownloads: number;
  readonly crossRunDownloads: number;
  readonly dynamicProducerSelectors: number;
  readonly executableCrossRunDownloads: number;
  readonly signals: readonly ArtifactProducerSignal[];
  readonly findings: readonly Finding[];
}

const DOWNLOAD = /^actions\/download-artifact@[0-9a-f]{40}$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const UNTRUSTED_RUN = /\$\{\{\s*(?:inputs\.|github\.event\.(?:client_payload\.|issue|pull_request|comment|review|repository_dispatch)|github\.head_ref)/i;
const WORKFLOW_RUN_ID = /\$\{\{\s*github\.event\.workflow_run\.id\s*\}\}/i;
const DYNAMIC_REPOSITORY = /\$\{\{/;
const DYNAMIC_ARTIFACT = /\$\{\{/;
const EXECUTION = /(?:^|[;&|]\s*)(?:\.\/|bash\s+|sh\s+|zsh\s+|node\s+|python(?:3)?\s+|pwsh\s+|powershell\s+|dotnet\s+|java\s+-jar\s+|source\s+|\.\s+)/im;
const PATH_PROMOTION = /(?:GITHUB_PATH|\bPATH\s*=)/i;
const RELEASE_USE = /\b(?:publish|deploy|release|upload|sign|attest|push)\b/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}
function truthy(value: string | undefined): boolean { return /^(?:true|yes|on|1)$/i.test((value ?? '').trim()); }
function laterExecutableUse(steps: readonly WorkflowStepBlock[], current: WorkflowStepBlock): boolean {
  return steps.some(step => {
    if (step.index <= current.index) return false;
    const run = stepRunText(step);
    if (run && (EXECUTION.test(run) || PATH_PROMOTION.test(run) || RELEASE_USE.test(run))) return true;
    const identity = stepUsesIdentity(step)?.raw ?? '';
    return /(?:deploy|publish|release|upload|attest|sign)/i.test(identity);
  });
}
function signalFor(block: WorkflowJobBlock, steps: readonly WorkflowStepBlock[], step: WorkflowStepBlock): ArtifactProducerSignal | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity || !DOWNLOAD.test(identity.raw)) return undefined;
  const withMap = stepNestedMapping(step, 'with');
  const artifactName = (withMap.get('name') ?? withMap.get('pattern') ?? '').trim();
  const repository = (withMap.get('repository') ?? '').trim();
  const runId = (withMap.get('run-id') ?? '').trim();
  const trigger = workflowTriggerProfile(block.file);
  const crossRun = Boolean(runId || repository || withMap.get('github-token'));
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    artifactName,
    repository,
    runId,
    crossRun,
    dynamicRunSelector: Boolean(runId && EXPRESSION.test(runId) && !WORKFLOW_RUN_ID.test(runId)),
    dynamicRepository: Boolean(repository && DYNAMIC_REPOSITORY.test(repository)),
    dynamicArtifactSelector: Boolean(artifactName && DYNAMIC_ARTIFACT.test(artifactName)),
    mergesArtifacts: truthy(withMap.get('merge-multiple')),
    executableConsumer: laterExecutableUse(steps, step),
    privileged: privileged(block),
    externalContribution: trigger.externalContribution,
    workflowRunTrigger: /workflow_run\s*:/i.test(block.file.text),
  };
}
function where(step: WorkflowStepBlock) { return { file: step.job.file.repositoryPath, line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine }; }
function finding(id: string, title: string, message: string, remediation: string, signal: ArtifactProducerSignal, step: WorkflowStepBlock, critical = true): Finding {
  return { id, domain: 'security', severity: critical ? 'critical' : 'high', ...(critical ? { blocking: true } : {}), title, message, location: where(step), remediation, tags: ['ci','artifact','provenance','producer','supply-chain'] };
}
function findingsFor(signal: ArtifactProducerSignal, step: WorkflowStepBlock): Finding[] {
  const findings: Finding[] = [];
  const highImpact = signal.executableConsumer || signal.privileged;
  if (signal.dynamicRunSelector) findings.push(finding('ci-artifact-dynamic-run-selector','Artifact producer run is selected from mutable input','A cross-run artifact download selects its producer run from manual, dispatch, pull-request, or other mutable input instead of a trusted workflow-run identity.','Bind run-id to github.event.workflow_run.id from a statically named workflow, or resolve a trusted commit/workflow identity server-side before download.',signal,step,highImpact));
  if (signal.runId && UNTRUSTED_RUN.test(signal.runId)) findings.push(finding('ci-artifact-untrusted-run-selector','Untrusted event data controls artifact producer selection','Attacker- or operator-controlled event data can redirect the artifact download to another workflow run.','Do not accept run IDs from external event payloads or ordinary workflow inputs for executable/release artifacts.',signal,step,true));
  if (signal.dynamicRepository) findings.push(finding('ci-artifact-dynamic-repository','Artifact producer repository is expression-derived','The repository supplying a cross-run artifact is selected dynamically, weakening repository identity review.','Use a literal owner/repository identity for release artifacts and keep cross-repository artifact execution isolated from secrets/write authority.',signal,step,highImpact));
  if (signal.dynamicArtifactSelector && highImpact) findings.push(finding('ci-artifact-dynamic-name','Executable artifact identity is expression-derived','The artifact name or pattern consumed by a privileged/executable job is expression-derived and can select a different producer output.','Use a literal allowlisted artifact name for executable/release inputs and bind it to the expected producer workflow.',signal,step,true));
  if (signal.mergesArtifacts && highImpact) findings.push(finding('ci-artifact-merge-multiple-executable','Multiple artifacts are merged before privileged or executable consumption','merge-multiple combines independently produced artifact trees before executable/release use, obscuring file ownership and allowing collisions.','Download each allowlisted artifact to an isolated path, verify each subject independently, reject collisions, and only then assemble non-executable release data.',signal,step,true));
  if (signal.crossRun && signal.executableConsumer && !signal.workflowRunTrigger) findings.push(finding('ci-artifact-cross-run-without-workflow-identity','Executable cross-run artifact lacks workflow_run producer binding','The job executes or promotes a cross-run artifact but the workflow is not bound to a workflow_run producer event. A run number alone does not establish producer workflow identity.','Use a workflow_run trigger with a static workflows allowlist and successful-conclusion guard, then bind download run-id to github.event.workflow_run.id.',signal,step,true));
  if (signal.crossRun && signal.executableConsumer && !signal.artifactName) findings.push(finding('ci-artifact-cross-run-broad-selection','Executable cross-run download does not name an artifact','The download has no literal artifact name/pattern, so executable consumption can include unexpected producer outputs.','Require a literal artifact name and isolated destination path; verify the exact artifact subject before any execution or PATH promotion.',signal,step,true));
  return findings;
}
export function auditArtifactProducerProvenance(inventory: RepositoryInventory): AuditSection<ArtifactProducerProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory), signals: ArtifactProducerSignal[] = [], findings: Finding[] = [];
  for (const file of files) for (const block of workflowJobBlocks(file)) {
    const steps = workflowStepBlocks(block);
    for (const step of steps) {
      const signal = signalFor(block, steps, step); if (!signal) continue;
      signals.push(signal); findings.push(...findingsFor(signal, step));
    }
  }
  const canonical = stableSortFindings(findings);
  return { domain:'security', title:'CI artifact producer provenance and identity audit', summary:{ workflowFiles:files.length, artifactDownloads:signals.length, crossRunDownloads:signals.filter(x=>x.crossRun).length, dynamicProducerSelectors:signals.filter(x=>x.dynamicRunSelector||x.dynamicRepository||x.dynamicArtifactSelector).length, executableCrossRunDownloads:signals.filter(x=>x.crossRun&&x.executableConsumer).length, signals, findings:canonical }, findings:canonical, elapsedMs:Math.max(0,performance.now()-started) };
}
