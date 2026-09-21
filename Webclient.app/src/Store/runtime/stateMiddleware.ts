import type { Middleware } from 'redux';
import type { RootState } from '../contracts';
import type { StoreStateRuntime } from './contracts';

const defaultClock = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

export const createStoreStateRuntimeMiddleware = (
  runtime: StoreStateRuntime,
  clock: () => number = defaultClock,
): Middleware<{}, RootState> => (api) => (next) => (action) => {
  const previousState = api.getState();
  if (!runtime.initialized) runtime.initialize(previousState);
  const startedAt = clock();

  try {
    const result = next(action);
    const completedAt = clock();
    runtime.recordTransition({
      action,
      previousState,
      nextState: api.getState(),
      startedAt,
      completedAt,
    });
    return result;
  } catch (error) {
    const completedAt = clock();
    runtime.recordFailure({
      action,
      state: api.getState(),
      startedAt,
      completedAt,
      error,
    });
    throw error;
  }
};
