import {
  LayerViewLifecycleCoordinator,
  type GisViewMode,
  type LayerViewCoordinatorOptions,
  type LayerViewKey,
  type LayerViewRegistration,
  type LayerViewSnapshot,
} from './layerViewLifecycleCoordinator';
import {
  SceneLodBudgetCoordinator,
  type SceneLodBudget,
  type SceneLodResource,
  type SceneLodSnapshot,
} from './sceneLodBudgetCoordinator';
import {
  SceneSectionRuntime,
  type SceneSectionDefinition,
  type SceneSectionPlan,
  type SceneSectionPlanContext,
  type SceneSectionRuntimeOptions,
} from './sceneSectionRuntime';
import {
  ViewStateTransitionCoordinator,
  type UnifiedViewState,
  type ViewStateTransitionCoordinatorOptions,
  type ViewTransitionExecutor,
  type ViewTransitionRequest,
  type ViewTransitionResult,
} from './viewStateTransitionCoordinator';
import type { GisRenderBudget, GisViewSnapshot } from './runtimeContracts';

export type GisViewOrchestrationEventType =
  | 'budget-updated'
  | 'view-updated'
  | 'layer-view-registered'
  | 'layer-view-ready'
  | 'layer-view-suspended'
  | 'layer-view-removed'
  | 'scene-lod-registered'
  | 'scene-lod-removed'
  | 'scene-lod-planned'
  | 'scene-section-updated'
  | 'scene-section-removed'
  | 'scene-section-planned'
  | 'view-transition-seeded'
  | 'view-transition-completed'
  | 'view-transition-history'
  | 'disposed';

export interface GisViewOrchestrationEvent {
  readonly type: GisViewOrchestrationEventType;
  readonly revision: number;
  readonly timestamp: number;
  readonly layerId?: string;
  readonly resourceId?: string;
  readonly sectionId?: string;
  readonly mode?: '2d' | '3d';
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface GisViewOrchestrationBudget {
  readonly layerViews: Readonly<{
    maxEntries: number;
    maxConcurrentLoads: number;
    maxReadyResources: number;
  }>;
  readonly sceneLod: Readonly<SceneLodBudget>;
}

export interface ModernGisViewOrchestrationOptions {
  readonly budget: GisRenderBudget;
  readonly initialView?: GisViewSnapshot;
  readonly now?: () => number;
  readonly layerViews?: Omit<LayerViewCoordinatorOptions, 'now'>;
  readonly transitions?: ViewStateTransitionCoordinatorOptions;
  readonly sections?: SceneSectionRuntimeOptions;
  readonly onEvent?: (event: GisViewOrchestrationEvent) => void;
  readonly onListenerError?: (error: unknown, event: GisViewOrchestrationEvent) => void;
}

export interface ModernGisViewOrchestrationMetrics {
  readonly budgetUpdates: number;
  readonly viewUpdates: number;
  readonly layerViewRegistrations: number;
  readonly layerViewEnsures: number;
  readonly layerViewSuspensions: number;
  readonly layerViewRemovals: number;
  readonly sceneLodRegistrations: number;
  readonly sceneLodPlans: number;
  readonly sceneSectionUpdates: number;
  readonly sceneSectionPlans: number;
  readonly transitions: number;
  readonly historyNavigations: number;
  readonly listenerErrors: number;
}

export interface ModernGisViewOrchestrationSnapshot {
  readonly revision: number;
  readonly disposed: boolean;
  readonly currentView: GisViewSnapshot | null;
  readonly budget: GisViewOrchestrationBudget;
  readonly layerViews: ReturnType<LayerViewLifecycleCoordinator['snapshot']>;
  readonly sceneLod: SceneLodSnapshot;
  readonly sceneSections: ReturnType<SceneSectionRuntime['snapshot']>;
  readonly transitions: ReturnType<ViewStateTransitionCoordinator['snapshot']>;
  readonly metrics: ModernGisViewOrchestrationMetrics;
}

interface MutableMetrics {
  budgetUpdates: number;
  viewUpdates: number;
  layerViewRegistrations: number;
  layerViewEnsures: number;
  layerViewSuspensions: number;
  layerViewRemovals: number;
  sceneLodRegistrations: number;
  sceneLodPlans: number;
  sceneSectionUpdates: number;
  sceneSectionPlans: number;
  transitions: number;
  historyNavigations: number;
  listenerErrors: number;
}

const ONE_MIB = 1024 * 1024;

const finitePositive = (value: unknown, fallback: number, field: string): number => {
  const numeric = Number(value);
  const resolved = Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`${field} must be finite and positive`);
  return resolved;
};

