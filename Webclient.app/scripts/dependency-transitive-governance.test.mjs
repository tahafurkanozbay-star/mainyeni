import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPeerExceptions, validatePeerExceptions } from './dependency-transitive-governance.mjs';

const edge = Object.freeze({ from: 'node_modules/react-color', name: 'react', range: '*', optional: false, target: 'node_modules/react', targetVersion: '19.3.0' });
const finding = Object.freeze({ code: 'peer-range', path: edge.from, detail: 'react uses unreviewable peer range *', severity: 'error' });
const base = Object.freeze({
  ok: false,
  issues: Object.freeze([finding]),
  inventory: Object.freeze({ peerEdges: Object.freeze([edge]), summary: Object.freeze({ reachable: 2, peerEdges: 1, installScripts: 0, deprecated: 0 }), fingerprint: 'fixture' }),
});
const exception = Object.freeze({
  package: 'react-color',
  peer: 'react',
  range: '*',
  owner: 'platform',
  expiresOn: '2026-11-30',
  reason: 'Legacy unused package is scheduled for deterministic removal from the lock graph.',
});

test('accepts a bounded, owned and unexpired exact peer exception', () => {
  assert.deepEqual(validatePeerExceptions({ peerExceptions: [exception] }, '2026-10-05'), []);
});

test('rejects expired peer exceptions', () => {
  const issues = validatePeerExceptions({ peerExceptions: [{ ...exception, expiresOn: '2026-10-04' }] }, '2026-10-05');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /expired/);
});

test('rejects duplicate peer exceptions', () => {
  const issues = validatePeerExceptions({ peerExceptions: [exception, exception] }, '2026-10-05');
  assert.ok(issues.some((issue) => issue.includes('duplicate peer exception')));
});

test('rejects weak exception metadata', () => {
  const issues = validatePeerExceptions({ peerExceptions: [{ package: 'react-color', peer: 'react', range: '*', owner: '', expiresOn: 'tomorrow', reason: 'short' }] }, '2026-10-05');
  assert.ok(issues.some((issue) => issue.includes('owner')));
  assert.ok(issues.some((issue) => issue.includes('reason')));
  assert.ok(issues.some((issue) => issue.includes('YYYY-MM-DD')));
});

test('suppresses only the exact reviewed legacy peer finding', () => {
  const result = applyPeerExceptions(base, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, true);
  assert.equal(result.usedPeerExceptions, 1);
  assert.equal(result.peerExceptionCount, 1);
  assert.deepEqual(result.issues, []);
});

test('does not suppress a different peer range', () => {
  const result = applyPeerExceptions(base, { peerExceptions: [{ ...exception, range: '^18.0.0' }] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'peer-range'));
  assert.ok(result.issues.some((issue) => issue.code === 'peer-exception-policy'));
});

test('does not suppress unrelated transitive findings', () => {
  const other = Object.freeze({ code: 'install-script-budget', path: 'node_modules/native', detail: 'fixture', severity: 'error' });
  const result = applyPeerExceptions({ ...base, issues: Object.freeze([finding, other]) }, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === 'install-script-budget'), true);
});

test('fails closed when an exception becomes stale', () => {
  const clean = Object.freeze({ ...base, ok: true, issues: Object.freeze([]) });
  const result = applyPeerExceptions(clean, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /unnecessary peer exception/.test(issue.detail)));
});

test('fails closed when an exception target disappears', () => {
  const result = applyPeerExceptions({ ...base, inventory: { ...base.inventory, peerEdges: Object.freeze([]) } }, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /stale peer exception/.test(issue.detail)));
});

test('keeps returned issue arrays immutable', () => {
  const result = applyPeerExceptions(base, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issues), true);
});


