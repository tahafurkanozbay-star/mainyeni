import {
  measurePolygon,
  measurePolyline,
  nearestPointOnPolyline,
  type AnalysisPoint,
  type AnalysisPolygon,
  type AnalysisPolyline,
  type GeometryAnalysisBudget,
  type PolygonMeasurement,
  type PolylineMeasurement,
  type SegmentProjection,
} from './geometryAnalysisRuntime';
import {
  aggregateSpatialGrid,
  type SpatialAggregationBudget,
  type SpatialAggregationPoint,
  type SpatialAggregationResult,
} from './spatialAggregationRuntime';
import {
  bufferPoint,
  bufferPolyline,
  type BufferOptions,
  type BufferPolygon,
} from './spatialBufferRuntime';
import {
  createSpatialAnalysisJobRuntime,
  type SpatialAnalysisJobPriority,
  type SpatialAnalysisJobRuntime,
  type SpatialAnalysisJobRuntimeConfiguration,
  type SpatialAnalysisJobRuntimeSnapshot,
} from './spatialAnalysisJobRuntime';
import {
  joinPointsToPolygons,
  type SpatialJoinBudgets,
  type SpatialJoinFeature,
  type SpatialJoinId,
  type SpatialJoinPolygon,
  type SpatialJoinResult,
} from './spatialJoinRuntime';
import {
  selectByExtent,
  selectByPolygon,
  type SpatialSelectionBudget,
  type SpatialSelectionResult,
} from './spatialSelectionRuntime';
import {
  createSpatialSelectionIndexRuntime,
  type SpatialSelectionIndexOptions,
  type SpatialSelectionIndexRuntime,
  type SpatialSelectionLayerSnapshot,
  type SpatialSelectionMutation,
  type SpatialSelectionNearestQuery,
  type SpatialSelectionQuery,
  type SpatialSelectionQueryResult,
  type SpatialSelectionRecord,
  type SpatialSelectionSnapshot,
} from './spatialSelectionIndexRuntime';
import {
  classifyCategoryValue,
  classifyNumericValue,
  createCategoryClassification,
  createNumericClassification,
  summarizeSpatialStatistics,
  type CategoryClassificationResult,
  type NumericClassificationMethod,
  type NumericClassificationResult,
  type SpatialStatisticCategory,
  type SpatialStatisticObservation,
  type SpatialStatisticsBudget,
  type SpatialStatisticsOptions,
  type SpatialStatisticsSummary,
} from './spatialStatisticsRuntime';
import {
  analyzePolygonTopology,
  type SpatialTopologyBudget,
  type SpatialTopologyResult,
} from './spatialTopologyRuntime';
import type {
  SpatialExtent,
  SpatialFeature,
  SpatialPoint,
} from './spatialAnalysisRuntime';

export type ModernSpatialAnalysisKernelConfiguration = Readonly<{
  geometry: GeometryAnalysisBudget;
  selection: SpatialSelectionBudget;
  selectionIndex?: SpatialSelectionIndexOptions;
  aggregation: SpatialAggregationBudget;
  join: SpatialJoinBudgets;
  topology: SpatialTopologyBudget;
  statistics: SpatialStatisticsBudget;
  jobs: SpatialAnalysisJobRuntimeConfiguration;
}>;

export type PolygonAnalysisResult = Readonly<{
  measurement: PolygonMeasurement;
  topology: SpatialTopologyResult;
  trustworthyMeasurement: boolean;
}>;

export type ModernSpatialAnalysisKernelSnapshot = Readonly<{
  disposed: boolean;
  jobs: SpatialAnalysisJobRuntimeSnapshot;
  selectionIndex: SpatialSelectionSnapshot;
}>;

