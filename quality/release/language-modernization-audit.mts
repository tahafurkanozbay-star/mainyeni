import {
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { findFile } from './inventory.mts';

export interface LanguageModernizationSummary {
  readonly productionJavaScriptFiles: number;
  readonly productionTypeScriptFiles: number;
  readonly jsxInJavaScriptFiles: number;
  readonly commonJsFiles: number;
  readonly typeSuppressionFiles: number;
  readonly strictTypeScript: boolean;
  readonly allowJs: boolean | null;
  readonly checkJs: boolean | null;
  readonly moduleResolution: string | null;
  readonly findings: readonly Finding[];
}

const PRODUCTION_SOURCE = /^Webclient\.app\/src\//;
const TEST_OR_FIXTURE = /(?:^|\/)(?:__tests__|fixtures?|test-fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GENERATED = /(?:^|\/)(?:dist|build|coverage|node_modules)(?:\/|$)/;
const JS_EXT = /\.[cm]?jsx?$/i;
const TS_EXT = /\.[cm]?tsx?$/i;

function productionSource(file: SourceFile): boolean {
  return PRODUCTION_SOURCE.test(file.repositoryPath) && !TEST_OR_FIXTURE.test(file.repositoryPath) && !GENERATED.test(file.repositoryPath);
}

function lineOf(text: string, pattern: RegExp): number {
  const flags = pattern.flags.replace('g', '');
  const match = new RegExp(pattern.source, flags).exec(text);
  if (!match || match.index < 0) return 1;
  return text.slice(0, match.index).split(/\r?\n/).length;
}

function finding(file: SourceFile, input: Omit<Finding, 'location'> & { readonly pattern?: RegExp }): Finding {
  const { pattern, ...rest } = input;
  return {
    ...rest,
    location: { file: file.repositoryPath, line: pattern ? lineOf(file.text, pattern) : 1 },
  };
}

function compilerOptions(inventory: RepositoryInventory): Record<string, unknown> | null {
  const file = findFile(inventory, 'Webclient.app/tsconfig.json');
  if (!file) return null;
  const parsed = safeJsonParse<Record<string, unknown>>(file.text);
  if (!parsed.ok || !parsed.value) return null;
  const options = parsed.value.compilerOptions;
  return options && typeof options === 'object' && !Array.isArray(options) ? options as Record<string, unknown> : null;
}

function stringOption(options: Record<string, unknown> | null, key: string): string | null {
  const value = options?.[key];
  return typeof value === 'string' ? value : null;
}

function booleanOption(options: Record<string, unknown> | null, key: string): boolean | null {
  const value = options?.[key];
  return typeof value === 'boolean' ? value : null;
}

function scanSource(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const path = file.repositoryPath;
    const text = file.text;
    if (JS_EXT.test(path)) {
      const jsxPattern = /<\s*[A-Z][A-Za-z0-9_.:-]*\b|<\s*(?:div|span|button|input|label|section|main|aside|nav|form|table|svg)\b/i;
      if (jsxPattern.test(text)) {
        findings.push(finding(file, {
          id: 'language-jsx-in-javascript',
          domain: 'architecture',
          severity: 'medium',
          title: 'JSX remains in untyped JavaScript',
          message: 'A production JavaScript module contains JSX and remains outside the typed TSX boundary.',
          remediation: 'Migrate the component to TSX with explicit props/state/event contracts; preserve behavior and tests during conversion.',
          tags: ['typescript', 'tsx', 'migration'],
          pattern: jsxPattern,
        }));
      }
    }
    const commonJsPattern = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$]/;
    if (commonJsPattern.test(text)) {
      findings.push(finding(file, {
        id: 'language-commonjs-production',
        domain: 'architecture',
        severity: 'medium',
        title: 'CommonJS remains in browser production source',
        message: 'Browser production source uses CommonJS instead of the repository native ESM direction.',
        remediation: 'Convert the module to static ESM imports/exports and validate Vite chunking plus runtime loading behavior.',
        tags: ['esm', 'vite', 'migration'],
        pattern: commonJsPattern,
      }));
    }
    const noCheckPattern = /@ts-nocheck\b/;
    if (noCheckPattern.test(text)) {
      findings.push(finding(file, {
        id: 'language-ts-nocheck-production',
        domain: 'architecture',
        severity: 'high',
        title: 'Type checking disabled in production source',
        message: 'A production source file disables TypeScript checking with @ts-nocheck.',
        remediation: 'Remove the suppression and model the boundary with explicit types, unknown narrowing or a small typed adapter.',
        blocking: true,
        tags: ['typescript', 'strict'],
        pattern: noCheckPattern,
      }));
    }
    const ignorePattern = /@ts-ignore\b/;
    if (ignorePattern.test(text)) {
      findings.push(finding(file, {
        id: 'language-ts-ignore-production',
        domain: 'architecture',
        severity: 'medium',
        title: 'Unexplained TypeScript suppression in production source',
        message: 'A production source file uses @ts-ignore, which can hide contract regressions after dependency or compiler upgrades.',
        remediation: 'Replace @ts-ignore with a typed adapter or, when an upstream defect truly requires suppression, use a narrowly documented @ts-expect-error.',
        tags: ['typescript', 'strict'],
        pattern: ignorePattern,
      }));
    }
  }
  return findings;
}

