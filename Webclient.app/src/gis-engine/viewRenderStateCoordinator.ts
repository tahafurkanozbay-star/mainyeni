export type RenderViewMode = '2d' | '3d';
export type RenderQuality = 'eco' | 'balanced' | 'quality';
export type RenderPressure = 'normal' | 'elevated' | 'critical';

export interface RenderExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReferenceWkid: number;
}

export interface RenderCameraState {
  readonly longitude: number;
  readonly latitude: number;
  readonly altitude: number;
  readonly heading: number;
  readonly tilt: number;
}

export interface RenderViewState {
  readonly mode: RenderViewMode;
  readonly scale: number;
  readonly center: readonly [number, number];
  readonly rotation: number;
  readonly extent?: RenderExtent;
  readonly camera?: RenderCameraState;
  readonly quality: RenderQuality;
}

export interface RenderLayerState {
  readonly layerId: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly priority: number;
  readonly estimatedDrawCalls: number;
  readonly estimatedGpuBytes: number;
}

export interface RenderLayerDecision {
  readonly layerId: string;
  readonly requestedVisible: boolean;
  readonly effectiveVisible: boolean;
  readonly reason: 'visible' | 'hidden' | 'scale' | 'draw-budget' | 'gpu-budget';
  readonly opacity: number;
}

export interface RenderStateSnapshot {
  readonly view: RenderViewState;
  readonly pressure: RenderPressure;
  readonly layers: readonly RenderLayerDecision[];
  readonly admittedDrawCalls: number;
  readonly admittedGpuBytes: number;
  readonly revision: number;
}

export interface RenderStateOptions {
  readonly maxLayers?: number;
  readonly maxDrawCalls?: number;
  readonly maxGpuBytes?: number;
  readonly criticalPressureRatio?: number;
  readonly elevatedPressureRatio?: number;
}

type MutableLayer = {
  state: RenderLayerState;
  sequence: number;
};

const finite = (value: number, field: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  return value;
};

const nonNegative = (value: number, field: string): number => {
  finite(value, field);
  if (value < 0) throw new Error(`${field} must be non-negative`);
  return value;
};

const positive = (value: number, field: string): number => {
  finite(value, field);
  if (value <= 0) throw new Error(`${field} must be positive`);
  return value;
};

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
};

const ratio = (value: number, field: string): number => {
  finite(value, field);
  if (value <= 0 || value > 1) throw new Error(`${field} must be in (0, 1]`);
  return value;
};

const clampOpacity = (value: number): number => Math.min(1, Math.max(0, finite(value, 'opacity')));
const normalizeAngle = (value: number): number => ((finite(value, 'angle') % 360) + 360) % 360;

const normalizeExtent = (extent: RenderExtent | undefined): RenderExtent | undefined => {
  if (!extent) return undefined;
  const xmin = finite(extent.xmin, 'extent.xmin');
  const ymin = finite(extent.ymin, 'extent.ymin');
  const xmax = finite(extent.xmax, 'extent.xmax');
  const ymax = finite(extent.ymax, 'extent.ymax');
  if (xmax < xmin || ymax < ymin) throw new Error('extent bounds are inverted');
  return Object.freeze({ xmin, ymin, xmax, ymax, spatialReferenceWkid: positiveInteger(extent.spatialReferenceWkid, 'extent.spatialReferenceWkid') });
};

const normalizeCamera = (camera: RenderCameraState | undefined): RenderCameraState | undefined => {
  if (!camera) return undefined;
  const latitude = finite(camera.latitude, 'camera.latitude');
  if (latitude < -90 || latitude > 90) throw new Error('camera.latitude must be in [-90, 90]');
  return Object.freeze({
    longitude: finite(camera.longitude, 'camera.longitude'),
    latitude,
    altitude: nonNegative(camera.altitude, 'camera.altitude'),
    heading: normalizeAngle(camera.heading),
    tilt: Math.min(180, Math.max(0, finite(camera.tilt, 'camera.tilt'))),
  });
};

const normalizeView = (view: RenderViewState): RenderViewState => {
  if (!Array.isArray(view.center) || view.center.length !== 2) throw new Error('center must contain two coordinates');
  const center = Object.freeze([finite(view.center[0], 'center.x'), finite(view.center[1], 'center.y')] as const);
  const extent = normalizeExtent(view.extent);
  const camera = normalizeCamera(view.camera);
  if (view.mode === '3d' && !camera) throw new Error('3d render state requires camera');
  return Object.freeze({
    mode: view.mode,
    scale: positive(view.scale, 'scale'),
    center,
    rotation: normalizeAngle(view.rotation),
    quality: view.quality,
    ...(extent ? { extent } : {}),
    ...(camera ? { camera } : {}),
  });
};

