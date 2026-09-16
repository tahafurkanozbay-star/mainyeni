import type { SceneBudgetLimits, SceneBudgetSnapshot, SceneResourceRequest, SceneViewMode } from './sceneResourceBudget';
import { createSceneResourceBudget } from './sceneResourceBudget';
import type { SceneFrameContext, SceneLayerEstimate, SceneLayerLodPolicy, SceneLodDecision } from './sceneLodPlanner';
import { createSceneLodPlanner } from './sceneLodPlanner';

export type SceneLayerFrameInput = Readonly<{ policy: SceneLayerLodPolicy; estimate: SceneLayerEstimate }>;
export type SceneFrameAdmission = Readonly<{ layerId: string; decision: SceneLodDecision; admittedResourceIds: readonly string[]; rejectedResourceIds: readonly string[]; evictedResourceIds: readonly string[] }>;
export type SceneFrameResult = Readonly<{ generation: number; mode: SceneViewMode; admissions: readonly SceneFrameAdmission[]; releasedResourceIds: readonly string[]; snapshot: SceneBudgetSnapshot }>;
export type SceneFrameCoordinatorOptions = Readonly<{ mode: SceneViewMode; limits?: Partial<SceneBudgetLimits> }>;
export type SceneFrameCoordinator = Readonly<{ reconcile: (layers: readonly SceneLayerFrameInput[], context: SceneFrameContext) => SceneFrameResult; releaseLayer: (layerId: string) => number; updateLimits: (limits: Partial<SceneBudgetLimits>) => readonly string[]; snapshot: () => SceneBudgetSnapshot; dispose: () => void }>;
type OwnedResource = Readonly<{ id: string; layerId: string; signature: string }>;

const requestSignature = (request: SceneResourceRequest): string => [request.layerId, request.kind, request.priority, request.estimatedCpuBytes, request.estimatedGpuBytes, request.estimatedDrawCalls, request.estimatedFeatures, request.distance ?? '', request.screenCoverage ?? ''].join('|');
const validLayerId = (value: string): string => value.trim();
const assertUniqueLayers = (layers: readonly SceneLayerFrameInput[]): void => { const seen = new Set<string>(); for (const layer of layers) { const id = validLayerId(layer.policy.layerId); if (!id) continue; if (seen.has(id)) throw new Error(`Duplicate scene layer id in frame: ${id}`); seen.add(id); } };
const frozenStrings = (values: Iterable<string>): readonly string[] => Object.freeze(Array.from(values));

/** Coordinates frame-to-frame LOD decisions with bounded logical scene-resource ownership. */
export const createSceneFrameCoordinator = (options: SceneFrameCoordinatorOptions): SceneFrameCoordinator => {
  const planner = createSceneLodPlanner();
  const budget = createSceneResourceBudget(options.mode, options.limits);
  const owned = new Map<string, OwnedResource>();
  let generation = 0;
  let disposed = false;
  const ensureActive = (): void => { if (disposed) throw new Error('Scene frame coordinator is disposed'); };
  const forget = (id: string): void => { owned.delete(id); };
  const releaseOwned = (id: string, released: Set<string>): void => { if (budget.release(id)) released.add(id); forget(id); };

  const reconcile = (layers: readonly SceneLayerFrameInput[], context: SceneFrameContext): SceneFrameResult => {
    ensureActive(); assertUniqueLayers(layers); generation += 1;
    const decisions = planner.planMany(layers, context);
    const desired = new Map<string, SceneResourceRequest>();
    const decisionByLayer = new Map(decisions.map((decision) => [decision.layerId, decision] as const));
    for (const decision of decisions) for (const request of decision.resourceRequests) { if (desired.has(request.id)) throw new Error(`Duplicate scene resource id in frame: ${request.id}`); desired.set(request.id, request); }
    const released = new Set<string>();
    for (const [id, current] of owned) { const next = desired.get(id); if (!next || current.signature !== requestSignature(next)) releaseOwned(id, released); }
    const admittedByLayer = new Map<string, string[]>(); const rejectedByLayer = new Map<string, string[]>(); const evictedByLayer = new Map<string, string[]>();
    for (const decision of decisions) {
      admittedByLayer.set(decision.layerId, []); rejectedByLayer.set(decision.layerId, []); evictedByLayer.set(decision.layerId, []);
      for (const request of decision.resourceRequests) {
        const existing = owned.get(request.id);
        if (existing && existing.signature === requestSignature(request)) { admittedByLayer.get(decision.layerId)?.push(request.id); continue; }
        const admission = budget.admit(request);
        for (const evictedId of admission.evicted) { const previousOwner = owned.get(evictedId)?.layerId; forget(evictedId); released.add(evictedId); if (previousOwner) { const bucket = evictedByLayer.get(previousOwner) ?? []; bucket.push(evictedId); evictedByLayer.set(previousOwner, bucket); } }
        if (admission.admitted) { owned.set(request.id, Object.freeze({ id: request.id, layerId: request.layerId, signature: requestSignature(request) })); admittedByLayer.get(decision.layerId)?.push(request.id); } else rejectedByLayer.get(decision.layerId)?.push(request.id);
      }
    }
    for (const ids of admittedByLayer.values()) for (let index = ids.length - 1; index >= 0; index -= 1) if (!owned.has(ids[index])) ids.splice(index, 1);
    const admissions = decisions.map((decision) => Object.freeze({ layerId: decision.layerId, decision, admittedResourceIds: frozenStrings(admittedByLayer.get(decision.layerId) ?? []), rejectedResourceIds: frozenStrings(rejectedByLayer.get(decision.layerId) ?? []), evictedResourceIds: frozenStrings(evictedByLayer.get(decision.layerId) ?? []) }));
    for (const id of owned.keys()) if (!desired.has(id)) releaseOwned(id, released);
    for (const [layerId, decision] of decisionByLayer) if (!decision.visible && (admittedByLayer.get(layerId)?.length ?? 0) !== 0) throw new Error(`Hidden scene layer retained resources: ${layerId}`);
    return Object.freeze({ generation, mode: options.mode, admissions: Object.freeze(admissions), releasedResourceIds: frozenStrings(released), snapshot: budget.snapshot() });
  };

  const releaseLayer = (layerIdInput: string): number => {
    ensureActive(); const layerId = validLayerId(layerIdInput); if (!layerId) return 0;
    const ids = Array.from(owned.values()).filter((resource) => resource.layerId === layerId).map((resource) => resource.id);
    for (const id of ids) forget(id);
    const released = budget.releaseLayer(layerId);
    if (released !== ids.length) for (const [id, resource] of owned) if (resource.layerId === layerId) forget(id);
    return released;
  };
  const updateLimits = (limits: Partial<SceneBudgetLimits>): readonly string[] => { ensureActive(); const evicted = budget.updateLimits(limits); evicted.forEach(forget); return evicted; };
  const snapshot = (): SceneBudgetSnapshot => { ensureActive(); return budget.snapshot(); };
  const dispose = (): void => { if (disposed) return; budget.clear(); owned.clear(); disposed = true; };
  return Object.freeze({ reconcile, releaseLayer, updateLimits, snapshot, dispose });
};
