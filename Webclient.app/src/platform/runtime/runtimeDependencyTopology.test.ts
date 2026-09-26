import { describe, expect, it } from 'vitest';
import { RuntimeDependencyTopology } from './runtimeDependencyTopology';

function topology() {
  return new RuntimeDependencyTopology({ maximumNodes: 16, maximumEdges: 32, maximumDependenciesPerNode: 4, maximumTraversalDepth: 8, maximumHistory: 16 });
}

function addBasicGraph(subject: RuntimeDependencyTopology): void {
  subject.addNode({ id: 'ui', criticality: 'critical' }, 1);
  subject.addNode({ id: 'search', criticality: 'important' }, 2);
  subject.addNode({ id: 'address', criticality: 'important' }, 3);
  subject.addNode({ id: 'telemetry', criticality: 'optional' }, 4);
  subject.addEdge({ consumer: 'ui', dependency: 'search', required: true }, 5);
  subject.addEdge({ consumer: 'search', dependency: 'address', required: true }, 6);
  subject.addEdge({ consumer: 'ui', dependency: 'telemetry', required: false }, 7);
}

describe('RuntimeDependencyTopology', () => {
  it('tracks bounded nodes and edges', () => {
    const subject = topology();
    addBasicGraph(subject);
    expect(subject.snapshot()).toEqual({ nodes: 4, edges: 3, revision: 7, roots: ['ui'], leaves: ['address', 'telemetry'] });
  });

  it('rejects duplicate nodes', () => {
    const subject = topology();
    subject.addNode({ id: 'api', criticality: 'critical' }, 1);
    expect(() => subject.addNode({ id: 'api', criticality: 'critical' }, 2)).toThrow(/already exists/);
  });

  it('normalizes node identifiers', () => {
    const subject = topology();
    subject.addNode({ id: '  api  ', criticality: 'critical' }, 1);
    expect(subject.snapshot().leaves).toEqual(['api']);
  });

  it('rejects blank node identifiers', () => {
    expect(() => topology().addNode({ id: '   ', criticality: 'critical' }, 1)).toThrow(/must not be empty/);
  });

  it('rejects oversized identifiers', () => {
    expect(() => topology().addNode({ id: 'x'.repeat(161), criticality: 'critical' }, 1)).toThrow(/160/);
  });

  it('rejects oversized descriptions', () => {
    expect(() => topology().addNode({ id: 'api', criticality: 'critical', description: 'x'.repeat(501) }, 1)).toThrow(/500/);
  });

  it('enforces node capacity', () => {
    const subject = new RuntimeDependencyTopology({ maximumNodes: 1 });
    subject.addNode({ id: 'one', criticality: 'critical' }, 1);
    expect(() => subject.addNode({ id: 'two', criticality: 'critical' }, 2)).toThrow(/capacity/);
  });

  it('requires existing edge endpoints', () => {
    const subject = topology();
    subject.addNode({ id: 'ui', criticality: 'critical' }, 1);
    expect(() => subject.addEdge({ consumer: 'ui', dependency: 'missing', required: true }, 2)).toThrow(/unknown/);
  });

  it('rejects self dependencies', () => {
    const subject = topology();
    subject.addNode({ id: 'ui', criticality: 'critical' }, 1);
    expect(() => subject.addEdge({ consumer: 'ui', dependency: 'ui', required: true }, 2)).toThrow(/self/);
  });

  it('rejects duplicate edges', () => {
    const subject = topology();
    subject.addNode({ id: 'ui', criticality: 'critical' }, 1);
    subject.addNode({ id: 'api', criticality: 'critical' }, 2);
    subject.addEdge({ consumer: 'ui', dependency: 'api', required: true }, 3);
    expect(() => subject.addEdge({ consumer: 'ui', dependency: 'api', required: false }, 4)).toThrow(/already exists/);
  });

  it('rejects direct cycles', () => {
    const subject = topology();
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 3);
    expect(() => subject.addEdge({ consumer: 'b', dependency: 'a', required: true }, 4)).toThrow(/cycle/);
  });

  it('rejects transitive cycles', () => {
    const subject = topology();
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addNode({ id: 'c', criticality: 'critical' }, 3);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 4);
    subject.addEdge({ consumer: 'b', dependency: 'c', required: true }, 5);
    expect(() => subject.addEdge({ consumer: 'c', dependency: 'a', required: true }, 6)).toThrow(/cycle/);
  });

  it('orders dependencies before consumers', () => {
    const subject = topology();
    addBasicGraph(subject);
    const order = subject.topologicalOrder();
    expect(order.indexOf('address')).toBeLessThan(order.indexOf('search'));
    expect(order.indexOf('search')).toBeLessThan(order.indexOf('ui'));
    expect(order.indexOf('telemetry')).toBeLessThan(order.indexOf('ui'));
  });

  it('propagates required unavailability as blocked', () => {
    const subject = topology();
    addBasicGraph(subject);
    subject.setAvailability('address', 'unavailable', 8);
    expect(subject.impact('ui')).toMatchObject({ effectiveImpact: 'blocked', blockedBy: ['address'] });
  });

  it('propagates optional unavailability as degraded', () => {
    const subject = topology();
    addBasicGraph(subject);
    subject.setAvailability('telemetry', 'unavailable', 8);
    expect(subject.impact('ui')).toMatchObject({ effectiveImpact: 'degraded', degradedBy: ['telemetry'] });
  });

  it('propagates degraded required dependencies as degraded', () => {
    const subject = topology();
    addBasicGraph(subject);
    subject.setAvailability('search', 'degraded', 8);
    expect(subject.impact('ui')).toMatchObject({ effectiveImpact: 'degraded', degradedBy: ['search'] });
  });

  it('includes own availability in effective impact', () => {
    const subject = topology();
    addBasicGraph(subject);
    subject.setAvailability('ui', 'unavailable', 8);
    expect(subject.impact('ui').effectiveImpact).toBe('blocked');
  });

  it('returns all impacts in deterministic order', () => {
    const subject = topology();
    addBasicGraph(subject);
    expect(subject.impacts().map((entry) => entry.node)).toEqual(['address', 'search', 'telemetry', 'ui']);
  });

  it('lists deterministic dependency edges', () => {
    const subject = topology();
    addBasicGraph(subject);
    expect(subject.dependencies('ui')).toEqual([
      { consumer: 'ui', dependency: 'search', required: true },
      { consumer: 'ui', dependency: 'telemetry', required: false },
    ]);
  });

  it('lists consumers', () => {
    const subject = topology();
    addBasicGraph(subject);
    expect(subject.consumers('search')).toEqual(['ui']);
    expect(subject.consumers('address')).toEqual(['search']);
  });

  it('removes an edge and updates impact', () => {
    const subject = topology();
    addBasicGraph(subject);
    subject.setAvailability('address', 'unavailable', 8);
    expect(subject.impact('ui').effectiveImpact).toBe('blocked');
    expect(subject.removeEdge('search', 'address', 9)).toBe(true);
    expect(subject.impact('ui').effectiveImpact).toBe('none');
  });

  it('returns false for missing edge removal', () => {
    const subject = topology();
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    expect(subject.removeEdge('a', 'b', 3)).toBe(false);
  });

  it('removes all incident edges with a node', () => {
    const subject = topology();
    addBasicGraph(subject);
    expect(subject.removeNode('search', 8)).toBe(true);
    expect(subject.snapshot()).toMatchObject({ nodes: 3, edges: 1 });
    expect(subject.dependencies('ui')).toEqual([{ consumer: 'ui', dependency: 'telemetry', required: false }]);
  });

  it('returns false for missing node removal', () => {
    expect(topology().removeNode('missing', 1)).toBe(false);
  });

  it('records bounded mutation history', () => {
    const subject = new RuntimeDependencyTopology({ maximumHistory: 2 });
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 3);
    expect(subject.history()).toHaveLength(2);
    expect(subject.history().map((event) => event.type)).toEqual(['node-added', 'edge-added']);
  });

  it('records availability changes only when state changes', () => {
    const subject = topology();
    subject.addNode({ id: 'api', criticality: 'critical' }, 1);
    expect(subject.setAvailability('api', 'healthy', 2)).toBe(false);
    expect(subject.setAvailability('api', 'degraded', 3)).toBe(true);
    expect(subject.history().map((event) => event.type)).toEqual(['node-added', 'availability-changed']);
  });

  it('enforces monotonic mutation timestamps', () => {
    const subject = topology();
    subject.addNode({ id: 'api', criticality: 'critical' }, 10);
    expect(() => subject.addNode({ id: 'ui', criticality: 'critical' }, 9)).toThrow(/monotonic/);
  });

  it('rejects invalid policy integers', () => {
    expect(() => new RuntimeDependencyTopology({ maximumNodes: 0 })).toThrow(/positive integer/);
    expect(() => new RuntimeDependencyTopology({ maximumEdges: 1.5 })).toThrow(/positive integer/);
    expect(() => new RuntimeDependencyTopology({ maximumTraversalDepth: -1 })).toThrow(/positive integer/);
  });

  it('enforces edge capacity', () => {
    const subject = new RuntimeDependencyTopology({ maximumEdges: 1 });
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addNode({ id: 'c', criticality: 'critical' }, 3);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 4);
    expect(() => subject.addEdge({ consumer: 'a', dependency: 'c', required: true }, 5)).toThrow(/edge capacity/);
  });

  it('enforces per-node dependency capacity', () => {
    const subject = new RuntimeDependencyTopology({ maximumDependenciesPerNode: 1 });
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addNode({ id: 'c', criticality: 'critical' }, 3);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 4);
    expect(() => subject.addEdge({ consumer: 'a', dependency: 'c', required: true }, 5)).toThrow(/per node/);
  });

  it('fails closed when traversal depth is exceeded during cycle checks', () => {
    const subject = new RuntimeDependencyTopology({ maximumTraversalDepth: 1 });
    subject.addNode({ id: 'a', criticality: 'critical' }, 1);
    subject.addNode({ id: 'b', criticality: 'critical' }, 2);
    subject.addNode({ id: 'c', criticality: 'critical' }, 3);
    subject.addEdge({ consumer: 'a', dependency: 'b', required: true }, 4);
    subject.addEdge({ consumer: 'b', dependency: 'c', required: true }, 5);
    expect(() => subject.addEdge({ consumer: 'c', dependency: 'a', required: true }, 6)).toThrow();
  });

  it('does not expose mutable history storage', () => {
    const subject = topology();
    subject.addNode({ id: 'api', criticality: 'critical' }, 1);
    const copy = [...subject.history()];
    copy.splice(0, copy.length);
    expect(subject.history()).toHaveLength(1);
  });

  it('handles diamond dependencies without duplicate diagnostics', () => {
    const subject = topology();
    for (const id of ['ui', 'left', 'right', 'db']) subject.addNode({ id, criticality: 'critical' }, subject.snapshot().revision + 1);
    subject.addEdge({ consumer: 'ui', dependency: 'left', required: true }, 5);
    subject.addEdge({ consumer: 'ui', dependency: 'right', required: true }, 6);
    subject.addEdge({ consumer: 'left', dependency: 'db', required: true }, 7);
    subject.addEdge({ consumer: 'right', dependency: 'db', required: true }, 8);
    subject.setAvailability('db', 'unavailable', 9);
    expect(subject.impact('ui').blockedBy).toEqual(['db']);
  });
});
