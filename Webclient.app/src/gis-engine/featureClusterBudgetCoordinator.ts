export type ClusterPriority = 'background' | 'normal' | 'interactive' | 'critical';
export type ClusterPressure = 'normal' | 'elevated' | 'critical';

export interface ClusterLayerDescriptor {
  readonly layerId: string;
  readonly priority: ClusterPriority;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly targetPixelRadius: number;
  readonly minPixelRadius?: number;
  readonly maxPixelRadius?: number;
  readonly estimatedFeatureCount: number;
  readonly estimatedClusterCount: number;
  readonly bytesPerFeature?: number;
  readonly bytesPerCluster?: number;
}

export interface ClusterBudget {
  readonly maxVisibleFeatures: number;
  readonly maxClusters: number;
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxDrawCalls: number;
  readonly maxLayers: number;
}

export interface ClusterViewport {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface ClusterAdmission {
  readonly layerId: string;
  readonly admitted: boolean;
  readonly pixelRadius: number;
  readonly visibleFeatureBudget: number;
  readonly clusterBudget: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly drawCalls: number;
  readonly degraded: boolean;
  readonly reason?: 'scale' | 'single-layer-budget' | 'capacity';
}

export interface ClusterSnapshot {
  readonly revision: number;
  readonly pressure: ClusterPressure;
  readonly admissions: readonly ClusterAdmission[];
  readonly usage: Readonly<{
    visibleFeatures: number;
    clusters: number;
    cpuBytes: number;
    gpuBytes: number;
    drawCalls: number;
    layers: number;
  }>;
}

export interface FeatureClusterBudgetCoordinatorOptions {
  readonly budget: ClusterBudget;
  readonly maxDescriptors?: number;
}

type MutableUsage = {
  visibleFeatures: number;
  clusters: number;
  cpuBytes: number;
  gpuBytes: number;
  drawCalls: number;
  layers: number;
};

type NormalizedDescriptor = Required<Pick<ClusterLayerDescriptor,
  'layerId' | 'priority' | 'targetPixelRadius' | 'minPixelRadius' | 'maxPixelRadius' |
  'estimatedFeatureCount' | 'estimatedClusterCount' | 'bytesPerFeature' | 'bytesPerCluster'>> &
  Pick<ClusterLayerDescriptor, 'minScale' | 'maxScale'>;

const PRIORITY_WEIGHT: Readonly<Record<ClusterPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  interactive: 2,
  critical: 3,
});

const zeroUsage = (): MutableUsage => ({
  visibleFeatures: 0,
  clusters: 0,
  cpuBytes: 0,
  gpuBytes: 0,
  drawCalls: 0,
  layers: 0,
});

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
  return value;
}

function optionalScale(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveFinite(value, name);
}

function normalizeDescriptor(input: ClusterLayerDescriptor): NormalizedDescriptor {
  const layerId = input.layerId.trim();
  if (!layerId) throw new TypeError('layerId must not be empty');
  const minScale = optionalScale(input.minScale, 'minScale');
  const maxScale = optionalScale(input.maxScale, 'maxScale');
  if (minScale !== undefined && maxScale !== undefined && minScale > maxScale) {
    throw new RangeError('minScale must be <= maxScale');
  }
  const targetPixelRadius = positiveFinite(input.targetPixelRadius, 'targetPixelRadius');
  const minPixelRadius = positiveFinite(input.minPixelRadius ?? Math.max(4, targetPixelRadius * 0.5), 'minPixelRadius');
  const maxPixelRadius = positiveFinite(input.maxPixelRadius ?? Math.max(targetPixelRadius, targetPixelRadius * 2), 'maxPixelRadius');
  if (minPixelRadius > targetPixelRadius || targetPixelRadius > maxPixelRadius) {
    throw new RangeError('cluster radius bounds must contain targetPixelRadius');
  }
  return Object.freeze({
    layerId,
    priority: input.priority,
    minScale,
    maxScale,
    targetPixelRadius,
    minPixelRadius,
    maxPixelRadius,
    estimatedFeatureCount: nonNegativeInteger(input.estimatedFeatureCount, 'estimatedFeatureCount'),
    estimatedClusterCount: nonNegativeInteger(input.estimatedClusterCount, 'estimatedClusterCount'),
    bytesPerFeature: nonNegativeInteger(input.bytesPerFeature ?? 96, 'bytesPerFeature'),
    bytesPerCluster: nonNegativeInteger(input.bytesPerCluster ?? 160, 'bytesPerCluster'),
  });
}

