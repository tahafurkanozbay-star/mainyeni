export type SceneViewMode = '2d' | '3d';
export type SceneResourceKind = 'feature' | 'label' | 'mesh' | 'texture' | 'terrain' | 'highlight';
export type ScenePriority = 'critical' | 'interactive' | 'visible' | 'prefetch';

export type SceneResourceRequest = Readonly<{
  id: string;
  layerId: string;
  kind: SceneResourceKind;
  priority: ScenePriority;
  estimatedCpuBytes: number;
  estimatedGpuBytes: number;
  estimatedDrawCalls: number;
  estimatedFeatures: number;
  distance?: number | undefined;
  screenCoverage?: number | undefined;
}>;

export type SceneBudgetLimits = Readonly<{
  maxCpuBytes: number;
  maxGpuBytes: number;
  maxDrawCalls: number;
  maxFeatures: number;
  maxResources: number;
  maxResourcesPerLayer: number;
}>;

export type SceneBudgetUsage = Readonly<{
  cpuBytes: number;
  gpuBytes: number;
  drawCalls: number;
  features: number;
  resources: number;
}>;

export type SceneAdmissionReason = 'admitted' | 'duplicate' | 'invalid' | 'layer-limit' | 'resource-limit' | 'cpu-limit' | 'gpu-limit' | 'draw-call-limit' | 'feature-limit' | 'lower-priority';
export type SceneAdmission = Readonly<{ admitted: boolean; reason: SceneAdmissionReason; evicted: readonly string[]; usage: SceneBudgetUsage }>;
export type SceneBudgetSnapshot = Readonly<{ mode: SceneViewMode; limits: SceneBudgetLimits; usage: SceneBudgetUsage; resources: readonly SceneResourceRequest[] }>;

const ZERO_USAGE: SceneBudgetUsage = Object.freeze({ cpuBytes: 0, gpuBytes: 0, drawCalls: 0, features: 0, resources: 0 });
const PRIORITY_WEIGHT: Readonly<Record<ScenePriority, number>> = Object.freeze({ critical: 4, interactive: 3, visible: 2, prefetch: 1 });
const DEFAULT_2D: SceneBudgetLimits = Object.freeze({ maxCpuBytes: 256 * 1024 * 1024, maxGpuBytes: 192 * 1024 * 1024, maxDrawCalls: 1200, maxFeatures: 75_000, maxResources: 256, maxResourcesPerLayer: 64 });
const DEFAULT_3D: SceneBudgetLimits = Object.freeze({ maxCpuBytes: 384 * 1024 * 1024, maxGpuBytes: 512 * 1024 * 1024, maxDrawCalls: 1800, maxFeatures: 100_000, maxResources: 384, maxResourcesPerLayer: 96 });

const bounded = (value: unknown, fallback: number, maximum: number): number => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, maximum) : fallback;
};

export const normalizeSceneBudgetLimits = (mode: SceneViewMode, input: Partial<SceneBudgetLimits> = {}): SceneBudgetLimits => {
  const base = mode === '3d' ? DEFAULT_3D : DEFAULT_2D;
  return Object.freeze({
    maxCpuBytes: bounded(input.maxCpuBytes, base.maxCpuBytes, 2 * 1024 * 1024 * 1024),
    maxGpuBytes: bounded(input.maxGpuBytes, base.maxGpuBytes, 2 * 1024 * 1024 * 1024),
    maxDrawCalls: bounded(input.maxDrawCalls, base.maxDrawCalls, 20_000),
    maxFeatures: bounded(input.maxFeatures, base.maxFeatures, 1_000_000),
    maxResources: bounded(input.maxResources, base.maxResources, 10_000),
    maxResourcesPerLayer: bounded(input.maxResourcesPerLayer, base.maxResourcesPerLayer, 2_000),
  });
};

const validRequest = (request: SceneResourceRequest): boolean => {
  if (!request.id.trim() || !request.layerId.trim()) return false;
  const values = [request.estimatedCpuBytes, request.estimatedGpuBytes, request.estimatedDrawCalls, request.estimatedFeatures];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  if (request.distance !== undefined && (!Number.isFinite(request.distance) || request.distance < 0)) return false;
  if (request.screenCoverage !== undefined && (!Number.isFinite(request.screenCoverage) || request.screenCoverage < 0 || request.screenCoverage > 1)) return false;
  return true;
};

const plus = (usage: SceneBudgetUsage, request: SceneResourceRequest): SceneBudgetUsage => Object.freeze({
  cpuBytes: usage.cpuBytes + request.estimatedCpuBytes,
  gpuBytes: usage.gpuBytes + request.estimatedGpuBytes,
  drawCalls: usage.drawCalls + request.estimatedDrawCalls,
  features: usage.features + request.estimatedFeatures,
  resources: usage.resources + 1,
});
const minus = (usage: SceneBudgetUsage, request: SceneResourceRequest): SceneBudgetUsage => Object.freeze({
  cpuBytes: Math.max(0, usage.cpuBytes - request.estimatedCpuBytes),
  gpuBytes: Math.max(0, usage.gpuBytes - request.estimatedGpuBytes),
  drawCalls: Math.max(0, usage.drawCalls - request.estimatedDrawCalls),
  features: Math.max(0, usage.features - request.estimatedFeatures),
  resources: Math.max(0, usage.resources - 1),
});

