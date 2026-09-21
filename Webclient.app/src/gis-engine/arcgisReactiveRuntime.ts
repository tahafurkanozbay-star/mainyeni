export interface ArcgisReactiveHandle {
  remove?: () => void;
}

export type ArcgisAccessorWatch = (
  target: unknown,
  propertyName: string,
  callback: (value: unknown, oldValue?: unknown) => void,
) => ArcgisReactiveHandle;

interface LegacyArcgisAccessor {
  watch?: (
    propertyName: string,
    callback: (value: unknown, oldValue?: unknown) => void,
  ) => ArcgisReactiveHandle;
}

/**
 * Prefer the reactiveUtils-backed compatibility watcher supplied by the
 * ArcGIS ESM transport. The legacy Accessor.watch fallback is retained only
 * for isolated tests and bounded compatibility callers that have not yet
 * received the injected watcher.
 */
export const watchArcgisProperty = (
  target: unknown,
  propertyName: string,
  callback: (value: unknown, oldValue?: unknown) => void,
  accessorWatch?: ArcgisAccessorWatch,
): ArcgisReactiveHandle | null => {
  if (typeof accessorWatch === 'function') {
    return accessorWatch(target, propertyName, callback);
  }

  const legacyWatch = (target as LegacyArcgisAccessor | null | undefined)?.watch;
  if (typeof legacyWatch !== 'function') return null;
  return legacyWatch.call(target, propertyName, callback);
};
