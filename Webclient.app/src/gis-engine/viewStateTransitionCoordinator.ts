export type ViewMode = '2d' | '3d';
export type TransitionIntent = 'programmatic' | 'navigation' | 'restore' | 'user';

export interface SpatialReferenceState {
  readonly wkid?: number;
  readonly latestWkid?: number;
}

export interface ViewPointState {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly spatialReference: SpatialReferenceState;
}

export interface ViewCameraState {
  readonly position: ViewPointState;
  readonly heading: number;
  readonly tilt: number;
}

export interface ViewState2D {
  readonly mode: '2d';
  readonly center: ViewPointState;
  readonly scale: number;
  readonly rotation: number;
}

export interface ViewState3D {
  readonly mode: '3d';
  readonly camera: ViewCameraState;
  readonly scale: number;
}

export type UnifiedViewState = ViewState2D | ViewState3D;

export interface ViewTransitionRequest {
  readonly target: UnifiedViewState;
  readonly intent?: TransitionIntent;
  readonly durationMs?: number;
  readonly reducedMotion?: boolean;
  readonly signal?: AbortSignal;
}

export interface ViewTransitionContext {
  readonly signal: AbortSignal;
  readonly sequence: number;
  readonly intent: TransitionIntent;
  readonly durationMs: number;
  readonly from?: UnifiedViewState;
  readonly target: UnifiedViewState;
}

export interface ViewTransitionResult {
  readonly sequence: number;
  readonly state: UnifiedViewState;
  readonly stale: boolean;
}

export type ViewTransitionExecutor = (context: ViewTransitionContext) => Promise<UnifiedViewState>;

export interface ViewStateTransitionCoordinatorOptions {
  readonly maxHistory?: number;
  readonly maxDurationMs?: number;
  readonly defaultDurationMs?: number;
  readonly coordinateLimit?: number;
}

export interface ViewTransitionSnapshot {
  readonly revision: number;
  readonly current?: UnifiedViewState;
  readonly pending: boolean;
  readonly historySize: number;
  readonly historyIndex: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly staleCompletions: number;
}

interface PendingTransition {
  readonly sequence: number;
  readonly controller: AbortController;
  readonly externalSignal?: AbortSignal;
  readonly externalAbort?: () => void;
}

const DEFAULT_COORDINATE_LIMIT = 100_000_000;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function normalizeSpatialReference(input: SpatialReferenceState): SpatialReferenceState {
  const wkid = input.wkid;
  const latestWkid = input.latestWkid;
  if (wkid === undefined && latestWkid === undefined) throw new TypeError('spatial reference requires wkid or latestWkid');
  if (wkid !== undefined && (!Number.isSafeInteger(wkid) || wkid <= 0)) throw new RangeError('wkid must be a positive safe integer');
  if (latestWkid !== undefined && (!Number.isSafeInteger(latestWkid) || latestWkid <= 0)) throw new RangeError('latestWkid must be a positive safe integer');
  return Object.freeze({ ...(wkid === undefined ? {} : { wkid }), ...(latestWkid === undefined ? {} : { latestWkid }) });
}

function spatialReferenceKey(input: SpatialReferenceState): string {
  return `${input.latestWkid ?? input.wkid ?? 0}:${input.wkid ?? input.latestWkid ?? 0}`;
}

function normalizePoint(input: ViewPointState, coordinateLimit: number): ViewPointState {
  const x = finite(input.x, 'x');
  const y = finite(input.y, 'y');
  if (Math.abs(x) > coordinateLimit || Math.abs(y) > coordinateLimit) throw new RangeError('view coordinate exceeds configured limit');
  const z = input.z === undefined ? undefined : finite(input.z, 'z');
  if (z !== undefined && Math.abs(z) > coordinateLimit) throw new RangeError('view elevation exceeds configured limit');
  return Object.freeze({ x, y, ...(z === undefined ? {} : { z }), spatialReference: normalizeSpatialReference(input.spatialReference) });
}

function normalizeHeading(value: number): number {
  const heading = finite(value, 'heading');
  return ((heading % 360) + 360) % 360;
}

