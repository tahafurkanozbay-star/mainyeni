import {
  DependencyCycleError,
  DuplicateComponentError,
  MissingDependencyError,
  normalizeDependencyKind,
  normalizeIdentifier,
  normalizeOptionalText,
  normalizeTags,
  phaseWeight,
  criticalityWeight,
  type ComponentDescriptor,
  type NormalizedComponentDescriptor,
  type NormalizedDependencyReference,
} from './contracts';

export interface DependencyGraphCompileOptions {
  readonly allowMissingOptional?: boolean;
  readonly allowMissingAfter?: boolean;
}

export interface DependencyGraphSnapshot {
  readonly revision: number;
  readonly nodes: readonly NormalizedComponentDescriptor[];
  readonly startupOrder: readonly string[];
  readonly shutdownOrder: readonly string[];
  readonly levels: readonly (readonly string[])[];
  readonly dependents: Readonly<Record<string, readonly string[]>>;
  readonly requiredDependencies: Readonly<Record<string, readonly string[]>>;
  readonly allDependencies: Readonly<Record<string, readonly string[]>>;
  readonly transitiveDependencies: Readonly<Record<string, readonly string[]>>;
  readonly criticalPath: readonly string[];
}

interface MutableGraphNode {
  readonly descriptor: NormalizedComponentDescriptor;
  readonly dependencies: Set<string>;
  readonly requiredDependencies: Set<string>;
  readonly dependents: Set<string>;
  indegree: number;
}

const descriptorComparator = (
  left: NormalizedComponentDescriptor,
  right: NormalizedComponentDescriptor,
): number => {
  const phase = phaseWeight(left.phase) - phaseWeight(right.phase);
  if (phase !== 0) return phase;
  const criticality = criticalityWeight(left.criticality) - criticalityWeight(right.criticality);
  if (criticality !== 0) return criticality;
  return left.id.localeCompare(right.id);
};

const normalizeDependencies = (
  componentId: string,
  dependencies: ComponentDescriptor['dependencies'],
): readonly NormalizedDependencyReference[] => {
  if (!dependencies?.length) return Object.freeze([]);
  const byId = new Map<string, NormalizedDependencyReference>();

  for (const raw of dependencies) {
    const id = normalizeIdentifier(raw.id, `dependency of ${componentId}`);
    if (id === componentId) {
      throw new DependencyCycleError(Object.freeze([componentId, componentId]));
    }
    const kind = normalizeDependencyKind(raw.kind);
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, Object.freeze({ id, kind }));
      continue;
    }

    if (previous.kind !== 'required' && kind === 'required') {
      byId.set(id, Object.freeze({ id, kind }));
      continue;
    }
    if (previous.kind === 'after' && kind === 'optional') {
      byId.set(id, Object.freeze({ id, kind }));
    }
  }

  return Object.freeze(
    [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
  );
};

export const normalizeComponentDescriptor = (
  input: ComponentDescriptor | NormalizedComponentDescriptor,
): NormalizedComponentDescriptor => {
  const id = normalizeIdentifier(input.id, 'component id');
  const phase = input.phase ?? 'feature';
  const criticality = input.criticality ?? 'important';
  if (phase !== 'bootstrap' && phase !== 'core' && phase !== 'feature' && phase !== 'background') {
    throw new TypeError(`Unsupported lifecycle phase for "${id}": ${String(phase)}.`);
  }
  if (criticality !== 'critical' && criticality !== 'important' && criticality !== 'optional') {
    throw new TypeError(`Unsupported criticality for "${id}": ${String(criticality)}.`);
  }
  return Object.freeze({
    id,
    phase,
    criticality,
    dependencies: normalizeDependencies(id, input.dependencies),
    tags: normalizeTags(input.tags),
    description: normalizeOptionalText(input.description),
  });
};

const buildMutableGraph = (
  descriptors: readonly (ComponentDescriptor | NormalizedComponentDescriptor)[],
  options: DependencyGraphCompileOptions,
): Map<string, MutableGraphNode> => {
  const graph = new Map<string, MutableGraphNode>();
  for (const raw of descriptors) {
    const descriptor = normalizeComponentDescriptor(raw);
    if (graph.has(descriptor.id)) throw new DuplicateComponentError(descriptor.id);
    graph.set(descriptor.id, {
      descriptor,
      dependencies: new Set<string>(),
      requiredDependencies: new Set<string>(),
      dependents: new Set<string>(),
      indegree: 0,
    });
  }

  for (const node of graph.values()) {
    for (const dependency of node.descriptor.dependencies) {
      const target = graph.get(dependency.id);
      if (!target) {
        if (dependency.kind === 'required') {
          throw new MissingDependencyError(node.descriptor.id, dependency.id);
        }
        if (dependency.kind === 'optional' && options.allowMissingOptional === false) {
          throw new MissingDependencyError(node.descriptor.id, dependency.id);
        }
        if (dependency.kind === 'after' && options.allowMissingAfter === false) {
          throw new MissingDependencyError(node.descriptor.id, dependency.id);
        }
        continue;
      }
      node.dependencies.add(target.descriptor.id);
      if (dependency.kind === 'required') node.requiredDependencies.add(target.descriptor.id);
      target.dependents.add(node.descriptor.id);
    }
    node.indegree = node.dependencies.size;
  }

  return graph;
};

