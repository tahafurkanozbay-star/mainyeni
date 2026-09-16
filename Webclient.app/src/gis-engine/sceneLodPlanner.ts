import type { ScenePriority, SceneResourceKind, SceneResourceRequest, SceneViewMode } from './sceneResourceBudget';

export type LodQuality = 'hidden' | 'coarse' | 'medium' | 'fine';
export type VisibilityReason = 'visible' | 'disabled' | 'outside-scale' | 'outside-distance' | 'outside-frustum' | 'tiny-screen-footprint' | 'invalid';

export type SceneLayerLodPolicy = Readonly<{
  layerId: string;
  enabled?: boolean;
  minScale?: number;
  maxScale?: number;
  maxDistance?: number;
  minScreenCoverage?: number;
  fineScreenCoverage?: number;
  mediumScreenCoverage?: number;
  fineDistance?: number;
  mediumDistance?: number;
  maxVisibleFeatures?: number;
  maxLabels?: number;
}>;

export type SceneFrameContext = Readonly<{
  mode: SceneViewMode;
  scale: number;
  cameraDistance: number;
  screenCoverage: number;
  intersectsFrustum: boolean;
  interactionActive?: boolean;
}>;

export type SceneLayerEstimate = Readonly<{
  featureCount: number;
  labelCount: number;
  cpuBytesPerFeature: number;
  gpuBytesPerFeature: number;
  drawCalls: number;
}>;

export type SceneLodDecision = Readonly<{
  layerId: string;
  visible: boolean;
  reason: VisibilityReason;
  quality: LodQuality;
  priority: ScenePriority;
  featureLimit: number;
  labelLimit: number;
  resourceRequests: readonly SceneResourceRequest[];
}>;

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const safeCount = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizePolicy = (policy: SceneLayerLodPolicy) => Object.freeze({
  ...policy,
  enabled: policy.enabled !== false,
  minScale: finiteNonNegative(policy.minScale ?? 0) ? policy.minScale ?? 0 : 0,
  maxScale: finiteNonNegative(policy.maxScale ?? Number.MAX_SAFE_INTEGER) ? policy.maxScale ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
  maxDistance: finiteNonNegative(policy.maxDistance ?? Number.MAX_SAFE_INTEGER) ? policy.maxDistance ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
  minScreenCoverage: clamp01(finiteNonNegative(policy.minScreenCoverage ?? 0.00005) ? policy.minScreenCoverage ?? 0.00005 : 0.00005),
  fineScreenCoverage: clamp01(finiteNonNegative(policy.fineScreenCoverage ?? 0.15) ? policy.fineScreenCoverage ?? 0.15 : 0.15),
  mediumScreenCoverage: clamp01(finiteNonNegative(policy.mediumScreenCoverage ?? 0.02) ? policy.mediumScreenCoverage ?? 0.02 : 0.02),
  fineDistance: finiteNonNegative(policy.fineDistance ?? 2_000) ? policy.fineDistance ?? 2_000 : 2_000,
  mediumDistance: finiteNonNegative(policy.mediumDistance ?? 15_000) ? policy.mediumDistance ?? 15_000 : 15_000,
  maxVisibleFeatures: Math.max(1, safeCount(policy.maxVisibleFeatures ?? 50_000)),
  maxLabels: Math.max(0, safeCount(policy.maxLabels ?? 4_000)),
});

const invalidContext = (context: SceneFrameContext): boolean =>
  !finiteNonNegative(context.scale) || context.scale === 0 ||
  !finiteNonNegative(context.cameraDistance) ||
  !finiteNonNegative(context.screenCoverage) || context.screenCoverage > 1;

const chooseQuality = (context: SceneFrameContext, policy: ReturnType<typeof normalizePolicy>): LodQuality => {
  if (context.screenCoverage >= policy.fineScreenCoverage && context.cameraDistance <= policy.fineDistance) return 'fine';
  if (context.screenCoverage >= policy.mediumScreenCoverage && context.cameraDistance <= policy.mediumDistance) return 'medium';
  return 'coarse';
};

const qualityFactor: Readonly<Record<Exclude<LodQuality, 'hidden'>, number>> = Object.freeze({ coarse: 0.12, medium: 0.45, fine: 1 });

const priorityFor = (quality: Exclude<LodQuality, 'hidden'>, interactive: boolean): ScenePriority => {
  if (interactive) return 'interactive';
  if (quality === 'fine') return 'visible';
  if (quality === 'medium') return 'visible';
  return 'prefetch';
};