const violation = (usage: SceneBudgetUsage, limits: SceneBudgetLimits): SceneAdmissionReason | null => {
  if (usage.resources > limits.maxResources) return 'resource-limit';
  if (usage.cpuBytes > limits.maxCpuBytes) return 'cpu-limit';
  if (usage.gpuBytes > limits.maxGpuBytes) return 'gpu-limit';
  if (usage.drawCalls > limits.maxDrawCalls) return 'draw-call-limit';
  if (usage.features > limits.maxFeatures) return 'feature-limit';
  return null;
};

const evictionScore = (request: SceneResourceRequest): number => {
  const priority = PRIORITY_WEIGHT[request.priority] * 1_000_000;
  const coverage = Math.round((request.screenCoverage ?? 0) * 100_000);
  const distance = Math.min(100_000, Math.round(request.distance ?? 0));
  return priority + coverage - distance;
};

export const createSceneResourceBudget = (mode: SceneViewMode, input: Partial<SceneBudgetLimits> = {}) => {
  let limits = normalizeSceneBudgetLimits(mode, input);
  let usage = ZERO_USAGE;
  const resources = new Map<string, SceneResourceRequest>();
  const layerCounts = new Map<string, number>();

  const snapshot = (): SceneBudgetSnapshot => Object.freeze({ mode, limits, usage, resources: Object.freeze([...resources.values()]) });
  const release = (id: string): boolean => {
    const current = resources.get(id);
    if (!current) return false;
    resources.delete(id);
    usage = minus(usage, current);
    const count = (layerCounts.get(current.layerId) ?? 1) - 1;
    if (count <= 0) layerCounts.delete(current.layerId); else layerCounts.set(current.layerId, count);
    return true;
  };

  const candidateEvictions = (incoming: SceneResourceRequest): SceneResourceRequest[] => [...resources.values()]
    .filter((resource) => PRIORITY_WEIGHT[resource.priority] < PRIORITY_WEIGHT[incoming.priority])
    .sort((a, b) => evictionScore(a) - evictionScore(b) || a.id.localeCompare(b.id));

  const admit = (request: SceneResourceRequest): SceneAdmission => {
    if (!validRequest(request)) return Object.freeze({ admitted: false, reason: 'invalid', evicted: [], usage });
    if (resources.has(request.id)) return Object.freeze({ admitted: false, reason: 'duplicate', evicted: [], usage });
    if ((layerCounts.get(request.layerId) ?? 0) >= limits.maxResourcesPerLayer) return Object.freeze({ admitted: false, reason: 'layer-limit', evicted: [], usage });

    let projected = plus(usage, request);
    let reason = violation(projected, limits);
    const evicted: string[] = [];
    if (reason) {
      for (const candidate of candidateEvictions(request)) {
        release(candidate.id);
        evicted.push(candidate.id);
        projected = plus(usage, request);
        reason = violation(projected, limits);
        if (!reason) break;
      }
    }
    if (reason) return Object.freeze({ admitted: false, reason: evicted.length ? 'lower-priority' : reason, evicted: Object.freeze(evicted), usage });

    resources.set(request.id, Object.freeze({ ...request }));
    layerCounts.set(request.layerId, (layerCounts.get(request.layerId) ?? 0) + 1);
    usage = projected;
    return Object.freeze({ admitted: true, reason: 'admitted', evicted: Object.freeze(evicted), usage });
  };

  const releaseLayer = (layerId: string): number => {
    const ids = [...resources.values()].filter((resource) => resource.layerId === layerId).map((resource) => resource.id);
    ids.forEach(release);
    return ids.length;
  };

  const clear = (): void => { resources.clear(); layerCounts.clear(); usage = ZERO_USAGE; };
  const updateLimits = (next: Partial<SceneBudgetLimits>): readonly string[] => {
    limits = normalizeSceneBudgetLimits(mode, { ...limits, ...next });
    const evicted: string[] = [];
    while (violation(usage, limits)) {
      const candidate = [...resources.values()].filter((resource) => resource.priority !== 'critical').sort((a, b) => evictionScore(a) - evictionScore(b) || a.id.localeCompare(b.id))[0];
      if (!candidate) break;
      release(candidate.id); evicted.push(candidate.id);
    }
    return Object.freeze(evicted);
  };

  return Object.freeze({ admit, release, releaseLayer, clear, updateLimits, snapshot });
};