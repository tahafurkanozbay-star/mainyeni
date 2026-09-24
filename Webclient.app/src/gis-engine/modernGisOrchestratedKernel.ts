import {
  createModernGisKernel,
  type ModernGisKernelConfiguration,
} from './modernGisKernel';
import {
  createModernGisViewOrchestrationRuntime,
  type ModernGisViewOrchestrationOptions,
  type ModernGisViewOrchestrationRuntime,
} from './modernGisViewOrchestrationRuntime';
import type { GisRenderBudget, GisViewSnapshot } from './runtimeContracts';

export interface ModernGisOrchestratedKernelConfiguration extends ModernGisKernelConfiguration {
  readonly viewOrchestration?: ModernGisViewOrchestrationRuntime;
  readonly viewOrchestrationOptions?: Omit<ModernGisViewOrchestrationOptions, 'budget' | 'now'>;
}

const budgetFingerprint = (budget: GisRenderBudget): string => [
  budget.tier,
  budget.maxVisibleFeatures,
  budget.maxPointSymbols,
  budget.maxLabels,
  budget.maxSceneNodes,
  budget.maxResidentBytes,
  budget.maxConcurrentRequests,
  budget.maxConcurrentLayerLoads,
  budget.sceneQuality,
  budget.labelDensity,
  budget.enableShadows ? 1 : 0,
  budget.enableExtrusion ? 1 : 0,
  budget.allowPrefetch ? 1 : 0,
  budget.geometryDetail,
  budget.framePressure,
  budget.memoryPressure,
].join('|');

/**
 * Composes the existing modern GIS kernel with the bounded 2D/3D view runtime.
 *
 * The base kernel remains authoritative for services, requests, render budget,
 * lifecycle, health and operational GIS state. The view orchestration extension
 * only owns layer-view resources, Scene LOD/sections and cross-mode navigation.
 * This avoids a second query/render authority while making the new runtimes part
 * of the production kernel lifecycle and diagnostics surface.
 */
export const createModernGisOrchestratedKernel = (
  configuration: ModernGisOrchestratedKernelConfiguration = {},
) => {
  const {
    viewOrchestration: injectedViewOrchestration,
    viewOrchestrationOptions,
    ...kernelConfiguration
  } = configuration;
  const kernel = createModernGisKernel(kernelConfiguration);
  const initialBudget = kernel.getSnapshot().renderBudget;
  const viewOrchestration = injectedViewOrchestration ?? createModernGisViewOrchestrationRuntime({
    budget: initialBudget,
    ...(kernelConfiguration.now === undefined ? {} : { now: kernelConfiguration.now }),
    ...viewOrchestrationOptions,
  });
  let lastBudgetFingerprint = budgetFingerprint(initialBudget);
  let destroyed = false;

  const synchronizeViewBudget = (reason: string): GisRenderBudget => {
    const budget = kernel.getSnapshot().renderBudget;
    const fingerprint = budgetFingerprint(budget);
    if (fingerprint !== lastBudgetFingerprint) {
      lastBudgetFingerprint = fingerprint;
      viewOrchestration.updateRenderBudget(budget, reason);
    }
    return budget;
  };

  const updateView = (view: GisViewSnapshot) => {
    const result = kernel.updateView(view);
    synchronizeViewBudget('kernel-view-update');
    viewOrchestration.updateView(view);
    return result;
  };

  const recordFrame = (durationMs: unknown) => {
    const result = kernel.recordFrame(durationMs);
    synchronizeViewBudget('kernel-frame-sample');
    return result;
  };

  const setResidentBytes = (bytes: unknown) => {
    const result = kernel.setResidentBytes(bytes);
    synchronizeViewBudget('kernel-resident-bytes');
    return result;
  };

  const setQualityTier = (
    tier: Parameters<typeof kernel.setQualityTier>[0],
    reason = 'manual',
  ) => {
    const result = kernel.setQualityTier(tier, reason);
    synchronizeViewBudget(`kernel-quality-tier:${reason}`);
    return result;
  };

  const getDiagnostics = () => Object.freeze({
    ...kernel.getDiagnostics(),
    viewOrchestration: viewOrchestration.diagnostics(),
  });

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    await viewOrchestration.dispose();
    await kernel.destroy();
  };

  return Object.freeze({
    ...kernel,
    updateView,
    recordFrame,
    setResidentBytes,
    setQualityTier,
    getDiagnostics,
    destroy,
    viewOrchestration,
    getViewOrchestrationSnapshot: () => viewOrchestration.snapshot(),
    isDestroyed: () => destroyed || kernel.isDestroyed(),
  });
};

export type ModernGisOrchestratedKernel = ReturnType<typeof createModernGisOrchestratedKernel>;
