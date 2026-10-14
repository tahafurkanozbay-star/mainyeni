import type { LatestOperationContext } from '../_shared/MapWidgetRuntime';
import { withTimeout } from '../../../platform/runtime/resilience';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';

export interface SelectableBasemap {
  readonly id?: string;
  readonly load?: (options: { signal: AbortSignal }) => Promise<unknown>;
  readonly cancelLoad?: () => void;
  readonly destroy?: () => void;
}
export interface BasemapMap { basemap: SelectableBasemap | null; }

const reportCleanupFailure = (error: unknown, source: string): void => {
  try {
    runtimeDiagnostics.captureError(new Error('Basemap resource cleanup failed.'), {
      source,
      failureKind: error instanceof Error ? (error.name || 'Error').slice(0, 48) : typeof error,
    }, 'warn');
  } catch { console.warn('Altlık kaynak temizliği raporlanamadı.'); }
};

/** Own only the candidate; the currently displayed map remains untouched on failure. */
export const applySelectedBasemap = async (candidate: SelectableBasemap, map: BasemapMap, operation: LatestOperationContext): Promise<void> => {
  let attached = false;
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    try { candidate.cancelLoad?.(); } catch (error) {
      reportCleanupFailure(error, 'experience.basemap.cancel');
    }
  };
  operation.signal.addEventListener('abort', cancel, { once: true });
  try {
    const previous = map.basemap;
    operation.signal.throwIfAborted();
    if (!operation.isCurrent()) throw new DOMException('Selection superseded.', 'AbortError');
    await withTimeout(() => candidate.load?.({ signal: operation.signal }), 15_000, operation.signal);
    operation.signal.throwIfAborted();
    if (!operation.isCurrent()) throw new DOMException('Selection superseded.', 'AbortError');
    if (map.basemap !== previous) throw new DOMException('Basemap changed while loading.', 'AbortError');
    map.basemap = candidate;
    attached = true;
  } finally {
    operation.signal.removeEventListener('abort', cancel);
    if (!attached) {
      cancel();
      try { candidate.destroy?.(); } catch (error) {
        reportCleanupFailure(error, 'experience.basemap.dispose');
      }
    }
  }
};

export interface AppliedBasemapOwnership {
  readonly map: BasemapMap;
  readonly basemap: SelectableBasemap;
}

/** Release only a basemap created by this gallery after its map detached it. */
export const releaseDetachedBasemap = (owned: AppliedBasemapOwnership | null): boolean => {
  if (!owned || owned.map.basemap === owned.basemap) return false;
  try { owned.basemap.destroy?.(); }
  catch (error) { reportCleanupFailure(error, 'experience.basemap.detached'); }
  return true;
};
