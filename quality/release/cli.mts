#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  safeJsonParse,
  safePositiveInteger,
  type BaselineSnapshot,
  type CliOptions,
  type ReleaseContext,
} from './contracts.mts';
import { buildRepositoryInventory } from './inventory.mts';
import {
  createBaseline,
  releaseReportMarkdown,
  runReleaseEngine,
} from './release-engine.mts';

function valueAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function parseCliOptions(args: readonly string[], cwd = process.cwd()): CliOptions {
  const root = resolve(valueAfter(args, '--root') ?? cwd);
  const outputDirectory = resolve(root, valueAfter(args, '--output') ?? 'qa-artifacts/release');
  const baseline = valueAfter(args, '--baseline');
  const maxTextBytes = safePositiveInteger(valueAfter(args, '--max-text-bytes'), 2 * 1024 * 1024);
  return {
    root,
    outputDirectory,
    ...(baseline ? { baselinePath: resolve(root, baseline) } : {}),
    strict: args.includes('--strict'),
    includeTests: !args.includes('--exclude-tests'),
    maxTextBytes,
  };
}

function loadBaseline(path: string | undefined): BaselineSnapshot | undefined {
  if (!path || !existsSync(path)) return undefined;
  const parsed = safeJsonParse<BaselineSnapshot>(readFileSync(path, 'utf8'));
  if (!parsed.ok || !parsed.value) {
    throw new Error(`Cannot parse baseline ${path}: ${parsed.error ?? 'unknown error'}`);
  }
  if (parsed.value.schemaVersion !== 1) {
    throw new Error(`Unsupported baseline schema: ${String(parsed.value.schemaVersion)}`);
  }
  return parsed.value;
}

function contextFromEnvironment(): ReleaseContext {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? 'tahafurkanozbay-star/mainyeni',
    ...(process.env.GITHUB_REF_NAME ? { branch: process.env.GITHUB_REF_NAME } : {}),
    ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
    ...(process.env.GITHUB_BASE_REF ? { baselineCommit: process.env.GITHUB_BASE_REF } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function writeArtifacts(options: CliOptions, json: string, markdown: string, baselineJson: string): void {
  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(resolve(options.outputDirectory, 'release-report.json'), json, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'release-report.md'), markdown, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'release-baseline.json'), baselineJson, 'utf8');
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseCliOptions(args);
  const baseline = loadBaseline(options.baselinePath);
  const inventory = buildRepositoryInventory({
    root: options.root,
    includeTests: options.includeTests,
    maxTextBytes: options.maxTextBytes,
  });
  const execution = await runReleaseEngine(inventory, contextFromEnvironment(), {}, baseline);
  const baselineSnapshot = createBaseline(execution.report);
  const json = `${JSON.stringify(execution.report, null, 2)}\n`;
  const markdown = releaseReportMarkdown(execution);
  const baselineJson = `${JSON.stringify(baselineSnapshot, null, 2)}\n`;
  writeArtifacts(options, json, markdown, baselineJson);

  process.stdout.write(`${markdown}\n`);
  if (options.strict && execution.report.decision.state === 'block') {
    process.stderr.write('Release QA blocked by critical/threshold findings.\n');
    return 1;
  }
  return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
