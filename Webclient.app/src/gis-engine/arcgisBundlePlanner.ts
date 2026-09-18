import {
  requireArcgisModuleDescriptor,
  resolveArcgisCatalogModules,
  type ArcgisResolvedModule,
} from './arcgisEsmModuleCatalog';

export type ArcgisFeatureIntent =
  | 'map-2d'
  | 'map-3d'
  | 'reactive-view'
  | 'query'
  | 'identify'
  | 'measurement'
  | 'sketch'
  | 'basemap-gallery'
  | 'legend'
  | 'projection'
  | 'feature-layer'
  | 'map-image-layer'
  | 'scene-layer'
  | 'imagery-layer'
  | 'vector-tile-layer'
  | 'geojson-layer';

export type ArcgisFeatureRequest = Readonly<{
  intent: ArcgisFeatureIntent;
  priority?: number;
}>;

export type ArcgisBundleBudget = Readonly<{
  maxModules: number;
  maxRelativeWeight: number;
}>;

export type ArcgisBundleFeaturePlan = Readonly<{
  intent: ArcgisFeatureIntent;
  priority: number;
  accepted: boolean;
  addedModuleIds: readonly string[];
  addedRelativeWeight: number;
  reason: string | null;
}>;

export type ArcgisBundlePlan = Readonly<{
  requestedFeatures: readonly ArcgisFeatureIntent[];
  acceptedFeatures: readonly ArcgisFeatureIntent[];
  deferredFeatures: readonly ArcgisFeatureIntent[];
  moduleIds: readonly string[];
  specifiers: readonly string[];
  relativeWeight: number;
  complete: boolean;
  featurePlans: readonly ArcgisBundleFeaturePlan[];
  diagnostics: readonly string[];
}>;

export type ArcgisRuntimeFeatureProfile = Readonly<{
  view: '2d' | '3d' | 'hybrid';
  reactiveView?: boolean;
  query?: boolean;
  identify?: boolean;
  measurement?: boolean;
  sketch?: boolean;
  basemapGallery?: boolean;
  legend?: boolean;
  projection?: boolean;
  featureLayer?: boolean;
  mapImageLayer?: boolean;
  sceneLayer?: boolean;
  imageryLayer?: boolean;
  vectorTileLayer?: boolean;
  geoJsonLayer?: boolean;
}>;

const FEATURE_REQUIREMENTS: Readonly<Record<ArcgisFeatureIntent, readonly string[]>> = Object.freeze({
  'map-2d': Object.freeze([
    'esri/config',
    'esri/Map',
    'esri/Graphic',
    'esri/layers/GraphicsLayer',
    'esri/views/MapView',
  ]),
  'map-3d': Object.freeze([
    'esri/config',
    'esri/Map',
    'esri/Graphic',
    'esri/layers/GraphicsLayer',
    'esri/views/SceneView',
  ]),
  'reactive-view': Object.freeze(['esri/core/watchUtils']),
  query: Object.freeze(['esri/tasks/QueryTask', 'esri/tasks/support/Query']),
  identify: Object.freeze(['esri/rest/identify', 'esri/rest/support/IdentifyParameters']),
  measurement: Object.freeze([
    'esri/widgets/Measurement',
    'esri/geometry/geometryEngine',
    'esri/geometry/support/geodesicUtils',
  ]),
  sketch: Object.freeze([
    'esri/widgets/Sketch',
    'esri/widgets/Sketch/SketchViewModel',
    'esri/layers/GraphicsLayer',
    'esri/Graphic',
  ]),
  'basemap-gallery': Object.freeze(['esri/Basemap', 'esri/widgets/BasemapGallery']),
  legend: Object.freeze(['esri/widgets/Legend']),
  projection: Object.freeze([
    'esri/geometry/SpatialReference',
    'esri/geometry/projection',
    'esri/geometry/support/webMercatorUtils',
  ]),
  'feature-layer': Object.freeze(['esri/layers/FeatureLayer']),
  'map-image-layer': Object.freeze(['esri/layers/MapImageLayer']),
  'scene-layer': Object.freeze(['esri/layers/SceneLayer']),
  'imagery-layer': Object.freeze(['esri/layers/ImageryLayer']),
  'vector-tile-layer': Object.freeze(['esri/layers/VectorTileLayer']),
  'geojson-layer': Object.freeze(['esri/layers/GeoJSONLayer']),
});