const cycleFromGraph = (graph: Map<string, MutableGraphNode>): readonly string[] => {
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    state.set(id, 'visiting');
    stack.push(id);
    const node = graph.get(id);
    const dependencies = node ? [...node.dependencies].sort() : [];
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency);
      if (dependencyState === 'visited') continue;
      if (dependencyState === 'visiting') {
        const cycleStart = stack.lastIndexOf(dependency);
        return Object.freeze([...stack.slice(Math.max(0, cycleStart)), dependency]);
      }
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'visited');
    return null;
  };

  for (const id of [...graph.keys()].sort()) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return Object.freeze([]);
};

const sortedReadyNodes = (
  graph: Map<string, MutableGraphNode>,
  ids: Iterable<string>,
): string[] => [...ids].sort((leftId, rightId) => {
  const left = graph.get(leftId)?.descriptor;
  const right = graph.get(rightId)?.descriptor;
  if (!left || !right) return leftId.localeCompare(rightId);
  return descriptorComparator(left, right);
});

const compileLevels = (graph: Map<string, MutableGraphNode>): readonly (readonly string[])[] => {
  const indegrees = new Map<string, number>();
  for (const [id, node] of graph) indegrees.set(id, node.indegree);
  let ready = sortedReadyNodes(
    graph,
    [...indegrees.entries()].filter(([, degree]) => degree === 0).map(([id]) => id),
  );
  const levels: string[][] = [];
  let visited = 0;

  while (ready.length > 0) {
    const current = ready;
    levels.push(current);
    visited += current.length;
    const next = new Set<string>();
    for (const id of current) {
      const node = graph.get(id);
      if (!node) continue;
      for (const dependentId of node.dependents) {
        const degree = (indegrees.get(dependentId) ?? 0) - 1;
        indegrees.set(dependentId, degree);
        if (degree === 0) next.add(dependentId);
      }
    }
    ready = sortedReadyNodes(graph, next);
  }

  if (visited !== graph.size) {
    const cycle = cycleFromGraph(graph);
    throw new DependencyCycleError(cycle.length ? cycle : Object.freeze(['unknown-cycle']));
  }

  return Object.freeze(levels.map((level) => Object.freeze([...level])));
};

const transitiveDependenciesFor = (
  id: string,
  graph: Map<string, MutableGraphNode>,
  memo: Map<string, readonly string[]>,
): readonly string[] => {
  const cached = memo.get(id);
  if (cached) return cached;
  const node = graph.get(id);
  if (!node) return Object.freeze([]);
  const result = new Set<string>();
  for (const dependencyId of node.dependencies) {
    result.add(dependencyId);
    for (const transitive of transitiveDependenciesFor(dependencyId, graph, memo)) {
      result.add(transitive);
    }
  }
  const normalized = Object.freeze([...result].sort());
  memo.set(id, normalized);
  return normalized;
};

const buildCriticalPath = (
  levels: readonly (readonly string[])[],
  graph: Map<string, MutableGraphNode>,
): readonly string[] => {
  if (levels.length === 0) return Object.freeze([]);
  const distance = new Map<string, number>();
  const predecessor = new Map<string, string>();

  for (const level of levels) {
    for (const id of level) {
      const node = graph.get(id);
      if (!node) continue;
      let bestDistance = 1;
      let bestPredecessor: string | null = null;
      for (const dependencyId of node.dependencies) {
        const candidateDistance = (distance.get(dependencyId) ?? 0) + 1;
        if (candidateDistance > bestDistance) {
          bestDistance = candidateDistance;
          bestPredecessor = dependencyId;
        } else if (
          candidateDistance === bestDistance
          && bestPredecessor !== null
          && dependencyId.localeCompare(bestPredecessor) < 0
        ) {
          bestPredecessor = dependencyId;
        }
      }
      distance.set(id, bestDistance);
      if (bestPredecessor) predecessor.set(id, bestPredecessor);
    }
  }

  let tail: string | null = null;
  let longest = 0;
  for (const [id, value] of distance) {
    if (value > longest || (value === longest && tail !== null && id.localeCompare(tail) < 0)) {
      longest = value;
      tail = id;
    }
  }
  if (!tail) return Object.freeze([]);

  const path: string[] = [];
  let current: string | undefined = tail;
  while (current) {
    path.push(current);
    current = predecessor.get(current);
  }
  path.reverse();
  return Object.freeze(path);
};

