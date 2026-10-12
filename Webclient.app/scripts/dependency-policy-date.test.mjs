import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDependencyPolicy } from './dependency-contract.mjs';

const issues = [{ package: 'legacy', issue: 'unused-runtime' }];
const manifest = { dependencies: { legacy: '1.0.0' } };
const exception = (expiresOn) => ({
  package: 'legacy',
  issues: ['unused-runtime'],
  owner: 'platform',
  reason: 'Reviewed dependency debt.',
  expiresOn,
});
const policy = (expiresOn) => ({
  schemaVersion: 1,
  budgets: {
    maxExceptions: 1,
    maxUnusedRuntime: 1,
    maxDeprecatedDirect: 0,
    maxInstallScriptDirect: 0,
  },
  exceptions: [exception(expiresOn)],
});
const check = (expiresOn, now) => validateDependencyPolicy({
  manifest, issues, policy: policy(expiresOn), now,
});

test('calendar rollover dates are rejected', () => {
  for (const value of ['2026-02-30', '2026-11-31', '2025-02-29', '2026-00-01']) {
    assert.match(check(value, new Date('2026-01-01T00:00:00Z')).errors.join('\n'), /not a valid calendar date/, value);
  }
});

test('leap day is accepted when the exception is still valid', () => {
  assert.deepEqual(check('2028-02-29', new Date('2028-02-28T23:59:59Z')).errors, []);
});

test('invalid evaluation dates are rejected instead of silently replaced', () => {
  assert.match(check('2026-10-04', new Date(Number.NaN)).errors.join('\n'), /now must be a valid date/);
});

test('UTC years below 0100 preserve their actual year', () => {
  assert.deepEqual(check('0100-01-01', new Date('0099-06-01T18:30:00Z')).errors, []);
});

test('expiry comparison uses UTC date rather than local wall-clock time', () => {
  assert.deepEqual(check('2026-10-05', new Date('2026-10-05T23:59:59Z')).errors, []);
  assert.match(check('2026-10-04', new Date('2026-10-05T00:00:00Z')).errors.join('\n'), /expired on 2026-10-04/);
});
