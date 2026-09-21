import { describe, expect, test } from 'vitest';
import {
  analyzeServiceGraph,
  createServiceGraph,
  normalizeServiceDescriptor,
  ServiceGraphError,
  type ServiceDescriptor,
} from './serviceGraph';

const service = (
  id: string,
  overrides: Partial<ServiceDescriptor> = {},
): ServiceDescriptor => ({
  id,
  version: '1.0.0',
  domain: 'platform',
  ...overrides,
});

describe('normalizeServiceDescriptor', () => {
  test('normalizes service identity and defaults', () => {
    expect(normalizeServiceDescriptor({
      id: ' Platform.Config ',
      version: '1.2.3',
      domain: ' Platform ',
    })).toEqual({
      id: 'platform.config',
      version: '1.2.3',
      domain: 'platform',
      criticality: 'required',
      startup: 'eager',
      dependsOn: [],
      optionalDependencies: [],
      provides: [],
      consumes: [],
    });
  });

  test('preserves supported prerelease versions', () => {
    expect(normalizeServiceDescriptor(service('runtime', {
      version: '2.0.0-rc.1+build.7',
    })).version).toBe('2.0.0-rc.1+build.7');
  });

  test.each([
    '',
    '1starts-with-number',
    '../escape',
    'contains space',
    'UPPER_CASE!',
    'a'.repeat(81),
  ])('rejects invalid service id %s', (id) => {
    expect(() => normalizeServiceDescriptor(service(id)))
      .toThrow(ServiceGraphError);
  });

  test.each([
    '',
    'version with space',
    '/unsafe',
    'x'.repeat(65),
  ])('rejects invalid version %s', (version) => {
    expect(() => normalizeServiceDescriptor(service('runtime', { version })))
      .toThrow(expect.objectContaining({ code: 'INVALID_DESCRIPTOR' }));
  });

  test('rejects version boundary whitespace fail-closed', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      version: ' 1.2.3 ',
    }))).toThrow(expect.objectContaining({ code: 'INVALID_DESCRIPTOR' }));
  });

  test('rejects invalid domain', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      domain: 'Platform Runtime',
    }))).toThrow(ServiceGraphError);
  });

  test('deduplicates and sorts required dependencies', () => {
    expect(normalizeServiceDescriptor(service('shell', {
      dependsOn: ['zeta', 'alpha', 'zeta'],
    })).dependsOn).toEqual(['alpha', 'zeta']);
  });

  test('removes optional dependency when it is already required', () => {
    const descriptor = normalizeServiceDescriptor(service('shell', {
      dependsOn: ['config'],
      optionalDependencies: ['telemetry', 'config'],
    }));
    expect(descriptor.dependsOn).toEqual(['config']);
    expect(descriptor.optionalDependencies).toEqual(['telemetry']);
  });

  test('rejects required self dependency', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      dependsOn: ['runtime'],
    }))).toThrow(/cannot depend on itself/i);
  });

  test('rejects optional self dependency', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      optionalDependencies: ['runtime'],
    }))).toThrow(/cannot depend on itself/i);
  });

  test('normalizes capability lists', () => {
    const descriptor = normalizeServiceDescriptor(service('network', {
      provides: [' Governed-HTTP ', 'endpoint-policy', 'governed-http'],
      consumes: [' Runtime-Config '],
    }));
    expect(descriptor.provides).toEqual(['endpoint-policy', 'governed-http']);
    expect(descriptor.consumes).toEqual(['runtime-config']);
  });

  test('supports optional and lazy service modes', () => {
    expect(normalizeServiceDescriptor(service('telemetry', {
      criticality: 'optional',
      startup: 'lazy',
    }))).toMatchObject({
      criticality: 'optional',
      startup: 'lazy',
    });
  });

  test('freezes normalized descriptors and relation arrays', () => {
    const descriptor = normalizeServiceDescriptor(service('runtime', {
      dependsOn: ['config'],
      provides: ['runtime'],
    }));
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.dependsOn)).toBe(true);
    expect(Object.isFrozen(descriptor.provides)).toBe(true);
  });

  test('enforces per-service dependency capacity', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      dependsOn: ['one', 'two', 'three'],
    }), {
      maxRelationsPerService: 2,
      maxCapabilitiesPerService: 8,
    })).toThrow(/capacity/i);
  });

  test('enforces per-service capability capacity', () => {
    expect(() => normalizeServiceDescriptor(service('runtime', {
      provides: ['one', 'two', 'three'],
    }), {
      maxRelationsPerService: 8,
      maxCapabilitiesPerService: 2,
    })).toThrow(/capacity/i);
  });
});

