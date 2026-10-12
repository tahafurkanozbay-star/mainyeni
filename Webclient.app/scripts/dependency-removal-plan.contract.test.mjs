import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemovalPlan, collectExclusiveClosure, collectSharedDependents, diffRemovalPlans, normalizeRemovalCandidates, renderRemovalPlan } from './dependency-removal-plan.mjs';

const mkGraph = ({ children = {}, parents = {}, ok = true, errors = [] } = {}) => ({ ok, errors, children, parents, reachable: Object.keys(parents).sort() });
const mkLock = (names) => ({ lockfileVersion: 3, packages: Object.fromEntries([['', { dependencies: Object.fromEntries(names.map((n) => [n, '1.0.0'])) }], ...names.map((n) => [`node_modules/${n}`, { version: '1.0.0' }])]) });
const mkManifest = (names) => ({ dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])) });
const independentGraph = (names) => mkGraph({ children: { '': names.map((n) => `node_modules/${n}`), ...Object.fromEntries(names.map((n) => [`node_modules/${n}`, []])) }, parents: Object.fromEntries(names.map((n) => [`node_modules/${n}`, ['']])) });

for (const invalid of ['', ' ', '../x', './x', '/x', 'a b', 'a#b', '@scope', '@scope/', 'http:x', 'file:x']) {
  test(`candidate sanitizer rejects ${JSON.stringify(invalid)}`, () => assert.deepEqual(normalizeRemovalCandidates([invalid]), []));
}

for (const valid of ['a', 'a-b', 'a_b', 'a.b', '@scope/pkg', '@scope/pkg-name']) {
  test(`candidate sanitizer accepts ${valid}`, () => assert.deepEqual(normalizeRemovalCandidates([valid]), [valid]));
}

test('candidate sanitizer is case-insensitive but does not rewrite identity', () => assert.deepEqual(normalizeRemovalCandidates(['Pkg']), ['Pkg']));
test('candidate sanitizer removes exact duplicates', () => assert.deepEqual(normalizeRemovalCandidates(['a', 'a', 'a']), ['a']));
test('candidate sanitizer sorts scoped and unscoped names deterministically', () => assert.deepEqual(normalizeRemovalCandidates(['z', '@a/x', 'a']), ['@a/x', 'a', 'z']));

test('closure handles a linear chain', () => {
  const g = mkGraph({ children: { a: ['b'], b: ['c'], c: [] }, parents: { a: [''], b: ['a'], c: ['b'] } });
  assert.deepEqual(collectExclusiveClosure(g, 'a'), ['a', 'b', 'c']);
});

test('closure handles a diamond when every child parent is owned', () => {
  const g = mkGraph({ children: { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }, parents: { a: [''], b: ['a'], c: ['a'], d: ['b', 'c'] } });
  assert.deepEqual(collectExclusiveClosure(g, 'a'), ['a', 'b', 'c', 'd']);
});

test('closure excludes a diamond leaf with an external parent', () => {
  const g = mkGraph({ children: { a: ['b'], b: ['d'], x: ['d'], d: [] }, parents: { a: [''], b: ['a'], x: [''], d: ['b', 'x'] } });
  assert.deepEqual(collectExclusiveClosure(g, 'a'), ['a', 'b']);
});

test('closure terminates on a cycle already admitted into ownership', () => {
  const g = mkGraph({ children: { a: ['b'], b: ['a'] }, parents: { a: ['b'], b: ['a'] } });
  assert.deepEqual(collectExclusiveClosure(g, 'a'), ['a', 'b']);
});

test('shared dependent collection deduplicates external parents', () => {
  const g = mkGraph({ children: {}, parents: { a: ['x', 'x', 'y'], b: ['x'] } });
  assert.deepEqual(collectSharedDependents(g, ['a', 'b']), ['x', 'y']);
});

test('shared dependent collection ignores internal parents', () => {
  const g = mkGraph({ children: {}, parents: { a: ['b'], b: ['a'] } });
  assert.deepEqual(collectSharedDependents(g, ['a', 'b']), []);
});

