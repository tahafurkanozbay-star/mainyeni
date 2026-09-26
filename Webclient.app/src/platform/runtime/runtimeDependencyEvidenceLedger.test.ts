import { describe, expect, it } from 'vitest';
import { RuntimeDependencyEvidenceLedger } from './runtimeDependencyEvidenceLedger';

const record = (overrides = {}) => ({ dependency: 'catalog', source: 'probe-a', sequence: 1, healthy: true, observedAt: 100, ...overrides });

describe('RuntimeDependencyEvidenceLedger', () => {
  it('stores immutable evidence snapshots', () => {
    const ledger = new RuntimeDependencyEvidenceLedger();
    ledger.append(record());
    expect(ledger.snapshot('catalog')?.entries).toEqual([record()]);
  });

  it('requires increasing sequence and monotonic timestamps', () => {
    const ledger = new RuntimeDependencyEvidenceLedger();
    ledger.append(record());
    expect(() => ledger.append(record({ sequence: 1, observedAt: 101 }))).toThrow('sequence');
    expect(() => ledger.append(record({ sequence: 2, observedAt: 99 }))).toThrow('monotonic');
  });

  it('bounds retained evidence per dependency', () => {
    const ledger = new RuntimeDependencyEvidenceLedger({ maxEntriesPerDependency: 2 });
    ledger.append(record());
    ledger.append(record({ sequence: 2, observedAt: 101 }));
    ledger.append(record({ sequence: 3, observedAt: 102 }));
    expect(ledger.snapshot('catalog')?.entries.map((entry) => entry.sequence)).toEqual([2, 3]);
  });

  it('returns only non-future fresh evidence', () => {
    const ledger = new RuntimeDependencyEvidenceLedger({ maxEvidenceAgeMs: 10 });
    ledger.append(record({ observedAt: 100 }));
    ledger.append(record({ sequence: 2, observedAt: 120 }));
    expect(ledger.fresh('catalog', 105).map((entry) => entry.sequence)).toEqual([1]);
  });

  it('enforces dependency capacity and deterministic listing', () => {
    const ledger = new RuntimeDependencyEvidenceLedger({ maxDependencies: 2 });
    ledger.append(record({ dependency: 'z' }));
    ledger.append(record({ dependency: 'a' }));
    expect(ledger.dependencies()).toEqual(['a', 'z']);
    expect(() => ledger.append(record({ dependency: 'third' }))).toThrow('capacity');
  });

  it('removes dependency evidence explicitly', () => {
    const ledger = new RuntimeDependencyEvidenceLedger();
    ledger.append(record());
    expect(ledger.remove('catalog')).toBe(true);
    expect(ledger.snapshot('catalog')).toBeUndefined();
  });

  it('validates policy and record input', () => {
    expect(() => new RuntimeDependencyEvidenceLedger({ maxDependencies: 0 })).toThrow('maxDependencies');
    expect(() => new RuntimeDependencyEvidenceLedger({ maxEntriesPerDependency: 0 })).toThrow('maxEntriesPerDependency');
    expect(() => new RuntimeDependencyEvidenceLedger({ maxEvidenceAgeMs: 0 })).toThrow('maxEvidenceAgeMs');
    const ledger = new RuntimeDependencyEvidenceLedger();
    expect(() => ledger.append(record({ dependency: '' }))).toThrow('dependency');
    expect(() => ledger.append(record({ source: '' }))).toThrow('source');
    expect(() => ledger.append(record({ sequence: 0 }))).toThrow('sequence');
    expect(() => ledger.append(record({ observedAt: Number.NaN }))).toThrow('finite');
  });
});