const boundedInteger = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
};

const cloneRenderBudget = (budget: GisRenderBudget): GisRenderBudget => Object.freeze({ ...budget });

const cloneViewSnapshot = (view: GisViewSnapshot): GisViewSnapshot => Object.freeze({
  ...view,
  ...(view.extent == null
    ? {}
    : {
      extent: Object.freeze({
        ...view.extent,
        ...(view.extent.spatialReference == null
          ? {}
          : { spatialReference: Object.freeze({ ...view.extent.spatialReference }) }),
      }),
    }),
});

const defaultScale = (view: GisViewSnapshot | undefined): number => {
  const numeric = Number(view?.scale);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 100_000;
};

const deriveSceneDrawCalls = (budget: GisRenderBudget): number => {
  const sceneNodes = Math.max(1, Number(budget.maxSceneNodes || 1));
  return boundedInteger(Math.ceil(sceneNodes / 32), 128, 8_192, 1_024);
};

const deriveLayerViewLimits = (budget: GisRenderBudget): GisViewOrchestrationBudget['layerViews'] => {
  const concurrent = boundedInteger(budget.maxConcurrentLayerLoads, 1, 12, 4);
  const ready = boundedInteger(concurrent * 8, 8, 128, 32);
  return Object.freeze({
    maxEntries: Math.max(64, Math.min(512, ready * 4)),
    maxConcurrentLoads: concurrent,
    maxReadyResources: ready,
  });
};

export const deriveGisViewOrchestrationBudget = (
  budgetInput: GisRenderBudget,
): GisViewOrchestrationBudget => {
  const maxResidentBytes = Math.max(1, Math.floor(finitePositive(
    budgetInput.maxResidentBytes,
    256 * ONE_MIB,
    'maxResidentBytes',
  )));
  const sceneGpuBytes = Math.max(1, Math.floor(maxResidentBytes * 0.45));
  const sceneCpuBytes = Math.max(1, Math.floor(maxResidentBytes * 0.30));
  const maxFeatures = Math.max(1, Math.floor(finitePositive(
    budgetInput.maxVisibleFeatures,
    50_000,
    'maxVisibleFeatures',
  )));
  const maxResources = boundedInteger(
    Math.max(32, Number(budgetInput.maxConcurrentLayerLoads || 1) * 24),
    32,
    512,
    128,
  );
  return Object.freeze({
    layerViews: deriveLayerViewLimits(budgetInput),
    sceneLod: Object.freeze({
      maxGpuBytes: sceneGpuBytes,
      maxCpuBytes: sceneCpuBytes,
      maxDrawCalls: deriveSceneDrawCalls(budgetInput),
      maxFeatures,
      maxResources,
      elevatedRatio: 0.7,
      criticalRatio: 0.9,
    }),
  });
};

const pressureFromBudget = (budget: GisRenderBudget): 'normal' | 'elevated' | 'critical' => {
  if (budget.framePressure === 'critical' || budget.memoryPressure === 'critical') return 'critical';
  if (
    budget.framePressure === 'high'
    || budget.framePressure === 'mild'
    || budget.memoryPressure === 'high'
    || budget.memoryPressure === 'moderate'
  ) return 'elevated';
  return 'normal';
};

const modeOf = (view: GisViewSnapshot | null): '2d' | '3d' | undefined => (
  view?.kind === '2d' || view?.kind === '3d' ? view.kind : undefined
);

const metricsSnapshot = (metrics: MutableMetrics): ModernGisViewOrchestrationMetrics => Object.freeze({ ...metrics });

/**
 * Owns the bounded view-specific parts of the modern GIS kernel that are not
 * already governed by the existing render/layer/query authorities.
 *
 * Responsibilities are intentionally narrow:
 * - asynchronous MapView/SceneView layer-view resources,
 * - deterministic Scene LOD admission,
 * - bounded 3D section/clipping state,
 * - cancellable 2D <-> 3D view transitions and history.
 *
 * It performs no network I/O and does not replace the kernel's existing render
 * governor, layer lifecycle runtime, query control plane or GIS hardening runtime.
 */
