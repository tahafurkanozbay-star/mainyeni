import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitiveInventory,
  collectDeprecatedSurface,
  collectInstallScriptSurface,
  collectPeerEdges,
  diffTransitiveInventory,
  evaluateTransitivePolicy,
  isConcreteVersion,
  isReviewablePeerRange,
  normalizePeerRange,
  satisfiesPeerRange,
  validatePeerEdges,
} from './dependency-transitive-policy.mjs';
import { buildLockGraph } from './dependency-lock-graph.mjs';

const integrity = `sha512-${'A'.repeat(88)}`;
const registry = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
const pkg = (name, version, extra = {}) => ({ version, resolved: registry(name, version), integrity, ...extra });
const lock = (root = {}, packages = {}) => ({
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'fixture', version: '1.0.0', ...root }, ...packages },
});

const peerFixture = ({ range = '^19.0.0', reactVersion = '19.3.0', optional = false, includeReact = true } = {}) => {
  const packages = {
    'node_modules/widget': pkg('widget', '2.0.0', {
      peerDependencies: { react: range },
      ...(optional ? { peerDependenciesMeta: { react: { optional: true } } } : {}),
    }),
  };
  if (includeReact) packages['node_modules/react'] = pkg('react', reactVersion);
  return lock({ dependencies: { widget: '2.0.0', ...(includeReact ? { react: reactVersion } : {}) } }, packages);
};

test('normalizes peer ranges without preserving redundant whitespace', () => {
  assert.equal(normalizePeerRange('  >=18.0.0   <20.0.0  '), '>=18.0.0 <20.0.0');
  assert.equal(normalizePeerRange(null), '');
});

test('recognizes concrete package versions', () => {
  for (const value of ['1.0.0', 'v2.3.4', '1.2.3-beta.1', '1.2.3+build.9']) assert.equal(isConcreteVersion(value), true, value);
  for (const value of ['', '1', '1.2', '^1.2.3', '~1.2.3', 'latest', 'workspace:*']) assert.equal(isConcreteVersion(value), false, value);
});

test('accepts bounded reviewable peer ranges', () => {
  for (const value of ['^19.0.0', '~18.2.0', '>=18.0.0 <20.0.0', '18.x', '18.2.x', '18.2.0 || 19.0.0']) {
    assert.equal(isReviewablePeerRange(value), true, value);
  }
});

test('rejects floating and external peer ranges', () => {
  for (const value of ['', '*', 'x', 'latest', 'next', 'file:../react', 'link:../react', 'git+https://example.test/react', 'https://example.test/react.tgz', 'workspace:*']) {
    assert.equal(isReviewablePeerRange(value), false, value);
  }
});

test('rejects pathologically large peer range expressions', () => {
  assert.equal(isReviewablePeerRange('1.0.0 || '.repeat(20) + '2.0.0'), false);
  assert.equal(isReviewablePeerRange('1.0.0 '.repeat(80)), false);
});

test('evaluates exact peer versions', () => {
  assert.equal(satisfiesPeerRange('19.0.0', '19.0.0'), true);
  assert.equal(satisfiesPeerRange('19.0.1', '19.0.0'), false);
});

test('evaluates caret peer versions', () => {
  assert.equal(satisfiesPeerRange('19.3.0', '^19.0.0'), true);
  assert.equal(satisfiesPeerRange('20.0.0', '^19.0.0'), false);
  assert.equal(satisfiesPeerRange('0.4.8', '^0.4.2'), true);
  assert.equal(satisfiesPeerRange('0.5.0', '^0.4.2'), false);
  assert.equal(satisfiesPeerRange('0.0.4', '^0.0.4'), true);
  assert.equal(satisfiesPeerRange('0.0.5', '^0.0.4'), false);
});

test('evaluates tilde peer versions', () => {
  assert.equal(satisfiesPeerRange('18.2.9', '~18.2.0'), true);
  assert.equal(satisfiesPeerRange('18.3.0', '~18.2.0'), false);
});