export type KernelSubmitOptions = Readonly<{
  priority?: SpatialAnalysisJobPriority;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

const disposedError = (): Error & { code: string } => Object.assign(
  new Error('Modern spatial analysis kernel is disposed.'),
  { code: 'KERNEL_DISPOSED' },
);

export class ModernSpatialAnalysisKernel {
  #configuration: ModernSpatialAnalysisKernelConfiguration;
  #jobs: SpatialAnalysisJobRuntime;
  #selectionIndex: SpatialSelectionIndexRuntime<unknown>;
  #disposed = false;

  constructor(configuration: ModernSpatialAnalysisKernelConfiguration) {
    this.#configuration = configuration;
    this.#jobs = createSpatialAnalysisJobRuntime(configuration.jobs);
    this.#selectionIndex = createSpatialSelectionIndexRuntime<unknown>(
      configuration.selectionIndex,
    );
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  measureLine(polyline: AnalysisPolyline, signal?: AbortSignal): PolylineMeasurement {
    this.#assertActive();
    return measurePolyline(polyline, this.#configuration.geometry, signal);
  }

  measureArea(polygon: AnalysisPolygon, signal?: AbortSignal): PolygonMeasurement {
    this.#assertActive();
    return measurePolygon(polygon, this.#configuration.geometry, signal);
  }

  analyzePolygon(polygon: AnalysisPolygon, signal?: AbortSignal): PolygonAnalysisResult {
    this.#assertActive();
    const topology = analyzePolygonTopology(polygon, this.#configuration.topology, signal ? { signal } : {});
    const measurement = measurePolygon(polygon, this.#configuration.geometry, signal);
    return {
      measurement,
      topology,
      trustworthyMeasurement: topology.valid
        && !topology.diagnostics.truncated
        && !measurement.diagnostics.truncated,
    };
  }

  nearestOnLine(
    point: AnalysisPoint,
    polyline: AnalysisPolyline,
    signal?: AbortSignal,
  ): SegmentProjection | null {
    this.#assertActive();
    return nearestPointOnPolyline(point, polyline, this.#configuration.geometry.maxSegments, signal);
  }

  selectExtent<T>(
    features: readonly SpatialFeature<T>[],
    extent: SpatialExtent,
    signal?: AbortSignal,
  ): SpatialSelectionResult<T> {
    this.#assertActive();
    return selectByExtent(features, extent, this.#configuration.selection, signal);
  }

  selectPolygon<T>(
    features: readonly SpatialFeature<T>[],
    polygon: readonly SpatialPoint[],
    signal?: AbortSignal,
  ): SpatialSelectionResult<T> {
    this.#assertActive();
    return selectByPolygon(features, polygon, this.#configuration.selection, signal);
  }

  indexSelection<T>(
    input: Omit<SpatialSelectionRecord<T>, 'revision'>,
  ): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    return this.#selectionIndex.upsert(input) as SpatialSelectionRecord<T> | null;
  }

  indexedSelection<T = unknown>(id: string): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    return this.#selectionIndex.get(id) as SpatialSelectionRecord<T> | null;
  }

  hasIndexedSelection(id: string): boolean {
    this.#assertActive();
    return this.#selectionIndex.has(id);
  }

  querySelectionIndex<T = unknown>(
    query: SpatialSelectionQuery,
  ): SpatialSelectionQueryResult<T> {
    this.#assertActive();
    return this.#selectionIndex.query(query) as SpatialSelectionQueryResult<T>;
  }

  nearestIndexedSelection<T = unknown>(
    query: SpatialSelectionNearestQuery,
  ): SpatialSelectionQueryResult<T> {
    this.#assertActive();
    return this.#selectionIndex.nearest(query) as SpatialSelectionQueryResult<T>;
  }

  indexedSelectionsForLayer<T = unknown>(
    layerId: string,
    limit?: number,
  ): readonly SpatialSelectionRecord<T>[] {
    this.#assertActive();
    return this.#selectionIndex.recordsForLayer(
      layerId,
      limit,
    ) as readonly SpatialSelectionRecord<T>[];
  }

  removeIndexedSelection(id: string): boolean {
    this.#assertActive();
    return this.#selectionIndex.remove(id);
  }

  removeIndexedSelectionLayer(layerId: string): number {
    this.#assertActive();
    return this.#selectionIndex.removeLayer(layerId);
  }

  clearSelectionIndex(): void {
    this.#assertActive();
    this.#selectionIndex.clear();
  }

  selectionIndexLayers(): readonly SpatialSelectionLayerSnapshot[] {
    this.#assertActive();
    return this.#selectionIndex.layerSnapshots();
  }

  selectionIndexHistory(limit?: number): readonly SpatialSelectionMutation[] {
    this.#assertActive();
    return this.#selectionIndex.history(limit);
  }

  bufferPoint(center: SpatialPoint, options: BufferOptions, signal?: AbortSignal): BufferPolygon {
    this.#assertActive();
    return bufferPoint(center, options, signal);
  }

  bufferLine(points: readonly SpatialPoint[], options: BufferOptions, signal?: AbortSignal): BufferPolygon {
    this.#assertActive();
    return bufferPolyline(points, options, signal);
  }

  aggregate(
    points: readonly SpatialAggregationPoint[],
    cellSize: number,
    options: Readonly<{ originX?: number; originY?: number; signal?: AbortSignal }> = {},
  ): SpatialAggregationResult {
    this.#assertActive();
    return aggregateSpatialGrid(points, cellSize, this.#configuration.aggregation, options);
  }

  join<TFeatureId extends SpatialJoinId, TPolygonId extends SpatialJoinId>(
    features: readonly SpatialJoinFeature<TFeatureId>[],
    polygons: readonly SpatialJoinPolygon<TPolygonId>[],
    signal?: AbortSignal,
  ): SpatialJoinResult<TFeatureId, TPolygonId> {
    this.#assertActive();
    return joinPointsToPolygons(features, polygons, {
      budgets: this.#configuration.join,
      ...(signal ? { signal } : {}),
    });
  }

  statistics(
    observations: readonly SpatialStatisticObservation[],
    options: SpatialStatisticsOptions = {},
  ): SpatialStatisticsSummary {
    this.#assertActive();
    return summarizeSpatialStatistics(observations, this.#configuration.statistics, options);
  }

  classify(
    observations: readonly SpatialStatisticObservation[],
    method: NumericClassificationMethod,
    classes: number,
    signal?: AbortSignal,
  ): NumericClassificationResult {
    this.#assertActive();
    return createNumericClassification(
      observations,
      method,
      classes,
      this.#configuration.statistics,
      signal ? { signal } : {},
    );
  }

  classifyValue(value: number, classification: NumericClassificationResult): number | null {
    this.#assertActive();
    return classifyNumericValue(value, classification);
  }

  classifyCategories(
    observations: readonly SpatialStatisticObservation[],
    maxClasses: number,
    signal?: AbortSignal,
  ): CategoryClassificationResult {
    this.#assertActive();
    return createCategoryClassification(
      observations,
      maxClasses,
      this.#configuration.statistics,
      signal ? { signal } : {},
    );
  }

  classifyCategory(
    value: SpatialStatisticCategory | undefined,
    classification: CategoryClassificationResult,
  ): number | null {
    this.#assertActive();
    return classifyCategoryValue(value, classification);
  }

  submit<T>(
    dedupeKey: string,
    task: (kernel: ModernSpatialAnalysisKernel, signal: AbortSignal) => T | Promise<T>,
    options: KernelSubmitOptions = {},
  ): Promise<T> {
    this.#assertActive();
    const jobOptions = {
      dedupeKey,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    return this.#jobs.submit(({ signal }) => task(this, signal), jobOptions);
  }

  snapshot(): ModernSpatialAnalysisKernelSnapshot {
    return {
      disposed: this.#disposed,
      jobs: this.#jobs.snapshot(),
      selectionIndex: this.#selectionIndex.snapshot(),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#selectionIndex.dispose();
    this.#jobs.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw disposedError();
  }
}

export const createModernSpatialAnalysisKernel = (
  configuration: ModernSpatialAnalysisKernelConfiguration,
): ModernSpatialAnalysisKernel => new ModernSpatialAnalysisKernel(configuration);