export class ModernGisViewOrchestrationRuntime {
  private renderBudget: GisRenderBudget;
  private derivedBudget: GisViewOrchestrationBudget;
  private readonly now: () => number;
  private readonly onEvent?: (event: GisViewOrchestrationEvent) => void;
  private readonly onListenerError?: (error: unknown, event: GisViewOrchestrationEvent) => void;
  private readonly layerViews: LayerViewLifecycleCoordinator;
  private readonly transitions: ViewStateTransitionCoordinator;
  private readonly sections: SceneSectionRuntime;
  private sceneLod: SceneLodBudgetCoordinator;
  private readonly sceneResources = new Map<string, SceneLodResource>();
  private currentView: GisViewSnapshot | null;
  private currentScale: number;
  private revision = 0;
  private disposed = false;
  private readonly metrics: MutableMetrics = {
    budgetUpdates: 0,
    viewUpdates: 0,
    layerViewRegistrations: 0,
    layerViewEnsures: 0,
    layerViewSuspensions: 0,
    layerViewRemovals: 0,
    sceneLodRegistrations: 0,
    sceneLodPlans: 0,
    sceneSectionUpdates: 0,
    sceneSectionPlans: 0,
    transitions: 0,
    historyNavigations: 0,
    listenerErrors: 0,
  };

  constructor(options: ModernGisViewOrchestrationOptions) {
    this.renderBudget = cloneRenderBudget(options.budget);
    this.derivedBudget = deriveGisViewOrchestrationBudget(this.renderBudget);
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    this.onListenerError = options.onListenerError;
    this.currentView = options.initialView ? cloneViewSnapshot(options.initialView) : null;
    this.currentScale = defaultScale(options.initialView);

    const layerViewLimits = this.derivedBudget.layerViews;
    this.layerViews = new LayerViewLifecycleCoordinator({
      maxEntries: options.layerViews?.maxEntries ?? layerViewLimits.maxEntries,
      maxConcurrentLoads: options.layerViews?.maxConcurrentLoads ?? layerViewLimits.maxConcurrentLoads,
      maxReadyResources: options.layerViews?.maxReadyResources ?? layerViewLimits.maxReadyResources,
      now: this.now,
    });
    this.transitions = new ViewStateTransitionCoordinator(options.transitions);
    this.sections = new SceneSectionRuntime(options.sections);
    this.sceneLod = new SceneLodBudgetCoordinator(this.currentScale, this.derivedBudget.sceneLod);
  }

  updateRenderBudget(nextBudget: GisRenderBudget, reason = 'render-budget'): ModernGisViewOrchestrationSnapshot {
    this.assertActive();
    const next = cloneRenderBudget(nextBudget);
    this.renderBudget = next;
    this.derivedBudget = deriveGisViewOrchestrationBudget(next);
    const replacement = new SceneLodBudgetCoordinator(this.currentScale, this.derivedBudget.sceneLod);
    for (const resource of this.sceneResources.values()) replacement.upsert(resource);
    this.sceneLod.clear();
    this.sceneLod = replacement;
    this.metrics.budgetUpdates += 1;
    this.bump();
    this.emit('budget-updated', {
      reason,
      qualityTier: next.tier,
      maxResidentBytes: next.maxResidentBytes,
      maxVisibleFeatures: next.maxVisibleFeatures,
      sceneMaxGpuBytes: this.derivedBudget.sceneLod.maxGpuBytes,
      sceneMaxDrawCalls: this.derivedBudget.sceneLod.maxDrawCalls,
    });
    return this.snapshot();
  }

  updateView(view: GisViewSnapshot): ModernGisViewOrchestrationSnapshot {
    this.assertActive();
    this.currentView = cloneViewSnapshot(view);
    const nextScale = Number(view.scale);
    if (Number.isFinite(nextScale) && nextScale > 0) {
      this.currentScale = nextScale;
      this.sceneLod.setScale(nextScale);
    }
    this.metrics.viewUpdates += 1;
    this.bump();
    this.emit('view-updated', {
      mode: view.kind,
      scale: this.currentScale,
      stationary: view.stationary === true,
      interacting: view.interacting === true,
    }, { mode: view.kind });
    return this.snapshot();
  }

  registerLayerView(registration: LayerViewRegistration): LayerViewSnapshot {
    this.assertActive();
    const snapshot = this.layerViews.register(registration);
    this.metrics.layerViewRegistrations += 1;
    this.bump();
    this.emit('layer-view-registered', {
      priority: registration.priority,
      generation: snapshot.generation,
    }, { layerId: registration.key.layerId, mode: registration.key.mode });
    return snapshot;
  }

