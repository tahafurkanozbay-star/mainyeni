let activeView: unknown | null = null;

/** Return the current visible ArcGIS view, falling back to the base MapView. */
export const getActiveMapView = <T>(fallback: T): unknown | T => activeView ?? fallback;

/** Set the view currently visible to map navigation and identify operations. */
export const setActiveMapView = (view: unknown | null | undefined): void => {
  activeView = view ?? null;
};

/** Clear the view only if it is still the expected instance. */
export const clearActiveMapView = (expectedView?: unknown): boolean => {
  if (expectedView !== undefined && activeView !== expectedView) return false;
  activeView = null;
  return true;
};
