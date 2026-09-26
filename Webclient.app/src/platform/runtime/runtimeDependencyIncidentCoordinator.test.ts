import { describe, expect, it } from 'vitest';
import { RuntimeDependencyIncidentCoordinator } from './runtimeDependencyIncidentCoordinator';

const evidence = (overrides: Partial<Parameters<RuntimeDependencyIncidentCoordinator['evaluate']>[0]> = {}) => ({
  service: 'map-shell',
  dependency: 'feature-catalog',
  incidentId: 'incident-1',
  dependencyReady: true,
  dependencyDegraded: false,
  required: true,
  observedAt: 100,
  evaluatedAt: 100,
  ...overrides,
});

describe('RuntimeDependencyIncidentCoordinator', () => {
  it('keeps healthy evidence in observing state without opening an incident', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    const result = coordinator.evaluate(evidence());
    expect(result.state).toBe('observing');
    expect(result.severity).toBe('info');
    expect(result.consecutiveFailures).toBe(0);
    expect(result.openedAt).toBeUndefined();
  });

  it('opens a warning incident after the configured consecutive failure threshold', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 2, criticalFailureCount: 4 });
    expect(coordinator.evaluate(evidence({ dependencyReady: false, required: false })).state).toBe('observing');
    const second = coordinator.evaluate(evidence({ dependencyReady: false, required: false, observedAt: 101, evaluatedAt: 101 }));
    expect(second.state).toBe('open');
    expect(second.severity).toBe('warning');
    expect(second.openedAt).toBe(101);
  });

  it('immediately mitigates a required dependency outage', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    const result = coordinator.evaluate(evidence({ dependencyReady: false }));
    expect(result.state).toBe('mitigating');
    expect(result.severity).toBe('critical');
    expect(result.reasons).toContain('critical-dependency-impact');
  });

  it('escalates repeated optional dependency failures to critical', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 2, criticalFailureCount: 3 });
    coordinator.evaluate(evidence({ dependencyReady: false, required: false }));
    coordinator.evaluate(evidence({ dependencyReady: false, required: false, observedAt: 101, evaluatedAt: 101 }));
    const result = coordinator.evaluate(evidence({ dependencyReady: false, required: false, observedAt: 102, evaluatedAt: 102 }));
    expect(result.state).toBe('mitigating');
    expect(result.severity).toBe('critical');
  });

  it('treats degraded dependencies as unhealthy evidence', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 1, criticalFailureCount: 3 });
    const result = coordinator.evaluate(evidence({ dependencyDegraded: true, required: false }));
    expect(result.state).toBe('open');
    expect(result.reasons).toContain('dependency-degraded');
  });

  it('fails closed when evidence is stale', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxEvidenceAgeMs: 10, warningFailureCount: 1, criticalFailureCount: 3 });
    const result = coordinator.evaluate(evidence({ observedAt: 1, evaluatedAt: 20, required: false }));
    expect(result.state).toBe('open');
    expect(result.reasons).toContain('dependency-evidence-stale');
  });

  it('fails closed when evidence comes from the future', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 1, criticalFailureCount: 3 });
    const result = coordinator.evaluate(evidence({ observedAt: 200, evaluatedAt: 100, required: false }));
    expect(result.reasons).toContain('dependency-evidence-stale');
  });

  it('requires bounded recovery confirmation before resolving', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ recoveryConfirmations: 2 });
    coordinator.evaluate(evidence({ dependencyReady: false }));
    const first = coordinator.evaluate(evidence({ observedAt: 101, evaluatedAt: 101 }));
    expect(first.state).toBe('recovering');
    expect(first.recoveryEvidence).toBe(1);
    const second = coordinator.evaluate(evidence({ observedAt: 102, evaluatedAt: 102 }));
    expect(second.state).toBe('resolved');
    expect(second.reasons).toContain('recovery-confirmed');
    expect(coordinator.snapshot('map-shell')?.openIncidentIds).toEqual([]);
  });

  it('resets recovery confirmation when unhealthy evidence returns', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ recoveryConfirmations: 3 });
    coordinator.evaluate(evidence({ dependencyReady: false }));
    expect(coordinator.evaluate(evidence({ observedAt: 101, evaluatedAt: 101 })).recoveryEvidence).toBe(1);
    const relapse = coordinator.evaluate(evidence({ dependencyReady: false, observedAt: 102, evaluatedAt: 102 }));
    expect(relapse.recoveryEvidence).toBe(0);
    expect(relapse.state).toBe('mitigating');
  });

  it('escalates an incident that remains open beyond its deadline', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 1, criticalFailureCount: 10, escalationAfterMs: 10 });
    coordinator.evaluate(evidence({ dependencyReady: false, required: false, evaluatedAt: 100 }));
    const result = coordinator.evaluate(evidence({ dependencyReady: false, required: false, observedAt: 111, evaluatedAt: 111 }));
    expect(result.state).toBe('mitigating');
    expect(result.severity).toBe('critical');
    expect(result.reasons).toContain('incident-escalation-deadline-exceeded');
  });

  it('rejects non-monotonic evaluation evidence per service', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence({ evaluatedAt: 100 }));
    expect(() => coordinator.evaluate(evidence({ observedAt: 99, evaluatedAt: 99 }))).toThrow('monotonic');
  });

  it('allows independent monotonic clocks for separate services', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence({ evaluatedAt: 500 }));
    expect(() => coordinator.evaluate(evidence({ service: 'search', incidentId: 'search-1', observedAt: 10, evaluatedAt: 10 }))).not.toThrow();
  });

  it('rejects reuse of an incident id for another dependency', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence());
    expect(() => coordinator.evaluate(evidence({ dependency: 'address-index', evaluatedAt: 101, observedAt: 101 }))).toThrow('cannot be reused');
  });

  it('enforces bounded service capacity', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxServices: 1 });
    coordinator.evaluate(evidence());
    expect(() => coordinator.evaluate(evidence({ service: 'search', incidentId: 'search-1' }))).toThrow('service capacity');
  });

  it('enforces bounded dependency capacity', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxDependenciesPerService: 1 });
    coordinator.evaluate(evidence());
    expect(() => coordinator.evaluate(evidence({ dependency: 'address-index', incidentId: 'incident-2', evaluatedAt: 101, observedAt: 101 }))).toThrow('dependency capacity');
  });

  it('enforces bounded open incident capacity', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxOpenIncidents: 1 });
    coordinator.evaluate(evidence());
    expect(() => coordinator.evaluate(evidence({ incidentId: 'incident-2', evaluatedAt: 101, observedAt: 101 }))).toThrow('incident capacity');
  });

  it('releases incident capacity after confirmed recovery', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxOpenIncidents: 1, recoveryConfirmations: 1 });
    coordinator.evaluate(evidence({ dependencyReady: false }));
    expect(coordinator.evaluate(evidence({ observedAt: 101, evaluatedAt: 101 })).state).toBe('resolved');
    expect(() => coordinator.evaluate(evidence({ incidentId: 'incident-2', observedAt: 102, evaluatedAt: 102 }))).not.toThrow();
  });

  it('bounds history to the configured capacity', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator({ maxHistoryEntries: 2 });
    coordinator.evaluate(evidence({ evaluatedAt: 100 }));
    coordinator.evaluate(evidence({ evaluatedAt: 101, observedAt: 101 }));
    coordinator.evaluate(evidence({ evaluatedAt: 102, observedAt: 102 }));
    expect(coordinator.history()).toHaveLength(2);
    expect(coordinator.history()[0]?.evaluatedAt).toBe(101);
  });

  it('returns defensive history copies', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence({ dependencyReady: false }));
    const history = coordinator.history().map((entry) => ({ ...entry, reasons: [...entry.reasons] }));
    history[0]?.reasons.push('mutated');
    expect(coordinator.history()[0]?.reasons).not.toContain('mutated');
  });

  it('returns deterministic sorted snapshots', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence({ dependency: 'z', incidentId: 'z-incident' }));
    coordinator.evaluate(evidence({ dependency: 'a', incidentId: 'a-incident', observedAt: 101, evaluatedAt: 101 }));
    const snapshot = coordinator.snapshot('map-shell');
    expect(snapshot?.dependencies).toEqual(['a', 'z']);
    expect(snapshot?.openIncidentIds).toEqual(['a-incident', 'z-incident']);
  });

  it('removes service state explicitly', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    coordinator.evaluate(evidence());
    expect(coordinator.removeService('map-shell')).toBe(true);
    expect(coordinator.snapshot('map-shell')).toBeUndefined();
    expect(coordinator.removeService('map-shell')).toBe(false);
  });

  it.each([
    [{ maxServices: 0 }, 'maxServices'],
    [{ maxDependenciesPerService: 0 }, 'maxDependenciesPerService'],
    [{ maxOpenIncidents: 0 }, 'maxOpenIncidents'],
    [{ maxHistoryEntries: 0 }, 'maxHistoryEntries'],
    [{ maxEvidenceAgeMs: 0 }, 'maxEvidenceAgeMs'],
    [{ recoveryConfirmations: 0 }, 'recoveryConfirmations'],
    [{ escalationAfterMs: 0 }, 'escalationAfterMs'],
  ])('rejects invalid positive integer policy %o', (policy, expected) => {
    expect(() => new RuntimeDependencyIncidentCoordinator(policy)).toThrow(expected);
  });

  it('rejects non-monotonic failure thresholds', () => {
    expect(() => new RuntimeDependencyIncidentCoordinator({ warningFailureCount: 4, criticalFailureCount: 4 })).toThrow('lower');
  });

  it('validates required evidence identifiers', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    expect(() => coordinator.evaluate(evidence({ service: ' ' }))).toThrow('service');
    expect(() => coordinator.evaluate(evidence({ dependency: '' }))).toThrow('dependency');
    expect(() => coordinator.evaluate(evidence({ incidentId: '' }))).toThrow('incidentId');
  });

  it('rejects non-finite timestamps', () => {
    const coordinator = new RuntimeDependencyIncidentCoordinator();
    expect(() => coordinator.evaluate(evidence({ observedAt: Number.NaN }))).toThrow('finite');
    expect(() => coordinator.evaluate(evidence({ evaluatedAt: Number.POSITIVE_INFINITY }))).toThrow('finite');
  });
});
