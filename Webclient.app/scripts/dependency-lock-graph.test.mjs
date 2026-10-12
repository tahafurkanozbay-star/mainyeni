import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeLockGraph,
  buildLockGraph,
  dependencySearchBases,
  packageNameFromLockPath,
  resolveDependencyPath,
  summarizeLockGraph,
  traceDependencyPath,
  validateReachableProvenance,
} from './dependency-lock-graph.mjs';

const pkg = (version = '1.0.0', extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
  integrity: 'sha512-example',
  ...extra,
});

const lock = (rootSections = {}, packages = {}) => ({
  name: 'webclient',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'webclient', version: '1.0.0', ...rootSections },
    ...packages,
  },
});

describe('lock path resolution', () => {
  const names = [
    ['', null],
    ['node_modules/react', 'react'],
    ['node_modules/@scope/pkg', '@scope/pkg'],
    ['node_modules/a/node_modules/b', 'b'],
    ['node_modules/a/node_modules/@scope/pkg', '@scope/pkg'],
    ['vendor/a', null],
  ];
  for (const [path, expected] of names) {
    test(`extracts package name from ${path || '<root>'}`, () => {
      assert.equal(packageNameFromLockPath(path), expected);
    });
  }

  test('builds Node-style search bases from a top-level package', () => {
    assert.deepEqual(dependencySearchBases('node_modules/a'), ['node_modules/a', '']);
  });

  test('builds Node-style search bases from a nested package', () => {
    assert.deepEqual(dependencySearchBases('node_modules/a/node_modules/b'), [
      'node_modules/a/node_modules/b',
      'node_modules/a',
      '',
    ]);
  });

  test('resolves nearest nested dependency first', () => {
    const packages = {
      'node_modules/c': pkg(),
      'node_modules/a/node_modules/c': pkg(),
    };
    assert.equal(resolveDependencyPath(packages, 'node_modules/a', 'c'), 'node_modules/a/node_modules/c');
  });

  test('falls back to hoisted dependency', () => {
    const packages = { 'node_modules/c': pkg() };
    assert.equal(resolveDependencyPath(packages, 'node_modules/a/node_modules/b', 'c'), 'node_modules/c');
  });

  test('resolves scoped dependencies', () => {
    const packages = { 'node_modules/@scope/c': pkg() };
    assert.equal(resolveDependencyPath(packages, 'node_modules/a', '@scope/c'), 'node_modules/@scope/c');
  });

  test('returns null for missing dependency', () => {
    assert.equal(resolveDependencyPath({}, 'node_modules/a', 'missing'), null);
  });
});

describe('lock graph traversal', () => {
  test('walks runtime, development and optional roots deterministically', () => {
    const document = lock({
      dependencies: { app: '^1.0.0' },
      devDependencies: { testkit: '^1.0.0' },
      optionalDependencies: { native: '^1.0.0' },
    }, {
      'node_modules/app': pkg('1.0.0', { dependencies: { shared: '^1.0.0' } }),
      'node_modules/testkit': pkg(),
      'node_modules/native': pkg('1.0.0', { optional: true }),
      'node_modules/shared': pkg(),
    });
    const graph = buildLockGraph(document);
    assert.equal(graph.ok, true, graph.errors.join('\n'));
    assert.deepEqual(graph.reachable, [
      'node_modules/app',
      'node_modules/native',
      'node_modules/shared',
      'node_modules/testkit',
    ]);
    assert.deepEqual(graph.orphans, []);
  });

  test('can exclude development roots without treating required runtime edges as optional', () => {
    const document = lock({
      dependencies: { app: '^1.0.0' },
      devDependencies: { testkit: '^1.0.0' },
    }, {
      'node_modules/app': pkg(),
      'node_modules/testkit': pkg(),
    });
    const graph = buildLockGraph(document, { includeDev: false });
    assert.deepEqual(graph.reachable, ['node_modules/app']);
    assert.deepEqual(graph.orphans, ['node_modules/testkit']);
  });

  test('tracks nested and hoisted dependencies in one graph', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { dependencies: { local: '^1.0.0', shared: '^1.0.0' } }),
      'node_modules/app/node_modules/local': pkg(),
      'node_modules/shared': pkg(),
    });
    const graph = buildLockGraph(document);
    assert.deepEqual(graph.reachable, [
      'node_modules/app',
      'node_modules/app/node_modules/local',
      'node_modules/shared',
    ]);
  });

  test('reports unresolved required edges as errors', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { dependencies: { missing: '^1.0.0' } }),
    });
    const graph = buildLockGraph(document);
    assert.equal(graph.ok, false);
    assert.match(graph.errors.join('\n'), /unresolved dependency missing from node_modules\/app/);
    assert.equal(graph.unresolved[0].required, true);
  });

  test('reports unresolved optional edges without failing the graph', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { optionalDependencies: { native: '^1.0.0' } }),
    });
    const graph = buildLockGraph(document);
    assert.equal(graph.ok, true, graph.errors.join('\n'));
    assert.equal(graph.unresolved.length, 1);
    assert.equal(graph.unresolved[0].required, false);
  });

  test('detects orphan lock entries', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg(),
      'node_modules/orphan': pkg(),
    });
    const graph = buildLockGraph(document);
    assert.deepEqual(graph.orphans, ['node_modules/orphan']);
  });

  test('handles cycles without revisiting nodes forever', () => {
    const document = lock({ dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': pkg('1.0.0', { dependencies: { b: '^1.0.0' } }),
      'node_modules/b': pkg('1.0.0', { dependencies: { a: '^1.0.0' } }),
    });
    const graph = buildLockGraph(document);
    assert.equal(graph.ok, true, graph.errors.join('\n'));
    assert.deepEqual(graph.reachable, ['node_modules/a', 'node_modules/b']);
  });

  test('records all parent explanations for shared packages', () => {
    const document = lock({ dependencies: { a: '^1.0.0', b: '^1.0.0' } }, {
      'node_modules/a': pkg('1.0.0', { dependencies: { shared: '^1.0.0' } }),
      'node_modules/b': pkg('1.0.0', { dependencies: { shared: '^1.0.0' } }),
      'node_modules/shared': pkg(),
    });
    const graph = buildLockGraph(document);
    assert.equal(graph.parents['node_modules/shared'].length, 2);
    assert.deepEqual(graph.parents['node_modules/shared'].map((item) => item.from), [
      'node_modules/a',
      'node_modules/b',
    ]);
  });
});

