#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = 'Webclient.app/src';
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_TEST_PATTERN = /(?:\.test|\.spec|\.fixture|\.mock)\.(?:ts|tsx)$/u;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);

/**
 * Application source is fully typed. No JavaScript exception is retained:
 * any future JavaScript source/test file under Webclient.app/src is a regression.
 */
const TRANSITIONAL_JAVASCRIPT_ALLOWLIST = new Set();

const normalizePath = (value) => value.split(path.sep).join('/');

const walk = async (directory, files = []) => {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
};

const finding = (code, file, message) => Object.freeze({ code, file, message });

export const auditTypedSourceBoundary = async (root = process.cwd()) => {
  const resolvedRoot = path.resolve(root);
  const sourceDirectory = path.join(resolvedRoot, SOURCE_ROOT);
  const files = (await walk(sourceDirectory)).sort();
  const findings = [];
  const javascript = [];
  const typedTests = [];

  for (const file of files) {
    const relative = normalizePath(path.relative(resolvedRoot, file));
    const extension = path.extname(file).toLowerCase();

    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      javascript.push(relative);

      if (/\.legacy\.(?:js|jsx|mjs|cjs)$/u.test(relative)) {
        findings.push(finding(
          'legacy-shadow-source',
          relative,
          'Legacy shadow JavaScript sources are forbidden once a typed canonical module exists.',
        ));
        continue;
      }

      if (!TRANSITIONAL_JAVASCRIPT_ALLOWLIST.has(relative)) {
        findings.push(finding(
          'unapproved-javascript-source',
          relative,
          'JavaScript is forbidden across the fully typed application source tree.',
        ));
      }
      continue;
    }

    if (!TYPESCRIPT_TEST_PATTERN.test(relative)) continue;
    typedTests.push(relative);
    const source = await fs.readFile(file, 'utf8');
    if (/\bjest\s*\./u.test(source)) {
      findings.push(finding(
        'jest-namespace-in-typescript',
        relative,
        'TypeScript tests must use native Vitest vi.* APIs instead of the legacy Jest namespace bridge.',
      ));
    }
  }

  const sortedFindings = Object.freeze([...findings].sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code)));

  return Object.freeze({
    passed: sortedFindings.length === 0,
    findings: sortedFindings,
    javascript: Object.freeze(javascript),
    typedTests: Object.freeze(typedTests),
    summary: Object.freeze({
      javascriptFiles: javascript.length,
      typedTestFiles: typedTests.length,
      transitionalJavascriptFiles: javascript.filter((file) =>
        TRANSITIONAL_JAVASCRIPT_ALLOWLIST.has(file)).length,
      violations: sortedFindings.length,
    }),
  });
};

export const formatTypedSourceBoundary = (report) => {
  const lines = [
    '# Typed Source Boundary',
    '',
    `Gate: **${report.passed ? 'PASS' : 'FAIL'}**`,
    '',
    `- JavaScript files under \`${SOURCE_ROOT}\`: **${report.summary.javascriptFiles}**`,
    `- Exact concurrent-migration JavaScript exceptions present: **${report.summary.transitionalJavascriptFiles}**`,
    `- TypeScript test files scanned for Jest namespace drift: **${report.summary.typedTestFiles}**`,
    `- Violations: **${report.summary.violations}**`,
    '',
  ];

  if (report.findings.length > 0) {
    lines.push('## Findings', '');
    for (const item of report.findings) {
      lines.push(`- **${item.code}** — \`${item.file}\`: ${item.message}`);
    }
    lines.push('');
  }

  lines.push(
    'Webclient.app/src is permanently ratcheted to TypeScript/TSX only. '
    + 'No transitional JavaScript exception remains; any JavaScript source or test file is a blocking regression.',
    '',
  );
  return lines.join('\n');
};

const isEntrypoint = () => {
  const executed = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return executed === fileURLToPath(import.meta.url);
};

if (isEntrypoint()) {
  const strict = process.argv.includes('--strict');
  auditTypedSourceBoundary(process.cwd())
    .then((report) => {
      process.stdout.write(formatTypedSourceBoundary(report));
      if (strict && !report.passed) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