const recordFromGraph = (
  graph: Map<string, MutableGraphNode>,
  selector: (node: MutableGraphNode) => Iterable<string>,
): Readonly<Record<string, readonly string[]>> => {
  const record: Record<string, readonly string[]> = {};
  for (const [id, node] of [...graph.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    record[id] = Object.freeze([...selector(node)].sort());
  }
  return Object.freeze(record);
};

export const compileDependencyGraph = (
  descriptors: readonly (ComponentDescriptor | NormalizedComponentDescriptor)[],
  options: DependencyGraphCompileOptions = {},
  revision = 1,
): DependencyGraphSnapshot => {
  const graph = buildMutableGraph(descriptors, options);
  const levels = compileLevels(graph);
  const startupOrder = Object.freeze(levels.flatMap((level) => [...level]));
  const shutdownOrder = Object.freeze([...startupOrder].reverse());
  const memo = new Map<string, readonly string[]>();
  const transitiveDependencies: Record<string, readonly string[]> = {};
  for (const id of [...graph.keys()].sort()) {
    transitiveDependencies[id] = transitiveDependenciesFor(id, graph, memo);
  }

  return Object.freeze({
    revision,
    nodes: Object.freeze([...graph.values()].map((node) => node.descriptor).sort(descriptorComparator)),
    startupOrder,
    shutdownOrder,
    levels,
    dependents: recordFromGraph(graph, (node) => node.dependents),
    requiredDependencies: recordFromGraph(graph, (node) => node.requiredDependencies),
    allDependencies: recordFromGraph(graph, (node) => node.dependencies),
    transitiveDependencies: Object.freeze(transitiveDependencies),
    criticalPath: buildCriticalPath(levels, graph),
  });
};

export class DependencyGraphRegistry {
  readonly #descriptors = new Map<string, NormalizedComponentDescriptor>();
  #revision = 0;
  #cached: DependencyGraphSnapshot | null = null;

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#descriptors.size;
  }

  register(descriptor: ComponentDescriptor): NormalizedComponentDescriptor {
    const normalized = normalizeComponentDescriptor(descriptor);
    if (this.#descriptors.has(normalized.id)) throw new DuplicateComponentError(normalized.id);
    this.#descriptors.set(normalized.id, normalized);
    this.#touch();
    return normalized;
  }

  upsert(descriptor: ComponentDescriptor): NormalizedComponentDescriptor {
    const normalized = normalizeComponentDescriptor(descriptor);
    this.#descriptors.set(normalized.id, normalized);
    this.#touch();
    return normalized;
  }

  remove(componentId: string): boolean {
    const id = normalizeIdentifier(componentId, 'component id');
    const removed = this.#descriptors.delete(id);
    if (removed) this.#touch();
    return removed;
  }

  clear(): void {
    if (this.#descriptors.size === 0) return;
    this.#descriptors.clear();
    this.#touch();
  }

  has(componentId: string): boolean {
    try {
      return this.#descriptors.has(normalizeIdentifier(componentId, 'component id'));
    } catch {
      return false;
    }
  }

  get(componentId: string): NormalizedComponentDescriptor | null {
    try {
      return this.#descriptors.get(normalizeIdentifier(componentId, 'component id')) ?? null;
    } catch {
      return null;
    }
  }

  list(): readonly NormalizedComponentDescriptor[] {
    return Object.freeze([...this.#descriptors.values()].sort(descriptorComparator));
  }

  compile(options: DependencyGraphCompileOptions = {}): DependencyGraphSnapshot {
    if (
      this.#cached
      && options.allowMissingAfter !== false
      && options.allowMissingOptional !== false
    ) {
      return this.#cached;
    }
    const snapshot = compileDependencyGraph(this.list(), options, this.#revision);
    if (options.allowMissingAfter !== false && options.allowMissingOptional !== false) {
      this.#cached = snapshot;
    }
    return snapshot;
  }

  dependentsOf(componentId: string, transitive = false): readonly string[] {
    const id = normalizeIdentifier(componentId, 'component id');
    const snapshot = this.compile();
    if (!transitive) return snapshot.dependents[id] ?? Object.freeze([]);
    const result = new Set<string>();
    const queue = [...(snapshot.dependents[id] ?? [])];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || result.has(next)) continue;
      result.add(next);
      queue.push(...(snapshot.dependents[next] ?? []));
    }
    return Object.freeze([...result].sort());
  }

  requiredBy(componentId: string): readonly string[] {
    const id = normalizeIdentifier(componentId, 'component id');
    const snapshot = this.compile();
    return Object.freeze(
      snapshot.nodes
        .filter((node) => (snapshot.requiredDependencies[node.id] ?? []).includes(id))
        .map((node) => node.id)
        .sort(),
    );
  }

  #touch(): void {
    this.#revision += 1;
    this.#cached = null;
  }
}