const hidden = (layerId: string, reason: VisibilityReason): SceneLodDecision => Object.freeze({
  layerId, visible: false, reason, quality: 'hidden', priority: 'prefetch', featureLimit: 0, labelLimit: 0, resourceRequests: Object.freeze([]),
});

const request = (
  id: string,
  layerId: string,
  kind: SceneResourceKind,
  priority: ScenePriority,
  features: number,
  cpuBytes: number,
  gpuBytes: number,
  drawCalls: number,
  context: SceneFrameContext,
): SceneResourceRequest => Object.freeze({
  id, layerId, kind, priority,
  estimatedFeatures: features,
  estimatedCpuBytes: Math.max(0, Math.ceil(cpuBytes)),
  estimatedGpuBytes: Math.max(0, Math.ceil(gpuBytes)),
  estimatedDrawCalls: Math.max(0, Math.ceil(drawCalls)),
  distance: context.cameraDistance,
  screenCoverage: context.screenCoverage,
});

export const planSceneLayerLod = (policyInput: SceneLayerLodPolicy, context: SceneFrameContext, estimate: SceneLayerEstimate): SceneLodDecision => {
  const layerId = policyInput.layerId.trim();
  if (!layerId || invalidContext(context)) return hidden(layerId || policyInput.layerId, 'invalid');
  const policy = normalizePolicy({ ...policyInput, layerId });
  if (!policy.enabled) return hidden(layerId, 'disabled');
  if (context.scale < policy.minScale || context.scale > policy.maxScale) return hidden(layerId, 'outside-scale');
  if (context.cameraDistance > policy.maxDistance) return hidden(layerId, 'outside-distance');
  if (!context.intersectsFrustum) return hidden(layerId, 'outside-frustum');
  if (context.screenCoverage < policy.minScreenCoverage) return hidden(layerId, 'tiny-screen-footprint');

  const quality = chooseQuality(context, policy);
  const factor = qualityFactor[quality];
  const priority = priorityFor(quality, context.interactionActive === true);
  const availableFeatures = safeCount(estimate.featureCount);
  const availableLabels = safeCount(estimate.labelCount);
  const featureLimit = Math.min(availableFeatures, policy.maxVisibleFeatures, Math.max(1, Math.ceil(policy.maxVisibleFeatures * factor)));
  const labelFactor = context.mode === '3d' ? factor * 0.75 : factor;
  const labelLimit = Math.min(availableLabels, policy.maxLabels, Math.ceil(policy.maxLabels * labelFactor));
  const cpuPerFeature = finiteNonNegative(estimate.cpuBytesPerFeature) ? estimate.cpuBytesPerFeature : 0;
  const gpuPerFeature = finiteNonNegative(estimate.gpuBytesPerFeature) ? estimate.gpuBytesPerFeature : 0;
  const drawCalls = safeCount(estimate.drawCalls);

  const resources: SceneResourceRequest[] = [];
  if (featureLimit > 0) resources.push(request(
    `${layerId}:features:${quality}`, layerId, context.mode === '3d' ? 'mesh' : 'feature', priority,
    featureLimit, featureLimit * cpuPerFeature, featureLimit * gpuPerFeature,
    Math.max(1, Math.ceil(drawCalls * factor)), context,
  ));
  if (labelLimit > 0) resources.push(request(
    `${layerId}:labels:${quality}`, layerId, 'label', priority, labelLimit,
    labelLimit * 96, labelLimit * 128, Math.max(1, Math.ceil(labelLimit / 500)), context,
  ));

  return Object.freeze({
    layerId, visible: true, reason: 'visible', quality, priority, featureLimit, labelLimit,
    resourceRequests: Object.freeze(resources),
  });
};

export type SceneLodPlanner = Readonly<{
  plan: (policy: SceneLayerLodPolicy, context: SceneFrameContext, estimate: SceneLayerEstimate) => SceneLodDecision;
  planMany: (layers: readonly Readonly<{ policy: SceneLayerLodPolicy; estimate: SceneLayerEstimate }>[], context: SceneFrameContext) => readonly SceneLodDecision[];
}>;

export const createSceneLodPlanner = (): SceneLodPlanner => Object.freeze({
  plan: planSceneLayerLod,
  planMany: (layers, context) => Object.freeze(layers
    .map(({ policy, estimate }) => planSceneLayerLod(policy, context, estimate))
    .sort((a, b) => Number(b.visible) - Number(a.visible) || b.featureLimit - a.featureLimit || a.layerId.localeCompare(b.layerId))),
});
