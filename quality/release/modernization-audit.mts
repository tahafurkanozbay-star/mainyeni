import {
  isRecord,
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import { collectManifestInventory, findFile } from './inventory.mts';

export interface ModernizationTarget {
  readonly area: string;
  readonly current: string;
  readonly target: string;
  readonly strategy: 'keep' | 'incremental' | 'dedicated-migration';
  readonly rationale: string;
  readonly prerequisites: readonly string[];
}

export interface ModernizationSummary {
  readonly javascriptFiles: number;
  readonly typescriptFiles: number;
  readonly csharpFiles: number;
  readonly typescriptRatio: number;
  readonly reactVersion: string | null;
  readonly reactScriptsVersion: string | null;
  readonly viteDetected: boolean;
  readonly targetFramework: string | null;
  readonly languageVersion: string | null;
  readonly nullableMode: string | null;
  readonly targets: readonly ModernizationTarget[];
  readonly findings: readonly Finding[];
}

function packageJson(inventory: RepositoryInventory, path: string): Record<string, unknown> | null {
  const file = findFile(inventory, path);
  if (!file) return null;
  const parsed = safeJsonParse<Record<string, unknown>>(file.text);
  return parsed.ok && parsed.value ? parsed.value : null;
}

function dependencyVersion(manifest: Record<string, unknown> | null, name: string): string | null {
  if (!manifest) return null;
  const sources = [manifest.dependencies, manifest.devDependencies];
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const value = source[name];
    if (typeof value === 'string') return value;
  }
  return null;
}

