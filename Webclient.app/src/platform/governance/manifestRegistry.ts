import {
  boundedText,
  freezeArray,
  freezeRecord,
  governanceIdentifier,
  stableFingerprint,
  type RuntimeManifestComponent,
  type RuntimeManifestIssue,
  type RuntimeManifestSnapshot,
} from './contracts';

export interface RuntimeManifestOptions {
  readonly maxComponents?: number;
  readonly maxDependenciesPerComponent?: number;
  readonly maxCapabilitiesPerComponent?: number;
}

export interface RuntimeManifestRegistry {
  readonly register: (component: RuntimeManifestComponent) => () => void;
  readonly replace: (component: RuntimeManifestComponent) => void;
  readonly remove: (id: string) => boolean;
  readonly component: (id: string) => RuntimeManifestComponent | null;
  readonly snapshot: () => RuntimeManifestSnapshot;
  readonly startupOrder: () => readonly string[];
  readonly validate: () => readonly RuntimeManifestIssue[];
  readonly clear: () => void;
  readonly dispose: () => void;
}

interface NormalizedComponent extends RuntimeManifestComponent {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly required: boolean;
  readonly startup: 'eager' | 'lazy';
  readonly dependsOn: readonly string[];
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
  readonly description: string;
}

const normalizeList = (values: readonly string[] | undefined, field: string, maximum: number): readonly string[] => {
  const output = new Set<string>();
  for (const value of values ?? []) {
    output.add(governanceIdentifier(value, field, 120));
    if (output.size > maximum) throw new RangeError(`${field} exceeds capacity ${maximum}`);
  }
  return freezeArray(output);
};

const normalizeVersion = (value: unknown): string => {
  const normalized = boundedText(value, '', 40);
  if (!normalized || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(normalized)) {
    throw new TypeError('manifest version must be bounded semver-like text');
  }
  return normalized;
};

const normalizeComponent = (
  component: RuntimeManifestComponent,
  maxDependencies: number,
  maxCapabilities: number,
): NormalizedComponent => {
  if (!component || typeof component !== 'object') throw new TypeError('runtime manifest component is required');
  const id = governanceIdentifier(component.id, 'component id', 120);
  const dependsOn = normalizeList(component.dependsOn, 'component dependency', maxDependencies);
  if (dependsOn.includes(id)) throw new Error(`component ${id} cannot depend on itself`);
  return Object.freeze({
    ...component,
    id,
    version: normalizeVersion(component.version),
    domain: governanceIdentifier(component.domain, 'component domain', 80),
    required: component.required !== false,
    startup: component.startup ?? 'eager',
    dependsOn,
    provides: normalizeList(component.provides, 'provided capability', maxCapabilities),
    consumes: normalizeList(component.consumes, 'consumed capability', maxCapabilities),
    description: boundedText(component.description, '', 240),
  });
};

const manifestIssue = (
  code: RuntimeManifestIssue['code'],
  message: string,
  componentId?: string,
): RuntimeManifestIssue => Object.freeze({
  ...(componentId ? { componentId } : {}),
  code,
  message: boundedText(message, code, 240),
});

