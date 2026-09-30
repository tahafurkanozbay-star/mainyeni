import type { ExperienceMapMode } from '../../experience/experienceRuntime';
import {
  type MapModeTransitionModel,
  type MapModeTransitionRequest,
  type MapModeTransitionSource,
} from './mapModeTransitionModel';

export interface MapModeTransitionExecutionContext {
  readonly request: MapModeTransitionRequest;
  readonly isCurrent: () => boolean;
}

export type MapModeTransitionExecutor = (
  targetMode: ExperienceMapMode,
  context: MapModeTransitionExecutionContext,
) => Promise<ExperienceMapMode | void>;

export interface MapModeTransitionCoordinatorDiagnostics {
  readonly acceptedRequestCount: number;
  readonly ignoredRequestCount: number;
  readonly executionCount: number;
  readonly executorFailureCount: number;
  readonly staleCompletionCount: number;
  readonly maximumPendingDepth: number;
  readonly running: boolean;
  readonly disposed: boolean;
}

/**
 * Serializes expensive MapView/SceneView changes while retaining only the
 * latest user intent. ArcGIS view operations themselves remain owned by the
 * existing bridge; this coordinator controls ordering, stale completion and
 * model publication only.
 */
export class MapModeTransitionCoordinator {
  readonly #model: MapModeTransitionModel;
  #executor: MapModeTransitionExecutor;
  #latest: MapModeTransitionRequest | null = null;
  #runningRequest: MapModeTransitionRequest | null = null;
  #running = false;
  #disposed = false;
  #drainPromise: Promise<void> = Promise.resolve();
  #diagnostics: MapModeTransitionCoordinatorDiagnostics = Object.freeze({
    acceptedRequestCount: 0,
    ignoredRequestCount: 0,
    executionCount: 0,
    executorFailureCount: 0,
    staleCompletionCount: 0,
    maximumPendingDepth: 0,
    running: false,
    disposed: false,
  });

  constructor(model: MapModeTransitionModel, executor: MapModeTransitionExecutor) {
    this.#model = model;
    this.#executor = executor;
  }

  readonly getDiagnostics = (): MapModeTransitionCoordinatorDiagnostics => this.#diagnostics;

  setExecutor(executor: MapModeTransitionExecutor): void {
    if (this.#disposed) return;
    this.#executor = executor;
  }

  request(targetMode: ExperienceMapMode, source: MapModeTransitionSource = 'control'): Promise<void> {
    if (this.#disposed) {
      this.#patch({ ignoredRequestCount: this.#diagnostics.ignoredRequestCount + 1 });
      return this.#drainPromise;
    }

    const request = this.#model.request(targetMode, source);
    if (!request) {
      this.#patch({ ignoredRequestCount: this.#diagnostics.ignoredRequestCount + 1 });
      return this.#drainPromise;
    }

    this.#latest = request;
    const pendingDepth = this.#running ? 2 : 1;
    this.#patch({
      acceptedRequestCount: this.#diagnostics.acceptedRequestCount + 1,
      maximumPendingDepth: Math.max(this.#diagnostics.maximumPendingDepth, pendingDepth),
    });

    if (!this.#running) {
      this.#running = true;
      this.#patch({ running: true });
      this.#drainPromise = this.#drain();
    }

    return this.#drainPromise;
  }

  whenIdle(): Promise<void> {
    return this.#drainPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#latest = null;
    this.#patch({ disposed: true });
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#disposed && this.#latest) {
        const request = this.#latest;
        this.#latest = null;
        this.#runningRequest = request;

        if (!this.#model.begin(request)) {
          this.#patch({ staleCompletionCount: this.#diagnostics.staleCompletionCount + 1 });
          continue;
        }

        this.#patch({ executionCount: this.#diagnostics.executionCount + 1 });
        const context: MapModeTransitionExecutionContext = Object.freeze({
          request,
          isCurrent: () => !this.#disposed && this.#model.getSnapshot().requestId === request.requestId,
        });

        try {
          const result = await this.#executor(request.targetMode, context);
          if (this.#disposed) break;
          const activeMode = result ?? request.targetMode;
          if (!this.#model.complete(request, activeMode)) {
            this.#patch({ staleCompletionCount: this.#diagnostics.staleCompletionCount + 1 });
          }
        } catch (error) {
          if (this.#disposed) break;
          this.#patch({ executorFailureCount: this.#diagnostics.executorFailureCount + 1 });
          const fallback = this.#model.getSnapshot().activeMode;
          if (!this.#model.fail(request, error, fallback)) {
            this.#patch({ staleCompletionCount: this.#diagnostics.staleCompletionCount + 1 });
          }
        } finally {
          this.#runningRequest = null;
        }
      }
    } finally {
      this.#running = false;
      this.#patch({ running: false });
      if (!this.#disposed && this.#latest) {
        this.#running = true;
        this.#patch({ running: true });
        this.#drainPromise = this.#drain();
      }
    }
  }

  #patch(patch: Partial<MapModeTransitionCoordinatorDiagnostics>): void {
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, ...patch });
  }
}

export const createMapModeTransitionCoordinator = (
  model: MapModeTransitionModel,
  executor: MapModeTransitionExecutor,
): MapModeTransitionCoordinator => new MapModeTransitionCoordinator(model, executor);
