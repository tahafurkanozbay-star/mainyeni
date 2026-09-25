import { describe, expect, it } from 'vitest';
import { RuntimeDependencyEvidenceLedger } from './runtimeDependencyEvidenceLedger';
import { RuntimeDependencyIncidentCoordinator } from './runtimeDependencyIncidentCoordinator';
import { RuntimeDependencyMaintenanceRegistry } from './runtimeDependencyMaintenanceRegistry';

describe('dependency operations governance integration', () => {
  it('keeps maintenance, evidence, and incident decisions deterministic across recovery', () => {
    const ledger = new RuntimeDependencyEvidenceLedger({ maxEvidenceAgeMs: 100 });
    const maintenance = new RuntimeDependencyMaintenanceRegistry();
    const incidents = new RuntimeDependencyIncidentCoordinator({ recoveryConfirmations: 2 });

    maintenance.register({
      id: 'catalog-upgrade',
      service: 'map-shell',
      dependency: 'feature-catalog',
      startsAt: 100,
      endsAt: 200,
      mode: 'degraded',
      reason: 'planned catalog upgrade',
    });
    ledger.append({ dependency: 'feature-catalog', source: 'health-probe', sequence: 1, healthy: false, observedAt: 120 });

    expect(maintenance.evaluate('map-shell', 'feature-catalog', 120).mode).toBe('degraded');
    expect(ledger.fresh('feature-catalog', 120)).toHaveLength(1);
    const failure = incidents.evaluate({
      service: 'map-shell', dependency: 'feature-catalog', incidentId: 'catalog-incident', required: true,
      dependencyReady: false, dependencyDegraded: true, observedAt: 120, evaluatedAt: 120,
    });
    expect(failure.state).toBe('mitigating');

    ledger.append({ dependency: 'feature-catalog', source: 'health-probe', sequence: 2, healthy: true, observedAt: 130 });
    const recovery = incidents.evaluate({
      service: 'map-shell', dependency: 'feature-catalog', incidentId: 'catalog-incident', required: true,
      dependencyReady: true, dependencyDegraded: false, observedAt: 130, evaluatedAt: 130,
    });
    expect(recovery.state).toBe('recovering');
    expect(recovery.recoveryEvidence).toBe(1);
    expect(maintenance.evaluate('map-shell', 'feature-catalog', 130).activeWindowIds).toEqual(['catalog-upgrade']);
  });
});