// Peer exceptions must match the exact failing edge, never a sibling peer at the same lock path.
test('does not hide a sibling unreviewable peer range', () => {
  const sibling = Object.freeze({ ...edge, name: 'other-peer', range: '*' });
  const siblingFinding = Object.freeze({ code: 'peer-range', path: edge.from, detail: 'other-peer uses unreviewable peer range *', severity: 'error' });
  const result = applyPeerExceptions({
    ...base,
    issues: Object.freeze([finding, siblingFinding]),
    inventory: Object.freeze({ ...base.inventory, peerEdges: Object.freeze([edge, sibling]) }),
  }, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.equal(result.usedPeerExceptions, 1);
  assert.deepEqual(result.issues, [siblingFinding]);
});

test('never suppresses unresolved or incompatible required peers', () => {
  const missing = Object.freeze({ ...edge, name: 'vite', range: '^8.0.0', target: null, targetVersion: null });
  const incompatible = Object.freeze({ ...edge, name: 'react-dom', range: '^19.0.0', target: 'node_modules/react-dom', targetVersion: '18.0.0' });
  const unresolved = Object.freeze({ code: 'peer-unresolved', path: edge.from, detail: 'required peer vite@^8.0.0 is not installed', severity: 'error' });
  const mismatch = Object.freeze({ code: 'peer-mismatch', path: edge.from, detail: 'react-dom@18.0.0 does not satisfy ^19.0.0', severity: 'error' });
  const result = applyPeerExceptions({
    ...base,
    issues: Object.freeze([finding, unresolved, mismatch]),
    inventory: Object.freeze({ ...base.inventory, peerEdges: Object.freeze([edge, missing, incompatible]) }),
  }, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.equal(result.usedPeerExceptions, 1);
  assert.equal(result.issues.some((issue) => issue.code === 'peer-unresolved'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'peer-mismatch'), true);
});

test('rejects malformed peer exception containers without TypeError or silent acceptance', () => {
  for (const peerExceptions of [null, {}, 'bad', 0]) {
    const result = applyPeerExceptions(base, { peerExceptions }, '2026-10-05');
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === 'peer-exception-policy'), true);
    assert.equal(result.issues.some((issue) => issue.code === 'peer-range'), true);
  }
});

test('rejects impossible peer exception expiry dates and accepts leap day', () => {
  for (const expiresOn of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-99-99']) {
    assert.ok(validatePeerExceptions({ peerExceptions: [{ ...exception, expiresOn }] }, '2026-01-01').some((issue) => issue.includes('calendar date')));
  }
  assert.deepEqual(validatePeerExceptions({ peerExceptions: [{ ...exception, expiresOn: '2028-02-29' }] }, '2026-10-05'), []);
});


test('three exact optional Vitest peer exceptions cannot hide sibling findings', () => {
  const from = 'node_modules/vitest';
  const specs = [
    ['@vitest/browser-webdriverio', '^5.0.0-beta.5 || >=5.0.0', null],
    ['happy-dom', '*', null],
    ['jsdom', '*', '30.0.1'],
  ];
  const peers = specs.map(([name, range, targetVersion]) => Object.freeze({
    from, name, range, optional: true,
    target: targetVersion ? 'node_modules/jsdom' : null, targetVersion,
  }));
  const findings = peers.map(({ name, range }) => Object.freeze({
    code: 'peer-range', path: from, detail: `${name} uses unreviewable peer range ${range}`, severity: 'error',
  }));
  const peerExceptions = peers.map(({ name, range }) => Object.freeze({
    package: 'vitest', peer: name, range, owner: 'platform', expiresOn: '2026-11-30',
    reason: 'Optional Vitest environment peer has an explicitly reviewed bounded policy exception.',
  }));
  const result = applyPeerExceptions({
    ...base, issues: Object.freeze(findings),
    inventory: Object.freeze({ ...base.inventory, peerEdges: Object.freeze(peers) }),
  }, { peerExceptions }, '2026-10-08');
  assert.equal(result.ok, true);
  assert.equal(result.usedPeerExceptions, 3);
  assert.equal(result.peerExceptionCount, 3);
});

test('exact peer-range exception cannot suppress a missing required peer on the same edge', () => {
  const unresolved = Object.freeze({ ...edge, target: null, targetVersion: null });
  const unresolvedFinding = Object.freeze({
    code: 'peer-unresolved', path: edge.from, detail: 'required peer react@* is not installed', severity: 'error',
  });
  const result = applyPeerExceptions({
    ...base,
    issues: Object.freeze([finding, unresolvedFinding]),
    inventory: Object.freeze({ ...base.inventory, peerEdges: Object.freeze([unresolved]) }),
  }, { peerExceptions: [exception] }, '2026-10-05');
  assert.equal(result.ok, false);
  assert.equal(result.usedPeerExceptions, 1);
  assert.deepEqual(result.issues, [unresolvedFinding]);
});
