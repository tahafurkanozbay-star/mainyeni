import { describe, expect, it, vi } from 'vitest';
import type { StoreRestorePlan } from './stateRestorePlan';
import { executeStoreRestorePlan } from './stateRestoreExecutor';

const plan = (): StoreRestorePlan => ({
  schemaVersion: 1,
  actions: [
    { type: 'CommonReducer/SetModuleSelectBarVisible', payload: true },
    { type: 'MapReducer/SetMobileRightClick', payload: true },
    { type: 'ActiveOnLeftClick/Enable' },
  ],
  skippedWindows: 0,
  truncated: false,
});

describe('stateRestoreExecutor', () => {
  it('dispatches planned actions in deterministic order', () => {
    const dispatch = vi.fn();
    const result = executeStoreRestorePlan(plan(), dispatch);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual([
      'CommonReducer/SetModuleSelectBarVisible',
      'MapReducer/SetMobileRightClick',
      'ActiveOnLeftClick/Enable',
    ]);
    expect(result).toEqual({
      planned: 3,
      dispatched: 3,
      cancelled: false,
      truncated: false,
    });
  });

  it('enforces an explicit execution action budget', () => {
    const dispatch = vi.fn();
    const result = executeStoreRestorePlan(plan(), dispatch, { maxActions: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      planned: 3,
      dispatched: 1,
      truncated: true,
    });
  });

  it('honors caller cancellation before dispatching later actions', () => {
    const controller = new AbortController();
    const dispatch = vi.fn(() => {
      controller.abort(new Error('navigation changed'));
    });
    expect(() => executeStoreRestorePlan(plan(), dispatch, {
      signal: controller.signal,
    })).toThrow('navigation changed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects missing dispatch functions', () => {
    expect(() => executeStoreRestorePlan(
      plan(),
      null as unknown as (action: StoreRestorePlan['actions'][number]) => unknown,
    )).toThrow(/dispatch function/);
  });
});