const normalizeLayer = (input: RenderLayerState): RenderLayerState => {
  const layerId = input.layerId.trim();
  if (!layerId) throw new Error('layerId must not be empty');
  const minScale = nonNegative(input.minScale, 'minScale');
  const maxScale = nonNegative(input.maxScale, 'maxScale');
  if (minScale > 0 && maxScale > 0 && minScale < maxScale) throw new Error('minScale must be >= maxScale when both are set');
  return Object.freeze({
    layerId,
    visible: input.visible,
    opacity: clampOpacity(input.opacity),
    minScale,
    maxScale,
    priority: finite(input.priority, 'priority'),
    estimatedDrawCalls: nonNegative(input.estimatedDrawCalls, 'estimatedDrawCalls'),
    estimatedGpuBytes: nonNegative(input.estimatedGpuBytes, 'estimatedGpuBytes'),
  });
};

const inScale = (layer: RenderLayerState, scale: number): boolean =>
  (layer.minScale === 0 || scale <= layer.minScale) && (layer.maxScale === 0 || scale >= layer.maxScale);

/**
 * Deterministic render-state policy shared by MapView and SceneView adapters.
 * It owns no ArcGIS objects and performs no network access; adapters feed the
 * normalized state and apply the resulting immutable visibility decisions.
 */
export class ViewRenderStateCoordinator {
  private readonly layers = new Map<string, MutableLayer>();
  private readonly maxLayers: number;
  private readonly maxDrawCalls: number;
  private readonly maxGpuBytes: number;
  private readonly criticalPressureRatio: number;
  private readonly elevatedPressureRatio: number;
  private view: RenderViewState;
  private revision = 0;
  private sequence = 0;

  constructor(initialView: RenderViewState, options: RenderStateOptions = {}) {
    this.view = normalizeView(initialView);
    this.maxLayers = positiveInteger(options.maxLayers ?? 256, 'maxLayers');
    this.maxDrawCalls = positiveInteger(options.maxDrawCalls ?? 2_000, 'maxDrawCalls');
    this.maxGpuBytes = positiveInteger(options.maxGpuBytes ?? 512 * 1024 * 1024, 'maxGpuBytes');
    this.criticalPressureRatio = ratio(options.criticalPressureRatio ?? 0.9, 'criticalPressureRatio');
    this.elevatedPressureRatio = ratio(options.elevatedPressureRatio ?? 0.7, 'elevatedPressureRatio');
    if (this.elevatedPressureRatio >= this.criticalPressureRatio) throw new Error('elevatedPressureRatio must be lower than criticalPressureRatio');
  }

  setView(next: RenderViewState): RenderStateSnapshot {
    this.view = normalizeView(next);
    this.revision += 1;
    return this.snapshot();
  }

  upsertLayer(input: RenderLayerState): RenderStateSnapshot {
    const state = normalizeLayer(input);
    const existing = this.layers.get(state.layerId);
    if (!existing && this.layers.size >= this.maxLayers) throw new Error('render layer capacity exhausted');
    if (existing) existing.state = state;
    else this.layers.set(state.layerId, { state, sequence: ++this.sequence });
    this.revision += 1;
    return this.snapshot();
  }

  removeLayer(layerIdInput: string): boolean {
    const layerId = layerIdInput.trim();
    if (!layerId) return false;
    const removed = this.layers.delete(layerId);
    if (removed) this.revision += 1;
    return removed;
  }

  clear(): void {
    if (this.layers.size === 0) return;
    this.layers.clear();
    this.revision += 1;
  }

  snapshot(): RenderStateSnapshot {
    const ordered = Array.from(this.layers.values()).sort((a, b) =>
      b.state.priority - a.state.priority || a.sequence - b.sequence || a.state.layerId.localeCompare(b.state.layerId));
    let drawCalls = 0;
    let gpuBytes = 0;
    const decisions: RenderLayerDecision[] = [];
    for (const entry of ordered) {
      const layer = entry.state;
      let effectiveVisible = false;
      let reason: RenderLayerDecision['reason'];
      if (!layer.visible || layer.opacity === 0) reason = 'hidden';
      else if (!inScale(layer, this.view.scale)) reason = 'scale';
      else if (drawCalls + layer.estimatedDrawCalls > this.maxDrawCalls) reason = 'draw-budget';
      else if (gpuBytes + layer.estimatedGpuBytes > this.maxGpuBytes) reason = 'gpu-budget';
      else {
        reason = 'visible';
        effectiveVisible = true;
        drawCalls += layer.estimatedDrawCalls;
        gpuBytes += layer.estimatedGpuBytes;
      }
      decisions.push(Object.freeze({ layerId: layer.layerId, requestedVisible: layer.visible, effectiveVisible, reason, opacity: layer.opacity }));
    }
    decisions.sort((a, b) => a.layerId.localeCompare(b.layerId));
    const drawRatio = drawCalls / this.maxDrawCalls;
    const gpuRatio = gpuBytes / this.maxGpuBytes;
    const pressureRatio = Math.max(drawRatio, gpuRatio);
    const pressure: RenderPressure = pressureRatio >= this.criticalPressureRatio ? 'critical' : pressureRatio >= this.elevatedPressureRatio ? 'elevated' : 'normal';
    return Object.freeze({
      view: this.view,
      pressure,
      layers: Object.freeze(decisions),
      admittedDrawCalls: drawCalls,
      admittedGpuBytes: gpuBytes,
      revision: this.revision,
    });
  }
}
