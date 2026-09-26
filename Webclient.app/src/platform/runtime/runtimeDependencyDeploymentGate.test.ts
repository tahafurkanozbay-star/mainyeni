import { describe, expect, it } from 'vitest';
import { RuntimeDependencyDeploymentGate } from './runtimeDependencyDeploymentGate';

const request = (overrides: Partial<Parameters<RuntimeDependencyDeploymentGate['evaluate']>[0]> = {}) => ({
  service: 'search', dependency: 'address', deploymentId: 'deploy-1', changeUnits: 10,
  required: true, dependencyReady: true, dependencyDegraded: false, evidenceAt: 1, evaluatedAt: 1, ...overrides,
});

describe('RuntimeDependencyDeploymentGate', () => {
  it('allows healthy bounded low-risk deployment', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    expect(gate.evaluate(request()).decision).toBe('allow');
    expect(gate.snapshot('search')?.activeDeployments).toEqual(['deploy-1']);
  });

  it('fails closed for stale evidence', () => {
    const gate = new RuntimeDependencyDeploymentGate({ maxEvidenceAgeMs: 10 });
    const result = gate.evaluate(request({ evidenceAt: 1, evaluatedAt: 20 }));
    expect(result.decision).toBe('block');
    expect(result.reasons).toContain('dependency-evidence-stale');
  });

  it('blocks a required dependency that is not ready', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    expect(gate.evaluate(request({ dependencyReady: false })).decision).toBe('block');
  });

  it('canaries an optional dependency that is not ready', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    const result = gate.evaluate(request({ required: false, dependencyReady: false }));
    expect(result.decision).toBe('canary');
    expect(result.reasons).toContain('optional-dependency-not-ready');
  });

  it('canaries a degraded dependency', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    expect(gate.evaluate(request({ dependencyDegraded: true })).decision).toBe('canary');
  });

  it('requires confirmation before high-risk deployment', () => {
    const gate = new RuntimeDependencyDeploymentGate({ recoveryConfirmations: 2 });
    const first = gate.evaluate(request({ changeUnits: 60 }));
    const second = gate.evaluate(request({ deploymentId: 'deploy-2', changeUnits: 60, evaluatedAt: 2, evidenceAt: 2 }));
    expect(first.decision).toBe('canary');
    expect(first.reasons).toContain('recovery-confirmation-pending');
    expect(second.decision).toBe('allow');
  });

  it('always canaries critical deployments', () => {
    const gate = new RuntimeDependencyDeploymentGate({ recoveryConfirmations: 1 });
    const result = gate.evaluate(request({ changeUnits: 90 }));
    expect(result.decision).toBe('canary');
    expect(result.reasons).toContain('critical-change-requires-canary');
  });

  it('bounds concurrent deployment capacity', () => {
    const gate = new RuntimeDependencyDeploymentGate({ maxConcurrentDeployments: 1 });
    expect(gate.evaluate(request()).decision).toBe('allow');
    const blocked = gate.evaluate(request({ deploymentId: 'deploy-2', evaluatedAt: 2, evidenceAt: 2 }));
    expect(blocked.decision).toBe('block');
    expect(blocked.reasons).toContain('deployment-capacity-exceeded');
    expect(gate.complete('search', 'deploy-1')).toBe(true);
    expect(gate.evaluate(request({ deploymentId: 'deploy-2', evaluatedAt: 3, evidenceAt: 3 })).decision).toBe('allow');
  });

  it('does not double-count repeated deployment ids', () => {
    const gate = new RuntimeDependencyDeploymentGate({ maxConcurrentDeployments: 1 });
    gate.evaluate(request());
    expect(gate.evaluate(request({ evaluatedAt: 2, evidenceAt: 2 })).decision).toBe('allow');
    expect(gate.snapshot('search')?.activeDeployments).toHaveLength(1);
  });

  it('rejects non-monotonic service evidence', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    gate.evaluate(request({ evaluatedAt: 10, evidenceAt: 10 }));
    expect(() => gate.evaluate(request({ evaluatedAt: 9, evidenceAt: 9 }))).toThrow(/monotonic/);
  });

  it('bounds service and dependency capacities', () => {
    const serviceGate = new RuntimeDependencyDeploymentGate({ maxServices: 1 });
    serviceGate.evaluate(request());
    expect(() => serviceGate.evaluate(request({ service: 'map', evaluatedAt: 2, evidenceAt: 2 }))).toThrow(/service capacity/);
    const dependencyGate = new RuntimeDependencyDeploymentGate({ maxDependenciesPerService: 1 });
    dependencyGate.evaluate(request());
    expect(() => dependencyGate.evaluate(request({ dependency: 'places', evaluatedAt: 2, evidenceAt: 2 }))).toThrow(/dependency capacity/);
  });

  it('bounds and defensively copies history', () => {
    const gate = new RuntimeDependencyDeploymentGate({ maxHistoryEntries: 2 });
    gate.evaluate(request({ deploymentId: 'a', evaluatedAt: 1, evidenceAt: 1 }));
    gate.evaluate(request({ deploymentId: 'b', evaluatedAt: 2, evidenceAt: 2 }));
    gate.evaluate(request({ deploymentId: 'c', evaluatedAt: 3, evidenceAt: 3 }));
    const history = gate.history();
    expect(history.map((entry) => entry.deploymentId)).toEqual(['b', 'c']);
    const mutable = [...history];
    mutable.pop();
    expect(gate.history()).toHaveLength(2);
  });

  it('returns deterministic snapshots and supports explicit removal', () => {
    const gate = new RuntimeDependencyDeploymentGate();
    gate.evaluate(request({ dependency: 'zeta', deploymentId: 'z' }));
    gate.evaluate(request({ dependency: 'alpha', deploymentId: 'a', evaluatedAt: 2, evidenceAt: 2 }));
    expect(gate.snapshot('search')?.dependencies).toEqual(['alpha', 'zeta']);
    expect(gate.snapshot('search')?.activeDeployments).toEqual(['a', 'z']);
    expect(gate.removeService('search')).toBe(true);
    expect(gate.snapshot('search')).toBeUndefined();
  });

  it('validates policy and request bounds', () => {
    expect(() => new RuntimeDependencyDeploymentGate({ elevatedChangeUnits: 60, highChangeUnits: 50 })).toThrow(/monotonic/);
    const gate = new RuntimeDependencyDeploymentGate();
    expect(() => gate.evaluate(request({ changeUnits: 101 }))).toThrow(/between 0 and 100/);
    expect(() => gate.evaluate(request({ service: ' ' }))).toThrow(/blank/);
    expect(() => gate.evaluate(request({ evaluatedAt: Number.NaN }))).toThrow(/finite/);
  });
});