function xmlValue(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function calculateTypeScriptRatio(javascriptFiles: number, typescriptFiles: number): number {
  const total = javascriptFiles + typescriptFiles;
  return total === 0 ? 0 : typescriptFiles / total;
}

function targets(
  reactVersion: string | null,
  reactScriptsVersion: string | null,
  viteDetected: boolean,
  targetFramework: string | null,
  languageVersion: string | null,
  typescriptRatio: number,
): ModernizationTarget[] {
  return [
    {
      area: 'frontend-language',
      current: typescriptRatio === 0 ? 'JavaScript-only application code' : `Mixed JavaScript/TypeScript (${Math.round(typescriptRatio * 100)}% TS by source-file count)`,
      target: 'TypeScript 7 typed-by-default for new shared/runtime modules',
      strategy: 'incremental',
      rationale: 'Type contracts reduce schema/GIS/network regression risk without requiring a one-shot UI rewrite.',
      prerequisites: [
        'strict typecheck lane stays green',
        'Node/browser module boundaries remain explicit',
        'convert shared pure runtimes before stateful legacy components',
      ],
    },
    {
      area: 'frontend-build',
      current: viteDetected ? 'Vite detected' : `react-scripts ${reactScriptsVersion ?? 'unknown'}`,
      target: 'Vite 8.x stable build/test-compatible pipeline',
      strategy: viteDetected ? 'keep' : 'dedicated-migration',
      rationale: 'CRA/Webpack 4 carries large transitive debt; Vite 8 uses the current Rolldown-based toolchain and reduces dev/build overhead.',
      prerequisites: [
        'inventory PUBLIC_URL/process.env assumptions',
        'preserve lazy query-window chunking',
        'validate ArcGIS/esri-loader and static asset paths',
        'capture production bundle baseline before switching',
        'migrate tests without reducing coverage',
      ],
    },
    {
      area: 'frontend-framework',
      current: `React ${reactVersion ?? 'unknown'}`,
      target: 'React 19.3 stable',
      strategy: reactVersion?.includes('19.3') ? 'keep' : 'dedicated-migration',
      rationale: 'Modern React support should follow lifecycle/focus/test cleanup, not precede it.',
      prerequisites: [
        'remove unsafe legacy lifecycle usage',
        'modernize root/render contract',
        'upgrade Testing Library in the same compatibility program',
        're-run GIS widget lifecycle and accessibility smoke tests',
      ],
    },
    {
      area: 'backend-runtime',
      current: `${targetFramework ?? 'unknown framework'} / C# ${languageVersion ?? 'unknown'}`,
      target: 'net10.0 + stable current C# language features',
      strategy: targetFramework === 'net10.0' ? 'keep' : 'incremental',
      rationale: 'The backend is already on a modern runtime; focus should be nullability, analyzers, resilience and measurable hot-path improvements.',
      prerequisites: [
        'restore/build/test/publish remain green',
        'enable stricter compiler features project-by-project',
      ],
    },
  ];
}

function buildFindings(
  reactVersion: string | null,
  reactScriptsVersion: string | null,
  viteDetected: boolean,
  targetFramework: string | null,
  nullableMode: string | null,
  typescriptRatio: number,
): Finding[] {
  const findings: Finding[] = [];
  if (typescriptRatio < 0.1) {
    findings.push({
      id: 'modernization-typescript-adoption-low',
      domain: 'architecture',
      severity: 'medium',
      title: 'TypeScript adoption is low',
      message: 'The frontend remains predominantly untyped JavaScript, increasing refactor and schema-contract risk.',
      remediation: 'Adopt TypeScript 7 incrementally for shared pure runtimes, contracts and new modules; do not mass-rename legacy components.',
      tags: ['typescript', 'migration'],
    });
  }
  if (reactScriptsVersion && /^\^?4\./.test(reactScriptsVersion) && !viteDetected) {
    findings.push({
      id: 'modernization-cra4-build-chain',
      domain: 'architecture',
      severity: 'high',
      title: 'Legacy CRA 4 build chain',
      message: 'The frontend build remains tied to react-scripts 4 / Webpack 4 era tooling.',
      location: { file: 'Webclient.app/package.json', line: 1 },
      evidence: { value: reactScriptsVersion },
      remediation: 'Execute a dedicated Vite 8 migration after compatibility inventory and bundle/test baselines are captured.',
      tags: ['cra', 'vite'],
    });
  }
  if (reactVersion && /^\^?17\./.test(reactVersion)) {
    findings.push({
      id: 'modernization-react17',
      domain: 'architecture',
      severity: 'medium',
      title: 'React 17 framework baseline',
      message: 'The UI framework is multiple major generations behind the current stable React line.',
      location: { file: 'Webclient.app/package.json', line: 1 },
      evidence: { value: reactVersion },
      remediation: 'Prepare a React 19.3 migration with lifecycle, root, test and third-party compatibility gates.',
      tags: ['react'],
    });
  }
  if (targetFramework && targetFramework !== 'net10.0') {
    findings.push({
      id: 'modernization-dotnet-target',
      domain: 'architecture',
      severity: 'medium',
      title: 'Backend target framework review',
      message: `Backend target framework is ${targetFramework}, not the repository modernization baseline net10.0.`,
      location: { file: 'Directory.Build.props', line: 1 },
      evidence: { value: targetFramework },
      remediation: 'Move to net10.0 only after package/API compatibility is verified.',
    });
  }
  if (nullableMode?.toLowerCase() === 'disable') {
    findings.push({
      id: 'modernization-csharp-nullable-disabled',
      domain: 'architecture',
      severity: 'medium',
      title: 'C# nullable analysis disabled globally',
      message: 'Global nullable disable leaves a large class of contract/null-reference regressions outside compiler analysis.',
      location: { file: 'Directory.Build.props', line: 1 },
      evidence: { value: nullableMode },
      remediation: 'Enable nullable incrementally by project/namespace and fix warnings; do not flip the entire solution without a remediation pass.',
      tags: ['csharp', 'nullability'],
    });
  }
  return findings;
}

export function auditModernization(inventory: RepositoryInventory): AuditSection<ModernizationSummary> {
  const start = performance.now();
  const javascriptFiles = inventory.languageStats.find(stat => stat.kind === 'javascript')?.files ?? 0;
  const typescriptFiles = inventory.languageStats.find(stat => stat.kind === 'typescript')?.files ?? 0;
  const csharpFiles = inventory.languageStats.find(stat => stat.kind === 'csharp')?.files ?? 0;
  const typescriptRatio = calculateTypeScriptRatio(javascriptFiles, typescriptFiles);
  const webManifest = packageJson(inventory, 'Webclient.app/package.json');
  const reactVersion = dependencyVersion(webManifest, 'react');
  const reactScriptsVersion = dependencyVersion(webManifest, 'react-scripts');
  const manifestInventory = collectManifestInventory(inventory);
  const viteDetected = manifestInventory.configFiles.some(file => /vite\.config\.[cm]?[jt]s$/.test(file.repositoryPath))
    || dependencyVersion(webManifest, 'vite') !== null;
  const buildProps = findFile(inventory, 'Directory.Build.props');
  const targetFramework = buildProps ? xmlValue(buildProps.text, 'TargetFramework') : null;
  const languageVersion = buildProps ? xmlValue(buildProps.text, 'LangVersion') : null;
  const nullableMode = buildProps ? xmlValue(buildProps.text, 'Nullable') : null;
  const migrationTargets = targets(reactVersion, reactScriptsVersion, viteDetected, targetFramework, languageVersion, typescriptRatio);
  const findings = stableSortFindings(buildFindings(
    reactVersion,
    reactScriptsVersion,
    viteDetected,
    targetFramework,
    nullableMode,
    typescriptRatio,
  ));

  return {
    domain: 'architecture',
    title: 'Language, framework and build modernization readiness',
    summary: {
      javascriptFiles,
      typescriptFiles,
      csharpFiles,
      typescriptRatio,
      reactVersion,
      reactScriptsVersion,
      viteDetected,
      targetFramework,
      languageVersion,
      nullableMode,
      targets: migrationTargets,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