describe('analyzeServiceGraph valid graphs', () => {
  test('returns an empty graph as valid', () => {
    const snapshot = analyzeServiceGraph([]);
    expect(snapshot).toMatchObject({
      valid: true,
      serviceCount: 0,
      relationCount: 0,
      startupOrder: [],
      shutdownOrder: [],
      layers: [],
      capabilities: {},
      dependents: {},
    });
  });

  test('orders a linear dependency chain', () => {
    const snapshot = analyzeServiceGraph([
      service('experience', { dependsOn: ['gis'] }),
      service('config'),
      service('gis', { dependsOn: ['network'] }),
      service('network', { dependsOn: ['config'] }),
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.startupOrder).toEqual([
      'config',
      'network',
      'gis',
      'experience',
    ]);
    expect(snapshot.shutdownOrder).toEqual([
      'experience',
      'gis',
      'network',
      'config',
    ]);
  });

  test('builds deterministic topological layers', () => {
    const snapshot = analyzeServiceGraph([
      service('shell', { dependsOn: ['gis', 'search'] }),
      service('search', { dependsOn: ['network'] }),
      service('gis', { dependsOn: ['network'] }),
      service('network', { dependsOn: ['config'] }),
      service('config'),
    ]);
    expect(snapshot.layers).toEqual([
      { index: 0, services: ['config'] },
      { index: 1, services: ['network'] },
      { index: 2, services: ['gis', 'search'] },
      { index: 3, services: ['shell'] },
    ]);
  });

  test('sorts independent services deterministically', () => {
    const snapshot = analyzeServiceGraph([
      service('zeta'),
      service('alpha'),
      service('middle'),
    ]);
    expect(snapshot.startupOrder).toEqual(['alpha', 'middle', 'zeta']);
    expect(snapshot.layers[0]?.services).toEqual(['alpha', 'middle', 'zeta']);
  });

  test('optional dependency does not alter required startup order', () => {
    const snapshot = analyzeServiceGraph([
      service('shell', { optionalDependencies: ['telemetry'] }),
      service('telemetry', { startup: 'lazy', criticality: 'optional' }),
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.startupOrder).toEqual(['shell', 'telemetry']);
  });

  test('missing optional dependency remains valid', () => {
    const snapshot = analyzeServiceGraph([
      service('shell', { optionalDependencies: ['missing-telemetry'] }),
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.issues).toEqual([]);
  });

  test('builds capability providers', () => {
    const snapshot = analyzeServiceGraph([
      service('network-primary', { provides: ['governed-http'] }),
      service('network-secondary', { provides: ['governed-http'] }),
      service('shell', { consumes: ['governed-http'] }),
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.capabilities).toEqual({
      'governed-http': ['network-primary', 'network-secondary'],
    });
  });

  test('builds required dependent index', () => {
    const snapshot = analyzeServiceGraph([
      service('config'),
      service('network', { dependsOn: ['config'] }),
      service('search', { dependsOn: ['network'] }),
      service('gis', { dependsOn: ['network'] }),
    ]);
    expect(snapshot.dependents).toEqual({
      config: ['network'],
      gis: [],
      network: ['gis', 'search'],
      search: [],
    });
  });

  test('does not index optional dependency as required dependent', () => {
    const snapshot = analyzeServiceGraph([
      service('telemetry'),
      service('shell', { optionalDependencies: ['telemetry'] }),
    ]);
    expect(snapshot.dependents.telemetry).toEqual([]);
  });

  test('counts every dependency and capability declaration', () => {
    const snapshot = analyzeServiceGraph([
      service('config', { provides: ['runtime-config'] }),
      service('network', {
        dependsOn: ['config'],
        optionalDependencies: ['telemetry'],
        provides: ['governed-http'],
        consumes: ['runtime-config'],
      }),
      service('telemetry', { criticality: 'optional' }),
    ]);
    expect(snapshot.relationCount).toBe(5);
  });

  test('fingerprint is stable independent of registration order', () => {
    const first = analyzeServiceGraph([
      service('config'),
      service('network', { dependsOn: ['config'] }),
    ]);
    const second = analyzeServiceGraph([
      service('network', { dependsOn: ['config'] }),
      service('config'),
    ]);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('fingerprint changes when a version changes', () => {
    const first = analyzeServiceGraph([service('config', { version: '1.0.0' })]);
    const second = analyzeServiceGraph([service('config', { version: '1.0.1' })]);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('fingerprint changes when a dependency changes', () => {
    const first = analyzeServiceGraph([
      service('config'),
      service('network'),
    ]);
    const second = analyzeServiceGraph([
      service('config'),
      service('network', { dependsOn: ['config'] }),
    ]);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('freezes all support-facing collections', () => {
    const snapshot = analyzeServiceGraph([
      service('config', { provides: ['runtime-config'] }),
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.descriptors)).toBe(true);
    expect(Object.isFrozen(snapshot.issues)).toBe(true);
    expect(Object.isFrozen(snapshot.startupOrder)).toBe(true);
    expect(Object.isFrozen(snapshot.layers)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.dependents)).toBe(true);
  });

  test('retains caller-provided revision', () => {
    expect(analyzeServiceGraph([service('config')], {}, 42).revision).toBe(42);
  });
});

describe('analyzeServiceGraph invalid graphs', () => {
  test('reports missing required dependency and fails closed', () => {
    const snapshot = analyzeServiceGraph([
      service('network', { dependsOn: ['config'] }),
    ]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toContainEqual({
      code: 'missing-dependency',
      serviceId: 'network',
      target: 'config',
    });
    expect(snapshot.startupOrder).toEqual([]);
    expect(snapshot.shutdownOrder).toEqual([]);
    expect(snapshot.layers).toEqual([]);
  });

  test('reports missing consumed capability', () => {
    const snapshot = analyzeServiceGraph([
      service('shell', { consumes: ['governed-http'] }),
    ]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toContainEqual({
      code: 'missing-capability',
      serviceId: 'shell',
      target: 'governed-http',
    });
  });

  test('accepts consumed capability from any provider', () => {
    const snapshot = analyzeServiceGraph([
      service('network', { provides: ['governed-http'] }),
      service('shell', { consumes: ['governed-http'] }),
    ]);
    expect(snapshot.valid).toBe(true);
  });

  test('detects a two-node dependency cycle', () => {
    const snapshot = analyzeServiceGraph([
      service('alpha', { dependsOn: ['beta'] }),
      service('beta', { dependsOn: ['alpha'] }),
    ]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.filter((issue) => issue.code === 'dependency-cycle'))
      .toEqual([
        { code: 'dependency-cycle', serviceId: 'alpha', target: 'alpha' },
        { code: 'dependency-cycle', serviceId: 'beta', target: 'beta' },
      ]);
  });

  test('detects a long dependency cycle', () => {
    const snapshot = analyzeServiceGraph([
      service('alpha', { dependsOn: ['beta'] }),
      service('beta', { dependsOn: ['gamma'] }),
      service('gamma', { dependsOn: ['delta'] }),
      service('delta', { dependsOn: ['alpha'] }),
    ]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.filter((issue) => issue.code === 'dependency-cycle'))
      .toHaveLength(4);
  });

  test('does not treat optional cycles as required cycles', () => {
    const snapshot = analyzeServiceGraph([
      service('alpha', { optionalDependencies: ['beta'] }),
      service('beta', { optionalDependencies: ['alpha'] }),
    ]);
    expect(snapshot.valid).toBe(true);
  });

  test('rejects duplicate descriptors', () => {
    expect(() => analyzeServiceGraph([
      service('config'),
      service('config'),
    ])).toThrow(expect.objectContaining({ code: 'DUPLICATE_SERVICE' }));
  });

  test('enforces graph service capacity', () => {
    expect(() => analyzeServiceGraph([
      service('one'),
      service('two'),
    ], { maxServices: 1 })).toThrow(
      expect.objectContaining({ code: 'SERVICE_CAPACITY_EXCEEDED' }),
    );
  });

  test('bounds issue accumulation', () => {
    const snapshot = analyzeServiceGraph([
      service('one', { dependsOn: ['missing-one'] }),
      service('two', { dependsOn: ['missing-two'] }),
      service('three', { consumes: ['missing-capability'] }),
    ], { maxIssues: 2 });
    expect(snapshot.issues).toHaveLength(2);
  });

  test('reports global relation capacity exhaustion', () => {
    const snapshot = analyzeServiceGraph([
      service('one'),
      service('two'),
      service('three', {
        dependsOn: ['one', 'two'],
        provides: ['capability-a'],
        consumes: ['capability-a'],
      }),
    ], {
      maxRelations: 1,
      maxRelationsPerService: 8,
      maxCapabilitiesPerService: 8,
    });
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.some((issue) =>
      issue.code === 'relation-capacity-exceeded')).toBe(true);
  });
});

describe('ServiceGraphBuilder lifecycle', () => {
  test('registers and snapshots descriptors', () => {
    const graph = createServiceGraph();
    graph.register(service('config'));
    graph.register(service('network', { dependsOn: ['config'] }));
    const snapshot = graph.snapshot();
    expect(snapshot.valid).toBe(true);
    expect(snapshot.serviceCount).toBe(2);
    expect(snapshot.revision).toBe(2);
  });

  test('register returns an idempotent unregister function', () => {
    const graph = createServiceGraph();
    const unregister = graph.register(service('config'));
    expect(graph.has('config')).toBe(true);
    unregister();
    unregister();
    expect(graph.has('config')).toBe(false);
    expect(graph.snapshot().revision).toBe(2);
  });

  test('replace updates a descriptor without duplicating it', () => {
    const graph = createServiceGraph();
    graph.register(service('config', { version: '1.0.0' }));
    graph.replace(service('config', { version: '2.0.0' }));
    expect(graph.descriptor('config')?.version).toBe('2.0.0');
    expect(graph.snapshot().serviceCount).toBe(1);
  });

  test('replace can insert below capacity', () => {
    const graph = createServiceGraph({ maxServices: 2 });
    graph.replace(service('config'));
    expect(graph.ids()).toEqual(['config']);
  });

  test('replace enforces capacity for a new service', () => {
    const graph = createServiceGraph({ maxServices: 1 });
    graph.register(service('config'));
    expect(() => graph.replace(service('network')))
      .toThrow(expect.objectContaining({ code: 'SERVICE_CAPACITY_EXCEEDED' }));
  });

  test('remove reports whether an id existed', () => {
    const graph = createServiceGraph();
    graph.register(service('config'));
    expect(graph.remove('config')).toBe(true);
    expect(graph.remove('config')).toBe(false);
  });

  test('ids are sorted', () => {
    const graph = createServiceGraph();
    graph.register(service('zeta'));
    graph.register(service('alpha'));
    graph.register(service('middle'));
    expect(graph.ids()).toEqual(['alpha', 'middle', 'zeta']);
  });

  test('descriptor returns normalized immutable data', () => {
    const graph = createServiceGraph();
    graph.register(service('Platform.Config', {
      provides: ['Runtime-Config'],
    }));
    const descriptor = graph.descriptor('platform.config');
    expect(descriptor).toMatchObject({
      id: 'platform.config',
      provides: ['runtime-config'],
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  test('rejects duplicate registration', () => {
    const graph = createServiceGraph();
    graph.register(service('config'));
    expect(() => graph.register(service('config')))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_SERVICE' }));
  });

  test('enforces builder capacity', () => {
    const graph = createServiceGraph({ maxServices: 1 });
    graph.register(service('config'));
    expect(() => graph.register(service('network')))
      .toThrow(expect.objectContaining({ code: 'SERVICE_CAPACITY_EXCEEDED' }));
  });

  test('clear removes all descriptors and increments revision once', () => {
    const graph = createServiceGraph();
    graph.register(service('one'));
    graph.register(service('two'));
    const before = graph.snapshot().revision;
    graph.clear();
    expect(graph.ids()).toEqual([]);
    expect(graph.snapshot().revision).toBe(before + 1);
  });

  test('clear on empty graph does not increment revision', () => {
    const graph = createServiceGraph();
    const before = graph.snapshot().revision;
    graph.clear();
    expect(graph.snapshot().revision).toBe(before);
  });

  test('snapshot reflects missing dependency after removal', () => {
    const graph = createServiceGraph();
    graph.register(service('config'));
    graph.register(service('network', { dependsOn: ['config'] }));
    graph.remove('config');
    expect(graph.snapshot()).toMatchObject({
      valid: false,
      startupOrder: [],
    });
  });

  test('dispose rejects future reads and mutations', () => {
    const graph = createServiceGraph();
    graph.register(service('config'));
    graph.dispose();
    expect(() => graph.snapshot()).toThrow(
      expect.objectContaining({ code: 'GRAPH_DISPOSED' }),
    );
    expect(() => graph.register(service('network'))).toThrow(
      expect.objectContaining({ code: 'GRAPH_DISPOSED' }),
    );
    expect(() => graph.ids()).toThrow(
      expect.objectContaining({ code: 'GRAPH_DISPOSED' }),
    );
  });

  test('dispose is idempotent', () => {
    const graph = createServiceGraph();
    expect(() => {
      graph.dispose();
      graph.dispose();
    }).not.toThrow();
  });
});

describe('service graph architecture invariants', () => {
  test('models Platform -> GIS -> Experience direction deterministically', () => {
    const snapshot = analyzeServiceGraph([
      service('platform-config', {
        domain: 'platform',
        provides: ['runtime-config'],
      }),
      service('platform-network', {
        domain: 'platform',
        dependsOn: ['platform-config'],
        provides: ['governed-http'],
        consumes: ['runtime-config'],
      }),
      service('gis-runtime', {
        domain: 'gis',
        dependsOn: ['platform-network'],
        consumes: ['governed-http'],
        provides: ['spatial-runtime'],
      }),
      service('experience-runtime', {
        domain: 'experience',
        dependsOn: ['gis-runtime'],
        consumes: ['spatial-runtime'],
      }),
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.startupOrder).toEqual([
      'platform-config',
      'platform-network',
      'gis-runtime',
      'experience-runtime',
    ]);
  });

  test('contains no implicit WMS or WFS assumptions', () => {
    const snapshot = analyzeServiceGraph([
      service('platform-network', { provides: ['governed-http'] }),
      service('gis-runtime', {
        dependsOn: ['platform-network'],
        consumes: ['governed-http'],
      }),
    ]);
    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain('wms');
    expect(serialized).not.toContain('wfs');
    expect(serialized).not.toContain('wmts');
  });

  test('keeps lazy optional diagnostics out of required dependency edges', () => {
    const snapshot = analyzeServiceGraph([
      service('runtime', { provides: ['runtime'] }),
      service('diagnostics', {
        startup: 'lazy',
        criticality: 'optional',
        optionalDependencies: ['runtime'],
      }),
    ]);
    expect(snapshot.dependents.runtime).toEqual([]);
    expect(snapshot.descriptors.find((item) => item.id === 'diagnostics'))
      .toMatchObject({
        startup: 'lazy',
        criticality: 'optional',
      });
  });

  test('fingerprint does not contain runtime secret material because descriptors have no values', () => {
    const snapshot = analyzeServiceGraph([
      service('config', {
        provides: ['runtime-config'],
      }),
    ]);
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{8}$/u);
    expect(JSON.stringify(snapshot)).not.toContain('password=');
    expect(JSON.stringify(snapshot)).not.toContain('token=');
  });
});