function normalizeBudget(input: ClusterBudget): ClusterBudget {
  return Object.freeze({
    maxVisibleFeatures: positiveInteger(input.maxVisibleFeatures, 'maxVisibleFeatures'),
    maxClusters: positiveInteger(input.maxClusters, 'maxClusters'),
    maxCpuBytes: positiveInteger(input.maxCpuBytes, 'maxCpuBytes'),
    maxGpuBytes: positiveInteger(input.maxGpuBytes, 'maxGpuBytes'),
    maxDrawCalls: positiveInteger(input.maxDrawCalls, 'maxDrawCalls'),
    maxLayers: positiveInteger(input.maxLayers, 'maxLayers'),
  });
}

function normalizeViewport(input: ClusterViewport): ClusterViewport {
  return Object.freeze({
    scale: positiveFinite(input.scale, 'scale'),
    width: positiveInteger(input.width, 'width'),
    height: positiveInteger(input.height, 'height'),
    devicePixelRatio: positiveFinite(input.devicePixelRatio, 'devicePixelRatio'),
  });
}

function isScaleVisible(descriptor: NormalizedDescriptor, scale: number): boolean {
  if (descriptor.minScale !== undefined && scale < descriptor.minScale) return false;
  if (descriptor.maxScale !== undefined && scale > descriptor.maxScale) return false;
  return true;
}

function addUsage(usage: MutableUsage, admission: ClusterAdmission): void {
  usage.visibleFeatures += admission.visibleFeatureBudget;
  usage.clusters += admission.clusterBudget;
  usage.cpuBytes += admission.cpuBytes;
  usage.gpuBytes += admission.gpuBytes;
  usage.drawCalls += admission.drawCalls;
  usage.layers += 1;
}

function fits(usage: MutableUsage, admission: ClusterAdmission, budget: ClusterBudget): boolean {
  return usage.visibleFeatures + admission.visibleFeatureBudget <= budget.maxVisibleFeatures &&
    usage.clusters + admission.clusterBudget <= budget.maxClusters &&
    usage.cpuBytes + admission.cpuBytes <= budget.maxCpuBytes &&
    usage.gpuBytes + admission.gpuBytes <= budget.maxGpuBytes &&
    usage.drawCalls + admission.drawCalls <= budget.maxDrawCalls &&
    usage.layers + 1 <= budget.maxLayers;
}

function pressureRatio(usage: MutableUsage, budget: ClusterBudget): number {
  return Math.max(
    usage.visibleFeatures / budget.maxVisibleFeatures,
    usage.clusters / budget.maxClusters,
    usage.cpuBytes / budget.maxCpuBytes,
    usage.gpuBytes / budget.maxGpuBytes,
    usage.drawCalls / budget.maxDrawCalls,
    usage.layers / budget.maxLayers,
  );
}

function classifyPressure(usage: MutableUsage, budget: ClusterBudget): ClusterPressure {
  const ratio = pressureRatio(usage, budget);
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.7) return 'elevated';
  return 'normal';
}

export class FeatureClusterBudgetCoordinator {
  private readonly budget: ClusterBudget;
  private readonly maxDescriptors: number;
  private readonly descriptors = new Map<string, NormalizedDescriptor>();
  private revision = 0;
  private disposed = false;

  constructor(options: FeatureClusterBudgetCoordinatorOptions) {
    this.budget = normalizeBudget(options.budget);
    this.maxDescriptors = positiveInteger(options.maxDescriptors ?? 256, 'maxDescriptors');
  }

  register(input: ClusterLayerDescriptor): void {
    this.assertActive();
    const descriptor = normalizeDescriptor(input);
    if (!this.descriptors.has(descriptor.layerId) && this.descriptors.size >= this.maxDescriptors) {
      throw new Error('cluster descriptor capacity exceeded');
    }
    this.descriptors.set(descriptor.layerId, descriptor);
    this.revision += 1;
  }

  remove(layerId: string): boolean {
    this.assertActive();
    const removed = this.descriptors.delete(layerId.trim());
    if (removed) this.revision += 1;
    return removed;
  }

