import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemovalPlan, collectExclusiveClosure, collectSharedDependents, diffRemovalPlans, directDependencyKind, directDependencyNames, inspectCandidate, normalizeRemovalCandidates, renderRemovalPlan } from './dependency-removal-plan.mjs';

const graph = (children = {}, parents = {}) => ({ ok: true, errors: [], reachable: Object.keys(parents), children, parents });
const lock = (packages) => ({ lockfileVersion: 3, packages });
const manifest = { dependencies: { alpha: '^1.0.0', shared: '^1.0.0' }, devDependencies: { beta: '^2.0.0' }, optionalDependencies: { opt: '^3.0.0' }, peerDependencies: { peer: '^4.0.0' } };
const packages = {
  '': { dependencies: { alpha: '^1.0.0', shared: '^1.0.0' }, devDependencies: { beta: '^2.0.0' }, optionalDependencies: { opt: '^3.0.0' }, peerDependencies: { peer: '^4.0.0' } },
  'node_modules/alpha': { version: '1.0.0', dependencies: { leaf: '1.0.0', shared: '1.0.0' } },
  'node_modules/beta': { version: '2.0.0', dependencies: { betaLeaf: '1.0.0' } },
  'node_modules/opt': { version: '3.0.0' },
  'node_modules/peer': { version: '4.0.0' },
  'node_modules/shared': { version: '1.0.0' },
  'node_modules/leaf': { version: '1.0.0' },
  'node_modules/betaLeaf': { version: '1.0.0' },
};
const dependencyGraph = graph({
  '': ['node_modules/alpha', 'node_modules/beta', 'node_modules/opt', 'node_modules/peer', 'node_modules/shared'],
  'node_modules/alpha': ['node_modules/leaf', 'node_modules/shared'],
  'node_modules/beta': ['node_modules/betaLeaf'],
  'node_modules/leaf': [], 'node_modules/betaLeaf': [], 'node_modules/opt': [], 'node_modules/peer': [], 'node_modules/shared': [],
}, {
  'node_modules/alpha': [''], 'node_modules/beta': [''], 'node_modules/opt': [''], 'node_modules/peer': [''], 'node_modules/shared': ['', 'node_modules/alpha'],
  'node_modules/leaf': ['node_modules/alpha'], 'node_modules/betaLeaf': ['node_modules/beta'],
});

test('normalizes candidates deterministically and rejects unsafe names', () => {
  assert.deepEqual(normalizeRemovalCandidates([' beta ', 'alpha', 'alpha', '', '../bad', '@scope/pkg', 'a b']), ['@scope/pkg', 'alpha', 'beta']);
});

test('normalization tolerates non-array input', () => assert.deepEqual(normalizeRemovalCandidates(null), []));

test('classifies all supported direct dependency sections', () => {
  assert.equal(directDependencyKind(manifest, 'alpha'), 'runtime');
  assert.equal(directDependencyKind(manifest, 'beta'), 'development');
  assert.equal(directDependencyKind(manifest, 'opt'), 'optional');
  assert.equal(directDependencyKind(manifest, 'peer'), 'peer');
  assert.equal(directDependencyKind(manifest, 'missing'), null);
});

test('runtime ownership wins when a malformed manifest duplicates a name', () => assert.equal(directDependencyKind({ dependencies: { x: '1' }, devDependencies: { x: '1' } }, 'x'), 'runtime'));

test('lists direct dependencies once and sorted', () => assert.deepEqual(directDependencyNames({ dependencies: { z: '1', a: '1' }, devDependencies: { a: '1', b: '1' } }), ['a', 'b', 'z']));

test('exclusive closure includes descendants owned only by candidate', () => assert.deepEqual(collectExclusiveClosure(dependencyGraph, 'node_modules/alpha'), ['node_modules/alpha', 'node_modules/leaf']));

test('exclusive closure is empty without a root', () => assert.deepEqual(collectExclusiveClosure(dependencyGraph, null), []));

test('shared dependents are reported outside the candidate closure', () => {
  const custom = graph({ a: ['b'], x: ['b'], b: [] }, { a: [''], x: [''], b: ['a', 'x'] });
  assert.deepEqual(collectSharedDependents(custom, ['a', 'b']), ['x']);
});

test('inspectCandidate rejects names absent from manifest', () => {
  const result = inspectCandidate(manifest, lock(packages), dependencyGraph, 'ghost');
  assert.equal(result.status, 'not-direct');
  assert.equal(result.blockers.length, 1);
  assert.ok(Object.isFrozen(result));
});

