export type MapModeFocusRestoreResult = 'captured' | 'fallback' | 'skipped';

export interface MapModeFocusableTarget {
  readonly isConnected: boolean;
  readonly disabled?: boolean;
  focus: (options?: FocusOptions) => void;
}

export interface MapModeFocusRestorationDiagnostics {
  readonly captureCount: number;
  readonly restoreCount: number;
  readonly fallbackRestoreCount: number;
  readonly skippedRestoreCount: number;
  readonly focusFailureCount: number;
  readonly disposed: boolean;
}

const EMPTY_DIAGNOSTICS: MapModeFocusRestorationDiagnostics = Object.freeze({
  captureCount: 0,
  restoreCount: 0,
  fallbackRestoreCount: 0,
  skippedRestoreCount: 0,
  focusFailureCount: 0,
  disposed: false,
});

const canFocus = (target: MapModeFocusableTarget | null | undefined): target is MapModeFocusableTarget => (
  Boolean(target)
  && target?.isConnected === true
  && target?.disabled !== true
  && typeof target?.focus === 'function'
);

/**
 * Keeps mode-switch focus deterministic without owning any GIS state.
 * The model stores at most one DOM target and never retries focus in a loop.
 */
export class MapModeFocusRestorationModel {
  #captured: MapModeFocusableTarget | null = null;
  #diagnostics = EMPTY_DIAGNOSTICS;
  #disposed = false;

  getDiagnostics(): MapModeFocusRestorationDiagnostics {
    return this.#diagnostics;
  }

  capture(target: MapModeFocusableTarget | null | undefined): boolean {
    if (this.#disposed || !canFocus(target)) return false;
    this.#captured = target;
    this.#patch({ captureCount: this.#diagnostics.captureCount + 1 });
    return true;
  }

  clear(): void {
    this.#captured = null;
  }

  restore(fallback?: MapModeFocusableTarget | null): MapModeFocusRestoreResult {
    if (this.#disposed) {
      this.#patch({ skippedRestoreCount: this.#diagnostics.skippedRestoreCount + 1 });
      return 'skipped';
    }

    const captured = this.#captured;
    this.#captured = null;
    if (canFocus(captured) && this.#focus(captured)) {
      this.#patch({ restoreCount: this.#diagnostics.restoreCount + 1 });
      return 'captured';
    }

    if (canFocus(fallback) && this.#focus(fallback)) {
      this.#patch({
        restoreCount: this.#diagnostics.restoreCount + 1,
        fallbackRestoreCount: this.#diagnostics.fallbackRestoreCount + 1,
      });
      return 'fallback';
    }

    this.#patch({ skippedRestoreCount: this.#diagnostics.skippedRestoreCount + 1 });
    return 'skipped';
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#captured = null;
    this.#patch({ disposed: true });
  }

  #focus(target: MapModeFocusableTarget): boolean {
    try {
      target.focus({ preventScroll: true });
      return true;
    } catch {
      this.#patch({ focusFailureCount: this.#diagnostics.focusFailureCount + 1 });
      return false;
    }
  }

  #patch(patch: Partial<MapModeFocusRestorationDiagnostics>): void {
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, ...patch });
  }
}

export const createMapModeFocusRestorationModel = (): MapModeFocusRestorationModel => (
  new MapModeFocusRestorationModel()
);
