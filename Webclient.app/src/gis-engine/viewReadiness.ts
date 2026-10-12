import { withTimeout } from '../platform/runtime/resilience';
import { watchArcgisProperty, type ArcgisAccessorWatch, type ArcgisReactiveHandle } from './arcgisReactiveRuntime';

export interface ReadyArcgisView {
  readonly ready?: boolean;
  readonly readyState?: string;
  readonly destroyed?: boolean;
  readonly when?: () => PromiseLike<unknown>;
}

export class ArcgisViewReadinessError extends Error {
  constructor(readonly state: string) {
    super(state === 'rendering-error'
      ? 'Harita grafik bileşenleri başlatılamadı.'
      : 'Harita görünümü başlatılamadı.');
    this.name = 'ArcgisViewReadinessError';
  }
}

const FAILED_STATES = new Set(['missing-map', 'missing-container', 'empty-map', 'map-content-error', 'rendering-error']);

/** Resolve with void: SDK views are thenables and must not become the promise result. */
export const waitForArcgisView = async (
  view: ReadyArcgisView,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number; accessorWatch?: ArcgisAccessorWatch }> = {},
): Promise<void> => {
  await withTimeout((signal) => new Promise<void>((resolve, reject) => {
    let finished = false;
    let handle: ArcgisReactiveHandle | null = null;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      try { handle?.remove?.(); } catch { /* Cleanup must not mask readiness failure. */ }
    };
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = (): void => {
      if (view.destroyed) finish(new ArcgisViewReadinessError('destroyed'));
      else if (FAILED_STATES.has(view.readyState ?? '')) finish(new ArcgisViewReadinessError(view.readyState ?? 'unknown'));
      else if (view.ready === true || view.readyState === 'ready') finish();
    };
    const onAbort = (): void => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    inspect();
    if (finished) return;
    try {
      if (options.accessorWatch) {
        handle = watchArcgisProperty(view, 'readyState', inspect, options.accessorWatch);
        // An injected observer may invoke synchronously before returning its handle.
        if (finished) { cleanup(); return; }
      }
      inspect();
      if (finished) return;
      if (typeof view.when !== 'function') {
        finish(new ArcgisViewReadinessError('missing-readiness-contract'));
        return;
      }
      Promise.resolve(view.when()).then(() => {
        if (view.destroyed || FAILED_STATES.has(view.readyState ?? '')) {
          finish(new ArcgisViewReadinessError(view.readyState ?? 'destroyed'));
        } else finish();
      }, finish);
    } catch (error) { finish(error); }
  }), options.timeoutMs ?? 20_000, options.signal);
};
