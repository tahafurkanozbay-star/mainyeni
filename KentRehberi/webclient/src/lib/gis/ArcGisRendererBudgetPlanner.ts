export type ArcGisRendererViewMode = '2d' | '3d';
export type ArcGisRendererGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon';
export type ArcGisRendererType = 'simple' | 'unique-value' | 'class-breaks';
export type ArcGisVisualVariableType = 'color' | 'size' | 'opacity' | 'rotation';
export type ArcGisRendererQualityTier = 'full' | 'reduced' | 'minimum' | 'rejected';
export type ArcGisRendererBudgetReason =
  | 'class-break-complexity'
  | 'cpu-budget'
  | 'draw-call-budget'
  | 'feature-budget'
  | 'gpu-budget'
  | 'label-complexity'
  | 'symbol-complexity'
  | 'unique-value-complexity'
  | 'visual-variable-complexity';

export interface ArcGisVisualVariableComplexity {
  readonly type: ArcGisVisualVariableType;
  readonly stopCount: number;
}

export interface ArcGisRendererBudgetRequest {
  readonly layerKey: string;
  readonly viewMode: ArcGisRendererViewMode;
  readonly geometryType: ArcGisRendererGeometryType;
  readonly rendererType: ArcGisRendererType;
  readonly featureCountEstimate: number;
  readonly uniqueValueCount: number;
  readonly classBreakCount: number;
  readonly symbolCount: number;
  readonly symbolLayerCount: number;
  readonly labelClassCount: number;
  readonly visualVariables: readonly ArcGisVisualVariableComplexity[];
  readonly gpuBytesPerFeature: number;
  readonly cpuMicrosPerFeature: number;
  readonly expectedDrawCalls: number;
  readonly clusterEnabled: boolean;
}

export interface ArcGisRendererBudgetPolicy {
  readonly maxLayerKeyLength: number;
  readonly maxFeatures2d: number;
  readonly maxFeatures3d: number;
  readonly maxUniqueValues: number;
  readonly maxClassBreaks: number;
  readonly maxSymbols: number;
  readonly maxSymbolLayers: number;
  readonly maxLabelClasses: number;
  readonly maxVisualVariables: number;
  readonly maxColorOpacityStops: number;
  readonly maxSizeStops: number;
  readonly maxRotationStops: number;
  readonly maxGpuBytesPerFrame: number;
  readonly maxCpuMsPerFrame: number;
  readonly maxDrawCallsPerFrame: number;
  readonly maxComplexityUnits: number;
  readonly clusterRecommendationThreshold: number;
  readonly threeDimensionalCostPercent: number;
}

export interface ArcGisRendererBudgetPlan {
  readonly layerKey: string;
  readonly viewMode: ArcGisRendererViewMode;
  readonly qualityTier: ArcGisRendererQualityTier;
  readonly requestedFeatureCount: number;
  readonly admittedFeatureCount: number;
  readonly admissionRatio: number;
  readonly estimatedGpuBytes: number;
  readonly estimatedCpuMs: number;
  readonly expectedDrawCalls: number;
  readonly complexityUnits: number;
  readonly clusterRecommended: boolean;
  readonly reasons: readonly ArcGisRendererBudgetReason[];
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const finite = (value: number, name: string, minimum = 0): number => {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const safeProduct = (left: number, right: number, name: string): number => {
  const value = left * right;
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) throw new Error(`${name} overflow`);
  return value;
};

/**
 * Deterministic, transport-neutral renderer admission planner for ArcGIS 2D/3D layers.
 *
 * Callers provide normalized renderer complexity after reading verified layer metadata/config.
 * The planner never creates Renderer/Symbol/LayerView objects; it only produces a bounded plan
 * that can be consumed by the runtime before allocating large CPU/GPU workloads.
 */
export class ArcGisRendererBudgetPlanner {
  private readonly policy: Readonly<ArcGisRendererBudgetPolicy>;