export const createRuntimeManifestRegistry = (
  options: RuntimeManifestOptions = {},
): RuntimeManifestRegistry => {
  const maxComponents = Math.min(2048, Math.max(1, Math.trunc(options.maxComponents ?? 256)));
  const maxDependencies = Math.min(128, Math.max(0, Math.trunc(options.maxDependenciesPerComponent ?? 24)));
  const maxCapabilities = Math.min(128, Math.max(0, Math.trunc(options.maxCapabilitiesPerComponent ?? 32)));
  const components = new Map<string, NormalizedComponent>();
  let revision = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('runtime manifest registry has been disposed');
  };

  const register = (input: RuntimeManifestComponent): (() => void) => {
    assertActive();
    if (components.size >= maxComponents) throw new RangeError('runtime manifest component capacity exceeded');
    const component = normalizeComponent(input, maxDependencies, maxCapabilities);
    if (components.has(component.id)) throw new Error(`runtime manifest component already registered: ${component.id}`);
    components.set(component.id, component);
    revision += 1;
    return () => {
      if (components.delete(component.id)) revision += 1;
    };
  };

  const replace = (input: RuntimeManifestComponent): void => {
    assertActive();
    const component = normalizeComponent(input, maxDependencies, maxCapabilities);
    if (!components.has(component.id) && components.size >= maxComponents) {
      throw new RangeError('runtime manifest component capacity exceeded');
    }
    components.set(component.id, component);
    revision += 1;
  };

  const remove = (id: string): boolean => {
    assertActive();
    const removed = components.delete(governanceIdentifier(id, 'component id', 120));
    if (removed) revision += 1;
    return removed;
  };

  const capabilityProviders = (): Map<string, string[]> => {
    const providers = new Map<string, string[]>();
    for (const component of components.values()) {
      for (const capability of component.provides) {
        const owners = providers.get(capability) ?? [];
        owners.push(component.id);
        providers.set(capability, owners);
      }
    }
    return providers;
  };

  const validate = (): readonly RuntimeManifestIssue[] => {
    assertActive();
    const issues: RuntimeManifestIssue[] = [];
    const providers = capabilityProviders();

    for (const component of components.values()) {
      for (const dependency of component.dependsOn) {
        if (!components.has(dependency)) {
          issues.push(manifestIssue('missing-dependency', `component depends on missing component ${dependency}`, component.id));
        }
      }
      for (const capability of component.consumes) {
        const owners = providers.get(capability) ?? [];
        if (owners.length === 0) {
          issues.push(manifestIssue('missing-capability', `component consumes unavailable capability ${capability}`, component.id));
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const start = path.indexOf(id);
        const cycle = start >= 0 ? [...path.slice(start), id] : [id];
        issues.push(manifestIssue('dependency-cycle', `dependency cycle: ${cycle.join(' -> ')}`, id));
        return;
      }
      visiting.add(id);
      path.push(id);
      for (const dependency of components.get(id)?.dependsOn ?? []) {
        if (components.has(dependency)) visit(dependency);
      }
      path.pop();
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of components.keys()) visit(id);

    return freezeArray(
      issues.sort((left, right) =>
        (left.componentId ?? '').localeCompare(right.componentId ?? '', 'en') ||
        left.code.localeCompare(right.code, 'en')),
    );
  };

  const startupOrder = (): readonly string[] => {
    assertActive();
    const issues = validate();
    if (issues.some((item) => item.code === 'dependency-cycle' || item.code === 'missing-dependency')) {
      return Object.freeze([]);
    }
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const component of components.values()) {
      indegree.set(component.id, component.dependsOn.length);
      for (const dependency of component.dependsOn) {
        const values = dependents.get(dependency) ?? [];
        values.push(component.id);
        dependents.set(dependency, values);
      }
    }
    const ready = [...components.values()]
      .filter((component) => (indegree.get(component.id) ?? 0) === 0)
      .sort((a, b) =>
        Number(a.startup === 'lazy') - Number(b.startup === 'lazy') ||
        a.id.localeCompare(b.id, 'en'));
    const ordered: string[] = [];
    while (ready.length > 0) {
      const component = ready.shift();
      if (!component) break;
      ordered.push(component.id);
      for (const dependentId of dependents.get(component.id) ?? []) {
        const next = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, next);
        if (next === 0) {
          const dependent = components.get(dependentId);
          if (dependent) {
            ready.push(dependent);
            ready.sort((a, b) =>
              Number(a.startup === 'lazy') - Number(b.startup === 'lazy') ||
              a.id.localeCompare(b.id, 'en'));
          }
        }
      }
    }
    return ordered.length === components.size ? freezeArray(ordered) : Object.freeze([]);
  };

  const snapshot = (): RuntimeManifestSnapshot => {
    assertActive();
    const orderedComponents = freezeArray(
      [...components.values()].sort((left, right) => left.id.localeCompare(right.id, 'en')),
    );
    const issues = validate();
    const providers = capabilityProviders();
    const capabilities: Record<string, readonly string[]> = {};
    [...providers.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .forEach(([capability, owners]) => {
        capabilities[capability] = freezeArray(owners.sort((left, right) => left.localeCompare(right, 'en')));
      });
    const order = startupOrder();
    return Object.freeze({
      revision,
      valid: issues.length === 0,
      components: orderedComponents,
      startupOrder: order,
      issues,
      capabilities: freezeRecord(capabilities),
      fingerprint: stableFingerprint({
        components: orderedComponents.map((component) => ({
          id: component.id,
          version: component.version,
          domain: component.domain,
          required: component.required,
          startup: component.startup,
          dependsOn: component.dependsOn,
          provides: component.provides,
          consumes: component.consumes,
        })),
        issues: issues.map((item) => [item.componentId ?? '', item.code]),
      }),
    });
  };

  const clear = (): void => {
    assertActive();
    if (components.size > 0) revision += 1;
    components.clear();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    components.clear();
  };

  return Object.freeze({
    register,
    replace,
    remove,
    component: (id: string) => components.get(governanceIdentifier(id, 'component id', 120)) ?? null,
    snapshot,
    startupOrder,
    validate,
    clear,
    dispose,
  });
};