test('empty candidate plan is valid and deterministic', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, [], { graph: mkGraph() });
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.candidates, 0);
  assert.equal(plan.fingerprint.length, 64);
});

test('unknown candidate is evidence, not a mutation instruction', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, ['unknown'], { graph: mkGraph() });
  assert.equal(plan.candidates[0].status, 'not-direct');
  assert.equal(plan.summary.exclusivePackages, 0);
});

test('multiple graph errors are sorted in policy output', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, [], { graph: mkGraph({ ok: false, errors: ['z', 'a'] }) });
  assert.deepEqual(plan.issues, ['lock graph: a', 'lock graph: z']);
});

test('zero candidate budget rejects non-empty request', () => {
  const names = ['a'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: independentGraph(names), maxCandidates: 0 });
  assert.equal(plan.ok, false);
  assert.equal(plan.candidates.length, 0);
});

test('budget truncation is deterministic after candidate normalization', () => {
  const names = ['a', 'b', 'c'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), ['c', 'a', 'b'], { graph: independentGraph(names), maxCandidates: 2 });
  assert.deepEqual(plan.candidates.map((x) => x.name), ['a', 'b']);
});

test('independent direct packages are individually plannable', () => {
  const names = ['a', 'b', 'c'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: independentGraph(names) });
  assert.equal(plan.summary.plannable, 3);
  assert.equal(plan.summary.exclusivePackages, 3);
});

test('plan candidate objects expose no manifest range payload', () => {
  const names = ['a'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: independentGraph(names) });
  assert.equal('range' in plan.candidates[0], false);
});

test('render includes policy errors', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, [], { graph: mkGraph({ ok: false, errors: ['broken'] }) });
  assert.match(renderRemovalPlan(plan), /policy: lock graph: broken/);
});

test('render includes blockers for absent direct dependency', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, ['ghost'], { graph: mkGraph() });
  assert.match(renderRemovalPlan(plan), /blocker: candidate is not a direct dependency/);
});

test('render has exactly one terminal newline', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, [], { graph: mkGraph() });
  assert.equal(renderRemovalPlan(plan).endsWith('\n\n'), false);
  assert.equal(renderRemovalPlan(plan).endsWith('\n'), true);
});

test('equivalent plans have equivalent rendered fingerprints', () => {
  const names = ['a', 'b'];
  const options = { graph: independentGraph(names) };
  const a = buildRemovalPlan(mkManifest(names), mkLock(names), ['a', 'b'], options);
  const b = buildRemovalPlan(mkManifest(names), mkLock(names), ['b', 'a'], options);
  assert.equal(a.fingerprint, b.fingerprint);
});

test('adding a candidate changes fingerprint', () => {
  const names = ['a', 'b'];
  const options = { graph: independentGraph(names) };
  const a = buildRemovalPlan(mkManifest(names), mkLock(names), ['a'], options);
  const b = buildRemovalPlan(mkManifest(names), mkLock(names), ['a', 'b'], options);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('diff result is immutable', () => {
  const names = ['a', 'b'];
  const options = { graph: independentGraph(names) };
  const a = buildRemovalPlan(mkManifest(names), mkLock(names), ['a'], options);
  const b = buildRemovalPlan(mkManifest(names), mkLock(names), ['a', 'b'], options);
  const diff = diffRemovalPlans(a, b);
  assert.ok(Object.isFrozen(diff));
  assert.throws(() => diff.push({}), TypeError);
});

test('diff ordering follows dependency name', () => {
  const names = ['a', 'b', 'c'];
  const options = { graph: independentGraph(names) };
  const before = buildRemovalPlan(mkManifest(names), mkLock(names), ['a'], options);
  const after = buildRemovalPlan(mkManifest(names), mkLock(names), ['a', 'c', 'b'], options);
  assert.deepEqual(diffRemovalPlans(before, after).map((x) => x.name), ['b', 'c']);
});

test('plan summary is frozen', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, [], { graph: mkGraph() });
  assert.ok(Object.isFrozen(plan.summary));
  assert.throws(() => { plan.summary.candidates = 9; }, TypeError);
});

