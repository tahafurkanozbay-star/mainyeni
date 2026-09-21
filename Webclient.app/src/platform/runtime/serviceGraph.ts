export type ServiceCriticality = 'required' | 'optional';
export type ServiceStartupMode = 'eager' | 'lazy';

export interface ServiceDescriptor {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly criticality?: ServiceCriticality;
  readonly startup?: ServiceStartupMode;
  readonly dependsOn?: readonly string[];
  readonly optionalDependencies?: readonly string[];
  readonly provides?: readonly string[];
  readonly consumes?: readonly string[];
}

export interface NormalizedServiceDescriptor {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly criticality: ServiceCriticality;
  readonly startup: ServiceStartupMode;
  readonly dependsOn: readonly string[];
  readonly optionalDependencies: readonly string[];
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
}

export type ServiceGraphIssueCode =
  | 'missing-dependency'
  | 'missing-capability'
  | 'dependency-cycle'
  | 'relation-capacity-exceeded';

export interface ServiceGraphIssue {
  readonly code: ServiceGraphIssueCode;
  readonly serviceId: string;
  readonly target: string;
}

export interface ServiceGraphLayer {
  readonly index: number;
  readonly services: readonly string[];
}

export interface ServiceGraphSnapshot {
  readonly revision: number;
  readonly valid: boolean;
  readonly serviceCount: number;
  readonly relationCount: number;
  readonly descriptors: readonly NormalizedServiceDescriptor[];
  readonly issues: readonly ServiceGraphIssue[];
  readonly startupOrder: readonly string[];
  readonly shutdownOrder: readonly string[];
  readonly layers: readonly ServiceGraphLayer[];
  readonly capabilities: Readonly<Record<string, readonly string[]>>;
  readonly dependents: Readonly<Record<string, readonly string[]>>;
  readonly fingerprint: string;
}

export interface ServiceGraphOptions {
  readonly maxServices?: number;
  readonly maxRelations?: number;
  readonly maxRelationsPerService?: number;
  readonly maxCapabilitiesPerService?: number;
  readonly maxIssues?: number;
}

export interface ServiceGraphBuilder {
  readonly register: (descriptor: ServiceDescriptor) => () => void;
  readonly replace: (descriptor: ServiceDescriptor) => void;
  readonly remove: (id: string) => boolean;
  readonly has: (id: string) => boolean;
  readonly descriptor: (id: string) => NormalizedServiceDescriptor | null;
  readonly ids: () => readonly string[];
  readonly snapshot: () => ServiceGraphSnapshot;
  readonly clear: () => void;
  readonly dispose: () => void;
}

export class ServiceGraphError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DESCRIPTOR'
      | 'DUPLICATE_SERVICE'
      | 'SERVICE_CAPACITY_EXCEEDED'
      | 'GRAPH_DISPOSED',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceGraphError';
  }
}

const ID_PATTERN = /^[a-z][a-z0-9.-]{0,79}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

const boundedInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ServiceGraphError(
      'INVALID_DESCRIPTOR',
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const normalizeId = (name: string, value: string): string => {
  if (typeof value !== 'string') {
    throw new ServiceGraphError('INVALID_DESCRIPTOR', name + ' must be a string');
  }
  const normalized = value.trim().toLowerCase();
  if (!ID_PATTERN.test(normalized)) {
    throw new ServiceGraphError(
      'INVALID_DESCRIPTOR',
      name + ' must match ' + ID_PATTERN.source,
    );
  }
  return normalized;
};

const normalizeVersion = (value: string): string => {
  if (typeof value !== 'string') {
    throw new ServiceGraphError('INVALID_DESCRIPTOR', 'version must be a string');
  }
  const normalized = value.trim();
  if (!VERSION_PATTERN.test(normalized)) {
    throw new ServiceGraphError(
      'INVALID_DESCRIPTOR',
      'version must contain bounded semver-compatible text',
    );
  }
  return normalized;
};

const normalizeStringList = (
  name: string,
  values: readonly string[] | undefined,
  maximum: number,
): readonly string[] => {
  if (!values) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > maximum) {
    throw new ServiceGraphError(
      'INVALID_DESCRIPTOR',
      name + ' exceeds the configured capacity',
    );
  }
  const normalized = new Set<string>();
  for (const value of values) normalized.add(normalizeId(name, value));
  return Object.freeze([...normalized].sort());
};

const normalizeCriticality = (
  value: ServiceCriticality | undefined,
): ServiceCriticality => {
  const normalized = value ?? 'required';
  if (normalized !== 'required' && normalized !== 'optional') {
    throw new ServiceGraphError('INVALID_DESCRIPTOR', 'unsupported service criticality');
  }
  return normalized;
};

