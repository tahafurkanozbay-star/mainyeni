import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBaseline,
  compareBaseline,
  decideReleaseGate,
  fingerprintReportData,
  regressionFindings,
  releaseReportMarkdown,
  runReleaseEngine,
  stableJson,
} from './release-engine.mts';
import { DEFAULT_THRESHOLDS, type BaselineSnapshot, type Finding, type ReleaseContext } from './contracts.mts';
import { fixtureInventory, fullFixtureInventory } from './test-helpers.mts';

const context: ReleaseContext = {
  repository: 'owner/repo',
  branch: 'agent/test',
  commit: 'abc123',
  generatedAt: '2026-09-16T00:00:00.000Z',
};

const finding = (id: string, severity: Finding['severity'], blocking = false): Finding => ({
  id,
  domain: 'release',
  severity,
  title: id,
  message: id,
  ...(blocking ? { blocking: true } : {}),
});

test('release gate passes an empty finding set', () => {
  const decision = decideReleaseGate([], DEFAULT_THRESHOLDS);
  assert.equal(decision.state, 'pass');
  assert.equal(decision.riskScore, 0);
});

test('release gate reviews non-blocking medium findings when thresholds allow', () => {
  const decision = decideReleaseGate([finding('m', 'medium')], { ...DEFAULT_THRESHOLDS, maxMediumFindings: 10, maxRiskScore: 100 });
  assert.equal(decision.state, 'review');
});

test('release gate blocks critical finding', () => {
  const decision = decideReleaseGate([finding('c', 'critical')], { ...DEFAULT_THRESHOLDS, maxRiskScore: 10_000 });
  assert.equal(decision.state, 'block');
  assert.ok(decision.reasons.some(reason => reason.includes('critical')));
});

test('release gate blocks explicit blocker independent of severity', () => {
  const decision = decideReleaseGate([finding('explicit', 'low', true)], { ...DEFAULT_THRESHOLDS, maxRiskScore: 10_000 });
  assert.equal(decision.state, 'block');
  assert.equal(decision.blockingFindingIds.length, 1);
});

test('release gate blocks when high count exceeds threshold', () => {
  const decision = decideReleaseGate([
    finding('h1', 'high'),
    finding('h2', 'high'),
  ], { ...DEFAULT_THRESHOLDS, maxHighFindings: 1, maxRiskScore: 10_000 });
  assert.equal(decision.state, 'block');
});

test('release gate blocks when risk score exceeds threshold', () => {
  const decision = decideReleaseGate([
    finding('m1', 'medium'),
    finding('m2', 'medium'),
  ], { ...DEFAULT_THRESHOLDS, maxMediumFindings: 10, maxRiskScore: 20 });
  assert.equal(decision.state, 'block');
  assert.ok(decision.reasons.some(reason => reason.includes('Risk score')));
});

test('stableJson sorts object keys recursively', () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('fingerprint is deterministic for differently ordered objects', () => {
  const left = fingerprintReportData({ b: 2, a: 1 });
  const right = fingerprintReportData({ a: 1, b: 2 });
  assert.equal(left, right);
  assert.equal(left.length, 64);
});

test('runReleaseEngine returns a report with every audit section', async () => {
  const inventory = fullFixtureInventory();
  const execution = await runReleaseEngine(inventory, context, {
    thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 },
  });
  const domains = new Set(execution.report.sections.map(section => section.domain));
  assert.ok(domains.has('architecture'));
  assert.ok(domains.has('security'));
  assert.ok(domains.has('dependencies'));
  assert.ok(domains.has('network'));
  assert.ok(domains.has('gis'));
  assert.ok(domains.has('accessibility'));
  assert.ok(domains.has('performance'));
  assert.ok(domains.has('testing'));
});

