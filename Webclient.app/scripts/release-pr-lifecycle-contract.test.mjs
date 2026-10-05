import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReleasePrLifecycle } from './release-pr-lifecycle-contract.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const valid = () => ({
  version: 1,
  number: 469,
  state: 'open',
  merged: false,
  draft: false,
  mergeable: true,
  baseSha: base,
  headSha: head,
  createdAt: '2026-10-05T01:00:00.000Z',
  updatedAt: '2026-10-05T01:10:00.000Z',
  observedAt: '2026-10-05T01:15:00.000Z',
});
const codes = result => new Set(result.findings.map(item => item.code));

test('accepts coherent open exact-head PR lifecycle evidence', () => {
  const result = evaluateReleasePrLifecycle(valid(), { expectedNumber: 469, expectedHeadSha: head, expectedBaseSha: base });
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.summary.errors, 0);
});

test('rejects closed candidate even when other metadata looks mergeable', () => {
  const input = valid(); input.state = 'closed';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('pr-closed'));
});

test('rejects already merged candidate', () => {
  const input = valid(); input.merged = true;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('pr-merged'));
});

test('rejects draft candidate', () => {
  const input = valid(); input.draft = true;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('pr-draft'));
});

test('rejects non-mergeable candidate', () => {
  const input = valid(); input.mergeable = false;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('pr-not-mergeable'));
});

test('rejects candidate whose head equals base', () => {
  const input = valid(); input.headSha = base;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('head-equals-base'));
});

test('binds evidence to expected PR number', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedNumber: 470 })).has('number-mismatch'));
});

test('binds evidence to expected exact head', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedHeadSha: 'c'.repeat(40) })).has('head-mismatch'));
});

test('binds evidence to expected current main', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedBaseSha: 'c'.repeat(40) })).has('base-mismatch'));
});

test('rejects malformed expected number policy', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedNumber: 0 })).has('expected-number-invalid'));
});

test('rejects malformed expected head policy', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedHeadSha: 'bad' })).has('expected-head-invalid'));
});

test('rejects malformed expected base policy', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { expectedBaseSha: 'bad' })).has('expected-base-invalid'));
});

test('rejects malformed policy containers without throwing', () => {
  for (const policy of [null, [], 'policy', 42, false]) {
    const result = evaluateReleasePrLifecycle(valid(), policy);
    assert.equal(result.passed, false);
    assert.equal(result.mergeAllowed, false);
    assert.ok(codes(result).has('policy-invalid'));
    assert.equal(result.summary.errors, 1);
  }
});

test('rejects metadata timestamp before creation timestamp', () => {
  const input = valid(); input.updatedAt = '2026-10-05T00:59:59.000Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('timestamp-order-invalid'));
});

test('rejects metadata timestamp from the future', () => {
  const input = valid(); input.updatedAt = '2026-10-05T01:16:00.000Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('metadata-from-future'));
});

test('rejects creation timestamp from the future', () => {
  const input = valid(); input.createdAt = '2026-10-05T01:16:00.000Z'; input.updatedAt = '2026-10-05T01:16:00.000Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('created-from-future'));
});

test('rejects stale PR metadata', () => {
  const input = valid(); input.observedAt = '2026-10-05T02:00:00.000Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input, { maxMetadataAgeMs: 30 * 60 * 1000 })).has('metadata-stale'));
});

test('accepts metadata exactly on freshness boundary', () => {
  const input = valid(); input.observedAt = '2026-10-05T01:40:00.000Z';
  assert.equal(evaluateReleasePrLifecycle(input, { maxMetadataAgeMs: 30 * 60 * 1000 }).passed, true);
});

test('rejects freshness policy over 24 hours', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { maxMetadataAgeMs: 24 * 60 * 60 * 1000 + 1 })).has('freshness-policy-invalid'));
});

test('rejects negative freshness policy', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(valid(), { maxMetadataAgeMs: -1 })).has('freshness-policy-invalid'));
});

test('rejects non-object evidence', () => {
  assert.ok(codes(evaluateReleasePrLifecycle(null)).has('evidence-invalid'));
  assert.ok(codes(evaluateReleasePrLifecycle([])).has('evidence-invalid'));
});

test('rejects unsupported evidence version', () => {
  const input = valid(); input.version = 2;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('version-unsupported'));
});

test('rejects invalid PR number', () => {
  const input = valid(); input.number = 0;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('number-invalid'));
});

test('rejects invalid PR state', () => {
  const input = valid(); input.state = 'merged';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('state-invalid'));
});

test('rejects non-boolean merged state', () => {
  const input = valid(); input.merged = 'false';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('merged-invalid'));
});

test('rejects non-boolean draft state', () => {
  const input = valid(); input.draft = 0;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('draft-invalid'));
});

test('rejects non-boolean mergeability', () => {
  const input = valid(); input.mergeable = null;
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('mergeable-invalid'));
});

test('rejects malformed base SHA', () => {
  const input = valid(); input.baseSha = 'bad';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('base-sha-invalid'));
});

test('rejects malformed head SHA', () => {
  const input = valid(); input.headSha = 'bad';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('head-sha-invalid'));
});

test('normalizes uppercase SHA evidence before exact-head comparison', () => {
  const input = valid(); input.headSha = head.toUpperCase();
  assert.equal(evaluateReleasePrLifecycle(input, { expectedHeadSha: head }).passed, true);
});

test('rejects non-canonical creation timestamp', () => {
  const input = valid(); input.createdAt = '2026-10-05T01:00:00Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('created-at-invalid'));
});

test('rejects non-canonical update timestamp', () => {
  const input = valid(); input.updatedAt = '2026-10-05 01:10:00Z';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('updated-at-invalid'));
});

test('rejects non-canonical observation timestamp', () => {
  const input = valid(); input.observedAt = '2026-10-05T04:15:00.000+03:00';
  assert.ok(codes(evaluateReleasePrLifecycle(input)).has('observed-at-invalid'));
});

test('result, findings, finding entries, and summary are immutable', () => {
  const input = valid(); input.state = 'closed';
  const result = evaluateReleasePrLifecycle(input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.ok(result.findings.length > 0);
  assert.equal(Object.isFrozen(result.findings[0]), true);
  assert.equal(Object.isFrozen(result.summary), true);
});
