import { describe, expect, it } from 'vitest';
import { RuntimeResourceBudget } from './runtimeResourceBudget';

describe('RuntimeResourceBudget boundary semantics', () => {
  it('admits an item exactly at the configured per-item maximum', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 40, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    expect(budget.acquire('exact-item', 'critical', 40).admitted).toBe(true);
    expect(budget.snapshot()).toMatchObject({ items: 1, bytes: 40, remainingBytes: 60 });
  });

  it('admits critical work exactly to global capacity', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 20 });
    expect(budget.acquire('exact-global', 'critical', 100).admitted).toBe(true);
    expect(budget.snapshot().remainingBytes).toBe(0);
  });

  it('admits interactive work exactly to the critical reserve boundary', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 0 });
    expect(budget.acquire('interactive-boundary', 'interactive', 80).admitted).toBe(true);
    expect(budget.snapshot().remainingBytes).toBe(20);
  });

  it('rejects interactive work one byte beyond the critical reserve boundary', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 0 });
    expect(budget.acquire('interactive-over', 'interactive', 81)).toMatchObject({ admitted: false, reason: 'lane-capacity' });
  });

  it('admits background work exactly to the combined reserve boundary', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 30 });
    expect(budget.acquire('background-boundary', 'background', 50).admitted).toBe(true);
    expect(budget.snapshot().remainingBytes).toBe(50);
  });

  it('rejects background work one byte beyond the combined reserve boundary', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 30 });
    expect(budget.acquire('background-over', 'background', 51)).toMatchObject({ admitted: false, reason: 'lane-capacity' });
  });

  it('restores reserved capacity immediately after explicit release', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 20, interactiveReservedBytes: 30 });
    const lease = budget.acquire('background-a', 'background', 50).lease;
    expect(budget.acquire('background-b', 'background', 1)).toMatchObject({ admitted: false, reason: 'lane-capacity' });
    lease?.release();
    expect(budget.acquire('background-b', 'background', 50).admitted).toBe(true);
  });

  it('does not let rejected requests consume bytes or item slots', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItems: 1, maxItemBytes: 50, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    expect(budget.acquire('too-large', 'critical', 51).admitted).toBe(false);
    expect(budget.snapshot()).toMatchObject({ items: 0, bytes: 0, rejected: 1 });
    expect(budget.acquire('valid', 'critical', 50).admitted).toBe(true);
  });

  it('keeps duplicate rejection from replacing original ownership', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    const original = budget.acquire('same', 'critical', 40).lease;
    expect(budget.acquire('same', 'background', 10)).toMatchObject({ admitted: false, reason: 'duplicate' });
    expect(budget.snapshot().lanes.critical).toEqual({ items: 1, bytes: 40 });
    expect(budget.snapshot().lanes.background).toEqual({ items: 0, bytes: 0 });
    original?.release();
    expect(budget.snapshot().items).toBe(0);
  });

  it('keeps stale pre-reset leases from releasing new ownership with the same key', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 100, maxItemBytes: 100, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    const stale = budget.acquire('same', 'critical', 40).lease;
    budget.reset();
    const current = budget.acquire('same', 'critical', 30).lease;
    stale?.release();
    expect(budget.snapshot()).toMatchObject({ items: 1, bytes: 30, released: 0 });
    current?.release();
    expect(budget.snapshot()).toMatchObject({ items: 0, released: 1 });
  });

  it('preserves exact integer accounting across many small leases', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 1000, maxItems: 100, maxItemBytes: 100, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    const leases = Array.from({ length: 50 }, (_, index) => budget.acquire(`item-${index}`, 'critical', 7).lease);
    expect(budget.snapshot()).toMatchObject({ items: 50, bytes: 350, remainingBytes: 650 });
    for (const lease of leases) lease?.release();
    expect(budget.snapshot()).toMatchObject({ items: 0, bytes: 0, remainingBytes: 1000, released: 50 });
  });
});