test('evaluates comparator intersections', () => {
  assert.equal(satisfiesPeerRange('19.1.0', '>=18.0.0 <20.0.0'), true);
  assert.equal(satisfiesPeerRange('20.0.0', '>=18.0.0 <20.0.0'), false);
  assert.equal(satisfiesPeerRange('17.9.9', '>=18.0.0 <20.0.0'), false);
});

test('evaluates wildcard minor and patch ranges', () => {
  assert.equal(satisfiesPeerRange('18.9.1', '18.x'), true);
  assert.equal(satisfiesPeerRange('19.0.0', '18.x'), false);
  assert.equal(satisfiesPeerRange('18.2.9', '18.2.x'), true);
  assert.equal(satisfiesPeerRange('18.3.0', '18.2.x'), false);
});

test('evaluates alternative peer ranges', () => {
  assert.equal(satisfiesPeerRange('18.2.0', '18.2.0 || 19.0.0'), true);
  assert.equal(satisfiesPeerRange('19.0.0', '18.2.0 || 19.0.0'), true);
  assert.equal(satisfiesPeerRange('20.0.0', '18.2.0 || 19.0.0'), false);
});

test('returns false for malformed version or range', () => {
  assert.equal(satisfiesPeerRange('banana', '^19.0.0'), false);
  assert.equal(satisfiesPeerRange('19.0.0', 'latest'), false);
});

test('collects a resolved required peer edge', () => {
  const document = peerFixture();
  const graph = buildLockGraph(document);
  const edges = collectPeerEdges(document, graph);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], {
    from: 'node_modules/widget',
    name: 'react',
    range: '^19.0.0',
    optional: false,
    target: 'node_modules/react',
    targetVersion: '19.3.0',
  });
});

test('collects optional peer metadata', () => {
  const document = peerFixture({ optional: true, includeReact: false });
  const graph = buildLockGraph(document);
  const [edge] = collectPeerEdges(document, graph);
  assert.equal(edge.optional, true);
  assert.equal(edge.target, null);
});

test('resolves a peer through npm ancestor lookup', () => {
  const document = lock(
    { dependencies: { host: '1.0.0', react: '19.3.0' } },
    {
      'node_modules/host': pkg('host', '1.0.0', { dependencies: { child: '1.0.0' } }),
      'node_modules/host/node_modules/child': pkg('child', '1.0.0', { peerDependencies: { react: '^19.0.0' } }),
      'node_modules/react': pkg('react', '19.3.0'),
    },
  );
  const graph = buildLockGraph(document);
  const edge = collectPeerEdges(document, graph).find((value) => value.name === 'react');
  assert.equal(edge.target, 'node_modules/react');
  assert.equal(edge.targetVersion, '19.3.0');
});

test('validates a compatible required peer', () => {
  const document = peerFixture();
  const edges = collectPeerEdges(document, buildLockGraph(document));
  assert.deepEqual(validatePeerEdges(edges), []);
});

test('reports an unresolved required peer', () => {
  const document = peerFixture({ includeReact: false });
  const issues = validatePeerEdges(collectPeerEdges(document, buildLockGraph(document)));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'peer-unresolved');
});

test('allows an unresolved optional peer', () => {
  const document = peerFixture({ includeReact: false, optional: true });
  assert.deepEqual(validatePeerEdges(collectPeerEdges(document, buildLockGraph(document))), []);
});

test('reports an incompatible peer version', () => {
  const document = peerFixture({ reactVersion: '20.0.0' });
  const issues = validatePeerEdges(collectPeerEdges(document, buildLockGraph(document)));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'peer-mismatch');
  assert.match(issues[0].detail, /20\.0\.0/);
});

test('reports an unreviewable peer range before resolution compatibility', () => {
  const document = peerFixture({ range: '*' });
  const issues = validatePeerEdges(collectPeerEdges(document, buildLockGraph(document)));
  assert.equal(issues[0].code, 'peer-range');
});

test('reports peer targets without concrete versions', () => {
  const document = peerFixture();
  document.packages['node_modules/react'].version = '^19.0.0';
  const issues = validatePeerEdges(collectPeerEdges(document, buildLockGraph(document)));
  assert.equal(issues[0].code, 'peer-version');
});

