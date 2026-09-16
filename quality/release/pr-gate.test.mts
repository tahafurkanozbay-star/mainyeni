import assert from 'node:assert/strict';
import test from 'node:test';
import type { FindingSnapshot, RegressionDelta, Severity } from './contracts.mts';
import {
  decidePullRequestRegression,
  reconcileLanguageMigrationDelta,
} from './pr-gate.mts';

function snapshot(
  key: string,
  severity: Severity,
  file = 'src/example.js',
  line = 1,
): FindingSnapshot {
  return { key, severity, domain: 'security', file, line };
}

function delta(overrides: Partial<RegressionDelta> = {}): RegressionDelta {
  return {
    added: [],
    removed: [],
    unchanged: [],
    riskScoreDelta: 0,
    severityDelta: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    ...overrides,
  };
}

test('unchanged historical critical debt does not block a pull request', () => {
  const historical = snapshot('security|legacy|src/old.js:1|x', 'critical');
  const result = decidePullRequestRegression(delta({ unchanged: [historical] }));
  assert.equal(result.findings.length, 0);
  assert.equal(result.decision.state, 'pass');
});

test('new critical finding blocks a pull request', () => {
  const result = decidePullRequestRegression(delta({
    added: [snapshot('security|new-critical|src/new.js:1|x', 'critical')],
    riskScoreDelta: 100,
    severityDelta: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
  }));
  assert.equal(result.decision.state, 'block');
  assert.ok(result.findings.some(finding => finding.id === 'release-new-critical-regression'));
});

test('new high finding blocks a pull request under zero-high regression policy', () => {
  const result = decidePullRequestRegression(delta({
    added: [snapshot('security|new-high|src/new.js:1|x', 'high')],
    riskScoreDelta: 40,
    severityDelta: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  }));
  assert.equal(result.decision.state, 'block');
  assert.ok(result.findings.some(finding => finding.id === 'release-new-high-regression'));
});

test('severity escalation without a new finding key is still detected', () => {
  const result = decidePullRequestRegression(delta({
    unchanged: [snapshot('security|same-key|src/existing.js:1|x', 'critical')],
    riskScoreDelta: 88,
    severityDelta: { critical: 1, high: 0, medium: -1, low: 0, info: 0 },
  }));
  assert.equal(result.decision.state, 'block');
  assert.ok(result.findings.some(finding => finding.id === 'release-critical-severity-escalation'));
});

test('low and bounded medium changes stay visible without blocking', () => {
  const result = decidePullRequestRegression(delta({
    added: [snapshot('accessibility|new-medium|src/view.js:1|x', 'medium')],
    riskScoreDelta: 12,
    severityDelta: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
  }));
  assert.equal(result.findings.length, 0);
  assert.equal(result.decision.state, 'pass');
});

test('material aggregate risk increase blocks even without a single new high finding', () => {
  const result = decidePullRequestRegression(delta({
    added: [
      snapshot('performance|m1|src/a.js:1|x', 'medium'),
      snapshot('accessibility|m2|src/b.js:1|x', 'medium'),
    ],
    riskScoreDelta: 108,
    severityDelta: { critical: 0, high: 0, medium: 9, low: 0, info: 0 },
  }));
  assert.equal(result.decision.state, 'block');
  assert.ok(result.findings.some(finding => finding.id === 'release-risk-score-regression'));
});

test('js to typescript migration pairs the same audit finding without hiding new risk', () => {
  const migrated = reconcileLanguageMigrationDelta(delta({
    added: [
      snapshot(
        'security|client-secret-env|src/requestPolicy.ts:23|new-excerpt',
        'critical',
        'src/requestPolicy.ts',
        23,
      ),
      snapshot(
        'network|plain-http-runtime|src/newRuntime.ts:9|http://example.test',
        'high',
        'src/newRuntime.ts',
        9,
      ),
    ],
    removed: [
      snapshot(
        'security|client-secret-env|src/requestPolicy.js:17|old-excerpt',
        'critical',
        'src/requestPolicy.js',
        17,
      ),
    ],
  }));

  assert.equal(migrated.added.length, 1);
  assert.equal(migrated.added[0]?.file, 'src/newRuntime.ts');
  assert.equal(migrated.removed.length, 0);
  assert.equal(migrated.unchanged.some(item => item.file === 'src/requestPolicy.ts'), true);
});

test('language reconciliation requires matching id domain severity and source stem', () => {
  const migrated = reconcileLanguageMigrationDelta(delta({
    added: [
      snapshot('security|new-critical|src/requestPolicy.ts:1|x', 'critical', 'src/requestPolicy.ts'),
    ],
    removed: [
      snapshot('security|old-critical|src/requestPolicy.js:1|x', 'critical', 'src/requestPolicy.js'),
      snapshot('security|new-critical|src/other.js:1|x', 'critical', 'src/other.js'),
      snapshot('security|new-critical|src/requestPolicy.js:1|x', 'high', 'src/requestPolicy.js'),
    ],
  }));

  assert.equal(migrated.added.length, 1);
  assert.equal(migrated.removed.length, 3);
  assert.equal(migrated.unchanged.length, 0);
});
