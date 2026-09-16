/**
 * Shared TypeScript contracts for Kent Rehberi GIS runtime.
 *
 * Keep these contracts framework-agnostic: React surfaces, 2D/3D ArcGIS
 * adapters and query workers consume the same domain language without
 * introducing a second configuration or icon-mapping authority.
 */

export type Nullable<T> = T | null;
export type Maybe<T> = T | null | undefined;
export type Dictionary<T = unknown> = Record<string, T>;
export type Id = string;
export type Timestamp = string;

export interface RuntimeErrorDetails {
  code?: string;
  cause?: unknown;
  status?: number;
}

export interface AbortableOptions {
  signal?: AbortSignal;
}

export type SpatialRelation =
  | 'contains'
  | 'crosses'
  | 'disjoint'
  | 'equals'
  | 'intersects'
  | 'overlaps'
  | 'touches'
  | 'within';

export interface ArcGisGeometryLike {
  type?: string;
  spatialReference?: { wkid?: number; latestWkid?: number; [key: string]: unknown };
  toJSON?: () => unknown;
  [key: string]: unknown;
}

export interface ArcGisGraphicLike {
  geometry?: ArcGisGeometryLike | null;
  attributes?: Dictionary;
  uid?: string | number;
  id?: string | number;
  layer?: ArcGisLayerLike | null;
  [key: string]: unknown;
}

export interface ArcGisFeatureSetLike {
  features?: ArcGisGraphicLike[];
  exceededTransferLimit?: boolean;
  [key: string]: unknown;
}

export interface ArcGisQueryLike {
  geometry?: ArcGisGeometryLike | null;
  where?: string;
  outFields?: string[];
  returnGeometry?: boolean;
  [key: string]: unknown;
}

export interface ArcGisLayerLike {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  geometryType?: string;
  popupTemplate?: unknown;
  featureReduction?: unknown;
  elevationInfo?: unknown;
  loadStatus?: string;
  loadError?: unknown;
  queryFeatures?: (
    query: ArcGisQueryLike,
    options?: { signal?: AbortSignal },
  ) => Promise<ArcGisFeatureSetLike>;
  watch?: (property: string, callback: (value: unknown) => void) => RemovableHandle;
  when?: (resolve?: () => void, reject?: (error: unknown) => void) => Promise<unknown> | void;
  [key: string]: unknown;
}

export interface RemovableHandle {
  remove?: () => void;
}

export interface IconEntry {
  id: string;
  icon: string;
  key?: string;
  type?: string;
  category?: string;
  aliases?: string[];
  url?: string;
  src?: string;
  title?: string;
  metadata?: Dictionary;
  [key: string]: unknown;
}

export interface ResolvedIconEntry extends IconEntry {
  aliases: string[];
  matchedBy: string | null;
  isFallback: boolean;
}

export interface IconRecord {
  id?: string | number;
  type?: string;
  category?: string;
  kind?: string;
  className?: string;
  iconKey?: string;
  title?: string;
  name?: string;
  angle?: number;
  [key: string]: unknown;
}

export interface IconFallbackEvent {
  record: IconRecord;
  candidates: string[];
  fallback: string;
}

export interface IconResolveOptions {
  fallback?: string;
  onFallback?: (event: IconFallbackEvent) => void;
}

export interface PictureMarkerOptions extends IconResolveOptions {
  minSize?: number;
  maxSize?: number;
  zoomThreshold?: number;
}

export interface PictureMarkerSymbolModel {
  type: 'picture-marker';
  url: string;
  width: string;
  height: string;
  angle: number;
}

export interface ListIconModel {
  key: string;
  src: string;
  alt: string;
  isFallback: boolean;
  matchedBy: string | null;
}

export interface Graphic3DModel {
  iconKey: string;
  billboard: string;
  label: string;
  isFallback: boolean;
}

export const GIS_SERVICE_TYPE = {
  MAP_SERVER: 'MapServer',
  FEATURE_SERVER: 'FeatureServer',
  VECTOR_TILE: 'VectorTileServer',
  IMAGE_SERVER: 'ImageServer',
  SCENE_SERVER: 'SceneServer',
  TILES_3D: '3DTiles',
  GLTF: 'GLTF',
  ELEVATION: 'Elevation',
  GENERIC_ARCGIS_REST: 'ArcGISREST',
} as const;

export type GisServiceType = typeof GIS_SERVICE_TYPE[keyof typeof GIS_SERVICE_TYPE];

export interface GisServiceInput {
  id?: string | number;
  name?: string;
  title?: string;
  type?: string;
  url?: string;
  enabled?: boolean;
  opacity?: number | string;
  minScale?: number | string;
  maxScale?: number | string;
  visible?: boolean;
  sublayerId?: number | null;
  proxy?: boolean;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  metadata?: Dictionary;
  [key: string]: unknown;
}

export interface SanitizedGisService {
  id: string;
  title: string;
  type: GisServiceType;
  url: string;
  enabled: boolean;
  opacity: number;
  minScale: number;
  maxScale: number;
  visible: boolean;
  sublayerId: number | null;
  proxy: boolean;
  metadata: Dictionary;
}

export interface RegisteredGisService extends GisServiceInput {
  id: string;
  title: string;
  type: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  retries: number;
  headers: Record<string, string>;
  metadata: Dictionary;
}

export type GisHealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export interface GisServiceHealth {
  status: GisHealthStatus;
  checkedAt: Timestamp | null;
  latencyMs: number | null;
  attempts: number;
  error: { code: string; message: string } | null;
}

export interface GisRequestContext {
  signal?: AbortSignal;
  attempt: number;
}