test('bounds peer cardinality per package', () => {
  const peerDependencies = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`peer-${index}`, '1.0.0']));
  const document = lock({ dependencies: { widget: '1.0.0' } }, { 'node_modules/widget': pkg('widget', '1.0.0', { peerDependencies }) });
  const edges = collectPeerEdges(document, buildLockGraph(document));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].name, '<peer-budget>');
  assert.equal(validatePeerEdges(edges)[0].code, 'peer-cardinality');
});

test('collects reachable install-script packages only', () => {
  const document = lock(
    { dependencies: { native: '1.0.0' } },
    {
      'node_modules/native': pkg('native', '1.0.0', { hasInstallScript: true }),
      'node_modules/orphan': pkg('orphan', '1.0.0', { hasInstallScript: true }),
    },
  );
  const graph = buildLockGraph(document);
  const surface = collectInstallScriptSurface(document, graph);
  assert.equal(surface.length, 1);
  assert.equal(surface[0].name, 'native');
  assert.equal(surface[0].parentCount, 1);
});

test('captures install-script dev and optional flags', () => {
  const document = lock(
    { optionalDependencies: { native: '1.0.0' } },
    { 'node_modules/native': pkg('native', '1.0.0', { hasInstallScript: true, optional: true, dev: true }) },
  );
  const [item] = collectInstallScriptSurface(document, buildLockGraph(document));
  assert.equal(item.optional, true);
  assert.equal(item.dev, true);
});

test('collects reachable deprecated packages only', () => {
  const document = lock(
    { dependencies: { legacy: '1.0.0' } },
    {
      'node_modules/legacy': pkg('legacy', '1.0.0', { deprecated: 'Use modern instead.' }),
      'node_modules/orphan': pkg('orphan', '1.0.0', { deprecated: 'orphan warning' }),
    },
  );
  const surface = collectDeprecatedSurface(document, buildLockGraph(document));
  assert.equal(surface.length, 1);
  assert.equal(surface[0].name, 'legacy');
  assert.equal(surface[0].message, 'Use modern instead.');
});

test('bounds copied deprecation text', () => {
  const document = lock({ dependencies: { legacy: '1.0.0' } }, { 'node_modules/legacy': pkg('legacy', '1.0.0', { deprecated: 'x'.repeat(1000) }) });
  const [item] = collectDeprecatedSurface(document, buildLockGraph(document));
  assert.equal(item.message.length, 240);
});

test('builds a deterministic inventory summary', () => {
  const document = lock(
    { dependencies: { widget: '2.0.0', react: '19.3.0', native: '1.0.0', legacy: '1.0.0' } },
    {
      'node_modules/widget': pkg('widget', '2.0.0', { peerDependencies: { react: '^19.0.0' } }),
      'node_modules/react': pkg('react', '19.3.0'),
      'node_modules/native': pkg('native', '1.0.0', { hasInstallScript: true }),
      'node_modules/legacy': pkg('legacy', '1.0.0', { deprecated: 'retired' }),
    },
  );
  const inventory = buildTransitiveInventory(document);
  assert.deepEqual(inventory.summary, { reachable: 4, peerEdges: 1, requiredPeers: 1, optionalPeers: 0, installScripts: 1, deprecated: 1 });
  assert.match(inventory.fingerprint, /^[a-f0-9]{64}$/);
});

test('inventory fingerprint is independent of package insertion order', () => {
  const left = peerFixture();
  const right = { ...left, packages: { 'node_modules/react': left.packages['node_modules/react'], '': left.packages[''], 'node_modules/widget': left.packages['node_modules/widget'] } };
  assert.equal(buildTransitiveInventory(left).fingerprint, buildTransitiveInventory(right).fingerprint);
});

test('inventory collections are immutable', () => {
  const inventory = buildTransitiveInventory(peerFixture());
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.peerEdges), true);
  assert.throws(() => inventory.peerEdges.push({}), TypeError);
});