const DEFAULT_PRIORITY: Readonly<Record<ArcgisFeatureIntent, number>> = Object.freeze({
  'map-2d': 100,
  'map-3d': 100,
  'reactive-view': 95,
  query: 90,
  identify: 85,
  'feature-layer': 80,
  'map-image-layer': 80,
  'scene-layer': 80,
  'vector-tile-layer': 75,
  'geojson-layer': 70,
  projection: 65,
  measurement: 60,
  sketch: 60,
  legend: 50,
  'basemap-gallery': 45,
  'imagery-layer': 40,
});

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(\`\${name} must be a positive safe integer\`);
  }
  return value;
};

export const normalizeArcgisBundleBudget = (
  budget: ArcgisBundleBudget,
): ArcgisBundleBudget => Object.freeze({
  maxModules: positiveInteger(budget.maxModules, 'maxModules'),
  maxRelativeWeight: positiveInteger(budget.maxRelativeWeight, 'maxRelativeWeight'),
});

const normalizePriority = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new TypeError('ArcGIS feature priority must be finite.');
  return value;
};

const normalizeRequests = (
  requests: readonly (ArcgisFeatureIntent | ArcgisFeatureRequest)[],
): readonly Readonly<{ intent: ArcgisFeatureIntent; priority: number; order: number }>[] => {
  const byIntent = new Map<ArcgisFeatureIntent, { intent: ArcgisFeatureIntent; priority: number; order: number }>();

  requests.forEach((request, order) => {
    const intent = typeof request === 'string' ? request : request.intent;
    if (!(intent in FEATURE_REQUIREMENTS)) {
      throw new Error(\`Unknown ArcGIS feature intent: \${String(intent)}\`);
    }
    const priority = normalizePriority(
      typeof request === 'string' ? undefined : request.priority,
      DEFAULT_PRIORITY[intent],
    );
    const existing = byIntent.get(intent);
    if (!existing) {
      byIntent.set(intent, { intent, priority, order });
      return;
    }
    if (priority > existing.priority) existing.priority = priority;
  });

  return [...byIntent.values()].sort((left, right) => (
    right.priority - left.priority || left.order - right.order || left.intent.localeCompare(right.intent)
  ));
};

const resolvedForFeature = (intent: ArcgisFeatureIntent): readonly ArcgisResolvedModule[] => {
  const requirements = FEATURE_REQUIREMENTS[intent];
  for (const moduleId of requirements) requireArcgisModuleDescriptor(moduleId);
  return resolveArcgisCatalogModules(requirements);
};

export const getArcgisFeatureRequirements = (
  intent: ArcgisFeatureIntent,
): readonly string[] => FEATURE_REQUIREMENTS[intent];

export const planArcgisBundle = (
  requests: readonly (ArcgisFeatureIntent | ArcgisFeatureRequest)[],
  budgetInput: ArcgisBundleBudget,
): ArcgisBundlePlan => {
  const budget = normalizeArcgisBundleBudget(budgetInput);
  const normalized = normalizeRequests(requests);
  const acceptedSpecifiers = new Set<string>();
  const moduleIds: string[] = [];
  const specifiers: string[] = [];
  const acceptedFeatures: ArcgisFeatureIntent[] = [];
  const deferredFeatures: ArcgisFeatureIntent[] = [];
  const featurePlans: ArcgisBundleFeaturePlan[] = [];
  const diagnostics: string[] = [];
  let relativeWeight = 0;

  for (const request of normalized) {
    const resolved = resolvedForFeature(request.intent);
    const additions = resolved.filter((item) => !acceptedSpecifiers.has(item.descriptor.specifier));
    const addedRelativeWeight = additions.reduce(
      (total, item) => total + item.descriptor.relativeWeight,
      0,
    );
    const nextModuleCount = moduleIds.length + additions.length;
    const nextWeight = relativeWeight + addedRelativeWeight;
    const moduleBudgetExceeded = nextModuleCount > budget.maxModules;
    const weightBudgetExceeded = nextWeight > budget.maxRelativeWeight;

    if (moduleBudgetExceeded || weightBudgetExceeded) {
      deferredFeatures.push(request.intent);
      const reasons = [
        ...(moduleBudgetExceeded ? ['module-budget'] : []),
        ...(weightBudgetExceeded ? ['weight-budget'] : []),
      ];
      const reason = reasons.join('+');
      diagnostics.push(\`\${request.intent} deferred: \${reason}\`);
      featurePlans.push(Object.freeze({
        intent: request.intent,
        priority: request.priority,
        accepted: false,
        addedModuleIds: Object.freeze([]),
        addedRelativeWeight,
        reason,
      }));
      continue;
    }

    acceptedFeatures.push(request.intent);
    for (const item of additions) {
      acceptedSpecifiers.add(item.descriptor.specifier);
      moduleIds.push(item.requestedId);
      specifiers.push(item.descriptor.specifier);
    }
    relativeWeight = nextWeight;
    featurePlans.push(Object.freeze({
      intent: request.intent,
      priority: request.priority,
      accepted: true,
      addedModuleIds: Object.freeze(additions.map((item) => item.requestedId)),
      addedRelativeWeight,
      reason: null,
    }));
  }

  return Object.freeze({
    requestedFeatures: Object.freeze(normalized.map((request) => request.intent)),
    acceptedFeatures: Object.freeze(acceptedFeatures),
    deferredFeatures: Object.freeze(deferredFeatures),
    moduleIds: Object.freeze(moduleIds),
    specifiers: Object.freeze(specifiers),
    relativeWeight,
    complete: deferredFeatures.length === 0,
    featurePlans: Object.freeze(featurePlans),
    diagnostics: Object.freeze(diagnostics),
  });
};

const pushIfEnabled = (
  target: ArcgisFeatureIntent[],
  enabled: boolean | undefined,
  intent: ArcgisFeatureIntent,
): void => {
  if (enabled) target.push(intent);
};

export const expandArcgisRuntimeFeatureProfile = (
  profile: ArcgisRuntimeFeatureProfile,
): readonly ArcgisFeatureIntent[] => {
  const intents: ArcgisFeatureIntent[] = [];

  if (profile.view === '2d' || profile.view === 'hybrid') intents.push('map-2d');
  if (profile.view === '3d' || profile.view === 'hybrid') intents.push('map-3d');
  pushIfEnabled(intents, profile.reactiveView, 'reactive-view');
  pushIfEnabled(intents, profile.query, 'query');
  pushIfEnabled(intents, profile.identify, 'identify');
  pushIfEnabled(intents, profile.measurement, 'measurement');
  pushIfEnabled(intents, profile.sketch, 'sketch');
  pushIfEnabled(intents, profile.basemapGallery, 'basemap-gallery');
  pushIfEnabled(intents, profile.legend, 'legend');
  pushIfEnabled(intents, profile.projection, 'projection');
  pushIfEnabled(intents, profile.featureLayer, 'feature-layer');
  pushIfEnabled(intents, profile.mapImageLayer, 'map-image-layer');
  pushIfEnabled(intents, profile.sceneLayer, 'scene-layer');
  pushIfEnabled(intents, profile.imageryLayer, 'imagery-layer');
  pushIfEnabled(intents, profile.vectorTileLayer, 'vector-tile-layer');
  pushIfEnabled(intents, profile.geoJsonLayer, 'geojson-layer');

  return Object.freeze(intents);
};

export const planArcgisRuntimeProfile = (
  profile: ArcgisRuntimeFeatureProfile,
  budget: ArcgisBundleBudget,
): ArcgisBundlePlan => planArcgisBundle(expandArcgisRuntimeFeatureProfile(profile), budget);
