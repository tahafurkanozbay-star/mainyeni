import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasExpression,
  hasUntrustedExpression,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';

export type ContainerKind = 'job' | 'service';

export interface ContainerBoundarySignal {
  readonly file: string;
  readonly job: string;
  readonly name: string;
  readonly kind: ContainerKind;
  readonly image: string;
  readonly immutableDigest: boolean;
  readonly dynamicImage: boolean;
  readonly untrustedImage: boolean;
  readonly privileged: boolean;
  readonly hostNetwork: boolean;
  readonly hostPid: boolean;
  readonly dockerSocket: boolean;
  readonly rootMount: boolean;
  readonly secretReference: boolean;
  readonly externalTrigger: boolean;
}

export interface ContainerBoundarySummary {
  readonly workflowFiles: number;
  readonly containers: number;
  readonly services: number;
  readonly mutableImages: number;
  readonly dynamicImages: number;
  readonly dangerousRuntimeOptions: number;
  readonly signals: readonly ContainerBoundarySignal[];
  readonly findings: readonly Finding[];
}

interface NestedBlock {
  readonly line: WorkflowLine;
  readonly lines: readonly WorkflowLine[];
  readonly scalar: string;
  readonly text: string;
}

const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}(?:\s|$)/i;
const PRIVILEGED = /(?:^|\s)--privileged(?:\s|$)/i;
const HOST_NETWORK = /(?:^|\s)--network(?:=|\s+)host(?:\s|$)/i;
const HOST_PID = /(?:^|\s)--pid(?:=|\s+)host(?:\s|$)/i;
const DOCKER_SOCKET = /(?:\/var\/run\/docker\.sock|docker\.sock\s*:)/i;
const ROOT_MOUNT = /(?:^|[\s"'])\/(?:\s*:\s*\/|:\/(?:\s|$))/m;
const SECRET_REFERENCE = /\$\{\{\s*secrets\./i;
const MAPPING = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

function nestedBlock(lines: readonly WorkflowLine[], key: string, minimumIndent: number): NestedBlock | undefined {
  const matcher = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'i');
  const start = lines.find(line => line.indent > minimumIndent && matcher.test(line.text));
  if (!start) return undefined;
  const scalar = start.text.match(matcher)?.[1]?.trim() ?? '';
  const nested: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= start.line) continue;
    if (line.trimmed && line.indent <= start.indent) break;
    if (line.trimmed) nested.push(line);
  }
  return { line: start, lines: nested, scalar, text: [scalar, ...nested.map(line => line.text)].join('\n') };
}

function directChildren(block: NestedBlock): Array<{ name: string; block: NestedBlock }> {
  const candidates = block.lines.filter(line => MAPPING.test(line.text));
  const directIndent = candidates.reduce<number | undefined>((minimum, line) => minimum === undefined ? line.indent : Math.min(minimum, line.indent), undefined);
  if (directIndent === undefined) return [];
  const starts = candidates.filter(line => line.indent === directIndent);
  return starts.map((start, index) => {
    const next = starts[index + 1];
    const lines = block.lines.filter(line => line.line > start.line && (!next || line.line < next.line) && (!line.trimmed || line.indent > start.indent));
    const match = start.text.match(MAPPING);
    const name = match?.[1] ?? 'unknown';
    const scalar = match?.[2]?.trim() ?? '';
    return { name, block: { line: start, lines, scalar, text: [scalar, ...lines.map(line => line.text)].join('\n') } };
  });
}

function field(block: NestedBlock, key: string): { value: string; line: number } | undefined {
  const matcher = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'i');
  const line = block.lines.find(candidate => matcher.test(candidate.text));
  if (!line) return undefined;
  return { value: line.text.match(matcher)?.[1]?.trim() ?? '', line: line.line };
}