test('policy passes a compatible peer-only graph', () => {
  const result = evaluateTransitivePolicy(peerFixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('policy fails closed on required peer mismatch', () => {
  const result = evaluateTransitivePolicy(peerFixture({ reactVersion: '20.0.0' }));
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'peer-mismatch'), true);
});

test('policy enforces install-script cardinality budget', () => {
  const document = lock(
    { dependencies: { a: '1.0.0', b: '1.0.0' } },
    { 'node_modules/a': pkg('a', '1.0.0', { hasInstallScript: true }), 'node_modules/b': pkg('b', '1.0.0', { hasInstallScript: true }) },
  );
  const result = evaluateTransitivePolicy(document, { maxInstallScripts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'install-script-budget'), true);
});

test('policy allows install-script count at the configured boundary', () => {
  const document = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { hasInstallScript: true }) });
  assert.equal(evaluateTransitivePolicy(document, { maxInstallScripts: 1 }).ok, true);
});

test('policy enforces deprecated-package cardinality budget', () => {
  const document = lock(
    { dependencies: { a: '1.0.0', b: '1.0.0' } },
    { 'node_modules/a': pkg('a', '1.0.0', { deprecated: 'old' }), 'node_modules/b': pkg('b', '1.0.0', { deprecated: 'old' }) },
  );
  const result = evaluateTransitivePolicy(document, { maxDeprecated: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'deprecated-budget'), true);
});

test('policy surfaces invalid install-script package versions', () => {
  const document = lock({ dependencies: { native: '1.0.0' } }, { 'node_modules/native': pkg('native', '1.0.0', { version: 'latest', hasInstallScript: true }) });
  const result = evaluateTransitivePolicy(document);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'install-script-budget-version'), true);
});

test('policy surfaces invalid deprecated package versions', () => {
  const document = lock({ dependencies: { legacy: '1.0.0' } }, { 'node_modules/legacy': pkg('legacy', '1.0.0', { version: '', deprecated: 'old' }) });
  const result = evaluateTransitivePolicy(document);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'deprecated-budget-version'), true);
});

test('policy preserves deterministic issue ordering', () => {
  const document = lock(
    { dependencies: { widget: '2.0.0', react: '20.0.0', native: '1.0.0' } },
    {
      'node_modules/widget': pkg('widget', '2.0.0', { peerDependencies: { react: '^19.0.0' } }),
      'node_modules/react': pkg('react', '20.0.0'),
      'node_modules/native': pkg('native', '1.0.0', { version: 'latest', hasInstallScript: true }),
    },
  );
  const result = evaluateTransitivePolicy(document);
  const sorted = [...result.issues].sort((a, b) => `${a.code}\0${a.path}\0${a.detail}`.localeCompare(`${b.code}\0${b.path}\0${b.detail}`));
  assert.deepEqual(result.issues, sorted);
});

test('diff reports newly introduced install-script packages', () => {
  const baseline = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0') }));
  const candidate = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { hasInstallScript: true }) }));
  const delta = diffTransitiveInventory(baseline, candidate);
  assert.deepEqual(delta.installScripts.added, ['node_modules/a@1.0.0']);
  assert.deepEqual(delta.installScripts.removed, []);
});

test('diff reports removed install-script packages', () => {
  const baseline = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { hasInstallScript: true }) }));
  const candidate = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0') }));
  const delta = diffTransitiveInventory(baseline, candidate);
  assert.deepEqual(delta.installScripts.added, []);
  assert.deepEqual(delta.installScripts.removed, ['node_modules/a@1.0.0']);
});

test('diff reports newly deprecated packages', () => {
  const baseline = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0') }));
  const candidate = buildTransitiveInventory(lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { deprecated: 'old' }) }));
  assert.deepEqual(diffTransitiveInventory(baseline, candidate).deprecated.added, ['node_modules/a@1.0.0']);
});

test('diff reports changed peer contracts as remove plus add', () => {
  const baseline = buildTransitiveInventory(peerFixture({ range: '^19.0.0' }));
  const candidate = buildTransitiveInventory(peerFixture({ range: '>=19.0.0 <20.0.0' }));
  const delta = diffTransitiveInventory(baseline, candidate);
  assert.equal(delta.peers.added.length, 1);
  assert.equal(delta.peers.removed.length, 1);
  assert.match(delta.peers.added[0], />=19\.0\.0/);
});