  async ensureLayerView(key: LayerViewKey): Promise<LayerViewSnapshot> {
    this.assertActive();
    const snapshot = await this.layerViews.ensure(key);
    this.metrics.layerViewEnsures += 1;
    this.bump();
    this.emit('layer-view-ready', {
      phase: snapshot.phase,
      generation: snapshot.generation,
    }, { layerId: key.layerId, mode: key.mode });
    return snapshot;
  }

  async suspendLayerView(key: LayerViewKey): Promise<boolean> {
    this.assertActive();
    const suspended = await this.layerViews.suspend(key);
    if (suspended) {
      this.metrics.layerViewSuspensions += 1;
      this.bump();
      this.emit('layer-view-suspended', {}, { layerId: key.layerId, mode: key.mode });
    }
    return suspended;
  }

  async removeLayerView(key: LayerViewKey): Promise<boolean> {
    this.assertActive();
    const removed = await this.layerViews.remove(key);
    if (removed) {
      this.metrics.layerViewRemovals += 1;
      this.bump();
      this.emit('layer-view-removed', {}, { layerId: key.layerId, mode: key.mode });
    }
    return removed;
  }

  touchLayerView(key: LayerViewKey): boolean {
    this.assertActive();
    return this.layerViews.touch(key);
  }

  registerSceneLodResource(resource: SceneLodResource): SceneLodSnapshot {
    this.assertActive();
    const next = Object.freeze({
      ...resource,
      levels: Object.freeze(resource.levels.map((level) => Object.freeze({ ...level }))),
    });
    this.sceneResources.set(resource.id.trim(), next);
    const snapshot = this.sceneLod.upsert(next);
    this.metrics.sceneLodRegistrations += 1;
    this.bump();
    this.emit('scene-lod-registered', {
      kind: resource.kind,
      priority: resource.priority,
      levels: resource.levels.length,
    }, { resourceId: resource.id });
    return snapshot;
  }

  removeSceneLodResource(resourceIdInput: string): boolean {
    this.assertActive();
    const resourceId = resourceIdInput.trim();
    if (!resourceId) return false;
    const removedCatalog = this.sceneResources.delete(resourceId);
    const removedRuntime = this.sceneLod.remove(resourceId);
    if (removedCatalog || removedRuntime) {
      this.bump();
      this.emit('scene-lod-removed', {}, { resourceId });
      return true;
    }
    return false;
  }

  planSceneLod(scaleInput?: number): SceneLodSnapshot {
    this.assertActive();
    if (scaleInput !== undefined) {
      this.currentScale = finitePositive(scaleInput, this.currentScale, 'scene scale');
      this.sceneLod.setScale(this.currentScale);
    }
    const snapshot = this.sceneLod.snapshot();
    this.metrics.sceneLodPlans += 1;
    this.bump();
    this.emit('scene-lod-planned', {
      scale: snapshot.scale,
      pressure: snapshot.pressure,
      admitted: snapshot.decisions.filter((decision) => decision.admitted).length,
      rejected: snapshot.decisions.filter((decision) => !decision.admitted).length,
      gpuBytes: snapshot.usage.gpuBytes,
      cpuBytes: snapshot.usage.cpuBytes,
      drawCalls: snapshot.usage.drawCalls,
    });
    return snapshot;
  }

  upsertSceneSection(section: SceneSectionDefinition): ReturnType<SceneSectionRuntime['snapshot']> {
    this.assertActive();
    const snapshot = this.sections.upsert(section);
    this.metrics.sceneSectionUpdates += 1;
    this.bump();
    this.emit('scene-section-updated', {
      enabled: section.enabled !== false,
      planes: section.planes.length,
      essential: section.essential === true,
    }, { sectionId: section.id });
    return snapshot;
  }

  removeSceneSection(sectionId: string): boolean {
    this.assertActive();
    const removed = this.sections.remove(sectionId);
    if (removed) {
      this.bump();
      this.emit('scene-section-removed', {}, { sectionId });
    }
    return removed;
  }