function configurationFindings(inventory: RepositoryInventory, options: Record<string, unknown> | null): Finding[] {
  const findings: Finding[] = [];
  const config = findFile(inventory, 'Webclient.app/tsconfig.json');
  if (!config) {
    findings.push({
      id: 'language-tsconfig-missing',
      domain: 'architecture',
      severity: 'critical',
      title: 'Frontend TypeScript configuration missing',
      message: 'Webclient.app/tsconfig.json is required for the typed-by-default modernization boundary.',
      remediation: 'Restore the strict frontend TypeScript configuration before release.',
      blocking: true,
      tags: ['typescript', 'build'],
    });
    return findings;
  }
  if (options?.strict !== true) {
    findings.push(finding(config, {
      id: 'language-typescript-strict-disabled',
      domain: 'architecture',
      severity: 'critical',
      title: 'Strict TypeScript mode is not enforced',
      message: 'The frontend TypeScript compiler contract no longer has strict=true.',
      remediation: 'Keep strict=true and fix type errors at their owning boundaries instead of weakening the compiler.',
      blocking: true,
      tags: ['typescript', 'strict', 'release'],
      pattern: /"strict"\s*:/,
    }));
  }
  if (options?.noUncheckedIndexedAccess !== true) {
    findings.push(finding(config, {
      id: 'language-unchecked-index-access',
      domain: 'architecture',
      severity: 'medium',
      title: 'Unchecked indexed access protection is disabled',
      message: 'noUncheckedIndexedAccess is not enabled, weakening array/map/schema safety during the migration.',
      remediation: 'Enable noUncheckedIndexedAccess and narrow possibly missing values at data/GIS boundaries.',
      tags: ['typescript', 'data-integrity'],
      pattern: /"noUncheckedIndexedAccess"\s*:/,
    }));
  }
  if (options?.useUnknownInCatchVariables !== true) {
    findings.push(finding(config, {
      id: 'language-catch-variable-not-unknown',
      domain: 'architecture',
      severity: 'medium',
      title: 'Catch variables are not forced to unknown',
      message: 'useUnknownInCatchVariables is not enabled, allowing unsafe assumptions about runtime failures.',
      remediation: 'Enable useUnknownInCatchVariables and normalize errors through typed helpers.',
      tags: ['typescript', 'resilience'],
      pattern: /"useUnknownInCatchVariables"\s*:/,
    }));
  }
  return findings;
}

export function auditLanguageModernization(inventory: RepositoryInventory): AuditSection<LanguageModernizationSummary> {
  const start = performance.now();
  const files = inventory.files.filter(productionSource);
  const options = compilerOptions(inventory);
  const sourceFindings = scanSource(files);
  const findings = stableSortFindings([...sourceFindings, ...configurationFindings(inventory, options)]);
  const productionJavaScriptFiles = files.filter(file => JS_EXT.test(file.repositoryPath)).length;
  const productionTypeScriptFiles = files.filter(file => TS_EXT.test(file.repositoryPath)).length;
  const jsxInJavaScriptFiles = new Set(sourceFindings.filter(item => item.id === 'language-jsx-in-javascript').map(item => item.location?.file)).size;
  const commonJsFiles = new Set(sourceFindings.filter(item => item.id === 'language-commonjs-production').map(item => item.location?.file)).size;
  const typeSuppressionFiles = new Set(sourceFindings.filter(item => item.id === 'language-ts-nocheck-production' || item.id === 'language-ts-ignore-production').map(item => item.location?.file)).size;
  return {
    domain: 'architecture',
    title: 'Whole-code language modernization regression guard',
    summary: {
      productionJavaScriptFiles,
      productionTypeScriptFiles,
      jsxInJavaScriptFiles,
      commonJsFiles,
      typeSuppressionFiles,
      strictTypeScript: options?.strict === true,
      allowJs: booleanOption(options, 'allowJs'),
      checkJs: booleanOption(options, 'checkJs'),
      moduleResolution: stringOption(options, 'moduleResolution'),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
