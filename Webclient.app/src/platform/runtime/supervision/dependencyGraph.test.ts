import { describe, expect, test } from 'vitest';
import {
  DependencyCycleError,
  DuplicateComponentError,
  MissingDependencyError,
} from './contracts';
import {
  DependencyGraphRegistry,
  compileDependencyGraph,
  normalizeComponentDescriptor,
} from './dependencyGraph';

describe('dependency graph normalization', () => {
  test('normalizes identity, ordering hints, tags and defaults', () => {
    const descriptor = normalizeComponentDescriptor({
      id: '  map-shell  ',
      dependencies: [
        { id: 'bootstrap', kind: 'after' },
        { id: 'bootstrap', kind: 'required' },
        { id: 'optional-cache', kind: 'optional' },
      ],
      tags: [' GIS ', 'gis', 'Critical_Path'],
      description: '  shared map shell  ',
    });

    expect(descriptor).toEqual({
      id: 'map-shell',
      phase: 'feature',
      criticality: 'important',
      dependencies: [
        { id: 'bootstrap', kind: 'required' },
        { id: 'optional-cache', kind: 'optional' },
      ],
      tags: ['critical_path', 'gis'],
      description: 'shared map shell',
    });
  });

  test('required dependency wins when duplicate hints disagree', () => {
    const descriptor = normalizeComponentDescriptor({
      id: 'search',
      dependencies: [
        { id: 'http', kind: 'after' },
        { id: 'http', kind: 'optional' },
        { id: 'http', kind: 'required' },
      ],
    });
    expect(descriptor.dependencies).toEqual([{ id: 'http', kind: 'required' }]);
  });

  test('rejects self dependencies as an immediate cycle', () => {
    expect(() => normalizeComponentDescriptor({
      id: 'self',
      dependencies: [{ id: 'self' }],
    })).toThrow(DependencyCycleError);
  });

  test('rejects invalid empty identifiers before graph mutation', () => {
    expect(() => normalizeComponentDescriptor({ id: '   ' })).toThrow(TypeError);
  });
});