function jobContainer(job: WorkflowJobBlock): Array<{ name: string; kind: ContainerKind; block: NestedBlock; image: string; imageLine: number }> {
  const container = nestedBlock(job.lines, 'container', job.indent);
  if (!container) return [];
  if (container.scalar) {
    return [{ name: job.name, kind: 'job', block: container, image: container.scalar, imageLine: container.line.line }];
  }
  const image = field(container, 'image');
  return [{ name: job.name, kind: 'job', block: container, image: image?.value ?? '', imageLine: image?.line ?? container.line.line }];
}

function services(job: WorkflowJobBlock): Array<{ name: string; kind: ContainerKind; block: NestedBlock; image: string; imageLine: number }> {
  const serviceBlock = nestedBlock(job.lines, 'services', job.indent);
  if (!serviceBlock) return [];
  return directChildren(serviceBlock).map(({ name, block }) => {
    if (block.scalar) return { name, kind: 'service' as const, block, image: block.scalar, imageLine: block.line.line };
    const image = field(block, 'image');
    return { name, kind: 'service' as const, block, image: image?.value ?? '', imageLine: image?.line ?? block.line.line };
  });
}

function normalizeImage(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed.split(/\s+#/)[0]?.trim() ?? trimmed;
}

function runtimeOptions(text: string) {
  return {
    privileged: PRIVILEGED.test(text),
    hostNetwork: HOST_NETWORK.test(text),
    hostPid: HOST_PID.test(text),
    dockerSocket: DOCKER_SOCKET.test(text),
    rootMount: ROOT_MOUNT.test(text),
  };
}

function signals(job: WorkflowJobBlock): ContainerBoundarySignal[] {
  const trigger = workflowTriggerProfile(job.file);
  return [...jobContainer(job), ...services(job)].map(item => {
    const image = normalizeImage(item.image);
    const options = runtimeOptions(item.block.text);
    return {
      file: job.file.repositoryPath,
      job: job.name,
      name: item.name,
      kind: item.kind,
      image,
      immutableDigest: IMAGE_DIGEST.test(image),
      dynamicImage: hasExpression(image),
      untrustedImage: hasUntrustedExpression(image),
      ...options,
      secretReference: SECRET_REFERENCE.test(item.block.text),
      externalTrigger: trigger.externalContribution,
    };
  });
}

function containerItems(job: WorkflowJobBlock) {
  return [...jobContainer(job), ...services(job)];
}

function containerFindings(job: WorkflowJobBlock): Finding[] {
  const items = containerItems(job);
  const currentSignals = signals(job);
  const findings: Finding[] = [];
  for (let index = 0; index < currentSignals.length; index += 1) {
    const current = currentSignals[index]!;
    const item = items[index]!;
    const location = { file: job.file.repositoryPath, line: item.imageLine };
    const subject = current.kind === 'service' ? `Service ${current.name}` : `Job ${job.name} container`;

    if (!current.image) {
      findings.push({
        id: 'ci-container-image-missing',
        domain: 'security',
        severity: 'high',
        title: 'Container declaration has no explicit image',
        message: `${subject} does not declare a reviewable image identity.`,
        location,
        remediation: 'Declare a literal registry image pinned to an immutable sha256 digest.',
        tags: ['ci', 'container', 'supply-chain'],
      });
    } else if (current.untrustedImage || current.dynamicImage) {
      findings.push({
        id: current.untrustedImage ? 'ci-container-untrusted-image' : 'ci-container-dynamic-image',
        domain: 'security',
        severity: 'critical',
        blocking: true,
        title: current.untrustedImage ? 'Container image identity is attacker-controlled' : 'Container image identity is expression-derived',
        message: `${subject} selects executable container code through ${current.image}; workflow expressions must not redirect container identity.`,
        location,
        evidence: { value: current.image },
        remediation: 'Use a literal image reference pinned by sha256 digest. Pass variability through validated data, not executable image identity.',
        tags: ['ci', 'container', 'expression-injection', 'supply-chain'],
      });
    } else if (!current.immutableDigest) {
      findings.push({
        id: 'ci-container-mutable-image',
        domain: 'security',
        severity: current.externalTrigger ? 'high' : 'medium',
        title: 'Workflow container image is not digest-pinned',
        message: `${subject} uses mutable image ${current.image}; a moved tag changes executable CI code without a repository diff.`,
        location,
        evidence: { value: current.image },
        remediation: 'Pin the image to an immutable sha256 digest and retain a human-readable tag in a comment or update metadata.',
        tags: ['ci', 'container', 'supply-chain', 'provenance'],
      });
    }

    const dangerous = [current.privileged, current.hostNetwork, current.hostPid, current.dockerSocket, current.rootMount].filter(Boolean).length;
    const optionFindings: Array<[boolean, string, string, string]> = [
      [current.privileged, 'ci-container-privileged', 'Container runs with --privileged', 'Remove --privileged. Grant the narrow capability or device access the workload actually requires.'],
      [current.hostNetwork, 'ci-container-host-network', 'Container shares the host network namespace', 'Remove host networking and expose only required service ports on an isolated network.'],
      [current.hostPid, 'ci-container-host-pid', 'Container shares the host PID namespace', 'Remove host PID sharing and keep process namespaces isolated.'],
      [current.dockerSocket, 'ci-container-docker-socket', 'Container mounts the Docker daemon socket', 'Do not mount the host Docker socket into workflow containers. Use isolated build services with narrow APIs.'],
      [current.rootMount, 'ci-container-root-mount', 'Container mounts the host root filesystem', 'Remove root filesystem mounts and expose only the minimum workspace paths required by the job.'],
    ];
    for (const [active, id, title, remediation] of optionFindings) {
      if (!active) continue;
      findings.push({
        id,
        domain: 'security',
        severity: 'critical',
        blocking: true,
        title,
        message: `${subject} weakens the container/host isolation boundary. Compromise can escape the intended CI sandbox.`,
        location,
        remediation,
        tags: ['ci', 'container', 'host-isolation'],
      });
    }

    if (current.externalTrigger && current.secretReference) {
      findings.push({
        id: 'ci-container-external-secret-exposure',
        domain: 'security',
        severity: 'critical',
        blocking: true,
        title: 'Externally triggered container receives repository secrets',
        message: `${subject} references repository secrets in a workflow reachable from contribution-controlled events.`,
        location,
        remediation: 'Remove secrets from external validation containers. Use a trusted environment-protected follow-up workflow for privileged publication or deployment.',
        tags: ['ci', 'container', 'secrets', 'untrusted-code'],
      });
    }

    if (current.externalTrigger && !current.immutableDigest && dangerous > 0) {
      findings.push({
        id: 'ci-container-external-mutable-host-access',
        domain: 'security',
        severity: 'critical',
        blocking: true,
        title: 'External workflow combines mutable image with host-level container access',
        message: `${subject} is externally reachable, not digest-pinned, and requests ${dangerous} host-isolation exception(s).`,
        location,
        remediation: 'Use an immutable image and remove host-level runtime options. External validation should execute in a disposable least-privilege sandbox.',
        tags: ['ci', 'container', 'supply-chain', 'host-isolation'],
      });
    }
  }
  return findings;
}

export function auditContainerBoundaries(inventory: RepositoryInventory): AuditSection<ContainerBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const allSignals = jobs.flatMap(signals);
  const findings = stableSortFindings(jobs.flatMap(containerFindings));
  return {
    domain: 'security',
    title: 'CI container image and host-isolation boundary audit',
    summary: {
      workflowFiles: files.length,
      containers: allSignals.filter(item => item.kind === 'job').length,
      services: allSignals.filter(item => item.kind === 'service').length,
      mutableImages: allSignals.filter(item => item.image && !item.immutableDigest && !item.dynamicImage).length,
      dynamicImages: allSignals.filter(item => item.dynamicImage).length,
      dangerousRuntimeOptions: allSignals.reduce((sum, item) => sum + [item.privileged, item.hostNetwork, item.hostPid, item.dockerSocket, item.rootMount].filter(Boolean).length, 0),
      signals: allSignals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