const normalizeStartup = (
  value: ServiceStartupMode | undefined,
): ServiceStartupMode => {
  const normalized = value ?? 'eager';
  if (normalized !== 'eager' && normalized !== 'lazy') {
    throw new ServiceGraphError('INVALID_DESCRIPTOR', 'unsupported startup mode');
  }
  return normalized;
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const stableDescriptorLine = (descriptor: NormalizedServiceDescriptor): string =>
  [
    descriptor.id,
    descriptor.version,
    descriptor.domain,
    descriptor.criticality,
    descriptor.startup,
    descriptor.dependsOn.join(','),
    descriptor.optionalDependencies.join(','),
    descriptor.provides.join(','),
    descriptor.consumes.join(','),
  ].join('|');

const freezeDescriptor = (
  descriptor: NormalizedServiceDescriptor,
): NormalizedServiceDescriptor => Object.freeze({
  ...descriptor,
  dependsOn: Object.freeze([...descriptor.dependsOn]),
  optionalDependencies: Object.freeze([...descriptor.optionalDependencies]),
  provides: Object.freeze([...descriptor.provides]),
  consumes: Object.freeze([...descriptor.consumes]),
});

export const normalizeServiceDescriptor = (
  descriptor: ServiceDescriptor,
  options: Required<
    Pick<ServiceGraphOptions, 'maxRelationsPerService' | 'maxCapabilitiesPerService'>
  > = {
    maxRelationsPerService: 32,
    maxCapabilitiesPerService: 32,
  },
): NormalizedServiceDescriptor => {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new ServiceGraphError('INVALID_DESCRIPTOR', 'service descriptor is required');
  }
  const id = normalizeId('service id', descriptor.id);
  const dependsOn = normalizeStringList(
    'dependsOn',
    descriptor.dependsOn,
    options.maxRelationsPerService,
  );
  const optionalRaw = normalizeStringList(
    'optionalDependencies',
    descriptor.optionalDependencies,
    options.maxRelationsPerService,
  );
  const optionalDependencies = Object.freeze(
    optionalRaw.filter((dependency) => !dependsOn.includes(dependency)),
  );
  if (dependsOn.includes(id) || optionalDependencies.includes(id)) {
    throw new ServiceGraphError(
      'INVALID_DESCRIPTOR',
      'service cannot depend on itself: ' + id,
    );
  }

  return freezeDescriptor({
    id,
    version: normalizeVersion(descriptor.version),
    domain: normalizeId('service domain', descriptor.domain),
    criticality: normalizeCriticality(descriptor.criticality),
    startup: normalizeStartup(descriptor.startup),
    dependsOn,
    optionalDependencies,
    provides: normalizeStringList(
      'provides',
      descriptor.provides,
      options.maxCapabilitiesPerService,
    ),
    consumes: normalizeStringList(
      'consumes',
      descriptor.consumes,
      options.maxCapabilitiesPerService,
    ),
  });
};

const buildCapabilityMap = (
  descriptors: readonly NormalizedServiceDescriptor[],
): Readonly<Record<string, readonly string[]>> => {
  const providers = new Map<string, string[]>();
  for (const descriptor of descriptors) {
    for (const capability of descriptor.provides) {
      const services = providers.get(capability) ?? [];
      services.push(descriptor.id);
      providers.set(capability, services);
    }
  }
  const result: Record<string, readonly string[]> = {};
  for (const [capability, services] of [...providers.entries()].sort(([a], [b]) =>
    a.localeCompare(b))) {
    result[capability] = Object.freeze([...services].sort());
  }
  return Object.freeze(result);
};

const buildDependentMap = (
  descriptors: readonly NormalizedServiceDescriptor[],
): Readonly<Record<string, readonly string[]>> => {
  const dependents = new Map<string, Set<string>>();
  for (const descriptor of descriptors) dependents.set(descriptor.id, new Set());
  for (const descriptor of descriptors) {
    for (const dependency of descriptor.dependsOn) {
      dependents.get(dependency)?.add(descriptor.id);
    }
  }
  const result: Record<string, readonly string[]> = {};
  for (const [serviceId, values] of [...dependents.entries()].sort(([a], [b]) =>
    a.localeCompare(b))) {
    result[serviceId] = Object.freeze([...values].sort());
  }
  return Object.freeze(result);
};

const appendIssue = (
  issues: ServiceGraphIssue[],
  maximum: number,
  issue: ServiceGraphIssue,
): void => {
  if (issues.length >= maximum) return;
  issues.push(Object.freeze(issue));
};