describe('dependency graph compilation', () => {
  const descriptors = [
    { id: 'config', phase: 'bootstrap' as const, criticality: 'critical' as const },
    {
      id: 'http',
      phase: 'core' as const,
      criticality: 'critical' as const,
      dependencies: [{ id: 'config' }],
    },
    {
      id: 'cache',
      phase: 'core' as const,
      dependencies: [{ id: 'config' }],
    },
    {
      id: 'map',
      phase: 'feature' as const,
      dependencies: [{ id: 'http' }, { id: 'cache', kind: 'optional' as const }],
    },
    {
      id: 'search',
      phase: 'feature' as const,
      dependencies: [{ id: 'http' }, { id: 'cache', kind: 'after' as const }],
    },
    {
      id: 'telemetry',
      phase: 'background' as const,
      criticality: 'optional' as const,
      dependencies: [{ id: 'config' }],
    },
  ];

  test('creates deterministic topological startup and reverse shutdown plans', () => {
    const graph = compileDependencyGraph(descriptors);

    expect(graph.levels).toEqual([
      ['config'],
      ['http', 'cache', 'telemetry'],
      ['map', 'search'],
    ]);
    expect(graph.startupOrder).toEqual(['config', 'http', 'cache', 'telemetry', 'map', 'search']);
    expect(graph.shutdownOrder).toEqual(['search', 'map', 'telemetry', 'cache', 'http', 'config']);
  });

  test('keeps required dependency semantics separate from ordering semantics', () => {
    const graph = compileDependencyGraph(descriptors);
    expect(graph.requiredDependencies.map).toEqual(['http']);
    expect(graph.requiredDependencies.search).toEqual(['http']);
    expect(graph.allDependencies.map).toEqual(['cache', 'http']);
    expect(graph.allDependencies.search).toEqual(['cache', 'http']);
  });

  test('derives reverse dependents and transitive closure', () => {
    const graph = compileDependencyGraph(descriptors);
    expect(graph.dependents.config).toEqual(['cache', 'http', 'telemetry']);
    expect(graph.dependents.http).toEqual(['map', 'search']);
    expect(graph.transitiveDependencies.map).toEqual(['cache', 'config', 'http']);
    expect(graph.transitiveDependencies.telemetry).toEqual(['config']);
  });

  test('reports a stable critical path', () => {
    const graph = compileDependencyGraph(descriptors);
    expect(graph.criticalPath).toEqual(['config', 'cache', 'map']);
  });

  test('allows missing optional and after dependencies by default', () => {
    const graph = compileDependencyGraph([
      { id: 'config' },
      {
        id: 'feature',
        dependencies: [
          { id: 'optional-provider', kind: 'optional' },
          { id: 'late-observer', kind: 'after' },
          { id: 'config' },
        ],
      },
    ]);
    expect(graph.allDependencies.feature).toEqual(['config']);
  });

  test('can make missing optional dependencies strict for audits', () => {
    expect(() => compileDependencyGraph([
      { id: 'feature', dependencies: [{ id: 'missing', kind: 'optional' }] },
    ], { allowMissingOptional: false })).toThrow(MissingDependencyError);
  });

  test('can make missing ordering dependencies strict for audits', () => {
    expect(() => compileDependencyGraph([
      { id: 'feature', dependencies: [{ id: 'missing', kind: 'after' }] },
    ], { allowMissingAfter: false })).toThrow(MissingDependencyError);
  });

  test('always rejects missing required dependencies', () => {
    expect(() => compileDependencyGraph([
      { id: 'feature', dependencies: [{ id: 'missing' }] },
    ])).toThrow(MissingDependencyError);
  });

  test('rejects duplicate components', () => {
    expect(() => compileDependencyGraph([{ id: 'http' }, { id: 'http' }])).toThrow(DuplicateComponentError);
  });

  test('detects multi-node cycles with useful path data', () => {
    try {
      compileDependencyGraph([
        { id: 'a', dependencies: [{ id: 'c' }] },
        { id: 'b', dependencies: [{ id: 'a' }] },
        { id: 'c', dependencies: [{ id: 'b' }] },
      ]);
      throw new Error('expected compile to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).cycle[0]).toBe((error as DependencyCycleError).cycle.at(-1));
      expect((error as DependencyCycleError).cycle).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    }
  });

  test('is deterministic regardless of registration order', () => {
    const first = compileDependencyGraph(descriptors);
    const second = compileDependencyGraph([...descriptors].reverse());
    expect(second.startupOrder).toEqual(first.startupOrder);
    expect(second.levels).toEqual(first.levels);
    expect(second.criticalPath).toEqual(first.criticalPath);
  });
});

describe('dependency graph registry', () => {
  test('tracks revisions only for graph mutations', () => {
    const registry = new DependencyGraphRegistry();
    expect(registry.revision).toBe(0);
    registry.register({ id: 'config' });
    expect(registry.revision).toBe(1);
    registry.compile();
    registry.compile();
    expect(registry.revision).toBe(1);
    registry.upsert({ id: 'config', phase: 'bootstrap' });
    expect(registry.revision).toBe(2);
  });

  test('caches the ordinary permissive compile result', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    const first = registry.compile();
    const second = registry.compile();
    expect(second).toBe(first);
  });

  test('does not reuse permissive cache for strict audit compile', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({
      id: 'feature',
      dependencies: [{ id: 'optional-provider', kind: 'optional' }],
    });
    expect(registry.compile().startupOrder).toEqual(['feature']);
    expect(() => registry.compile({ allowMissingOptional: false })).toThrow(MissingDependencyError);
  });

  test('lists descriptors in phase and criticality order', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'feature-b', phase: 'feature', criticality: 'optional' });
    registry.register({ id: 'feature-a', phase: 'feature', criticality: 'critical' });
    registry.register({ id: 'bootstrap', phase: 'bootstrap', criticality: 'important' });
    expect(registry.list().map((entry) => entry.id)).toEqual(['bootstrap', 'feature-a', 'feature-b']);
  });

  test('finds direct and transitive dependents', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    registry.register({ id: 'http', dependencies: [{ id: 'config' }] });
    registry.register({ id: 'search', dependencies: [{ id: 'http' }] });
    registry.register({ id: 'map', dependencies: [{ id: 'http' }] });

    expect(registry.dependentsOf('config')).toEqual(['http']);
    expect(registry.dependentsOf('config', true)).toEqual(['http', 'map', 'search']);
  });

  test('reports components that require a dependency', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    registry.register({ id: 'http', dependencies: [{ id: 'config' }] });
    registry.register({ id: 'cache', dependencies: [{ id: 'config', kind: 'optional' }] });
    expect(registry.requiredBy('config')).toEqual(['http']);
  });

  test('invalid get and has operations are safe for caller-supplied ids', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    expect(registry.get('   ')).toBeNull();
    expect(registry.has('   ')).toBe(false);
  });

  test('remove invalidates cached compile and updates size', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    registry.register({ id: 'feature', dependencies: [{ id: 'config' }] });
    registry.compile();
    expect(registry.remove('feature')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.compile().startupOrder).toEqual(['config']);
  });

  test('clear is idempotent and produces an empty graph', () => {
    const registry = new DependencyGraphRegistry();
    registry.register({ id: 'config' });
    registry.clear();
    const revision = registry.revision;
    registry.clear();
    expect(registry.revision).toBe(revision);
    expect(registry.compile().startupOrder).toEqual([]);
  });
});
