export type ClusterDensity = 'sparse' | 'medium' | 'dense' | 'extreme';
export type ClusterMode = 'off' | 'soft' | 'aggressive';

export interface ClusterLodInput {
  featureCount: number;
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  averageFrameMs?: number;
  deviceMemoryGb?: number;
  reducedMotion?: boolean;
}

export interface ClusterLodDecision {
  density: ClusterDensity;
  mode: ClusterMode;
  clusterRadiusPx: number;
  maxVisibleFeatures: number;
  minClusterSize: number;
  labelBudget: number;
  animationEnabled: boolean;
  detailScore: number;
}

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const computeClusterDensity = (featureCount: number, viewportWidth: number, viewportHeight: number): ClusterDensity => {
  const area = Math.max(1, viewportWidth * viewportHeight);
  const perMegapixel = Math.max(0, featureCount) / (area / 1_000_000);
  if (perMegapixel >= 90_000) return 'extreme';
  if (perMegapixel >= 35_000) return 'dense';
  if (perMegapixel >= 10_000) return 'medium';
  return 'sparse';
};

export const createClusterLodDecision = (input: ClusterLodInput): ClusterLodDecision => {
  const featureCount = Math.max(0, Math.floor(finite(input.featureCount)));
  const width = Math.max(1, finite(input.viewportWidth, 1));
  const height = Math.max(1, finite(input.viewportHeight, 1));
  const zoom = clamp(finite(input.zoom, 0), 0, 24);
  const frameMs = Math.max(0, finite(input.averageFrameMs, 16.67));
  const memoryGb = Math.max(0.5, finite(input.deviceMemoryGb, 4));
  const density = computeClusterDensity(featureCount, width, height);
  const framePressure = frameMs > 33 ? 2 : frameMs > 22 ? 1 : 0;
  const memoryPressure = memoryGb < 2 ? 2 : memoryGb < 4 ? 1 : 0;
  const pressure = framePressure + memoryPressure;

  let mode: ClusterMode = 'off';
  if (density === 'extreme' || pressure >= 3) mode = 'aggressive';
  else if (density === 'dense' || density === 'medium' || pressure >= 1) mode = 'soft';

  if (zoom >= 18 && featureCount < 5_000 && pressure === 0) mode = 'off';

  const densityBaseRadius = density === 'extreme' ? 84 : density === 'dense' ? 64 : density === 'medium' ? 48 : 36;
  const zoomFactor = clamp(1.35 - zoom / 30, 0.65, 1.2);
  const pressureFactor = 1 + pressure * 0.12;
  const clusterRadiusPx = mode === 'off' ? 0 : Math.round(densityBaseRadius * zoomFactor * pressureFactor);

  const memoryBudget = memoryGb >= 8 ? 25_000 : memoryGb >= 4 ? 15_000 : memoryGb >= 2 ? 9_000 : 5_000;
  const frameBudget = frameMs <= 18 ? 1 : frameMs <= 25 ? 0.75 : frameMs <= 40 ? 0.5 : 0.3;
  const zoomBudget = clamp(0.55 + zoom / 30, 0.55, 1.25);
  const maxVisibleFeatures = Math.max(750, Math.floor(memoryBudget * frameBudget * zoomBudget));

  const labelBudget = Math.max(40, Math.min(2_000, Math.floor(maxVisibleFeatures * (mode === 'off' ? 0.14 : 0.05))));
  const minClusterSize = mode === 'aggressive' ? 3 : mode === 'soft' ? 2 : 1;
  const animationEnabled = !input.reducedMotion && frameMs < 28 && pressure <= 1;
  const detailScore = clamp((zoom / 24) * 0.55 + Math.min(memoryGb / 8, 1) * 0.25 + (frameMs <= 20 ? 0.2 : 0.05), 0, 1);

  return Object.freeze({
    density,
    mode,
    clusterRadiusPx,
    maxVisibleFeatures,
    minClusterSize,
    labelBudget,
    animationEnabled,
    detailScore,
  });
};

export interface ClusterBucketPoint {
  id: string | number;
  x: number;
  y: number;
  weight?: number;
}

export interface ClusterBucket {
  key: string;
  x: number;
  y: number;
  count: number;
  totalWeight: number;
  ids: readonly (string | number)[];
}

export const clusterPointsIntoGrid = (
  points: readonly ClusterBucketPoint[],
  radiusPx: number,
  maxIdsPerCluster = 64,
): readonly ClusterBucket[] => {
  const cellSize = Math.max(1, finite(radiusPx, 1));
  const limit = Math.max(1, Math.floor(finite(maxIdsPerCluster, 64)));
  const buckets = new Map<string, { x: number; y: number; count: number; totalWeight: number; ids: (string | number)[] }>();

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const key = `${cellX}:${cellY}`;
    const existing = buckets.get(key) ?? { x: 0, y: 0, count: 0, totalWeight: 0, ids: [] };
    const weight = Math.max(0, finite(point.weight, 1));
    const nextCount = existing.count + 1;
    existing.x += (point.x - existing.x) / nextCount;
    existing.y += (point.y - existing.y) / nextCount;
    existing.count = nextCount;
    existing.totalWeight += weight;
    if (existing.ids.length < limit) existing.ids.push(point.id);
    buckets.set(key, existing);
  }

  return Object.freeze([...buckets.entries()].map(([key, bucket]) => Object.freeze({
    key,
    x: bucket.x,
    y: bucket.y,
    count: bucket.count,
    totalWeight: bucket.totalWeight,
    ids: Object.freeze([...bucket.ids]),
  })));
};