const graphIssues = (
  descriptors: readonly NormalizedServiceDescriptor[],
  capabilities: Readonly<Record<string, readonly string[]>>,
  maxIssues: number,
  maxRelations: number,
): readonly ServiceGraphIssue[] => {
  const issues: ServiceGraphIssue[] = [];
  const ids = new Set(descriptors.map((descriptor) => descriptor.id));
  let relationCount = 0;

  for (const descriptor of descriptors) {
    relationCount += descriptor.dependsOn.length
      + descriptor.optionalDependencies.length
      + descriptor.provides.length
      + descriptor.consumes.length;
    for (const dependency of descriptor.dependsOn) {
      if (!ids.has(dependency)) {
        appendIssue(issues, maxIssues, {
          code: 'missing-dependency',
          serviceId: descriptor.id,
          target: dependency,
        });
      }
    }
    for (const capability of descriptor.consumes) {
      if (!(capability in capabilities)) {
        appendIssue(issues, maxIssues, {
          code: 'missing-capability',
          serviceId: descriptor.id,
          target: capability,
        });
      }
    }
  }

  if (relationCount > maxRelations && descriptors.length > 0) {
    appendIssue(issues, maxIssues, {
      code: 'relation-capacity-exceeded',
      serviceId: descriptors[0]?.id ?? 'graph',
      target: String(relationCount),
    });
  }

  return issues;
};

interface OrderResult {
  readonly order: readonly string[];
  readonly layers: readonly ServiceGraphLayer[];
  readonly cycleNodes: readonly string[];
}

const topologicalOrder = (
  descriptors: readonly NormalizedServiceDescriptor[],
): OrderResult => {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const descriptor of descriptors) {
    indegree.set(descriptor.id, 0);
    dependents.set(descriptor.id, new Set());
  }
  for (const descriptor of descriptors) {
    for (const dependency of descriptor.dependsOn) {
      if (!byId.has(dependency)) continue;
      indegree.set(descriptor.id, (indegree.get(descriptor.id) ?? 0) + 1);
      dependents.get(dependency)?.add(descriptor.id);
    }
  }

  let frontier = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  const layers: ServiceGraphLayer[] = [];
  let layerIndex = 0;

  while (frontier.length > 0) {
    const current = frontier;
    layers.push(Object.freeze({
      index: layerIndex,
      services: Object.freeze([...current]),
    }));
    layerIndex += 1;
    frontier = [];

    for (const id of current) {
      order.push(id);
      const nextServices = dependents.get(id);
      if (!nextServices) continue;
      for (const dependent of [...nextServices].sort()) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) frontier.push(dependent);
      }
    }
    frontier.sort();
  }

  const cycleNodes = [...indegree.entries()]
    .filter(([, count]) => count > 0)
    .map(([id]) => id)
    .sort();

  return Object.freeze({
    order: Object.freeze(order),
    layers: Object.freeze(layers),
    cycleNodes: Object.freeze(cycleNodes),
  });
};

const relationCount = (
  descriptors: readonly NormalizedServiceDescriptor[],
): number => descriptors.reduce(
  (total, descriptor) =>
    total
    + descriptor.dependsOn.length
    + descriptor.optionalDependencies.length
    + descriptor.provides.length
    + descriptor.consumes.length,
  0,
);