test('diff output is immutable', () => {
  const inventory = buildTransitiveInventory(peerFixture());
  const delta = diffTransitiveInventory(inventory, inventory);
  assert.equal(Object.isFrozen(delta), true);
  assert.equal(Object.isFrozen(delta.peers.added), true);
  assert.throws(() => delta.peers.added.push('x'), TypeError);
});

test('dev roots can be excluded from transitive inventory', () => {
  const document = lock(
    { devDependencies: { tool: '1.0.0' } },
    { 'node_modules/tool': pkg('tool', '1.0.0', { dev: true, hasInstallScript: true }) },
  );
  const included = buildTransitiveInventory(document);
  const excluded = buildTransitiveInventory(document, { includeDev: false });
  assert.equal(included.summary.installScripts, 1);
  assert.equal(excluded.summary.installScripts, 0);
});

test('malformed lock graph fails policy closed', () => {
  const result = evaluateTransitivePolicy({ lockfileVersion: 2, packages: {} });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((finding) => finding.code === 'lock-graph'), true);
});

test('scoped peer names are accepted', () => {
  const document = lock(
    { dependencies: { widget: '1.0.0', '@scope/runtime': '2.0.0' } },
    {
      'node_modules/widget': pkg('widget', '1.0.0', { peerDependencies: { '@scope/runtime': '^2.0.0' } }),
      'node_modules/@scope/runtime': pkg('@scope/runtime', '2.0.0'),
    },
  );
  assert.equal(evaluateTransitivePolicy(document).ok, true);
});

test('peer edge objects are immutable', () => {
  const document = peerFixture();
  const [edge] = collectPeerEdges(document, buildLockGraph(document));
  assert.equal(Object.isFrozen(edge), true);
  assert.throws(() => { edge.name = 'mutated'; }, TypeError);
});

test('surface objects are immutable', () => {
  const document = lock({ dependencies: { native: '1.0.0' } }, { 'node_modules/native': pkg('native', '1.0.0', { hasInstallScript: true }) });
  const [item] = collectInstallScriptSurface(document, buildLockGraph(document));
  assert.equal(Object.isFrozen(item), true);
  assert.throws(() => { item.version = '2.0.0'; }, TypeError);
});

test('policy does not retain arbitrary package payload fields', () => {
  const secretMarker = 'credential-like-fixture-value';
  const document = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { arbitraryPayload: { token: secretMarker } }) });
  const result = evaluateTransitivePolicy(document);
  assert.equal(JSON.stringify({ issues: result.issues, summary: result.inventory.summary, fingerprint: result.inventory.fingerprint }).includes(secretMarker), false);
});

test('fingerprint changes when peer topology changes', () => {
  const left = buildTransitiveInventory(peerFixture({ range: '^19.0.0' }));
  const right = buildTransitiveInventory(peerFixture({ range: '>=19.0.0 <20.0.0' }));
  assert.notEqual(left.fingerprint, right.fingerprint);
});

test('fingerprint changes when lifecycle surface changes', () => {
  const plain = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0') });
  const scripted = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { hasInstallScript: true }) });
  assert.notEqual(buildTransitiveInventory(plain).fingerprint, buildTransitiveInventory(scripted).fingerprint);
});

test('fingerprint changes when deprecation surface changes', () => {
  const plain = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0') });
  const deprecated = lock({ dependencies: { a: '1.0.0' } }, { 'node_modules/a': pkg('a', '1.0.0', { deprecated: 'retired' }) });
  assert.notEqual(buildTransitiveInventory(plain).fingerprint, buildTransitiveInventory(deprecated).fingerprint);
});

test('optional and required peer counts are separated', () => {
  const document = lock(
    { dependencies: { widget: '1.0.0', react: '19.0.0' } },
    {
      'node_modules/widget': pkg('widget', '1.0.0', {
        peerDependencies: { react: '^19.0.0', optionalHost: '^1.0.0' },
        peerDependenciesMeta: { optionalHost: { optional: true } },
      }),
      'node_modules/react': pkg('react', '19.0.0'),
    },
  );
  const summary = buildTransitiveInventory(document).summary;
  assert.equal(summary.requiredPeers, 1);
  assert.equal(summary.optionalPeers, 1);
});