test('runReleaseEngine fingerprint remains stable for identical inventory/context', async () => {
  const inventory = fixtureInventory([]);
  const first = await runReleaseEngine(inventory, context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const second = await runReleaseEngine(inventory, context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  assert.equal(first.report.fingerprint, second.report.fingerprint);
});

test('createBaseline preserves report fingerprint and findings', async () => {
  const inventory = fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'eval(input);' }]);
  const execution = await runReleaseEngine(inventory, context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(execution.report);
  assert.equal(baseline.fingerprint, execution.report.fingerprint);
  assert.equal(baseline.findings.length, execution.report.findings.length);
  assert.equal(baseline.commit, 'abc123');
});

test('compareBaseline marks new finding as added', async () => {
  const clean = await runReleaseEngine(fixtureInventory([]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(clean.report);
  const dirty = await runReleaseEngine(fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'eval(input);' }]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const delta = compareBaseline(dirty.report, baseline);
  assert.ok(delta.added.length > 0);
  assert.ok(delta.riskScoreDelta > 0);
});

test('compareBaseline marks removed finding as removed', async () => {
  const dirty = await runReleaseEngine(fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'eval(input);' }]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(dirty.report);
  const clean = await runReleaseEngine(fixtureInventory([]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const delta = compareBaseline(clean.report, baseline);
  assert.ok(delta.removed.length > 0);
  assert.ok(delta.riskScoreDelta < 0);
});

test('regressionFindings blocks new critical findings', () => {
  const delta = {
    added: [{ key: 'c', severity: 'critical' as const, domain: 'security' as const }],
    removed: [],
    unchanged: [],
    riskScoreDelta: 100,
    severityDelta: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
  };
  const findings = regressionFindings(delta);
  const critical = findings.find(item => item.id === 'release-new-critical-regression');
  assert.equal(critical?.blocking, true);
});

test('regressionFindings reports new high findings', () => {
  const delta = {
    added: [{ key: 'h', severity: 'high' as const, domain: 'security' as const }],
    removed: [],
    unchanged: [],
    riskScoreDelta: 40,
    severityDelta: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  };
  const findings = regressionFindings(delta);
  assert.ok(findings.some(item => item.id === 'release-new-high-regression'));
});

test('regressionFindings reports material aggregate risk increase', () => {
  const delta = {
    added: [],
    removed: [],
    unchanged: [],
    riskScoreDelta: 101,
    severityDelta: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
  assert.ok(regressionFindings(delta).some(item => item.id === 'release-risk-score-regression'));
});

test('engine with baseline returns regression object', async () => {
  const inventory = fixtureInventory([]);
  const first = await runReleaseEngine(inventory, context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(first.report);
  const second = await runReleaseEngine(inventory, context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } }, baseline);
  assert.ok(second.regression);
  assert.equal(second.regression?.added.length, 0);
});

test('release markdown includes repository, gate and fingerprint', async () => {
  const execution = await runReleaseEngine(fixtureInventory([]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const markdown = releaseReportMarkdown(execution);
  assert.match(markdown, /Kent Rehberi/);
  assert.match(markdown, /owner\/repo/);
  assert.match(markdown, /Gate:/);
  assert.match(markdown, /Fingerprint:/);
});

test('release markdown includes baseline delta when supplied', async () => {
  const clean = await runReleaseEngine(fixtureInventory([]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(clean.report);
  const execution = await runReleaseEngine(fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'console.warn("x")' }]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } }, baseline);
  assert.match(releaseReportMarkdown(execution), /Baseline delta/);
});

test('createBaseline emits schema version 1', async () => {
  const execution = await runReleaseEngine(fixtureInventory([]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  assert.equal(createBaseline(execution.report).schemaVersion, 1);
});

test('baseline comparison is key-based and stable', async () => {
  const execution = await runReleaseEngine(fixtureInventory([{ path: 'Webclient.app/src/x.js', text: 'console.warn("x")' }]), context, { thresholds: { maxHighFindings: 100, maxMediumFindings: 100, maxRiskScore: 100_000 } });
  const baseline = createBaseline(execution.report);
  const clone: BaselineSnapshot = JSON.parse(JSON.stringify(baseline)) as BaselineSnapshot;
  const delta = compareBaseline(execution.report, clone);
  assert.equal(delta.added.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.unchanged.length, execution.report.findings.length);
});
