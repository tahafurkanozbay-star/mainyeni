export interface MapWorkspaceViewportViewLike {
  readonly destroyed?: boolean;
  padding?: unknown;
}

export interface MapWorkspaceViewportRuntimeOptions<TConfiguration> {
  readonly getView: () => MapWorkspaceViewportViewLike | null;
  readonly getConfiguration: () => TConfiguration;
  readonly createPadding: (width: number, configuration: TConfiguration) => unknown;
  readonly getViewportWidth?: () => number;
  readonly target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly onError?: (error: unknown) => void;
  readonly applyInitial?: boolean;
}

export interface MapWorkspaceViewportDiagnostics {
  readonly scheduledCount: number;
  readonly appliedCount: number;
  readonly coalescedCount: number;
  readonly errorCount: number;
  readonly lastErrorKind: string | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceViewportRuntime {
  readonly requestUpdate: () => void;
  readonly flush: () => void;
  readonly diagnostics: () => MapWorkspaceViewportDiagnostics;
  readonly dispose: () => void;
}

const classifyError = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  const kind = typeof error;
  return kind.length <= 24 ? kind : 'unknown';
};

const frozenDiagnostics = (
  scheduledCount: number,
  appliedCount: number,
  coalescedCount: number,
  errorCount: number,
  lastErrorKind: string | null,
  disposed: boolean,
): MapWorkspaceViewportDiagnostics => Object.freeze({
  scheduledCount,
  appliedCount,
  coalescedCount,
  errorCount,
  lastErrorKind,
  disposed,
});

/**
 * Coalesces noisy viewport resize events into a single animation-frame write.
 * The runtime never owns the map view; callers keep view lifecycle authority.
 */
export const createMapWorkspaceViewportRuntime = <TConfiguration>(
  options: MapWorkspaceViewportRuntimeOptions<TConfiguration>,
): MapWorkspaceViewportRuntime => {
  const target = options.target ?? window;
  const scheduleFrame = options.scheduleFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const getViewportWidth = options.getViewportWidth ?? (() => window.innerWidth);
  let frameHandle: number | null = null;
  let scheduledCount = 0;
  let appliedCount = 0;
  let coalescedCount = 0;
  let errorCount = 0;
  let lastErrorKind: string | null = null;
  let disposed = false;

  const recordError = (error: unknown): void => {
    errorCount += 1;
    lastErrorKind = classifyError(error);
  };

  const reportError = (error: unknown): void => {
    recordError(error);
    if (!options.onError) return;
    try {
      options.onError(error);
    } catch (reporterError) {
      recordError(reporterError);
    }
  };

  const apply = (): void => {
    if (disposed) return;
    const view = options.getView();
    if (!view || view.destroyed) return;
    try {
      view.padding = options.createPadding(getViewportWidth(), options.getConfiguration());
      appliedCount += 1;
    } catch (error) {
      reportError(error);
    }
  };

  const flush = (): void => {
    if (disposed) return;
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    apply();
  };

  const requestUpdate = (): void => {
    if (disposed) return;
    if (frameHandle !== null) {
      coalescedCount += 1;
      return;
    }
    scheduledCount += 1;
    frameHandle = scheduleFrame(() => {
      frameHandle = null;
      apply();
    });
  };

  const onResize = (): void => requestUpdate();
  target.addEventListener('resize', onResize, { passive: true });

  if (options.applyInitial !== false) apply();

  return Object.freeze({
    requestUpdate,
    flush,
    diagnostics: () => frozenDiagnostics(
      scheduledCount,
      appliedCount,
      coalescedCount,
      errorCount,
      lastErrorKind,
      disposed,
    ),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('resize', onResize);
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
  });
};