export type GisRequestFactory<T = unknown> = (
  service: RegisteredGisService,
  context: GisRequestContext,
) => Promise<T> | T;

export interface GisRequestOptions extends AbortableOptions {
  timeoutMs?: number;
  retries?: number;
}

export const LAYER_RUNTIME_STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  DISABLED: 'disabled',
} as const;

export type LayerRuntimeStatus = typeof LAYER_RUNTIME_STATUS[keyof typeof LAYER_RUNTIME_STATUS];

export interface LayerRuntimeError {
  code: string;
  message: string;
}

export interface LayerRuntimeState {
  status: LayerRuntimeStatus;
  visible: boolean;
  opacity: number;
  minScale: number;
  maxScale: number;
  featureCount: number | null;
  lastLoadedAt: Timestamp | null;
  requestId: string | null;
  error: LayerRuntimeError | null;
}

export interface LayerDescriptorInput {
  id?: string | number;
  title?: string;
  name?: string;
  type?: string;
  serviceId?: string | null;
  parentId?: string | null;
  children?: Array<string | number>;
  iconKey?: string;
  category?: string;
  metadata?: Dictionary;
  visible?: boolean;
  opacity?: number | string;
  minScale?: number | string;
  maxScale?: number | string;
  [key: string]: unknown;
}

export interface LayerDescriptor {
  id: string;
  title: string;
  type: string;
  serviceId: string | number | null;
  parentId: string | null;
  children: string[];
  iconKey: string;
  metadata: Dictionary;
  runtime: LayerRuntimeState;
  sdkLayer: ArcGisLayerLike | null;
}

export interface LayerTree {
  byId: Map<string, LayerDescriptor>;
  roots: string[];
}

export interface FlattenedLayer {
  node: LayerDescriptor;
  depth: number;
  isGroup: boolean;
}

export type LayerAction =
  | { type: 'LOAD_START'; layerId: string; requestId?: string | null }
  | { type: 'LOAD_SUCCESS'; layerId: string; requestId?: string | null; featureCount?: number; loadedAt?: string }
  | { type: 'LOAD_ERROR'; layerId: string; requestId?: string | null; error?: Partial<LayerRuntimeError> | null }
  | { type: 'LOAD_CANCEL'; layerId: string; requestId?: string | null }
  | { type: 'SET_VISIBLE'; layerId: string; visible: boolean }
  | { type: 'SET_OPACITY'; layerId: string; opacity: number }
  | { type: 'SET_SCALE_RANGE'; layerId: string; minScale?: number; maxScale?: number }
  | { type: 'SET_SDK_LAYER'; layerId: string; requestId?: string | null; sdkLayer?: ArcGisLayerLike | null }
  | { type: 'SET_DISABLED'; layerId: string; disabled: boolean };

export interface LayerRuntimeSnapshot {
  layers?: Array<{
    id: string;
    visible?: boolean;
    opacity?: number;
    minScale?: number;
    maxScale?: number;
    status?: LayerRuntimeStatus;
  }>;
}

export interface SpatialQueryOptions extends AbortableOptions {
  geometry?: ArcGisGeometryLike;
  where?: string;
  outFields?: string[];
  returnGeometry?: boolean;
}

export interface DistanceQueryOptions extends SpatialQueryOptions {
  unit?: string;
}

export interface TimeSliderState {
  start: string;
  end: string;
  current: string;
  stepMs: number;
}

export interface AnalysisInput {
  distance?: unknown;
  unit?: unknown;
  where?: unknown;
  maxResults?: unknown;
}

export interface ParsedAnalysisInput {
  distance: number;
  unit: string;
  where: string;
  maxResults: number;
}

export interface FeatureSummary {
  count: number;
  exceededTransferLimit: boolean;
  hasGeometry: boolean;
}

export interface ServiceHealthSnapshot extends Dictionary {
  serviceId: string;
  status: string;
  lastCheckedAt: string;
}

export type DedupeWork<T> = () => Promise<T> | T;
export type DedupeExecutor = <T>(key: string, work: DedupeWork<T>) => Promise<T>;

export type ViewMode = '2d' | '3d';
export type ViewCenter = [number, number];
export type ObjectId = string | number;

export interface ViewExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  wkid: number | null;
}

export interface ViewState {
  mode: ViewMode;
  center: ViewCenter | null;
  zoom: number | null;
  scale: number | null;
  heading: number;
  tilt: number;
  extent: ViewExtent | null;
  basemapId: string | null;
  selectedLayerId: string | null;
  selectedObjectId: ObjectId | null;
  time: string | null;
}

export interface ViewStateInput {
  mode?: string;
  center?: unknown;
  zoom?: unknown;
  scale?: unknown;
  heading?: unknown;
  tilt?: unknown;
  extent?: unknown;
  basemapId?: unknown;
  selectedLayerId?: unknown;
  selectedObjectId?: unknown;
  time?: unknown;
  [key: string]: unknown;
}

export interface ViewSelectionInput {
  layerId?: unknown;
  objectId?: unknown;
}

export interface ViewCameraInput {
  center?: unknown;
  zoom?: unknown;
  scale?: unknown;
  heading?: unknown;
  tilt?: unknown;
  extent?: unknown;
}

export type ViewStateUpdater = ViewState | ViewStateInput | ((state: ViewState) => ViewState | ViewStateInput);
export type ViewStateListener = (state: ViewState) => void;

export interface ViewStateBridge {
  getState: () => ViewState;
  setState: (next: ViewStateUpdater) => ViewState;
  subscribe: (listener: ViewStateListener) => () => boolean | void;
  destroy: () => void;
  isDestroyed: () => boolean;
  listenerCount: () => number;
}
