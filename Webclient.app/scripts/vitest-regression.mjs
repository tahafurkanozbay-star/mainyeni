import fs from 'node:fs';
import path from 'node:path';

const FAIL_STATES = new Set(['fail', 'failed', 'failure']);

const readReport = (filePath) => {
  if (!filePath) throw new Error('A Vitest JSON report path is required.');
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Vitest JSON report does not exist: ${absolutePath}`);
  }
  const report = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error(`Unsupported Vitest JSON report shape: ${absolutePath}`);
  }
  return report;
};

const normalizeFile = (value) => String(value ?? '<unknown-file>')
  .replaceAll('\\', '/')
  .replace(/^.*?\/Webclient\.app\//, 'Webclient.app/');

const failureName = (assertion, index) => {
  const ancestor = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.join(' > ') : '';
  const title = assertion.fullName ?? assertion.title ?? assertion.name ?? `failure-${index + 1}`;
  if (assertion.fullName || !ancestor) return String(title).trim();
  return `${ancestor} > ${title}`.trim();
};

const collectReportState = (report) => {
  const failures = new Set();
  let failedAssertions = 0;
  let failedSuites = 0;

  report.testResults.forEach((result, resultIndex) => {
    const file = normalizeFile(result.name ?? result.filepath ?? result.file?.name ?? `suite-${resultIndex + 1}`);
    const assertions = Array.isArray(result.assertionResults)
      ? result.assertionResults
      : Array.isArray(result.assertions)
        ? result.assertions
        : Array.isArray(result.tests)
          ? result.tests
          : [];

    let suiteAssertionFailures = 0;
    assertions.forEach((assertion, assertionIndex) => {
      const state = String(assertion.status ?? assertion.state ?? '').toLowerCase();
      if (!FAIL_STATES.has(state)) return;
      suiteAssertionFailures += 1;
      failedAssertions += 1;
      failures.add(`${file} :: ${failureName(assertion, assertionIndex)}`);
    });

    const suiteState = String(result.status ?? '').toLowerCase();
    if (FAIL_STATES.has(suiteState)) {
      failedSuites += 1;
      if (suiteAssertionFailures === 0) failures.add(`${file} :: <suite-level failure>`);
    }
  });

  const reportedFailedTests = Number.isFinite(Number(report.numFailedTests))
    ? Number(report.numFailedTests)
    : failedAssertions;
  const reportedFailedSuites = Number.isFinite(Number(report.numFailedTestSuites))
    ? Number(report.numFailedTestSuites)
    : failedSuites;
  const unhandledErrors = Array.isArray(report.unhandledErrors)
    ? report.unhandledErrors.length
    : Array.isArray(report.errors)
      ? report.errors.length
      : 0;

  return Object.freeze({
    failures: Object.freeze([...failures].sort()),
    failedAssertions,
    failedTests: reportedFailedTests,
    failedSuites: reportedFailedSuites,
    unhandledErrors,
    success: report.success === true,
  });
};

const printState = (label, state) => {
  console.log(`[vitest:regression] ${label} failed tests: ${state.failedTests}`);
  console.log(`[vitest:regression] ${label} failed suites: ${state.failedSuites}`);
  console.log(`[vitest:regression] ${label} unhandled errors: ${state.unhandledErrors}`);
  for (const failure of state.failures) console.log(`[vitest:regression] ${label} failure: ${failure}`);
};

const args = process.argv.slice(2);
if (args[0] === '--list') {
  const state = collectReportState(readReport(args[1]));
  printState('current', state);
  process.exit(0);
}

if (args.length !== 2) {
  throw new Error('Usage: node scripts/vitest-regression.mjs [--list current.json] | <baseline.json> <current.json>');
}

const baseline = collectReportState(readReport(args[0]));
const current = collectReportState(readReport(args[1]));
printState('baseline', baseline);
printState('current', current);

const baselineFailures = new Set(baseline.failures);
const currentFailures = new Set(current.failures);
const added = current.failures.filter((failure) => !baselineFailures.has(failure));
const resolved = baseline.failures.filter((failure) => !currentFailures.has(failure));
const addedUnhandledErrors = Math.max(0, current.unhandledErrors - baseline.unhandledErrors);

console.log(`[vitest:regression] resolved failures: ${resolved.length}`);
console.log(`[vitest:regression] added failures: ${added.length}`);
for (const failure of added) console.error(`[vitest:regression] NEW failure: ${failure}`);

if (current.failedTests > baseline.failedTests && added.length === 0) {
  console.error('[vitest:regression] Current failed-test count increased without a normalized assertion identity; failing closed.');
  process.exit(1);
}
if (current.failedSuites > baseline.failedSuites && added.length === 0) {
  console.error('[vitest:regression] Current failed-suite count increased without a normalized assertion identity; failing closed.');
  process.exit(1);
}
if (addedUnhandledErrors > 0) {
  console.error(`[vitest:regression] NEW unhandled errors: ${addedUnhandledErrors}`);
  process.exit(1);
}
if (added.length > 0) process.exit(1);

console.log('[vitest:regression] PASS: candidate introduces no new Vitest failures versus exact PR base.');
