import type { LatestOperationContext } from '../_shared/MapWidgetRuntime';
import { withTimeout } from '../../../platform/runtime/resilience';

export interface SelectableBasemap {
  readonly id?: string;
  readonly load?: (options: { signal: AbortSignal }) => Promise<unknown>;
  readonly cancelLoad?: () => void;
  readonly destroy?: () => void;
}
export interface BasemapMap { basemap: SelectableBasemap | null; }

/** Own only the candidate; the currently displayed map remains untouched on failure. */
export const applySelectedBasemap = async (candidate: SelectableBasemap, map: BasemapMap, operation: LatestOperationContext): Promise<void> => {
  let attached = false;
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    try { candidate.cancelLoad?.(); } catch { /* Keep cancellation authoritative. */ }
  };
  operation.signal.addEventListener('abort', cancel, { once: true });
  try {
    operation.signal.throwIfAborted();
    if (!operation.isCurrent()) throw new DOMException('Selection superseded.', 'AbortError');
    await withTimeout(() => candidate.load?.({ signal: operation.signal }), 15_000, operation.signal);
    operation.signal.throwIfAborted();
    if (!operation.isCurrent()) throw new DOMException('Selection superseded.', 'AbortError');
    map.basemap = candidate;
    attached = true;
  } finally {
    operation.signal.removeEventListener('abort', cancel);
    if (!attached) {
      cancel();
      try { candidate.destroy?.(); } catch { /* Preserve the original load error. */ }
    }
  }
};
