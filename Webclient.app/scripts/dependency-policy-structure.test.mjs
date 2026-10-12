import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDependencyPolicy } from './dependency-contract.mjs';

const manifest = { dependencies: { legacy: '^1.0.0' } };
const issue = { package: 'legacy', issue: 'unused-runtime' };
const reviewed = {
  package: 'legacy',
  issues: ['unused-runtime'],
  owner: 'platform',
  reason: 'Reviewed and scheduled for removal.',
  expiresOn: '2099-12-31',
};
const budgets = {
  maxExceptions: 1,
  maxUnusedRuntime: 1,
  maxDeprecatedDirect: 0,
  maxInstallScriptDirect: 0,
};
const validPolicy = () => ({
  schemaVersion: 1,
  exceptions: [{ ...reviewed, issues: [...reviewed.issues] }],
  budgets: { ...budgets },
});
const check = (policy, issues = [issue]) => validateDependencyPolicy({
  manifest,
  issues,
  policy,
  now: new Date('2026-10-10T12:00:00.000Z'),
});

test('valid explicit exception list and integer budgets still pass', () => {
  assert.deepEqual(check(validPolicy()).errors, []);
  const zeroDebt = validPolicy();
  zeroDebt.exceptions = [];
  zeroDebt.budgets = Object.fromEntries(Object.keys(budgets).map((name) => [name, 0]));
  assert.deepEqual(check(zeroDebt, []).errors, []);
});

for (const [label, malformed] of [
  ['missing', undefined],
  ['null', null],
  ['object', {}],
  ['string', 'none'],
  ['number', 0],
  ['boolean', false],
]) {
  test(`rejects ${label} exception list even with no observed debt`, () => {
    const candidate = validPolicy();
    if (malformed === undefined) delete candidate.exceptions;
    else candidate.exceptions = malformed;
    assert.match(check(candidate, []).errors.join('\n'), /exceptions must be an array/);
  });
}

for (const field of Object.keys(budgets)) {
  for (const [label, malformed] of [
    ['missing', undefined],
    ['null', null],
    ['numeric string', '1'],
    ['boolean', true],
    ['array', []],
    ['fraction', 0.5],
    ['negative', -1],
    ['infinite', Infinity],
    ['NaN', NaN],
  ]) {
    test(`rejects ${label} in ${field} without coercion`, () => {
      const candidate = validPolicy();
      if (malformed === undefined) delete candidate.budgets[field];
      else candidate.budgets[field] = malformed;
      const errors = check(candidate).errors.join('\n');
      assert.match(errors, new RegExp(`budgets\\.${field} must be a non-negative integer`));
    });
  }
}

test('budget validation remains fail-closed when budgets is omitted', () => {
  const candidate = validPolicy();
  delete candidate.budgets;
  const errors = check(candidate).errors.join('\n');
  for (const field of Object.keys(budgets)) {
    assert.match(errors, new RegExp(`budgets\\.${field} must be a non-negative integer`));
  }
});

test('valid numeric budget limits still reject observed debt above limits', () => {
  const candidate = validPolicy();
  candidate.budgets.maxExceptions = 0;
  candidate.budgets.maxUnusedRuntime = 0;
  const errors = check(candidate).errors.join('\n');
  assert.match(errors, /exception issues exceed maxExceptions budget 0/);
  assert.match(errors, /unused-runtime issues exceed maxUnusedRuntime budget 0/);
});