  planSceneSections(context: SceneSectionPlanContext = {}): SceneSectionPlan {
    this.assertActive();
    const pressure = context.pressure ?? pressureFromBudget(this.renderBudget);
    const plan = this.sections.plan({
      ...context,
      pressure,
    });
    this.metrics.sceneSectionPlans += 1;
    this.bump();
    this.emit('scene-section-planned', {
      pressure: plan.pressure,
      admittedSections: plan.admittedSections,
      admittedPlanes: plan.admittedPlanes,
    });
    return plan;
  }

  seedViewTransition(state: UnifiedViewState): UnifiedViewState {
    this.assertActive();
    const seeded = this.transitions.seed(state);
    this.bump();
    this.emit('view-transition-seeded', {
      targetMode: state.mode,
      scale: state.scale,
    }, { mode: state.mode });
    return seeded;
  }

  async transitionView(
    request: ViewTransitionRequest,
    executor: ViewTransitionExecutor,
  ): Promise<ViewTransitionResult> {
    this.assertActive();
    const result = await this.transitions.transition(request, executor);
    this.metrics.transitions += 1;
    this.bump();
    this.emit('view-transition-completed', {
      sequence: result.sequence,
      stale: result.stale,
      targetMode: result.state.mode,
      scale: result.state.scale,
    }, { mode: result.state.mode });
    return result;
  }

  viewHistoryBack(): UnifiedViewState | undefined {
    this.assertActive();
    const state = this.transitions.historyBack();
    if (state) {
      this.metrics.historyNavigations += 1;
      this.bump();
      this.emit('view-transition-history', { direction: 'back', targetMode: state.mode }, { mode: state.mode });
    }
    return state;
  }

  viewHistoryForward(): UnifiedViewState | undefined {
    this.assertActive();
    const state = this.transitions.historyForward();
    if (state) {
      this.metrics.historyNavigations += 1;
      this.bump();
      this.emit('view-transition-history', { direction: 'forward', targetMode: state.mode }, { mode: state.mode });
    }
    return state;
  }

  snapshot(): ModernGisViewOrchestrationSnapshot {
    const sceneLod = this.sceneLod.snapshot();
    return Object.freeze({
      revision: this.revision,
      disposed: this.disposed,
      currentView: this.currentView,
      budget: this.derivedBudget,
      layerViews: this.layerViews.snapshot(),
      sceneLod,
      sceneSections: this.sections.snapshot(),
      transitions: this.transitions.snapshot(),
      metrics: metricsSnapshot(this.metrics),
    });
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    const snapshot = this.snapshot();
    return Object.freeze({
      revision: snapshot.revision,
      disposed: snapshot.disposed,
      mode: modeOf(snapshot.currentView) ?? null,
      scale: snapshot.currentView?.scale ?? this.currentScale,
      budget: snapshot.budget,
      layerViews: snapshot.layerViews,
      sceneLod: snapshot.sceneLod,
      sceneSections: snapshot.sceneSections,
      transitions: snapshot.transitions,
      metrics: snapshot.metrics,
      registeredSceneLodResources: this.sceneResources.size,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.layerViews.dispose();
    this.sceneLod.clear();
    this.sceneResources.clear();
    this.sections.dispose();
    this.transitions.dispose();
    this.bump();
    this.emit('disposed', {});
  }

  private bump(): void {
    this.revision += 1;
  }

  private emit(
    type: GisViewOrchestrationEventType,
    fields: Record<string, string | number | boolean | null>,
    identity: { layerId?: string; resourceId?: string; sectionId?: string; mode?: GisViewMode } = {},
  ): void {
    if (!this.onEvent) return;
    const event: GisViewOrchestrationEvent = Object.freeze({
      type,
      revision: this.revision,
      timestamp: this.now(),
      ...(identity.layerId === undefined ? {} : { layerId: identity.layerId }),
      ...(identity.resourceId === undefined ? {} : { resourceId: identity.resourceId }),
      ...(identity.sectionId === undefined ? {} : { sectionId: identity.sectionId }),
      ...(identity.mode === undefined ? {} : { mode: identity.mode }),
      fields: Object.freeze({ ...fields }),
    });
    try {
      this.onEvent(event);
    } catch (error) {
      this.metrics.listenerErrors += 1;
      this.onListenerError?.(error, event);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('ModernGisViewOrchestrationRuntime is disposed');
  }
}

export const createModernGisViewOrchestrationRuntime = (
  options: ModernGisViewOrchestrationOptions,
): ModernGisViewOrchestrationRuntime => new ModernGisViewOrchestrationRuntime(options);
