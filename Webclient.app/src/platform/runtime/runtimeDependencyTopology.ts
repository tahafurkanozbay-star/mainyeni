export type RuntimeDependencyCriticality = 'optional' | 'important' | 'critical';
export type RuntimeDependencyAvailability = 'healthy' | 'degraded' | 'unavailable';
export type RuntimeDependencyImpact = 'none' | 'degraded' | 'blocked';

export interface RuntimeDependencyTopologyPolicy {
  readonly maximumNodes: number;
  readonly maximumEdges: number;
  readonly maximumDependenciesPerNode: number;
  readonly maximumTraversalDepth: number;
  readonly maximumHistory: number;
}

export interface RuntimeDependencyNodeDefinition {
  readonly id: string;
  readonly criticality: RuntimeDependencyCriticality;
  readonly description?: string;
}

export interface RuntimeDependencyEdgeDefinition {
  readonly consumer: string;
  readonly dependency: string;
  readonly required: boolean;
}

export interface RuntimeDependencyImpactSnapshot {
  readonly node: string;
  readonly ownAvailability: RuntimeDependencyAvailability;
  readonly effectiveImpact: RuntimeDependencyImpact;
  readonly blockedBy: readonly string[];
  readonly degradedBy: readonly string[];
  readonly revision: number;
}

export interface RuntimeDependencyTopologySnapshot {
  readonly nodes: number;
  readonly edges: number;
  readonly revision: number;
  readonly roots: readonly string[];
  readonly leaves: readonly string[];
}

export interface RuntimeDependencyTopologyEvent {
  readonly type: 'node-added' | 'node-removed' | 'edge-added' | 'edge-removed' | 'availability-changed';
  readonly node: string;
  readonly relatedNode?: string;
  readonly occurredAt: number;
  readonly revision: number;
}

interface MutableNode {
  readonly id: string;
  readonly criticality: RuntimeDependencyCriticality;
  readonly description?: string;
  availability: RuntimeDependencyAvailability;
}

interface MutableEdge {
  readonly consumer: string;
  readonly dependency: string;
  readonly required: boolean;
}