  constructor(policy: ArcGisRendererBudgetPolicy) {
    const maxCpuMsPerFrame = finite(policy.maxCpuMsPerFrame, 'maxCpuMsPerFrame');
    if (maxCpuMsPerFrame <= 0) throw new Error('maxCpuMsPerFrame must be positive');
    this.policy = Object.freeze({
      maxLayerKeyLength: integer(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxFeatures2d: integer(policy.maxFeatures2d, 'maxFeatures2d'),
      maxFeatures3d: integer(policy.maxFeatures3d, 'maxFeatures3d'),
      maxUniqueValues: integer(policy.maxUniqueValues, 'maxUniqueValues', true),
      maxClassBreaks: integer(policy.maxClassBreaks, 'maxClassBreaks', true),
      maxSymbols: integer(policy.maxSymbols, 'maxSymbols'),
      maxSymbolLayers: integer(policy.maxSymbolLayers, 'maxSymbolLayers'),
      maxLabelClasses: integer(policy.maxLabelClasses, 'maxLabelClasses', true),
      maxVisualVariables: integer(policy.maxVisualVariables, 'maxVisualVariables', true),
      maxColorOpacityStops: integer(policy.maxColorOpacityStops, 'maxColorOpacityStops', true),
      maxSizeStops: integer(policy.maxSizeStops, 'maxSizeStops', true),
      maxRotationStops: integer(policy.maxRotationStops, 'maxRotationStops', true),
      maxGpuBytesPerFrame: integer(policy.maxGpuBytesPerFrame, 'maxGpuBytesPerFrame'),
      maxCpuMsPerFrame,
      maxDrawCallsPerFrame: integer(policy.maxDrawCallsPerFrame, 'maxDrawCallsPerFrame'),
      maxComplexityUnits: integer(policy.maxComplexityUnits, 'maxComplexityUnits'),
      clusterRecommendationThreshold: integer(policy.clusterRecommendationThreshold, 'clusterRecommendationThreshold'),
      threeDimensionalCostPercent: integer(policy.threeDimensionalCostPercent, 'threeDimensionalCostPercent'),
    });
    if (this.policy.threeDimensionalCostPercent < 100) throw new Error('threeDimensionalCostPercent must be at least 100');
  }

  plan(input: ArcGisRendererBudgetRequest): ArcGisRendererBudgetPlan {
    const layerKey = boundedText(input.layerKey, this.policy.maxLayerKeyLength, 'layer key');
    this.assertViewMode(input.viewMode);
    this.assertGeometryType(input.geometryType);
    this.assertRendererType(input.rendererType);
    const featureCountEstimate = integer(input.featureCountEstimate, 'featureCountEstimate', true);
    const uniqueValueCount = integer(input.uniqueValueCount, 'uniqueValueCount', true);
    const classBreakCount = integer(input.classBreakCount, 'classBreakCount', true);
    const symbolCount = integer(input.symbolCount, 'symbolCount');
    const symbolLayerCount = integer(input.symbolLayerCount, 'symbolLayerCount');
    const labelClassCount = integer(input.labelClassCount, 'labelClassCount', true);
    const gpuBytesPerFeature = integer(input.gpuBytesPerFeature, 'gpuBytesPerFeature', true);
    const cpuMicrosPerFeature = finite(input.cpuMicrosPerFeature, 'cpuMicrosPerFeature');
    const expectedDrawCalls = integer(input.expectedDrawCalls, 'expectedDrawCalls', true);
    if (typeof input.clusterEnabled !== 'boolean') throw new Error('clusterEnabled must be boolean');
    this.assertRendererCardinality(input.rendererType, uniqueValueCount, classBreakCount);
    const visualVariables = this.normalizeVisualVariables(input.visualVariables);

    const hardReasons: ArcGisRendererBudgetReason[] = [];
    if (uniqueValueCount > this.policy.maxUniqueValues) hardReasons.push('unique-value-complexity');
    if (classBreakCount > this.policy.maxClassBreaks) hardReasons.push('class-break-complexity');
    if (symbolCount > this.policy.maxSymbols || symbolLayerCount > this.policy.maxSymbolLayers) hardReasons.push('symbol-complexity');
    if (labelClassCount > this.policy.maxLabelClasses) hardReasons.push('label-complexity');
    if (visualVariables.length > this.policy.maxVisualVariables || this.visualVariablesExceedStops(visualVariables)) hardReasons.push('visual-variable-complexity');
    if (expectedDrawCalls > this.policy.maxDrawCallsPerFrame) hardReasons.push('draw-call-budget');

    const complexityUnits = this.complexityUnits({
      uniqueValueCount,
      classBreakCount,
      symbolCount,
      symbolLayerCount,
      labelClassCount,
      visualVariables,
    });
    if (complexityUnits > this.policy.maxComplexityUnits && !hardReasons.includes('symbol-complexity')) hardReasons.push('symbol-complexity');

    if (hardReasons.length > 0) return this.rejectedPlan(layerKey, input.viewMode, featureCountEstimate, expectedDrawCalls, complexityUnits, input.geometryType, input.clusterEnabled, hardReasons);

    const viewFeatureLimit = input.viewMode === '2d' ? this.policy.maxFeatures2d : this.policy.maxFeatures3d;
    const costMultiplier = input.viewMode === '3d' ? this.policy.threeDimensionalCostPercent / 100 : 1;
    const adjustedGpuBytesPerFeature = gpuBytesPerFeature * costMultiplier;
    const adjustedCpuMicrosPerFeature = cpuMicrosPerFeature * costMultiplier;
    if (!Number.isFinite(adjustedGpuBytesPerFeature) || !Number.isFinite(adjustedCpuMicrosPerFeature)) throw new Error('renderer cost multiplier overflow');

    const byGpu = adjustedGpuBytesPerFeature === 0
      ? featureCountEstimate
      : Math.floor(this.policy.maxGpuBytesPerFrame / adjustedGpuBytesPerFeature);
    const cpuMicrosBudget = this.policy.maxCpuMsPerFrame * 1_000;
    const byCpu = adjustedCpuMicrosPerFeature === 0
      ? featureCountEstimate
      : Math.floor(cpuMicrosBudget / adjustedCpuMicrosPerFeature);
    const admittedFeatureCount = Math.max(0, Math.min(featureCountEstimate, viewFeatureLimit, byGpu, byCpu));
    const reasons: ArcGisRendererBudgetReason[] = [];
    if (featureCountEstimate > viewFeatureLimit) reasons.push('feature-budget');
    if (admittedFeatureCount < featureCountEstimate && byGpu <= admittedFeatureCount) reasons.push('gpu-budget');
    if (admittedFeatureCount < featureCountEstimate && byCpu <= admittedFeatureCount) reasons.push('cpu-budget');

    const admissionRatio = featureCountEstimate === 0 ? 1 : admittedFeatureCount / featureCountEstimate;
    const qualityTier: ArcGisRendererQualityTier = admissionRatio >= 1 ? 'full' : admissionRatio >= 0.5 ? 'reduced' : admittedFeatureCount > 0 ? 'minimum' : 'rejected';
    const estimatedGpuBytes = safeProduct(admittedFeatureCount, adjustedGpuBytesPerFeature, 'estimatedGpuBytes');
    const estimatedCpuMs = safeProduct(admittedFeatureCount, adjustedCpuMicrosPerFeature, 'estimatedCpuMicros') / 1_000;
    const clusterRecommended = this.clusterRecommended(input.geometryType, input.clusterEnabled, featureCountEstimate, admittedFeatureCount);

    return Object.freeze({
      layerKey,
      viewMode: input.viewMode,
      qualityTier,
      requestedFeatureCount: featureCountEstimate,
      admittedFeatureCount,
      admissionRatio,
      estimatedGpuBytes,
      estimatedCpuMs,
      expectedDrawCalls,
      complexityUnits,
      clusterRecommended,
      reasons: Object.freeze([...new Set(reasons)].sort()),
    });
  }

  private normalizeVisualVariables(values: readonly ArcGisVisualVariableComplexity[]): readonly ArcGisVisualVariableComplexity[] {
    if (!Array.isArray(values)) throw new Error('visualVariables must be an array');
    const seen = new Set<ArcGisVisualVariableType>();
    const normalized = values.map((value) => {
      this.assertVisualVariableType(value.type);
      if (seen.has(value.type)) throw new Error('duplicate visual variable type');
      seen.add(value.type);
      return Object.freeze({ type: value.type, stopCount: integer(value.stopCount, 'visual variable stopCount', true) });
    }).sort((left, right) => left.type.localeCompare(right.type));
    return Object.freeze(normalized);
  }

  private visualVariablesExceedStops(values: readonly ArcGisVisualVariableComplexity[]): boolean {
    for (const value of values) {
      if ((value.type === 'color' || value.type === 'opacity') && value.stopCount > this.policy.maxColorOpacityStops) return true;
      if (value.type === 'size' && value.stopCount > this.policy.maxSizeStops) return true;
      if (value.type === 'rotation' && value.stopCount > this.policy.maxRotationStops) return true;
    }
    return false;
  }

  private complexityUnits(input: {
    readonly uniqueValueCount: number;
    readonly classBreakCount: number;
    readonly symbolCount: number;
    readonly symbolLayerCount: number;
    readonly labelClassCount: number;
    readonly visualVariables: readonly ArcGisVisualVariableComplexity[];
  }): number {
    let units = input.symbolCount + input.symbolLayerCount * 2 + input.labelClassCount * 4;
    units += input.uniqueValueCount * 2 + input.classBreakCount * 2;
    for (const variable of input.visualVariables) units += 3 + variable.stopCount * 2;
    if (!Number.isSafeInteger(units)) throw new Error('renderer complexity overflow');
    return units;
  }

  private rejectedPlan(
    layerKey: string,
    viewMode: ArcGisRendererViewMode,
    requestedFeatureCount: number,
    expectedDrawCalls: number,
    complexityUnits: number,
    geometryType: ArcGisRendererGeometryType,
    clusterEnabled: boolean,
    reasons: readonly ArcGisRendererBudgetReason[],
  ): ArcGisRendererBudgetPlan {
    return Object.freeze({
      layerKey,
      viewMode,
      qualityTier: 'rejected',
      requestedFeatureCount,
      admittedFeatureCount: 0,
      admissionRatio: requestedFeatureCount === 0 ? 1 : 0,
      estimatedGpuBytes: 0,
      estimatedCpuMs: 0,
      expectedDrawCalls,
      complexityUnits,
      clusterRecommended: this.clusterRecommended(geometryType, clusterEnabled, requestedFeatureCount, 0),
      reasons: Object.freeze([...new Set(reasons)].sort()),
    });
  }

  private clusterRecommended(
    geometryType: ArcGisRendererGeometryType,
    clusterEnabled: boolean,
    requestedFeatureCount: number,
    admittedFeatureCount: number,
  ): boolean {
    if (clusterEnabled || (geometryType !== 'point' && geometryType !== 'multipoint')) return false;
    return requestedFeatureCount >= this.policy.clusterRecommendationThreshold || admittedFeatureCount < requestedFeatureCount;
  }

  private assertRendererCardinality(rendererType: ArcGisRendererType, uniqueValueCount: number, classBreakCount: number): void {
    if (rendererType === 'simple' && (uniqueValueCount !== 0 || classBreakCount !== 0)) throw new Error('simple renderer cannot declare unique values or class breaks');
    if (rendererType === 'unique-value' && (uniqueValueCount === 0 || classBreakCount !== 0)) throw new Error('invalid unique-value renderer cardinality');
    if (rendererType === 'class-breaks' && (classBreakCount === 0 || uniqueValueCount !== 0)) throw new Error('invalid class-breaks renderer cardinality');
  }

  private assertViewMode(value: string): asserts value is ArcGisRendererViewMode {
    if (value !== '2d' && value !== '3d') throw new Error('invalid renderer view mode');
  }

  private assertGeometryType(value: string): asserts value is ArcGisRendererGeometryType {
    if (value !== 'point' && value !== 'multipoint' && value !== 'polyline' && value !== 'polygon') throw new Error('invalid renderer geometry type');
  }

  private assertRendererType(value: string): asserts value is ArcGisRendererType {
    if (value !== 'simple' && value !== 'unique-value' && value !== 'class-breaks') throw new Error('unsupported renderer type');
  }

  private assertVisualVariableType(value: string): asserts value is ArcGisVisualVariableType {
    if (value !== 'color' && value !== 'size' && value !== 'opacity' && value !== 'rotation') throw new Error('unsupported visual variable type');
  }
}
