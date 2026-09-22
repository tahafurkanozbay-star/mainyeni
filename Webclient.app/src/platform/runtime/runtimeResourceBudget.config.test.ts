import { describe, expect, it } from 'vitest';
import { RuntimeResourceBudget } from './runtimeResourceBudget';

describe('RuntimeResourceBudget zero-reserve configuration', () => {
  it('allows all lanes to share global capacity when both reservations are zero', () => {
    const budget = new RuntimeResourceBudget({
      maxBytes: 30,
      maxItems: 3,
      maxItemBytes: 10,
      criticalReservedBytes: 0,
      interactiveReservedBytes: 0,
    });
    expect(budget.acquire('background', 'background', 10).admitted).toBe(true);
    expect(budget.acquire('interactive', 'interactive', 10).admitted).toBe(true);
    expect(budget.acquire('critical', 'critical', 10).admitted).toBe(true);
    expect(budget.snapshot()).toMatchObject({ items: 3, bytes: 30, remainingBytes: 0 });
  });
});