describe('dependency trace', () => {
  test('returns a root-to-target explanation', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { dependencies: { helper: '^1.0.0' } }),
      'node_modules/helper': pkg('1.0.0', { dependencies: { leaf: '^1.0.0' } }),
      'node_modules/leaf': pkg(),
    });
    const graph = buildLockGraph(document);
    const trace = traceDependencyPath(graph, 'node_modules/leaf');
    assert.deepEqual(trace.map((item) => item.path), [
      'node_modules/app',
      'node_modules/helper',
      'node_modules/leaf',
    ]);
    assert.equal(trace.at(-1).via.name, 'leaf');
  });

  test('returns empty trace for unknown target', () => {
    assert.deepEqual(traceDependencyPath(buildLockGraph(lock()), 'node_modules/missing'), []);
  });

  test('honors a bounded maximum trace depth', () => {
    const document = lock({ dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': pkg('1.0.0', { dependencies: { b: '^1.0.0' } }),
      'node_modules/b': pkg('1.0.0', { dependencies: { c: '^1.0.0' } }),
      'node_modules/c': pkg(),
    });
    const graph = buildLockGraph(document);
    assert.equal(traceDependencyPath(graph, 'node_modules/c', { maxDepth: 2 }).length, 2);
  });
});

describe('reachable provenance', () => {
  test('accepts npm registry sha512 provenance', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, { 'node_modules/app': pkg() });
    const graph = buildLockGraph(document);
    assert.deepEqual(validateReachableProvenance(document, graph), []);
  });

  test('rejects missing version, resolved and integrity', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': { dependencies: {} },
    });
    const graph = buildLockGraph(document);
    const errors = validateReachableProvenance(document, graph).join('\n');
    assert.match(errors, /no concrete version/);
    assert.match(errors, /invalid or missing resolved URL/);
    assert.match(errors, /invalid or missing integrity/);
  });

  test('rejects an unapproved registry host', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { resolved: 'https://packages.example.test/app.tgz' }),
    });
    const graph = buildLockGraph(document);
    assert.match(validateReachableProvenance(document, graph).join('\n'), /unapproved host packages\.example\.test/);
  });

  test('rejects weak or unexpected integrity algorithms', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', { integrity: 'sha1-example' }),
    });
    const graph = buildLockGraph(document);
    assert.match(validateReachableProvenance(document, graph).join('\n'), /unapproved integrity algorithm sha1/);
  });

  test('allows link entries without registry provenance', () => {
    const document = lock({ dependencies: { workspace: '^1.0.0' } }, {
      'node_modules/workspace': { link: true, resolved: 'packages/workspace' },
    });
    const graph = buildLockGraph(document);
    assert.deepEqual(validateReachableProvenance(document, graph), []);
  });

  test('can explicitly allow another registry host and integrity algorithm', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', {
        resolved: 'https://packages.example.test/app.tgz',
        integrity: 'sha384-example',
      }),
    });
    const graph = buildLockGraph(document);
    assert.deepEqual(validateReachableProvenance(document, graph, {
      allowedRegistryHosts: ['packages.example.test'],
      allowedIntegrityAlgorithms: ['sha384'],
    }), []);
  });
});

describe('graph summary and end-to-end analysis', () => {
  test('summarizes reachable risk metadata without counting orphans', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', {
        deprecated: 'legacy',
        hasInstallScript: true,
        dependencies: { optional: '^1.0.0' },
      }),
      'node_modules/optional': pkg('1.0.0', { optional: true }),
      'node_modules/orphan': pkg('1.0.0', { deprecated: 'ignore orphan' }),
    });
    const graph = buildLockGraph(document);
    assert.deepEqual(summarizeLockGraph(document, graph), {
      rootCount: 1,
      nodeCount: 3,
      reachableCount: 2,
      orphanCount: 1,
      unresolvedCount: 0,
      deprecatedReachableCount: 1,
      installScriptReachableCount: 1,
      optionalReachableCount: 1,
      developmentReachableCount: 0,
    });
  });

  test('returns a coherent end-to-end result', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, { 'node_modules/app': pkg() });
    const result = analyzeLockGraph(document);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.summary.reachableCount, 1);
  });

  test('propagates graph and provenance failures together', () => {
    const document = lock({ dependencies: { app: '^1.0.0' } }, {
      'node_modules/app': pkg('1.0.0', {
        dependencies: { missing: '^1.0.0' },
        resolved: 'https://evil.example/app.tgz',
      }),
    });
    const result = analyzeLockGraph(document);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /unresolved dependency missing/);
  });

  test('rejects unsupported lockfile versions', () => {
    const result = analyzeLockGraph({ lockfileVersion: 2, packages: { '': {} } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /expected lockfileVersion 3/);
  });

  test('rejects missing package maps', () => {
    const result = analyzeLockGraph({ lockfileVersion: 3 });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /packages map is required/);
  });
});
