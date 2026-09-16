import assert from 'node:assert/strict';
import test from 'node:test';
import type { FindingSnapshot, RegressionDelta, Severity } from './contracts.mts';
import { decidePullRequestRegression } from './pr-gate.mts';

function snapshot(key: string, severity: Severity): FindingSnapshot {
  return { key, severity, domain: 'security', file: 'src/example.js', line: 1 };
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