test('candidate blockers are frozen', () => {
  const plan = buildRemovalPlan({}, { packages: { '': {} } }, ['ghost'], { graph: mkGraph() });
  assert.ok(Object.isFrozen(plan.candidates[0].blockers));
  assert.throws(() => plan.candidates[0].blockers.push('x'), TypeError);
});

test('candidate closure is frozen', () => {
  const names = ['a'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: independentGraph(names) });
  assert.ok(Object.isFrozen(plan.candidates[0].closure));
});

test('candidate shared dependent list is frozen', () => {
  const names = ['a'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: independentGraph(names) });
  assert.ok(Object.isFrozen(plan.candidates[0].sharedDependents));
});


test('manifest root ownership is not an external package dependent', () => {
  const g = mkGraph({
    children: { '': ['node_modules/a'], 'node_modules/a': [] },
    parents: { 'node_modules/a': [''] },
  });
  assert.deepEqual(collectSharedDependents(g, ['node_modules/a']), []);
});

test('real package parent remains an external blocker beside manifest root', () => {
  const g = mkGraph({
    children: { '': ['node_modules/a'], 'node_modules/host': ['node_modules/a'], 'node_modules/a': [] },
    parents: { 'node_modules/a': ['', 'node_modules/host'] },
  });
  assert.deepEqual(collectSharedDependents(g, ['node_modules/a']), ['node_modules/host']);
});

test('manifest root plus owned parent does not create a false blocker', () => {
  const g = mkGraph({
    children: { '': ['node_modules/a'], 'node_modules/a': ['node_modules/leaf'], 'node_modules/leaf': [] },
    parents: { 'node_modules/a': [''], 'node_modules/leaf': ['node_modules/a'] },
  });
  assert.deepEqual(
    collectSharedDependents(g, ['node_modules/a', 'node_modules/leaf']),
    [],
  );
});

test('independent direct dependency is plannable when graph records manifest root parent', () => {
  const names = ['a'];
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, {
    graph: independentGraph(names),
  });
  assert.equal(plan.candidates[0].status, 'plannable');
  assert.deepEqual(plan.candidates[0].sharedDependents, []);
  assert.deepEqual(plan.candidates[0].blockers, []);
});

test('real external package parent forces review while manifest root is ignored', () => {
  const names = ['a'];
  const g = mkGraph({
    children: {
      '': ['node_modules/a'],
      'node_modules/host': ['node_modules/a'],
      'node_modules/a': [],
    },
    parents: {
      'node_modules/a': ['', 'node_modules/host'],
    },
  });
  const plan = buildRemovalPlan(mkManifest(names), mkLock(names), names, { graph: g });
  assert.equal(plan.candidates[0].status, 'review');
  assert.deepEqual(plan.candidates[0].sharedDependents, ['node_modules/host']);
  assert.match(plan.candidates[0].blockers[0], /external dependent/);
});

test('multiple real external parents remain deterministic and deduplicated', () => {
  const g = mkGraph({
    children: {},
    parents: {
      'node_modules/a': ['', 'node_modules/z', 'node_modules/x', 'node_modules/z'],
    },
  });
  assert.deepEqual(
    collectSharedDependents(g, ['node_modules/a']),
    ['node_modules/x', 'node_modules/z'],
  );
});

test('manifest root sentinel is ignored only by dependent analysis, not closure ownership', () => {
  const g = mkGraph({
    children: { '': ['node_modules/a'], 'node_modules/a': ['node_modules/leaf'], 'node_modules/leaf': [] },
    parents: { 'node_modules/a': [''], 'node_modules/leaf': ['node_modules/a'] },
  });
  const closure = collectExclusiveClosure(g, 'node_modules/a');
  assert.deepEqual(closure, ['node_modules/a', 'node_modules/leaf']);
  assert.deepEqual(collectSharedDependents(g, closure), []);
});

test('root filtering does not mutate graph parent evidence', () => {
  const parents = { 'node_modules/a': ['', 'node_modules/host'] };
  const g = mkGraph({ children: {}, parents });
  const before = JSON.stringify(g);
  collectSharedDependents(g, ['node_modules/a']);
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(parents['node_modules/a'], ['', 'node_modules/host']);
});
