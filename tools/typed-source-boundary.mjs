#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = 'Webclient.app/src';
const ADMIN_SOURCE_ROOT = 'Webclient.admin/src';
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_TEST_PATTERN = /(?:\.test|\.spec|\.fixture|\.mock)\.(?:ts|tsx)$/u;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.cache']);

/**
 * Exact-path exceptions owned by concurrent canonical migration PRs.
 * They may disappear without requiring an audit change, but no new JavaScript
 * path outside this bounded set is permitted.
 */
const TRANSITIONAL_JAVASCRIPT_ALLOWLIST = new Set([
  'Webclient.app/src/Toolbox/GisGraphicsHelper.js',
  'Webclient.app/src/experience/accessibilityRuntime.test.js',
  'Webclient.app/src/platform/bootstrap/bootstrapCore.test.js',
  'Webclient.app/src/platform/bootstrap/bootstrapDiagnostics.test.js',
  'Webclient.app/src/platform/http/fetchTransport.test.js',
  'Webclient.app/src/platform/http/networkDiagnostics.test.js',
  'Webclient.app/src/platform/http/requestScheduler.test.js',
  'Webclient.app/src/platform/http/retryPolicy.test.js',
  'Webclient.app/src/platform/http/runtimeCapabilities.test.js',
  'Webclient.app/src/platform/http/typescriptRuntime.integration.test.js',
  'Webclient.app/src/platform/performance/performanceMonitor.test.js',
  'Webclient.app/src/platform/runtime/runtime.test.js',
  'Webclient.app/src/platform/runtime/runtimeDiagnostics.test.js',
]);

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

const isBusinessOwnedJavascript = (relative) =>
  relative.startsWith('Webclient.app/src/Business/');

const finding = (code, file, message) => Object.freeze({ code, file, message });

export const auditTypedSourceBoundary = async (root = process.cwd()) => {
  const resolvedRoot = path.resolve(root);
  const sourceDirectories = [SOURCE_ROOT, ADMIN_SOURCE_ROOT].map((root) => path.join(resolvedRoot, root));
  const files = (await Promise.all(sourceDirectories.map((directory) => walk(directory, []))))
    .flat()
    .sort();
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

      const adminJavascript = relative.startsWith(`${ADMIN_SOURCE_ROOT}/`);
      if (
        adminJavascript
        || (
          !isBusinessOwnedJavascript(relative)
          && !TRANSITIONAL_JAVASCRIPT_ALLOWLIST.has(relative)
        )
      ) {
        findings.push(finding(
          'unapproved-javascript-source',
          relative,
          'JavaScript outside the Business migration tranche and exact concurrent-migration allowlist is forbidden.',
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
      adminJavascriptFiles: javascript.filter((file) => file.startsWith(`${ADMIN_SOURCE_ROOT}/`)).length,
      businessOwnedJavascriptFiles: javascript.filter(isBusinessOwnedJavascript).length,
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
    `- JavaScript files under application source roots: **${report.summary.javascriptFiles}**`,
    `- Admin JavaScript files under \`${ADMIN_SOURCE_ROOT}\`: **${report.summary.adminJavascriptFiles}**`,
    `- Business-owned JavaScript files: **${report.summary.businessOwnedJavascriptFiles}**`,
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
    'Webclient.admin is permanently ratcheted to zero JavaScript. '
    + 'Business JavaScript remains under the concurrent Business migration ratchet. '
    + 'The exact-path exceptions are pre-existing files owned by concurrent GIS, Experience, and Platform cutovers; '
    + 'missing exceptions are allowed so those PRs can remove them without coordination. '
    + 'Every other application source area is permanently ratcheted away from JavaScript.',
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
