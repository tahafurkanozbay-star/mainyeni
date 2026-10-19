#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOT = path.resolve(process.cwd());
const WEBCLIENT_DIR = 'Webclient.app';

const REQUIRED_WEB_SCRIPTS = Object.freeze([
  'dev',
  'build',
  'build:verify',
  'quality:module-graph',
  'quality:language-ratchet',
  'quality:platform-boundaries',
  'quality:browser-runtime',
  'lint',
  'lint:strict',
  'test:ci',
  'typecheck',
  'verify',
]);

const MODERN_WEB_BASELINE = Object.freeze({
  dependencies: Object.freeze({
    react: 19,
    'react-dom': 19,
    bootstrap: 5,
  }),
  devDependencies: Object.freeze({
    typescript: 7,
    vite: 8,
    vitest: 5,
    oxlint: 1,
    '@vitejs/plugin-react': 6,
  }),
  engines: Object.freeze({
    node: 24,
    npm: 11,
  }),
});

const EXPECTED_TSC_PROJECTS = Object.freeze([
  'tsconfig.json',
  'tsconfig.platform.json',
  'tsconfig.platform-tests.json',
  'tsconfig.gis.json',
  'tsconfig.experience.json',
  'tsconfig.data-search.json',
]);

const WEB_ENTRYPOINTS = Object.freeze([
  'index.html',
  'src/main.tsx',
  'vite.config.ts',
  'vitest.config.ts',
]);

const normalizePath = (value) => value.split(path.sep).join('/');
const relative = (root, file) => normalizePath(path.relative(root, file));

const exists = async (file) => {
  try {
    const stats = await fs.stat(file);
    return stats.isFile();
  } catch {
    return false;
  }
};

const readText = async (file) => fs.readFile(file, 'utf8');
const readJson = async (file) => JSON.parse(await readText(file));

const summarize = (report) => {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of report.findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    passed: counts.error === 0,
  });
};

const markdown = (report) => {
  const rows = report.findings.length
    ? report.findings
      .map((finding) => `| ${finding.severity} | ${finding.code} | ${finding.file || ''} | ${finding.message.replace(/\|/g, '\\|')} |`)
      .join('\n')
    : '| _none_ | | | |';

  return `# Platform Contracts\n\nGenerated: ${report.summary.generatedAt}\n\n` +
    `- Errors: **${report.summary.errors}**\n` +
    `- Warnings: **${report.summary.warnings}**\n` +
    `- Gate: **${report.summary.passed ? 'PASS' : 'FAIL'}**\n\n` +
    `## Findings\n\n| Severity | Code | File | Message |\n| --- | --- | --- | --- |\n${rows}\n\n` +
    `## Contract scope\n\n` +
    `This gate validates the modern Vite/React/TypeScript toolchain, strict TypeScript project wiring, ` +
    `direct PlanASKI source integration, and frontend vulnerability-audit build gates. ` +
    `It intentionally does not introduce WMS/WFS or alter product behavior.\n`;
};

export async function runPlatformContracts(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const report = { findings: [] };
  await validateWebclient(resolvedRoot, report);
  report.findings.sort((left, right) =>
    left.severity.localeCompare(right.severity) ||
    String(left.file || '').localeCompare(String(right.file || '')) ||
    left.code.localeCompare(right.code));
  report.summary = summarize(report);
  return report;
}

async function main() {
  const report = await runPlatformContracts(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'platform-contracts.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'platform-contracts.md'), markdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.passed) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
