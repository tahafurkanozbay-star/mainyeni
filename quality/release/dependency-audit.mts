import {
  asString,
  isRecord,
  stableSortFindings,
  type AuditSection,
  type DependencyPolicy,
  type DependencyRecord,
  type DependencySummary,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import { collectManifestInventory } from './inventory.mts';

export const WEB_DEPENDENCY_POLICIES: readonly DependencyPolicy[] = Object.freeze([
  {
    name: 'react-scripts',
    legacyPattern: /^(?:\^|~)?4\./,
    severity: 'high',
    reason: 'Create React App 4/Webpack 4 is a legacy build baseline with substantial transitive security and maintenance debt.',
    migration: 'Plan a measured Vite 8 migration with entrypoint, asset, env, test, service-worker and ArcGIS compatibility gates.',
    tags: ['build', 'cra', 'vite-readiness'],
  },
  {
    name: 'react',
    legacyPattern: /^(?:\^|~)?17\./,
    severity: 'medium',
    reason: 'React 17 predates current React 19 concurrency, modern root and platform capabilities.',
    migration: 'Move through compatibility cleanup first, then React 19 with targeted component and test verification.',
    tags: ['react', 'ui'],
  },
  {
    name: 'react-dom',
    legacyPattern: /^(?:\^|~)?17\./,
    severity: 'medium',
    reason: 'ReactDOM 17 keeps the application on the legacy rendering root.',
    migration: 'Adopt the modern root API together with React 19 after lifecycle/hydration assumptions are audited.',
    tags: ['react', 'rendering'],
  },
  {
    name: 'axios',
    legacyPattern: /^(?:\^|~)?0\./,
    severity: 'high',
    reason: 'Axios 0.x is obsolete and has a large historical advisory surface.',
    migration: 'Prefer the existing native fetch transport; remove axios after usage reaches zero, or upgrade in an isolated compatibility PR.',
    tags: ['network', 'security'],
  },
  {
    name: 'crypto-js',
    legacyPattern: /^(?:\^|~)?4\.0\./,
    severity: 'high',
    reason: 'Client-side cryptographic dependency is old and browser cryptography should not establish a privileged security boundary.',
    migration: 'Move security-sensitive cryptography server-side; use Web Crypto only for legitimate client-local primitives.',
    tags: ['crypto', 'security'],
  },
  {
    name: 'jspdf',
    legacyPattern: /^(?:\^|~)?2\.[0-4](?:\.|$)/,
    severity: 'high',
    reason: 'Old jsPDF baselines have accumulated parser, injection and denial-of-service advisories.',
    migration: 'Inventory PDF callsites and input trust boundaries, then upgrade with golden PDF regression fixtures.',
    tags: ['pdf', 'security'],
  },
  {
    name: '@testing-library/react',
    legacyPattern: /^(?:\^|~)?11\./,
    severity: 'medium',
    reason: 'Legacy Testing Library limits modern React behavior and accessibility-oriented test APIs.',
    migration: 'Upgrade together with React migration and remove obsolete act/render compatibility patterns.',
    tags: ['testing', 'react'],
  },
  {
    name: '@testing-library/user-event',
    legacyPattern: /^(?:\^|~)?12\./,
    severity: 'medium',
    reason: 'Old user-event behavior can hide modern pointer/keyboard interaction regressions.',
    migration: 'Upgrade tests incrementally and await async user interactions explicitly.',
    tags: ['testing', 'accessibility'],
  },
  {
    name: 'web-vitals',
    legacyPattern: /^(?:\^|~)?0\./,
    severity: 'medium',
    reason: 'The metrics package predates current Core Web Vitals definitions and APIs.',
    migration: 'Adopt a current web-vitals release when telemetry consumers and metric names are verified.',
    tags: ['performance', 'observability'],
  },
]);

function entries(value: unknown): [string, string][] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort((left, right) => left[0].localeCompare(right[0], 'en'));
}