function normalizeRotation(value: number): number {
  const rotation = finite(value, 'rotation');
  return ((rotation % 360) + 360) % 360;
}

function normalizeTilt(value: number): number {
  const tilt = finite(value, 'tilt');
  if (tilt < 0 || tilt > 180) throw new RangeError('tilt must be between 0 and 180 degrees');
  return tilt;
}

function clonePoint(input: ViewPointState): ViewPointState {
  return Object.freeze({ ...input, spatialReference: Object.freeze({ ...input.spatialReference }) });
}

function cloneState(input: UnifiedViewState): UnifiedViewState {
  if (input.mode === '2d') return Object.freeze({ ...input, center: clonePoint(input.center) });
  return Object.freeze({ ...input, camera: Object.freeze({ ...input.camera, position: clonePoint(input.camera.position) }) });
}

function stateKey(input: UnifiedViewState): string {
  if (input.mode === '2d') return `2d:${input.center.x}:${input.center.y}:${input.scale}:${input.rotation}:${spatialReferenceKey(input.center.spatialReference)}`;
  return `3d:${input.camera.position.x}:${input.camera.position.y}:${input.camera.position.z ?? 0}:${input.scale}:${input.camera.heading}:${input.camera.tilt}:${spatialReferenceKey(input.camera.position.spatialReference)}`;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class ViewStateTransitionCoordinator {
  private readonly maxHistory: number;
  private readonly maxDurationMs: number;
  private readonly defaultDurationMs: number;
  private readonly coordinateLimit: number;
  private readonly history: UnifiedViewState[] = [];
  private historyIndex = -1;
  private current: UnifiedViewState | undefined;
  private pending: PendingTransition | undefined;
  private sequence = 0;
  private revision = 0;
  private completed = 0;
  private cancelled = 0;
  private failed = 0;
  private staleCompletions = 0;
  private disposed = false;

  constructor(options: ViewStateTransitionCoordinatorOptions = {}) {
    this.maxHistory = positiveInteger(options.maxHistory, 64, 'maxHistory');
    this.maxDurationMs = nonNegativeFinite(options.maxDurationMs ?? 4_000, 'maxDurationMs');
    this.defaultDurationMs = nonNegativeFinite(options.defaultDurationMs ?? 350, 'defaultDurationMs');
    if (this.defaultDurationMs > this.maxDurationMs) throw new RangeError('defaultDurationMs exceeds maxDurationMs');
    this.coordinateLimit = nonNegativeFinite(options.coordinateLimit ?? DEFAULT_COORDINATE_LIMIT, 'coordinateLimit');
    if (this.coordinateLimit === 0) throw new RangeError('coordinateLimit must be positive');
  }

  seed(input: UnifiedViewState): UnifiedViewState {
    this.assertActive();
    const state = this.normalizeState(input);
    this.cancelPending('View transition superseded by seed');
    this.current = state;
    this.history.length = 0;
    this.history.push(state);
    this.historyIndex = 0;
    this.revision += 1;
    return cloneState(state);
  }

  async transition(request: ViewTransitionRequest, executor: ViewTransitionExecutor): Promise<ViewTransitionResult> {
    this.assertActive();
    if (request.signal?.aborted) throw abortError('View transition cancelled before start');
    const target = this.normalizeState(request.target);
    const durationMs = request.reducedMotion === true ? 0 : Math.min(nonNegativeFinite(request.durationMs ?? this.defaultDurationMs, 'durationMs'), this.maxDurationMs);
    this.cancelPending('View transition superseded');
    const controller = new AbortController();
    const sequence = ++this.sequence;
    const intent = request.intent ?? 'programmatic';
    let externalAbort: (() => void) | undefined;
    if (request.signal) {
      externalAbort = (): void => controller.abort(abortError('View transition cancelled by caller'));
      request.signal.addEventListener('abort', externalAbort, { once: true });
    }
    const pending: PendingTransition = {
      sequence,
      controller,
      ...(request.signal === undefined ? {} : { externalSignal: request.signal }),
      ...(externalAbort === undefined ? {} : { externalAbort }),
    };
    this.pending = pending;
    const context: ViewTransitionContext = Object.freeze({
      signal: controller.signal,
      sequence,
      intent,
      durationMs,
      ...(this.current === undefined ? {} : { from: cloneState(this.current) }),
      target: cloneState(target),
    });
    try {
      const executed = this.normalizeState(await executor(context));
      if (this.pending?.sequence !== sequence || controller.signal.aborted) {
        this.staleCompletions += 1;
        return Object.freeze({ sequence, state: cloneState(executed), stale: true });
      }
      this.detachPending(pending);
      this.pending = undefined;
      this.current = executed;
      this.pushHistory(executed);
      this.completed += 1;
      this.revision += 1;
      return Object.freeze({ sequence, state: cloneState(executed), stale: false });
    } catch (error: unknown) {
      const isCurrent = this.pending?.sequence === sequence;
      if (isCurrent) {
        this.detachPending(pending);
        this.pending = undefined;
      }
      if (controller.signal.aborted) this.cancelled += 1;
      else this.failed += 1;
      this.revision += 1;
      throw error;
    }
  }

  canGoBack(): boolean { return this.historyIndex > 0; }
  canGoForward(): boolean { return this.historyIndex >= 0 && this.historyIndex < this.history.length - 1; }

  historyBack(): UnifiedViewState | undefined {
    this.assertActive();
    if (!this.canGoBack()) return undefined;
    this.cancelPending('View transition cancelled by history navigation');
    this.historyIndex -= 1;
    this.current = this.history[this.historyIndex];
    this.revision += 1;
    return this.current === undefined ? undefined : cloneState(this.current);
  }

  historyForward(): UnifiedViewState | undefined {
    this.assertActive();
    if (!this.canGoForward()) return undefined;
    this.cancelPending('View transition cancelled by history navigation');
    this.historyIndex += 1;
    this.current = this.history[this.historyIndex];
    this.revision += 1;
    return this.current === undefined ? undefined : cloneState(this.current);
  }

  snapshot(): ViewTransitionSnapshot {
    return Object.freeze({ revision: this.revision, ...(this.current === undefined ? {} : { current: cloneState(this.current) }), pending: this.pending !== undefined, historySize: this.history.length, historyIndex: this.historyIndex, completed: this.completed, cancelled: this.cancelled, failed: this.failed, staleCompletions: this.staleCompletions });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelPending('View transition coordinator disposed');
    this.history.length = 0;
    this.current = undefined;
    this.disposed = true;
    this.revision += 1;
  }

  private normalizeState(input: UnifiedViewState): UnifiedViewState {
    if (input.mode === '2d') return Object.freeze({ mode: '2d', center: normalizePoint(input.center, this.coordinateLimit), scale: positiveFinite(input.scale, 'scale'), rotation: normalizeRotation(input.rotation) });
    return Object.freeze({ mode: '3d', camera: Object.freeze({ position: normalizePoint(input.camera.position, this.coordinateLimit), heading: normalizeHeading(input.camera.heading), tilt: normalizeTilt(input.camera.tilt) }), scale: positiveFinite(input.scale, 'scale') });
  }

  private pushHistory(state: UnifiedViewState): void {
    const currentHistoryState = this.history[this.historyIndex];
    if (currentHistoryState && stateKey(currentHistoryState) === stateKey(state)) return;
    if (this.historyIndex < this.history.length - 1) this.history.splice(this.historyIndex + 1);
    this.history.push(state);
    while (this.history.length > this.maxHistory) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  private cancelPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.detachPending(pending);
    pending.controller.abort(abortError(message));
    this.pending = undefined;
    this.cancelled += 1;
    this.revision += 1;
  }

  private detachPending(pending: PendingTransition): void {
    if (pending.externalSignal && pending.externalAbort) pending.externalSignal.removeEventListener('abort', pending.externalAbort);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('ViewStateTransitionCoordinator is disposed');
  }
}
