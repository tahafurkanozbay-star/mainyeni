import type { StoreRestorePlan } from './stateRestorePlan';

export interface StoreRestoreExecutionOptions {
  readonly signal?: AbortSignal;
  readonly maxActions?: number;
}

export interface StoreRestoreExecutionResult {
  readonly planned: number;
  readonly dispatched: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

const cancellationError = (): Error & { code: string } =>
  Object.assign(new Error('Store restore execution was cancelled.'), {
    code: 'STORE_RESTORE_CANCELLED',
  });

export const executeStoreRestorePlan = (
  plan: StoreRestorePlan,
  dispatch: (action: StoreRestorePlan['actions'][number]) => unknown,
  options: StoreRestoreExecutionOptions = {},
): StoreRestoreExecutionResult => {
  if (typeof dispatch !== 'function') {
    throw new TypeError('Store restore execution requires a dispatch function.');
  }

  const maxActions = Number.isFinite(options.maxActions)
    ? Math.min(10_000, Math.max(0, Math.trunc(options.maxActions ?? 0)))
    : plan.actions.length;
  const limit = options.maxActions === undefined
    ? plan.actions.length
    : Math.min(plan.actions.length, maxActions);

  let dispatched = 0;
  for (let index = 0; index < limit; index += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? cancellationError();
    }
    const action = plan.actions[index];
    if (!action) continue;
    dispatch(action);
    dispatched += 1;
  }

  return Object.freeze({
    planned: plan.actions.length,
    dispatched,
    cancelled: false,
    truncated: plan.truncated || limit < plan.actions.length,
  });
};