export function collectDependencies(inventory: RepositoryInventory): DependencyRecord[] {
  const manifests = collectManifestInventory(inventory);
  const records: DependencyRecord[] = [];
  for (const document of manifests.packageJson) {
    if (!document.result.ok || !document.result.value) continue;
    const packageJson = document.result.value;
    for (const [name, version] of entries(packageJson.dependencies)) {
      records.push({ name, version, scope: 'runtime', manifest: document.file.repositoryPath });
    }
    for (const [name, version] of entries(packageJson.devDependencies)) {
      records.push({ name, version, scope: 'development', manifest: document.file.repositoryPath });
    }
  }
  return records;
}

function policyFinding(dependency: DependencyRecord, policy: DependencyPolicy): Finding | null {
  if (!policy.legacyPattern?.test(dependency.version)) return null;
  return {
    id: `dependency-legacy-${dependency.name.replace(/[^a-z0-9]+/gi, '-')}`,
    domain: 'dependencies',
    severity: policy.severity,
    title: `Legacy dependency: ${dependency.name}`,
    message: policy.reason,
    location: { file: dependency.manifest, line: 1 },
    evidence: { value: `${dependency.name}@${dependency.version}` },
    remediation: policy.migration,
    ...(policy.tags ? { tags: policy.tags } : {}),
  };
}