const DEFAULT_POLICY: RuntimeDependencyTopologyPolicy = Object.freeze({
  maximumNodes: 128,
  maximumEdges: 512,
  maximumDependenciesPerNode: 16,
  maximumTraversalDepth: 24,
  maximumHistory: 256,
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function normalizeId(value: string, name = 'node'): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty`);
  if (normalized.length > 160) throw new RangeError(`${name} must not exceed 160 characters`);
  return normalized;
}

function impactSeverity(value: RuntimeDependencyImpact): number {
  if (value === 'none') return 0;
  return value === 'degraded' ? 1 : 2;
}

function availabilityImpact(value: RuntimeDependencyAvailability): RuntimeDependencyImpact {
  if (value === 'healthy') return 'none';
  return value === 'degraded' ? 'degraded' : 'blocked';
}

export class RuntimeDependencyTopology {
  readonly #policy: RuntimeDependencyTopologyPolicy;
  readonly #nodes = new Map<string, MutableNode>();
  readonly #edges = new Map<string, MutableEdge>();
  readonly #dependencies = new Map<string, Set<string>>();
  readonly #consumers = new Map<string, Set<string>>();
  readonly #history: RuntimeDependencyTopologyEvent[] = [];
  #revision = 0;
  #lastMutationAt = 0;

  public constructor(policy: Partial<RuntimeDependencyTopologyPolicy> = {}) {
    const merged = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(merged.maximumNodes, 'maximumNodes');
    positiveInteger(merged.maximumEdges, 'maximumEdges');
    positiveInteger(merged.maximumDependenciesPerNode, 'maximumDependenciesPerNode');
    positiveInteger(merged.maximumTraversalDepth, 'maximumTraversalDepth');
    positiveInteger(merged.maximumHistory, 'maximumHistory');
    this.#policy = Object.freeze(merged);
  }

  public get policy(): RuntimeDependencyTopologyPolicy { return this.#policy; }

  public addNode(definition: RuntimeDependencyNodeDefinition, occurredAt: number): void {
    this.#assertTime(occurredAt);
    const id = normalizeId(definition.id);
    if (this.#nodes.has(id)) throw new Error(`dependency node already exists: ${id}`);
    if (this.#nodes.size >= this.#policy.maximumNodes) throw new RangeError('maximum dependency node capacity reached');
    const description = definition.description?.trim();
    if (description !== undefined && description.length > 500) throw new RangeError('description must not exceed 500 characters');
    const node: MutableNode = description === undefined
      ? { id, criticality: definition.criticality, availability: 'healthy' }
      : { id, criticality: definition.criticality, description, availability: 'healthy' };
    this.#nodes.set(id, node);
    this.#dependencies.set(id, new Set());
    this.#consumers.set(id, new Set());
    this.#record('node-added', id, occurredAt);
  }

  public removeNode(node: string, occurredAt: number): boolean {
    this.#assertTime(occurredAt);
    const id = normalizeId(node);
    if (!this.#nodes.has(id)) return false;
    const dependencies = [...(this.#dependencies.get(id) ?? [])];
    const consumers = [...(this.#consumers.get(id) ?? [])];
    for (const dependency of dependencies) this.#removeEdgeInternal(id, dependency);
    for (const consumer of consumers) this.#removeEdgeInternal(consumer, id);
    this.#nodes.delete(id);
    this.#dependencies.delete(id);
    this.#consumers.delete(id);
    this.#record('node-removed', id, occurredAt);
    return true;
  }

  public addEdge(definition: RuntimeDependencyEdgeDefinition, occurredAt: number): void {
    this.#assertTime(occurredAt);
    const consumer = normalizeId(definition.consumer, 'consumer');
    const dependency = normalizeId(definition.dependency, 'dependency');
    if (consumer === dependency) throw new Error('self dependency is not allowed');
    this.#requireNode(consumer);
    this.#requireNode(dependency);
    const key = this.#edgeKey(consumer, dependency);
    if (this.#edges.has(key)) throw new Error(`dependency edge already exists: ${consumer} -> ${dependency}`);
    if (this.#edges.size >= this.#policy.maximumEdges) throw new RangeError('maximum dependency edge capacity reached');
    const dependencies = this.#requireAdjacency(this.#dependencies, consumer, 'dependency');
    if (dependencies.size >= this.#policy.maximumDependenciesPerNode) throw new RangeError('maximum dependencies per node reached');
    if (this.#reaches(dependency, consumer)) throw new Error(`dependency cycle rejected: ${consumer} -> ${dependency}`);
    const edge: MutableEdge = { consumer, dependency, required: definition.required };
    this.#edges.set(key, edge);
    dependencies.add(dependency);
    this.#requireAdjacency(this.#consumers, dependency, 'consumer').add(consumer);
    this.#record('edge-added', consumer, occurredAt, dependency);
  }

  public removeEdge(consumerValue: string, dependencyValue: string, occurredAt: number): boolean {
    this.#assertTime(occurredAt);
    const consumer = normalizeId(consumerValue, 'consumer');
    const dependency = normalizeId(dependencyValue, 'dependency');
    if (!this.#removeEdgeInternal(consumer, dependency)) return false;
    this.#record('edge-removed', consumer, occurredAt, dependency);
    return true;
  }

  public setAvailability(node: string, availability: RuntimeDependencyAvailability, occurredAt: number): boolean {
    this.#assertTime(occurredAt);
    const target = this.#requireNode(normalizeId(node));
    if (target.availability === availability) return false;
    target.availability = availability;
    this.#record('availability-changed', target.id, occurredAt);
    return true;
  }

  public impact(node: string): RuntimeDependencyImpactSnapshot {
    const id = normalizeId(node);
    const target = this.#requireNode(id);
    const blockedBy = new Set<string>();
    const degradedBy = new Set<string>();
    let effectiveImpact = availabilityImpact(target.availability);
    const queue: Array<{ readonly id: string; readonly requiredPath: boolean; readonly depth: number }> = [];
    for (const dependency of this.#dependencies.get(id) ?? []) {
      const edge = this.#requireEdge(id, dependency);
      queue.push({ id: dependency, requiredPath: edge.required, depth: 1 });
    }
    const visited = new Map<string, number>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > this.#policy.maximumTraversalDepth) throw new RangeError('dependency traversal depth exceeded');
      const previousDepth = visited.get(current.id);
      if (previousDepth !== undefined && previousDepth <= current.depth) continue;
      visited.set(current.id, current.depth);
      const dependencyNode = this.#requireNode(current.id);
      const ownImpact = availabilityImpact(dependencyNode.availability);
      const propagated: RuntimeDependencyImpact = ownImpact === 'blocked' && !current.requiredPath ? 'degraded' : ownImpact;
      if (propagated === 'blocked') blockedBy.add(current.id);
      else if (propagated === 'degraded') degradedBy.add(current.id);
      if (impactSeverity(propagated) > impactSeverity(effectiveImpact)) effectiveImpact = propagated;
      for (const nested of this.#dependencies.get(current.id) ?? []) {
        const edge = this.#requireEdge(current.id, nested);
        queue.push({ id: nested, requiredPath: current.requiredPath && edge.required, depth: current.depth + 1 });
      }
    }
    return {
      node: id,
      ownAvailability: target.availability,
      effectiveImpact,
      blockedBy: [...blockedBy].sort(),
      degradedBy: [...degradedBy].sort(),
      revision: this.#revision,
    };
  }

  public impacts(): readonly RuntimeDependencyImpactSnapshot[] {
    return [...this.#nodes.keys()].sort().map((node) => this.impact(node));
  }

  public dependencies(node: string): readonly RuntimeDependencyEdgeDefinition[] {
    const id = normalizeId(node);
    this.#requireNode(id);
    return [...(this.#dependencies.get(id) ?? [])].sort().map((dependency) => {
      const edge = this.#requireEdge(id, dependency);
      return { consumer: edge.consumer, dependency: edge.dependency, required: edge.required };
    });
  }

  public consumers(node: string): readonly string[] {
    const id = normalizeId(node);
    this.#requireNode(id);
    return [...(this.#consumers.get(id) ?? [])].sort();
  }

  public topologicalOrder(): readonly string[] {
    const indegree = new Map<string, number>();
    for (const id of this.#nodes.keys()) indegree.set(id, 0);
    for (const edge of this.#edges.values()) indegree.set(edge.consumer, (indegree.get(edge.consumer) ?? 0) + 1);
    const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
    const order: string[] = [];
    while (ready.length > 0) {
      const dependency = ready.shift();
      if (dependency === undefined) break;
      order.push(dependency);
      for (const consumer of this.#consumers.get(dependency) ?? []) {
        const next = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, next);
        if (next === 0) {
          ready.push(consumer);
          ready.sort();
        }
      }
    }
    if (order.length !== this.#nodes.size) throw new Error('dependency topology contains a cycle');
    return order;
  }

  public snapshot(): RuntimeDependencyTopologySnapshot {
    const roots: string[] = [];
    const leaves: string[] = [];
    for (const id of this.#nodes.keys()) {
      if ((this.#consumers.get(id)?.size ?? 0) === 0) roots.push(id);
      if ((this.#dependencies.get(id)?.size ?? 0) === 0) leaves.push(id);
    }
    return { nodes: this.#nodes.size, edges: this.#edges.size, revision: this.#revision, roots: roots.sort(), leaves: leaves.sort() };
  }

  public history(): readonly RuntimeDependencyTopologyEvent[] { return this.#history.map((event) => ({ ...event })); }

  #reaches(start: string, target: string): boolean {
    const stack: Array<{ readonly id: string; readonly depth: number }> = [{ id: start, depth: 0 }];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.id === target) return true;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      if (current.depth >= this.#policy.maximumTraversalDepth) throw new RangeError('dependency traversal depth exceeded');
      for (const dependency of this.#dependencies.get(current.id) ?? []) stack.push({ id: dependency, depth: current.depth + 1 });
    }
    return false;
  }

  #removeEdgeInternal(consumer: string, dependency: string): boolean {
    const key = this.#edgeKey(consumer, dependency);
    if (!this.#edges.delete(key)) return false;
    this.#dependencies.get(consumer)?.delete(dependency);
    this.#consumers.get(dependency)?.delete(consumer);
    return true;
  }

  #requireNode(id: string): MutableNode {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`unknown dependency node: ${id}`);
    return node;
  }

  #requireEdge(consumer: string, dependency: string): MutableEdge {
    const edge = this.#edges.get(this.#edgeKey(consumer, dependency));
    if (edge === undefined) throw new Error(`dependency topology invariant violated: missing edge ${consumer} -> ${dependency}`);
    return edge;
  }

  #requireAdjacency(index: Map<string, Set<string>>, id: string, kind: string): Set<string> {
    const values = index.get(id);
    if (values === undefined) throw new Error(`dependency topology invariant violated: missing ${kind} index for ${id}`);
    return values;
  }

  #edgeKey(consumer: string, dependency: string): string { return `${consumer}\u0000${dependency}`; }

  #assertTime(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('occurredAt must be a non-negative finite number');
    if (value < this.#lastMutationAt) throw new RangeError('occurredAt must be monotonic');
    this.#lastMutationAt = value;
  }

  #record(type: RuntimeDependencyTopologyEvent['type'], node: string, occurredAt: number, relatedNode?: string): void {
    const revision = ++this.#revision;
    const event: RuntimeDependencyTopologyEvent = relatedNode === undefined
      ? { type, node, occurredAt, revision }
      : { type, node, relatedNode, occurredAt, revision };
    this.#history.push(event);
    if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
  }
}