test('inspectCandidate reports lock resolution gaps', () => {
  const result = inspectCandidate({ dependencies: { ghost: '^1' } }, lock({ '': {} }), dependencyGraph, 'ghost');
  assert.equal(result.status, 'lock-missing');
  assert.equal(result.rootPath, null);
});

test('inspectCandidate produces a safe exclusive closure', () => {
  const result = inspectCandidate(manifest, lock(packages), dependencyGraph, 'alpha');
  assert.equal(result.status, 'plannable');
  assert.deepEqual(result.closure, ['node_modules/alpha', 'node_modules/leaf']);
  assert.deepEqual(result.sharedDependents, []);
});

test('development dependency closure is independently planned', () => {
  const result = inspectCandidate(manifest, lock(packages), dependencyGraph, 'beta');
  assert.equal(result.kind, 'development');
  assert.deepEqual(result.closure, ['node_modules/beta', 'node_modules/betaLeaf']);
});

test('plan preserves candidate ordering independent of input ordering', () => {
  const a = buildRemovalPlan(manifest, lock(packages), ['beta', 'alpha'], { graph: dependencyGraph });
  const b = buildRemovalPlan(manifest, lock(packages), ['alpha', 'beta'], { graph: dependencyGraph });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.candidates.map((x) => x.name), ['alpha', 'beta']);
});

test('plan summary separates runtime and development candidates', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['alpha', 'beta'], { graph: dependencyGraph });
  assert.deepEqual(plan.summary, { candidates: 2, runtime: 1, development: 1, plannable: 2, review: 0, missing: 0, exclusivePackages: 4 });
});

test('plan records missing candidates without making policy execution non-deterministic', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['ghost'], { graph: dependencyGraph });
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.missing, 1);
  assert.equal(plan.candidates[0].status, 'not-direct');
});

test('candidate cardinality is fail-closed', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['alpha', 'beta'], { graph: dependencyGraph, maxCandidates: 1 });
  assert.equal(plan.ok, false);
  assert.match(plan.issues[0], /exceeds safety budget/);
  assert.equal(plan.candidates.length, 1);
});

test('lock graph errors are surfaced as policy errors', () => {
  const badGraph = { ...dependencyGraph, ok: false, errors: ['cycle detected'] };
  const plan = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: badGraph });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.issues, ['lock graph: cycle detected']);
});

test('returned plan structures are immutable at public boundaries', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.candidates));
  assert.ok(Object.isFrozen(plan.summary));
  assert.throws(() => plan.candidates.push({}), TypeError);
});

test('render emits deterministic review evidence without package payload content', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  const output = renderRemovalPlan(plan);
  assert.match(output, /^Dependency removal plan [a-f0-9]{64}/);
  assert.match(output, /alpha: plannable \(runtime\) closure=2 shared=0/);
  assert.ok(output.endsWith('\n'));
});

test('diff reports added candidates', () => {
  const before = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  const after = buildRemovalPlan(manifest, lock(packages), ['alpha', 'beta'], { graph: dependencyGraph });
  assert.deepEqual(diffRemovalPlans(before, after), [{ name: 'beta', change: 'added', before: null, after: 'plannable' }]);
});

test('diff reports removed candidates', () => {
  const before = buildRemovalPlan(manifest, lock(packages), ['alpha', 'beta'], { graph: dependencyGraph });
  const after = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  assert.deepEqual(diffRemovalPlans(before, after), [{ name: 'beta', change: 'removed', before: 'plannable', after: null }]);
});

test('diff is empty for equivalent plans', () => {
  const before = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  const after = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  assert.deepEqual(diffRemovalPlans(before, after), []);
});

test('fingerprint changes when candidate set changes', () => {
  const a = buildRemovalPlan(manifest, lock(packages), ['alpha'], { graph: dependencyGraph });
  const b = buildRemovalPlan(manifest, lock(packages), ['beta'], { graph: dependencyGraph });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('optional and peer direct dependencies remain explicit plan kinds', () => {
  const plan = buildRemovalPlan(manifest, lock(packages), ['opt', 'peer'], { graph: dependencyGraph });
  assert.deepEqual(plan.candidates.map(({ name, kind }) => [name, kind]), [['opt', 'optional'], ['peer', 'peer']]);
});

test('planner never mutates manifest or lockfile', () => {
  const manifestBefore = JSON.stringify(manifest);
  const lockfile = lock(packages);
  const lockBefore = JSON.stringify(lockfile);
  buildRemovalPlan(manifest, lockfile, ['alpha'], { graph: dependencyGraph });
  assert.equal(JSON.stringify(manifest), manifestBefore);
  assert.equal(JSON.stringify(lockfile), lockBefore);
});
