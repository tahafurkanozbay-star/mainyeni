import fs from 'node:fs';
import path from 'node:path';

const FAIL_STATES = new Set(['fail', 'failed', 'failure']);
const MAX_DETAIL_LENGTH = 600;

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
  .replace(/^.*?\/Webclient\.app\//, 'Webclient.app/')
  // Test-file language migrations must not manufacture a regression solely
  // because the same assertion moved from .test.js/.jsx to .test.ts/.tsx.
  // Only the terminal test extension is canonicalized; production-module
  // paths and assertion names remain exact so real new failures still fail.
  .replace(/\.test\.(?:jsx?|tsx?)$/i, '.test.<source>');

const failureName = (assertion, index) => {
  const ancestor = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.join(' > ') : '';
  const title = assertion.fullName ?? assertion.title ?? assertion.name ?? `failure-${index + 1}`;
  if (assertion.fullName || !ancestor) return String(title).trim();
  return `${ancestor} > ${title}`.trim();
};

const sanitizeDetail = (value) => String(value ?? '')
  .replace(/\u001b\[[0-9;]*m/gu, '')
  .replace(/\r?\n/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, MAX_DETAIL_LENGTH);

const assertionDetail = (assertion) => {
  const messages = Array.isArray(assertion.failureMessages)
    ? assertion.failureMessages
    : Array.isArray(assertion.errors)
      ? assertion.errors.map((error) => error?.message ?? error)
      : assertion.failureMessage
        ? [assertion.failureMessage]
        : assertion.error?.message
          ? [assertion.error.message]
          : [];
  return sanitizeDetail(messages.find((message) => String(message ?? '').trim()) ?? '');
};

const collectReportState = (report) => {
  const failures = new Set();
  const details = new Map();
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
      const identity = `${file} :: ${failureName(assertion, assertionIndex)}`;
      failures.add(identity);
      const detail = assertionDetail(assertion);
      if (detail && !details.has(identity)) details.set(identity, detail);
    });

    const suiteState = String(result.status ?? '').toLowerCase();
    if (FAIL_STATES.has(suiteState)) {
      failedSuites += 1;
      if (suiteAssertionFailures === 0) {
        const identity = `${file} :: <suite-level failure>`;
        failures.add(identity);
        const detail = sanitizeDetail(result.message ?? result.failureMessage ?? result.error?.message ?? '');
        if (detail && !details.has(identity)) details.set(identity, detail);
      }
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
    details,
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
  for (const failure of state.failures) {
    console.log(`[vitest:regression] ${label} failure: ${failure}`);
    const detail = state.details.get(failure);
    if (detail) console.log(`[vitest:regression] ${label} detail: ${detail}`);
  }
};

const escapeWorkflowCommand = (value) => String(value ?? '')
  .replaceAll('%', '%25')
  .replaceAll('\r', '%0D')
  .replaceAll('\n', '%0A');

const annotateRegression = (failure, detail) => {
  if (!process.env.GITHUB_ACTIONS) return;
  const title = escapeWorkflowCommand(`Exact-base Vitest regression: ${failure}`);
  const message = escapeWorkflowCommand(detail || 'Candidate introduces a failure that is absent from the exact PR base.');
  console.error(`::error title=${title}::${message}`);
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
for (const failure of added) {
  console.error(`[vitest:regression] NEW failure: ${failure}`);
  const detail = current.details.get(failure);
  if (detail) console.error(`[vitest:regression] NEW detail: ${detail}`);
  annotateRegression(failure, detail);
}

if (current.failedTests > baseline.failedTests && added.length === 0) {
  const message = 'Current failed-test count increased without a normalized assertion identity; failing closed.';
  console.error(`[vitest:regression] ${message}`);
  annotateRegression('<failed-test-count>', message);
  process.exit(1);
}
if (current.failedSuites > baseline.failedSuites && added.length === 0) {
  const message = 'Current failed-suite count increased without a normalized assertion identity; failing closed.';
  console.error(`[vitest:regression] ${message}`);
  annotateRegression('<failed-suite-count>', message);
  process.exit(1);
}
if (addedUnhandledErrors > 0) {
  const message = `NEW unhandled errors: ${addedUnhandledErrors}`;
  console.error(`[vitest:regression] ${message}`);
  annotateRegression('<unhandled-errors>', message);
  process.exit(1);
}
if (added.length > 0) process.exit(1);

console.log('[vitest:regression] PASS: candidate introduces no new Vitest failures versus exact PR base.');