function packageLockRootDependencies(lock: Record<string, unknown>): Record<string, string> {
  const packages = lock.packages;
  if (!isRecord(packages)) return {};
  const root = packages[''];
  if (!isRecord(root)) return {};
  const merged = { ...((isRecord(root.dependencies) ? root.dependencies : {})), ...((isRecord(root.devDependencies) ? root.devDependencies : {})) };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function manifestDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const merged = {
    ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isRecord(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function detectManifestLockDrift(inventory: RepositoryInventory): Finding[] {
  const manifests = collectManifestInventory(inventory);
  const findings: Finding[] = [];

  for (const manifestDocument of manifests.packageJson) {
    if (!manifestDocument.result.ok || !manifestDocument.result.value) continue;
    const directory = directoryOf(manifestDocument.file.repositoryPath);
    const expectedLockPath = directory ? `${directory}/package-lock.json` : 'package-lock.json';
    const lockDocument = manifests.packageLocks.find(document => document.file.repositoryPath === expectedLockPath);
    if (!lockDocument) continue;
    if (!lockDocument.result.ok || !lockDocument.result.value) {
      findings.push({
        id: 'package-lock-invalid-json',
        domain: 'dependencies',
        severity: 'critical',
        title: 'Invalid package-lock.json',
        message: 'The lockfile cannot be parsed deterministically.',
        location: { file: expectedLockPath, line: 1 },
        evidence: { value: lockDocument.result.error ?? 'JSON parse failure' },
        remediation: 'Regenerate the lockfile with the repository-supported npm version and rerun full CI.',
        blocking: true,
      });
      continue;
    }

    const manifest = manifestDependencies(manifestDocument.result.value);
    const lock = packageLockRootDependencies(lockDocument.result.value);
    const manifestNames = new Set(Object.keys(manifest));
    const lockNames = new Set(Object.keys(lock));

    for (const name of [...manifestNames].sort((a, b) => a.localeCompare(b, 'en'))) {
      if (!lockNames.has(name)) {
        findings.push({
          id: 'package-lock-missing-root-dependency',
          domain: 'dependencies',
          severity: 'high',
          title: 'Manifest dependency missing from lock root',
          message: `${name} is declared in package.json but absent from package-lock root metadata.`,
          location: { file: expectedLockPath, line: 1 },
          evidence: { value: `${name}@${manifest[name] ?? ''}` },
          remediation: 'Regenerate the lockfile and validate npm ci, tests and production build.',
        });
      }
    }

    for (const name of [...lockNames].sort((a, b) => a.localeCompare(b, 'en'))) {
      if (!manifestNames.has(name)) {
        findings.push({
          id: 'package-lock-stale-root-dependency',
          domain: 'dependencies',
          severity: 'medium',
          title: 'Stale lock root dependency',
          message: `${name} exists in package-lock root metadata but is no longer declared in package.json.`,
          location: { file: expectedLockPath, line: 1 },
          evidence: { value: `${name}@${lock[name] ?? ''}` },
          remediation: 'Regenerate the lockfile in a controlled dependency-maintenance change.',
        });
      }
    }
  }

  return findings;
}

function detectPackageManagerAmbiguity(inventory: RepositoryInventory): Finding[] {
  const findings: Finding[] = [];
  const roots = new Map<string, Set<string>>();
  for (const file of inventory.files) {
    const name = file.repositoryPath.split('/').at(-1)?.toLowerCase();
    if (!['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].includes(name ?? '')) continue;
    const directory = directoryOf(file.repositoryPath);
    const set = roots.get(directory) ?? new Set<string>();
    set.add(name ?? '');
    roots.set(directory, set);
  }
  for (const [directory, locks] of roots) {
    if (locks.size <= 1) continue;
    findings.push({
      id: 'multiple-package-manager-lockfiles',
      domain: 'dependencies',
      severity: 'high',
      title: 'Multiple package manager lockfiles',
      message: `Multiple lockfile authorities exist under ${directory || 'repository root'}.`,
      location: { file: directory || '.', line: 1 },
      evidence: { value: [...locks].sort().join(', ') },
      remediation: 'Select one package manager authority and remove stale lockfiles after reproducible CI validation.',
    });
  }
  return findings;
}

function detectUnpinnedActions(inventory: RepositoryInventory): Finding[] {
  const findings: Finding[] = [];
  const manifests = collectManifestInventory(inventory);
  for (const workflow of manifests.workflowFiles) {
    const pattern = /^\s*uses:\s*([^\s#]+)\s*$/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(workflow.text)) !== null) {
      const action = asString(match[1]);
      if (!action.includes('@')) continue;
      const version = action.split('@').at(-1) ?? '';
      if (/^[0-9a-f]{40}$/i.test(version)) continue;
      if (/^v\d+(?:\.\d+){0,2}$/.test(version)) continue;
      findings.push({
        id: 'workflow-action-floating-ref',
        domain: 'dependencies',
        severity: 'medium',
        title: 'Workflow action uses floating/nonstandard ref',
        message: 'Third-party workflow actions should use an intentional stable version or immutable commit pin.',
        location: { file: workflow.repositoryPath, line: workflow.text.slice(0, match.index).split('\n').length },
        evidence: { value: action },
        remediation: 'Pin the action to an approved stable major/minor or immutable SHA according to repository policy.',
      });
    }
  }
  return findings;
}

export function auditDependencies(
  inventory: RepositoryInventory,
  policies: readonly DependencyPolicy[] = WEB_DEPENDENCY_POLICIES,
): AuditSection<DependencySummary> {
  const start = performance.now();
  const dependencies = collectDependencies(inventory);
  const findings: Finding[] = [];
  const policyByName = new Map(policies.map(policy => [policy.name, policy]));

  for (const dependency of dependencies) {
    const policy = policyByName.get(dependency.name);
    if (!policy) continue;
    const finding = policyFinding(dependency, policy);
    if (finding) findings.push(finding);
  }

  findings.push(...detectManifestLockDrift(inventory));
  findings.push(...detectPackageManagerAmbiguity(inventory));
  findings.push(...detectUnpinnedActions(inventory));

  const sorted = stableSortFindings(findings);
  const manifests = [...new Set(dependencies.map(dependency => dependency.manifest))].sort();
  return {
    domain: 'dependencies',
    title: 'Dependency and build-chain modernization audit',
    summary: {
      dependencies,
      findings: sorted,
      manifests,
      legacyCount: sorted.filter(finding => finding.id.startsWith('dependency-legacy-')).length,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