export const analyzeServiceGraph = (
  descriptorsInput: readonly ServiceDescriptor[] | readonly NormalizedServiceDescriptor[],
  options: ServiceGraphOptions = {},
  revision = 0,
): ServiceGraphSnapshot => {
  const maxServices = boundedInteger('maxServices', options.maxServices ?? 512, 1, 10_000);
  const maxRelations = boundedInteger(
    'maxRelations',
    options.maxRelations ?? 8_192,
    1,
    100_000,
  );
  const maxRelationsPerService = boundedInteger(
    'maxRelationsPerService',
    options.maxRelationsPerService ?? 32,
    1,
    256,
  );
  const maxCapabilitiesPerService = boundedInteger(
    'maxCapabilitiesPerService',
    options.maxCapabilitiesPerService ?? 32,
    1,
    256,
  );
  const maxIssues = boundedInteger('maxIssues', options.maxIssues ?? 256, 1, 4_096);

  if (descriptorsInput.length > maxServices) {
    throw new ServiceGraphError(
      'SERVICE_CAPACITY_EXCEEDED',
      'service graph exceeds maxServices',
    );
  }

  const descriptors = Object.freeze(
    descriptorsInput
      .map((descriptor) => normalizeServiceDescriptor(descriptor, {
        maxRelationsPerService,
        maxCapabilitiesPerService,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      throw new ServiceGraphError(
        'DUPLICATE_SERVICE',
        'duplicate service descriptor: ' + descriptor.id,
      );
    }
    seen.add(descriptor.id);
  }

  const capabilities = buildCapabilityMap(descriptors);
  const dependents = buildDependentMap(descriptors);
  const issues = [...graphIssues(descriptors, capabilities, maxIssues, maxRelations)];
  const ordering = topologicalOrder(descriptors);
  for (const serviceId of ordering.cycleNodes) {
    appendIssue(issues, maxIssues, {
      code: 'dependency-cycle',
      serviceId,
      target: serviceId,
    });
  }

  const valid = issues.length === 0;
  const startupOrder = valid ? ordering.order : Object.freeze([] as string[]);
  const layers = valid ? ordering.layers : Object.freeze([] as ServiceGraphLayer[]);
  const shutdownOrder = Object.freeze([...startupOrder].reverse());
  const fingerprint = fnv1a(
    [
      'service-graph-v1',
      ...descriptors.map(stableDescriptorLine),
      ...issues.map((issue) => [issue.code, issue.serviceId, issue.target].join(':')),
    ].join('\n'),
  );

  return Object.freeze({
    revision,
    valid,
    serviceCount: descriptors.length,
    relationCount: relationCount(descriptors),
    descriptors,
    issues: Object.freeze(issues),
    startupOrder,
    shutdownOrder,
    layers,
    capabilities,
    dependents,
    fingerprint,
  });
};

class MutableServiceGraph implements ServiceGraphBuilder {
  readonly #options: ServiceGraphOptions;
  readonly #descriptors = new Map<string, NormalizedServiceDescriptor>();
  #revision = 0;
  #disposed = false;

  constructor(options: ServiceGraphOptions = {}) {
    this.#options = options;
  }

  register(descriptor: ServiceDescriptor): () => void {
    this.#assertUsable();
    const normalized = normalizeServiceDescriptor(descriptor, {
      maxRelationsPerService: this.#options.maxRelationsPerService ?? 32,
      maxCapabilitiesPerService: this.#options.maxCapabilitiesPerService ?? 32,
    });
    if (this.#descriptors.has(normalized.id)) {
      throw new ServiceGraphError(
        'DUPLICATE_SERVICE',
        'service is already registered: ' + normalized.id,
      );
    }
    const maximum = this.#options.maxServices ?? 512;
    if (this.#descriptors.size >= maximum) {
      throw new ServiceGraphError(
        'SERVICE_CAPACITY_EXCEEDED',
        'service graph capacity is exhausted',
      );
    }
    this.#descriptors.set(normalized.id, normalized);
    this.#revision += 1;
    return () => {
      if (this.#disposed) return;
      if (this.#descriptors.delete(normalized.id)) this.#revision += 1;
    };
  }

  replace(descriptor: ServiceDescriptor): void {
    this.#assertUsable();
    const normalized = normalizeServiceDescriptor(descriptor, {
      maxRelationsPerService: this.#options.maxRelationsPerService ?? 32,
      maxCapabilitiesPerService: this.#options.maxCapabilitiesPerService ?? 32,
    });
    if (
      !this.#descriptors.has(normalized.id)
      && this.#descriptors.size >= (this.#options.maxServices ?? 512)
    ) {
      throw new ServiceGraphError(
        'SERVICE_CAPACITY_EXCEEDED',
        'service graph capacity is exhausted',
      );
    }
    this.#descriptors.set(normalized.id, normalized);
    this.#revision += 1;
  }

  remove(id: string): boolean {
    this.#assertUsable();
    const removed = this.#descriptors.delete(normalizeId('service id', id));
    if (removed) this.#revision += 1;
    return removed;
  }

  has(id: string): boolean {
    this.#assertUsable();
    return this.#descriptors.has(normalizeId('service id', id));
  }

  descriptor(id: string): NormalizedServiceDescriptor | null {
    this.#assertUsable();
    return this.#descriptors.get(normalizeId('service id', id)) ?? null;
  }

  ids(): readonly string[] {
    this.#assertUsable();
    return Object.freeze([...this.#descriptors.keys()].sort());
  }

  snapshot(): ServiceGraphSnapshot {
    this.#assertUsable();
    return analyzeServiceGraph(
      [...this.#descriptors.values()],
      this.#options,
      this.#revision,
    );
  }

  clear(): void {
    this.#assertUsable();
    if (this.#descriptors.size === 0) return;
    this.#descriptors.clear();
    this.#revision += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#descriptors.clear();
    this.#revision += 1;
    this.#disposed = true;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new ServiceGraphError('GRAPH_DISPOSED', 'service graph is disposed');
    }
  }
}

export const createServiceGraph = (
  options: ServiceGraphOptions = {},
): ServiceGraphBuilder => new MutableServiceGraph(options);
