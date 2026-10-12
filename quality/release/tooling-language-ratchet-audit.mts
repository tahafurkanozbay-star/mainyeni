import {
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface ToolingRatchetFile {
  readonly file: string;
  readonly test: boolean;
  readonly bytes: number;
  readonly lines: number;
  readonly extension: string;
  readonly compatibilityShim: boolean;
  readonly baselineListed: boolean;
  readonly priority: number;
}

export interface ToolingLanguageRatchetSummary {
  readonly baselinePath: string;
  readonly baselineProductionBudget: number;
  readonly baselineTestBudget: number;
  readonly productionLegacy: number;
  readonly testLegacy: number;
  readonly compatibilityShims: number;
  readonly unlistedProduction: readonly string[];
  readonly unlistedTests: readonly string[];
  readonly staleBaselineProduction: readonly string[];
  readonly staleBaselineTests: readonly string[];
  readonly migrationQueue: readonly ToolingRatchetFile[];
  readonly findings: readonly Finding[];
}

interface Baseline {
  readonly schemaVersion: 1;
  readonly description: string;
  readonly productionLegacy: readonly string[];
  readonly testLegacy: readonly string[];
}

const BASELINE_PATH = 'quality/release/tooling-language-baseline.json';
const TOOLING_PATH = /^(?:tools\/|quality\/|scripts\/|Webclient\.app\/scripts\/|Webclient\.admin\/(?:scripts|tooling)\/)/i;
const LEGACY_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const TEST_FILE = /(?:\.test|\.spec)\.(?:js|jsx|mjs|cjs)$/i;
const GENERATED_OR_FIXTURE = /(?:^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts|generated|fixtures?|snapshots?|__snapshots__)(?:\/|$)/i;
const MTS_REFERENCE = /(?:from\s*|import\s*\()\s*['"][^'"]+\.mts['"]/;
const LOGIC_TOKEN = /\b(?:function|class|const|let|var|switch|while|for|try|catch)\b|=>/;
const CLI_FORWARD = /\b(?:run|main|cli)[A-Za-z0-9_$]*\s*\(/i;

function eligible(file: SourceFile): boolean {
  return TOOLING_PATH.test(file.repositoryPath)
    && LEGACY_EXTENSION.test(file.repositoryPath)
    && !GENERATED_OR_FIXTURE.test(file.repositoryPath);
}

function lines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function compatibilityShim(file: SourceFile): boolean {
  const count = lines(file.text);
  if (count > 14 || count < 1) return false;
  if (!MTS_REFERENCE.test(file.text)) return false;
  const withoutImports = file.text
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (LOGIC_TOKEN.test(withoutImports)) return false;
  return withoutImports.length === 0 || CLI_FORWARD.test(withoutImports);
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return value.map(String);
}

function baseline(inventory: RepositoryInventory): { baseline: Baseline | null; findings: Finding[] } {
  const file = inventory.files.find(item => item.repositoryPath === BASELINE_PATH);
  if (!file) return {
    baseline: null,
    findings: [{
      id: 'tooling-language-baseline-missing', domain: 'build', severity: 'critical', blocking: true,
      title: 'Legacy tooling language ratchet baseline is missing',
      message: 'Without a path-bounded baseline, new JavaScript tooling debt can enter the repository without a deterministic non-growth gate.',
      location: { file: BASELINE_PATH, line: 1 },
      remediation: 'Restore the versioned baseline and only remove entries as modules migrate to strict TypeScript.',
      tags: ['tooling', 'typescript', 'ratchet'],
    }],
  };
  const parsed = safeJsonParse<Record<string, unknown>>(file.text);
  if (!parsed.ok || !parsed.value) return {
    baseline: null,
    findings: [{
      id: 'tooling-language-baseline-invalid-json', domain: 'build', severity: 'critical', blocking: true,
      title: 'Tooling language baseline is not valid JSON',
      message: 'The release gate cannot determine whether legacy JavaScript tooling debt grew.',
      location: { file: BASELINE_PATH, line: 1 },
      remediation: 'Repair the baseline JSON without increasing the legacy path budgets.',
      tags: ['tooling', 'typescript', 'ratchet'],
    }],
  };
  const production = readStringArray(parsed.value.productionLegacy);
  const tests = readStringArray(parsed.value.testLegacy);
  if (parsed.value.schemaVersion !== 1 || production === null || tests === null) return {
    baseline: null,
    findings: [{
      id: 'tooling-language-baseline-schema-invalid', domain: 'build', severity: 'critical', blocking: true,
      title: 'Tooling language baseline schema is invalid',
      message: 'schemaVersion=1 plus string-array productionLegacy/testLegacy fields are required.',
      location: { file: BASELINE_PATH, line: 1 },
      remediation: 'Restore the v1 schema and keep path lists explicit, sorted and unique.',
      tags: ['tooling', 'typescript', 'ratchet'],
    }],
  };
  const findings: Finding[] = [];
  for (const [name, values] of [['productionLegacy', production], ['testLegacy', tests]] as const) {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length > 0) findings.push({
      id: 'tooling-language-baseline-duplicate', domain: 'build', severity: 'high', blocking: true,
      title: 'Tooling language baseline contains duplicate paths',
      message: `${name} repeats ${[...new Set(duplicates)].join(', ')}. Duplicate budget entries make the ratchet ambiguous.`,
      location: { file: BASELINE_PATH, line: 1 },
      remediation: 'Keep each legacy path exactly once and sort the list deterministically.',
      tags: ['tooling', 'typescript', 'ratchet'],
    });
    const sorted = [...values].sort((a, b) => a.localeCompare(b, 'en'));
    if (sorted.some((value, index) => value !== values[index])) findings.push({
      id: 'tooling-language-baseline-unsorted', domain: 'build', severity: 'low',
      title: 'Tooling language baseline is not sorted',
      message: `${name} should remain lexically sorted so review clearly shows debt removal/addition.`,
      location: { file: BASELINE_PATH, line: 1 },
      remediation: 'Sort the path list without adding new legacy entries.',
      tags: ['tooling', 'typescript', 'ratchet'],
    });
  }
  return {
    baseline: {
      schemaVersion: 1,
      description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
      productionLegacy: production,
      testLegacy: tests,
    },
    findings,
  };
}

function priority(file: SourceFile, test: boolean): number {
  const release = /(?:release|evidence|security|integrity|audit|verify|build|workflow)/i.test(file.repositoryPath) ? 80 : 0;
  const production = test ? 0 : 80;
  const size = Math.min(80, Math.ceil(file.bytes / 1024));
  return release + production + size;
}

function ratchetFinding(file: string, test: boolean): Finding {
  return {
    id: test ? 'tooling-language-new-legacy-test' : 'tooling-language-new-legacy-production',
    domain: 'architecture',
    severity: test ? 'high' : 'critical',
    blocking: true,
    title: test ? 'New legacy JavaScript tooling test bypasses the TypeScript ratchet' : 'New legacy JavaScript tooling authority bypasses the TypeScript ratchet',
    message: `${file} is a new .js/.mjs/.cjs tooling path that is neither in the frozen baseline nor a tiny typed compatibility shim.`,
    location: { file, line: 1 },
    remediation: 'Implement the module/test directly in strict .mts/.ts. If a compatibility filename must remain temporarily, keep only a tiny typed shim with no policy logic.',
    tags: ['tooling', 'language-modernization', 'typescript', 'ratchet'],
  };
}

function staleFinding(file: string, test: boolean): Finding {
  return {
    id: test ? 'tooling-language-stale-test-baseline' : 'tooling-language-stale-production-baseline',
    domain: 'architecture', severity: 'info',
    title: 'Legacy tooling baseline entry is stale',
    message: `${file} is budgeted as legacy JavaScript but no longer exists as active legacy tooling.`,
    location: { file: BASELINE_PATH, line: 1 },
    remediation: 'Remove the stale baseline entry so the JavaScript ceiling ratchets downward permanently.',
    tags: ['tooling', 'language-modernization', 'ratchet'],
  };
}

export function auditToolingLanguageRatchet(
  inventory: RepositoryInventory,
): AuditSection<ToolingLanguageRatchetSummary> {
  const started = performance.now();
  const baselineResult = baseline(inventory);
  const legacy = inventory.files.filter(eligible);
  const productionBaseline = new Set(baselineResult.baseline?.productionLegacy ?? []);
  const testBaseline = new Set(baselineResult.baseline?.testLegacy ?? []);
  const files: ToolingRatchetFile[] = legacy.map(file => {
    const test = TEST_FILE.test(file.repositoryPath);
    const shim = compatibilityShim(file);
    const listed = test ? testBaseline.has(file.repositoryPath) : productionBaseline.has(file.repositoryPath);
    return {
      file: file.repositoryPath, test, bytes: file.bytes, lines: file.lines,
      extension: file.extension.toLowerCase(), compatibilityShim: shim, baselineListed: listed,
      priority: priority(file, test),
    };
  }).sort((a, b) => a.file.localeCompare(b.file, 'en'));

  const activeProduction = new Set(files.filter(item => !item.test && !item.compatibilityShim).map(item => item.file));
  const activeTests = new Set(files.filter(item => item.test && !item.compatibilityShim).map(item => item.file));
  const unlistedProduction = [...activeProduction].filter(file => !productionBaseline.has(file)).sort((a, b) => a.localeCompare(b, 'en'));
  const unlistedTests = [...activeTests].filter(file => !testBaseline.has(file)).sort((a, b) => a.localeCompare(b, 'en'));
  const staleProduction = [...productionBaseline].filter(file => !activeProduction.has(file)).sort((a, b) => a.localeCompare(b, 'en'));
  const staleTests = [...testBaseline].filter(file => !activeTests.has(file)).sort((a, b) => a.localeCompare(b, 'en'));

  const findings = stableSortFindings([
    ...baselineResult.findings,
    ...unlistedProduction.map(file => ratchetFinding(file, false)),
    ...unlistedTests.map(file => ratchetFinding(file, true)),
    ...staleProduction.map(file => staleFinding(file, false)),
    ...staleTests.map(file => staleFinding(file, true)),
  ]);

  const migrationQueue = files
    .filter(item => !item.compatibilityShim)
    .sort((a, b) => b.priority - a.priority || b.bytes - a.bytes || a.file.localeCompare(b.file, 'en'));

  return {
    domain: 'architecture',
    title: 'Non-growing legacy tooling language ratchet',
    summary: {
      baselinePath: BASELINE_PATH,
      baselineProductionBudget: productionBaseline.size,
      baselineTestBudget: testBaseline.size,
      productionLegacy: activeProduction.size,
      testLegacy: activeTests.size,
      compatibilityShims: files.filter(item => item.compatibilityShim).length,
      unlistedProduction,
      unlistedTests,
      staleBaselineProduction: staleProduction,
      staleBaselineTests: staleTests,
      migrationQueue,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