  plan(viewportInput: ClusterViewport, requestedLayerIds?: readonly string[]): ClusterSnapshot {
    this.assertActive();
    const viewport = normalizeViewport(viewportInput);
    const requested = requestedLayerIds === undefined ? undefined : new Set(requestedLayerIds.map((id) => id.trim()));
    const candidates = Array.from(this.descriptors.values())
      .filter((descriptor) => requested === undefined || requested.has(descriptor.layerId))
      .sort((left, right) => {
        const priority = PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority];
        return priority || left.layerId.localeCompare(right.layerId);
      });
    const usage = zeroUsage();
    const admissions: ClusterAdmission[] = [];
    for (const descriptor of candidates) {
      if (!isScaleVisible(descriptor, viewport.scale)) {
        admissions.push(Object.freeze({
          layerId: descriptor.layerId,
          admitted: false,
          pixelRadius: descriptor.targetPixelRadius,
          visibleFeatureBudget: 0,
          clusterBudget: 0,
          cpuBytes: 0,
          gpuBytes: 0,
          drawCalls: 0,
          degraded: false,
          reason: 'scale',
        }));
        continue;
      }
      const admission = this.admitDescriptor(descriptor, viewport, usage);
      admissions.push(admission);
      if (admission.admitted) addUsage(usage, admission);
    }
    return Object.freeze({
      revision: this.revision,
      pressure: classifyPressure(usage, this.budget),
      admissions: Object.freeze(admissions),
      usage: Object.freeze({ ...usage }),
    });
  }

  snapshotDescriptors(): readonly ClusterLayerDescriptor[] {
    return Object.freeze(Array.from(this.descriptors.values())
      .sort((left, right) => left.layerId.localeCompare(right.layerId))
      .map((descriptor) => Object.freeze({ ...descriptor })));
  }

  dispose(): void {
    if (this.disposed) return;
    this.descriptors.clear();
    this.disposed = true;
    this.revision += 1;
  }

  private admitDescriptor(
    descriptor: NormalizedDescriptor,
    viewport: ClusterViewport,
    usage: MutableUsage,
  ): ClusterAdmission {
    const viewportPixels = viewport.width * viewport.height * viewport.devicePixelRatio * viewport.devicePixelRatio;
    const radiusSteps = [
      descriptor.targetPixelRadius,
      Math.min(descriptor.maxPixelRadius, descriptor.targetPixelRadius * 1.25),
      Math.min(descriptor.maxPixelRadius, descriptor.targetPixelRadius * 1.5),
      descriptor.maxPixelRadius,
    ].filter((radius, index, values) => values.indexOf(radius) === index);
    for (const radius of radiusSteps) {
      const radiusScale = descriptor.targetPixelRadius / radius;
      const pixelCapacity = Math.max(1, Math.floor(viewportPixels / Math.max(64, radius * radius * 4)));
      const clusterBudget = Math.min(
        descriptor.estimatedClusterCount,
        this.budget.maxClusters,
        Math.max(1, Math.floor(pixelCapacity * radiusScale)),
      );
      const visibleFeatureBudget = Math.min(
        descriptor.estimatedFeatureCount,
        this.budget.maxVisibleFeatures,
        Math.max(clusterBudget, Math.floor(clusterBudget * 24 * radiusScale)),
      );
      const cpuBytes = visibleFeatureBudget * descriptor.bytesPerFeature + clusterBudget * descriptor.bytesPerCluster;
      const gpuBytes = clusterBudget * descriptor.bytesPerCluster + Math.min(visibleFeatureBudget, clusterBudget * 4) * 32;
      const drawCalls = clusterBudget === 0 ? 0 : Math.max(1, Math.ceil(clusterBudget / 2048));
      const admission: ClusterAdmission = Object.freeze({
        layerId: descriptor.layerId,
        admitted: true,
        pixelRadius: radius,
        visibleFeatureBudget,
        clusterBudget,
        cpuBytes,
        gpuBytes,
        drawCalls,
        degraded: radius > descriptor.targetPixelRadius,
      });
      const singleLayerFits = cpuBytes <= this.budget.maxCpuBytes && gpuBytes <= this.budget.maxGpuBytes &&
        drawCalls <= this.budget.maxDrawCalls && visibleFeatureBudget <= this.budget.maxVisibleFeatures &&
        clusterBudget <= this.budget.maxClusters;
      if (singleLayerFits && fits(usage, admission, this.budget)) return admission;
    }
    const minimumRadius = Math.max(descriptor.minPixelRadius, descriptor.maxPixelRadius);
    const singleLayerImpossible = descriptor.bytesPerCluster > this.budget.maxCpuBytes || descriptor.bytesPerCluster > this.budget.maxGpuBytes;
    return Object.freeze({
      layerId: descriptor.layerId,
      admitted: false,
      pixelRadius: minimumRadius,
      visibleFeatureBudget: 0,
      clusterBudget: 0,
      cpuBytes: 0,
      gpuBytes: 0,
      drawCalls: 0,
      degraded: true,
      reason: singleLayerImpossible ? 'single-layer-budget' : 'capacity',
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('FeatureClusterBudgetCoordinator is disposed');
  }
}
