import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTurkishIconAliasDelta } from './pr-gate.mts';
import type { FindingSnapshot, RegressionDelta, Severity } from './contracts.mts';

function icon(alias: string, owners: string, severity: Severity = 'medium',
  file = 'Webclient.app/src/gis-engine/iconRegistry.json'): FindingSnapshot {
  return {
    key: 'icons|gis-icon-alias-collision|' + file + ':1|' + alias + ': ' + owners,
    domain: 'icons',
    severity,
    file,
    line: 1,
  };
}
function delta(added: FindingSnapshot[], removed: FindingSnapshot[]): RegressionDelta {
  return {
    added, removed, unchanged: [],
    riskScoreDelta: 0,
    severityDelta: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
}
test('pre-existing ASKİ collision migrates by normalized name and identical owners', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('aski', 'baraj, kart, bolge')],
    [icon('askı', 'baraj, kart, bolge')],
  ));
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.unchanged.length, 1);
});
test('pre-existing İştirakler collision is unchanged after diacritic folding', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('istirakler', 'anfa, belko')],
    [icon('ıstırakler', 'anfa, belko')],
  ));
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.unchanged.length, 1);
});
test('unrelated alias with same owners remains a new release risk', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('new place', 'a, b')],
    [icon('old place', 'a, b')],
  ));
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
});
test('newly added alias owner is not concealed by normalization', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('aski', 'a, b, c')],
    [icon('askı', 'a, b')],
  ));
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
});
test('severity escalation cannot be paired away', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('aski', 'a, b', 'high')],
    [icon('askı', 'a, b', 'medium')],
  ));
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
});
test('different registry path cannot borrow a historic collision', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('aski', 'a, b', 'medium', 'other/icons.json')],
    [icon('askı', 'a, b')],
  ));
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
});
test('one-to-one migration preserves genuine additional collisions', () => {
  const result = reconcileTurkishIconAliasDelta(delta(
    [icon('aski', 'a, b'), icon('aski', 'new, owners')],
    [icon('askı', 'a, b')],
  ));
  assert.equal(result.added.length, 1);
  assert.ok(result.added[0]?.key.endsWith('new, owners'));
  assert.equal(result.removed.length, 0);
  assert.equal(result.unchanged.length, 1);
});
test('unchanged deltas preserve their original arrays', () => {
  const empty = delta([], []);
  assert.equal(reconcileTurkishIconAliasDelta(empty), empty);
});
test('unrelated security findings are never migrated by the GIS policy', () => {
  const old = { ...icon('askı', 'a, b'), domain: 'security' as const };
  const current = { ...icon('aski', 'a, b'), domain: 'security' as const };
  const result = reconcileTurkishIconAliasDelta(delta([current], [old]));
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
});
