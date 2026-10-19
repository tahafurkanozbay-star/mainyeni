import {
  isRecord,
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import { collectManifestInventory } from './inventory.mts';
import {
  auditModernizationPlatform,
  type ModernizationPlatformSummary,
} from './modernization-platform-audit.mts';

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
  readonly typescriptRatio: number;
  readonly reactVersion: string | null;
  readonly reactScriptsVersion: string | null;
  readonly viteDetected: boolean;
  readonly targets: readonly ModernizationTarget[];
  readonly platformGovernance: ModernizationPlatformSummary;
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

function calculateTypeScriptRatio(javascriptFiles: number, typescriptFiles: number): number {
  const total = javascriptFiles + typescriptFiles;
  return total === 0 ? 0 : typescriptFiles / total;
}

function targets(
  reactVersion: string | null,
  reactScriptsVersion: string | null,
  viteDetected: boolean,
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
  ];
}

function buildFindings(
  reactVersion: string | null,
  reactScriptsVersion: string | null,
  viteDetected: boolean,
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
  return findings;
}

export function auditModernization(inventory: RepositoryInventory): AuditSection<ModernizationSummary> {
  const start = performance.now();
  const javascriptFiles = inventory.languageStats.find(stat => stat.kind === 'javascript')?.files ?? 0;
  const typescriptFiles = inventory.languageStats.find(stat => stat.kind === 'typescript')?.files ?? 0;
  const typescriptRatio = calculateTypeScriptRatio(javascriptFiles, typescriptFiles);
  const webManifest = packageJson(inventory, 'Webclient.app/package.json');
  const reactVersion = dependencyVersion(webManifest, 'react');
  const reactScriptsVersion = dependencyVersion(webManifest, 'react-scripts');
  const manifestInventory = collectManifestInventory(inventory);
  const viteDetected = manifestInventory.configFiles.some(file => /vite\.config\.[cm]?[jt]s$/.test(file.repositoryPath))
    || dependencyVersion(webManifest, 'vite') !== null;
  const migrationTargets = targets(reactVersion, reactScriptsVersion, viteDetected, typescriptRatio);
  const platformGovernance = auditModernizationPlatform(inventory);
  const findings = stableSortFindings([
    ...buildFindings(
      reactVersion,
      reactScriptsVersion,
      viteDetected,
      typescriptRatio,
    ),
    ...platformGovernance.findings,
  ]);

  return {
    domain: 'architecture',
    title: 'Language, framework and build modernization readiness',
    summary: {
      javascriptFiles,
      typescriptFiles,
      typescriptRatio,
      reactVersion,
      reactScriptsVersion,
      viteDetected,
      targets: migrationTargets,
      platformGovernance: platformGovernance.summary,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