test('policy issue records are immutable', () => {
  const result = evaluateTransitivePolicy(peerFixture({ reactVersion: '20.0.0' }));
  assert.equal(Object.isFrozen(result.issues), true);
  assert.equal(Object.isFrozen(result.issues[0]), true);
  assert.throws(() => result.issues.push({}), TypeError);
});

test('evaluates partial comparator boundaries without widening > or <=', () => {
  const cases = [
    ['18.3.0', '>=18.2', true], ['18.2.9', '>18.2', false],
    ['18.3.0', '>18.2', true], ['18.2.9', '<=18.2', true],
    ['18.3.0', '<=18.2', false], ['18.2.9', '<18.3', true],
    ['18.3.0', '<18.3', false], ['18.2.9', '18.2', true],
    ['18.3.0', '18.2', false],
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesPeerRange(version, range), expected, version + ' ' + range);
  }
});

test('evaluates partial caret, tilde and zero-major boundaries', () => {
  const cases = [
    ['1.3.0', '^1.2', true], ['2.0.0', '^1.2', false],
    ['0.0.9', '^0.0', true], ['0.1.0', '^0.0', false],
    ['0.0.4', '^0.0.4', true], ['0.0.5', '^0.0.4', false],
    ['18.2.9', '~18.2', true], ['18.3.0', '~18.2', false],
    ['18.9.9', '~18', true], ['19.0.0', '~18', false],
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesPeerRange(version, range), expected, version + ' ' + range);
  }
});

test('excludes prerelease candidates unless a comparator names the same tuple', () => {
  assert.equal(satisfiesPeerRange('1.2.3-beta.1', '>=1.2.3'), false);
  assert.equal(satisfiesPeerRange('1.2.3-rc.1', '>=1.2.2'), false);
  assert.equal(satisfiesPeerRange('1.2.3-rc.2', '^1.2.3-rc.1'), true);
  assert.equal(satisfiesPeerRange('1.2.3', '^1.2.3-rc.1'), true);
  assert.equal(satisfiesPeerRange('1.3.0-rc.1', '^1.2.3-rc.1'), false);
  assert.equal(satisfiesPeerRange('1.2.3-rc.2', '>=1.2.3 || ^1.2.3-rc.1'), true);
});

test('rejects empty OR branches, trailing garbage and invalid concrete versions', () => {
  for (const range of ['1.0.0 ||', '|| 1.0.0', '1.0.0 || || 2.0.0', '1.0.0junk', '1.0.0.4', '1.x.2', '>=01.0']) {
    assert.equal(isReviewablePeerRange(range), false, range);
    assert.equal(satisfiesPeerRange('1.0.0', range), false, range);
  }
  for (const version of ['1.2.3suffix', '1.2.3.4', '01.2.3', '1.2.3-rc.01', '1.2.3-', '1.2.3+']) {
    assert.equal(isConcreteVersion(version), false, version);
    assert.equal(satisfiesPeerRange(version, '>=1.0.0'), false, version);
  }
  assert.equal(isConcreteVersion('1.2.3-rc.2+build.7'), true);
});

test('reports missing required peers independently of invalid ranges', () => {
  for (const range of ['*', '1.0.0 ||']) {
    const missing = { from: 'node_modules/widget', name: 'react', range, optional: false, target: null, targetVersion: null };
    assert.deepEqual(validatePeerEdges([missing]).map(({ code }) => code), ['peer-range', 'peer-unresolved']);
    assert.deepEqual(validatePeerEdges([{ ...missing, optional: true }]).map(({ code }) => code), ['peer-range']);
  }
});

test('reports invalid ranges and invalid resolved versions independently', () => {
  const issues = validatePeerEdges([{
    from: 'node_modules/widget', name: 'react', range: '1.0.0 ||',
    optional: false, target: 'node_modules/react', targetVersion: '1.0.0oops',
  }]);
  assert.deepEqual(issues.map(({ code }) => code), ['peer-range', 'peer-version']);
});
