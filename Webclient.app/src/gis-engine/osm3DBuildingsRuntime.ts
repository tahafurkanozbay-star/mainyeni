import { loadArcgisModule, loadArcgisModules } from './arcgisModuleRuntime';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const OSM_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

const GRID_DEGREES = 0.006;
const MAX_BUILDINGS_PER_CELL = 250;
const MAX_CACHED_CELLS = 6;
const REFRESH_DEBOUNCE_MS = 650;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_INTERVAL_MS = 1_800;
const MAX_QUERY_SCALE = 45_000;
const MAX_CAMERA_ALTITUDE_METERS = 8_000;
const MAX_RING_POINTS = 300;

export interface OSMBuildingFootprint {
  readonly id: number;
  readonly ring: readonly (readonly [number, number])[];
  readonly heightMeters: number;
  readonly name?: string;
  readonly building?: string;
}
export interface OSMBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}
interface OSMElementLike {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly tags?: unknown;
  readonly geometry?: unknown;
}
interface OSMSceneLayerLike {
  visible?: boolean;
  addMany?: (graphics: unknown[]) => unknown;
  add?: (graphic: unknown) => unknown;
  removeAll?: () => unknown;
  destroy?: () => void;
}
interface OSMSceneMapLike {
  add?: (layer: OSMSceneLayerLike, index?: number) => unknown;
  remove?: (layer: OSMSceneLayerLike) => unknown;
}
interface OSMCoordinateLike {
  longitude?: unknown;
  latitude?: unknown;
  x?: unknown;
  y?: unknown;
  spatialReference?: { wkid?: unknown };
}
interface OSMCameraPositionLike extends OSMCoordinateLike {
  z?: unknown;
  altitude?: unknown;
}
export interface OSM3DSceneViewLike {
  readonly map?: OSMSceneMapLike | null;
  readonly center?: OSMCoordinateLike | null;
  readonly camera?: { readonly position?: OSMCameraPositionLike | null } | null;
  readonly scale?: number;
  watch?: (property: string, callback: (...args: unknown[]) => void) => { remove?: () => void };
}

type ArcgisConstructor<T = unknown> = new (properties?: Record<string, unknown>) => T;
type LoadArcgisModules = () => Promise<readonly [ArcgisConstructor<OSMSceneLayerLike>, ArcgisConstructor<unknown>]>;
interface ArcgisRequestOptions {
  readonly method: 'post';
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly responseType: 'json';
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly authMode: 'anonymous';
}
interface ArcgisRequestResponse {
  readonly data?: unknown;
  readonly httpStatus?: unknown;
  readonly status?: unknown;
}
type ArcgisRequest = (url: string, options: ArcgisRequestOptions) => Promise<ArcgisRequestResponse>;
type LoadArcgisRequest = () => Promise<ArcgisRequest>;
interface SceneCell {
  readonly key: string;
  readonly bounds: OSMBounds;
}

const finiteNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const tagObject = (value: unknown): Record<string, string> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (typeof tagValue === 'string') tags[key] = tagValue;
    else if (typeof tagValue === 'number') tags[key] = String(tagValue);
  }
  return tags;
};
const parseHeightTag = (value: string | undefined): number | null => {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|meter|meters|metre|metres|ft|feet|foot)?$/iu);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unit = (match[2] ?? 'm').toLocaleLowerCase('en-US');
  return unit === 'ft' || unit === 'feet' || unit === 'foot' ? raw * 0.3048 : raw;
};

export const buildingHeightMeters = (tags: Readonly<Record<string, string>>): number => {
  const taggedHeight = parseHeightTag(tags.height);
  const levels = finiteNumber(tags['building:levels']);
  const estimatedHeight = taggedHeight ?? (levels !== null && levels > 0 && levels <= 40 ? levels * 3 : 9);
  return Math.round(clamp(estimatedHeight, 3, 120) * 10) / 10;
};

/** Converts a bounded Overpass response to safe, closed polygon rings. */
export const parseOverpassBuildings = (payload: unknown): OSMBuildingFootprint[] => {
  if (!payload || typeof payload !== 'object') return [];
  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return [];
  const buildings: OSMBuildingFootprint[] = [];
  for (const candidate of elements as OSMElementLike[]) {
    if (candidate?.type !== 'way') continue;
    const id = finiteNumber(candidate.id);
    const tags = tagObject(candidate.tags);
    if (id === null || !Number.isSafeInteger(id) || !tags?.building || tags.building.toLowerCase() === 'no') continue;
    if (!Array.isArray(candidate.geometry) || candidate.geometry.length < 3 || candidate.geometry.length > MAX_RING_POINTS) continue;
    const ring: [number, number][] = [];
    let invalid = false;
    for (const vertex of candidate.geometry as unknown[]) {
      if (!vertex || typeof vertex !== 'object') { invalid = true; break; }
      const lon = finiteNumber((vertex as { lon?: unknown }).lon);
      const lat = finiteNumber((vertex as { lat?: unknown }).lat);
      if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        invalid = true;
        break;
      }
      ring.push([lon, lat]);
    }
    if (invalid || ring.length < 3) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) continue;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    if (ring.length < 4 || ring.length > MAX_RING_POINTS + 1) continue;
    buildings.push({
      id,
      ring,
      heightMeters: buildingHeightMeters(tags),
      ...(tags.name ? { name: tags.name.slice(0, 160) } : {}),
      ...(tags.building ? { building: tags.building.slice(0, 80) } : {}),
    });
    if (buildings.length >= MAX_BUILDINGS_PER_CELL) break;
  }
  return buildings;
};

export const createBuildingQuery = (bounds: OSMBounds): string => (
  `[out:json][timeout:12];way["building"]["building"!="no"](${bounds.south.toFixed(5)},${bounds.west.toFixed(5)},${bounds.north.toFixed(5)},${bounds.east.toFixed(5)});out geom ${MAX_BUILDINGS_PER_CELL};`
);

const cellForPosition = (longitude: number, latitude: number): SceneCell => {
  const lon = clamp(longitude, -179.999, 179.999);
  const lat = clamp(latitude, -89.999, 89.999);
  const x = Math.floor((lon + 180) / GRID_DEGREES);
  const y = Math.floor((lat + 90) / GRID_DEGREES);
  const west = -180 + x * GRID_DEGREES;
  const south = -90 + y * GRID_DEGREES;
  return {
    key: `${x}:${y}`,
    bounds: { south, west, north: Math.min(90, south + GRID_DEGREES), east: Math.min(180, west + GRID_DEGREES) },
  };
};

interface ScenePosition {
  readonly longitude: number;
  readonly latitude: number;
  readonly altitudeMeters: number | null;
}
const coordinatesForPoint = (
  point: OSMCoordinateLike | null | undefined,
): Readonly<{ longitude: number; latitude: number }> | null => {
  if (!point) return null;
  let longitude = finiteNumber(point.longitude);
  let latitude = finiteNumber(point.latitude);
  if (longitude === null || latitude === null) {
    const x = finiteNumber(point.x);
    const y = finiteNumber(point.y);
    const wkid = finiteNumber(point.spatialReference?.wkid);
    if (x === null || y === null) return null;
    if (wkid === 4326) {
      longitude = x;
      latitude = y;
    } else if (wkid === 3857 || wkid === 102100 || wkid === 102113) {
      longitude = (x / 20037508.34) * 180;
      latitude = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 2 - Math.PI / 2) * (180 / Math.PI);
    } else return null;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { longitude, latitude };
};

/** Prefers the SceneView target centre to avoid querying at the offset camera position. */
export const resolveOSMSceneTarget = (view: OSM3DSceneViewLike): ScenePosition | null => {
  const camera = view.camera?.position;
  const target = coordinatesForPoint(view.center) ?? coordinatesForPoint(camera);
  if (!target) return null;
  return {
    ...target,
    altitudeMeters: finiteNumber(camera?.altitude) ?? finiteNumber(camera?.z),
  };
};

const positionForView = resolveOSMSceneTarget;
const cameraIsCloseEnough = (view: OSM3DSceneViewLike, position: ScenePosition): boolean => {
  const scale = finiteNumber(view.scale);
  if (scale !== null && scale > MAX_QUERY_SCALE) return false;
  if (position.altitudeMeters !== null && position.altitudeMeters > MAX_CAMERA_ALTITUDE_METERS) return false;
  return scale !== null || position.altitudeMeters !== null;
};
const defaultLoadModules: LoadArcgisModules = () => loadArcgisModules<
  readonly [ArcgisConstructor<OSMSceneLayerLike>, ArcgisConstructor<unknown>]
>(['esri/layers/GraphicsLayer', 'esri/Graphic']);

const defaultLoadArcgisRequest: LoadArcgisRequest = () => loadArcgisModule<ArcgisRequest>('esri/request');

export interface OSM3DBuildingsRuntimeOptions {
  readonly loadModules?: LoadArcgisModules;
  readonly loadRequest?: LoadArcgisRequest;
}

/**
 * Queries a single small building cell only while the camera is close. Requests
 * are sequential, spaced out, abortable, and cached in memory. Footprints are
 * extruded in SceneView; areas without mapped OSM buildings remain unmodeled.
 */
export class OSM3DBuildingsRuntime {
  readonly #loadGisModules: LoadArcgisModules;
  readonly #loadRequest: LoadArcgisRequest;
  #requester: ArcgisRequest | null = null;
  #view: OSM3DSceneViewLike | null = null;
  #map: OSMSceneMapLike | null = null;
  #layer: OSMSceneLayerLike | null = null;
  #Graphic: ArcgisConstructor<unknown> | null = null;
  #watchHandles: Array<{ remove?: () => void }> = [];
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #requestController: AbortController | null = null;
  #requestTimeout: ReturnType<typeof setTimeout> | null = null;
  #cache = new Map<string, OSMBuildingFootprint[]>();
  #lastCellKey: string | null = null;
  #generation = 0;
  #cooldownUntil = 0;
  #lastRequestAt = 0;

  constructor(options: OSM3DBuildingsRuntimeOptions = {}) {
    this.#loadGisModules = options.loadModules ?? defaultLoadModules;
    this.#loadRequest = options.loadRequest ?? defaultLoadArcgisRequest;
  }

  async activate(view: OSM3DSceneViewLike): Promise<void> {
    const map = view.map;
    if (!map || typeof map.add !== 'function') throw new Error('OSM 3B binaları için harita nesnesi hazır değil.');
    if (this.#view === view && this.#layer) {
      this.#layer.visible = true;
      this.#scheduleRefresh(0);
      return;
    }
    this.deactivate();
    const generation = this.#generation;
    this.#view = view;
    const [[GraphicsLayer, Graphic], requester] = await Promise.all([this.#loadGisModules(), this.#loadRequest()]);
    if (generation !== this.#generation || this.#view !== view) return;
    this.#requester = requester;

    if (this.#map !== map) {
      if (this.#map && this.#layer) {
        try { this.#map.remove?.(this.#layer); } catch (error) {
          runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.remove-old-layer' }, 'warn');
        }
        try { this.#layer.destroy?.(); } catch (error) {
          runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.destroy-old-layer' }, 'warn');
        }
      }
      this.#map = map;
      this.#layer = null;
    }
    if (!this.#layer) {
      this.#layer = new GraphicsLayer({
        id: 'kentrehberi-osm-3d-buildings',
        title: 'OpenStreetMap 3B binalar',
        listMode: 'hide',
        visible: true,
      });
      map.add(this.#layer, 0);
    }
    this.#Graphic = Graphic;
    this.#layer.visible = true;
    if (typeof view.watch === 'function') {
      this.#watchHandles.push(
        view.watch('camera', () => this.#scheduleRefresh()),
        view.watch('scale', () => this.#scheduleRefresh()),
      );
    }
    this.#scheduleRefresh(100);
  }

  deactivate(): void {
    this.#generation += 1;
    this.#view = null;
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#requestController?.abort();
    this.#requestController = null;
    if (this.#requestTimeout !== null) clearTimeout(this.#requestTimeout);
    this.#requestTimeout = null;
    this.#watchHandles.forEach((handle) => {
      try { handle.remove?.(); } catch (error) {
        runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.remove-watch' }, 'warn');
      }
    });
    this.#watchHandles = [];
    if (this.#layer) this.#layer.visible = false;
    this.#lastCellKey = null;
  }

  dispose(): void {
    this.deactivate();
    if (this.#map && this.#layer) {
      try { this.#map.remove?.(this.#layer); } catch (error) {
        runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.remove-layer' }, 'warn');
      }
      try { this.#layer.destroy?.(); } catch (error) {
        runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.destroy-layer' }, 'warn');
      }
    }
    this.#layer = null;
    this.#map = null;
    this.#Graphic = null;
    this.#cache.clear();
  }

  #scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#refresh();
    }, delay);
  }

  async #refresh(): Promise<void> {
    const view = this.#view;
    const layer = this.#layer;
    const Graphic = this.#Graphic;
    const requester = this.#requester;
    if (!view || !layer || !Graphic || !requester) return;
    const position = positionForView(view);
    if (!position || !cameraIsCloseEnough(view, position)) {
      if (this.#requestController) this.#requestController.abort();
      this.#requestController = null;
      layer.removeAll?.();
      this.#lastCellKey = null;
      return;
    }

    const cell = cellForPosition(position.longitude, position.latitude);
    if (cell.key === this.#lastCellKey) return;

    // Keep at most one request in flight and add spacing between requests to
    // respect the shared, community-operated Overpass service.
    if (this.#requestController) {
      this.#lastCellKey = null;
      this.#scheduleRefresh(1_000);
      return;
    }
    const delayUntilRequest = MIN_REQUEST_INTERVAL_MS - (Date.now() - this.#lastRequestAt);
    if (delayUntilRequest > 0) {
      this.#lastCellKey = null;
      this.#scheduleRefresh(delayUntilRequest);
      return;
    }
    if (Date.now() < this.#cooldownUntil) {
      this.#lastCellKey = null;
      this.#scheduleRefresh(this.#cooldownUntil - Date.now() + 25);
      return;
    }
    this.#lastCellKey = cell.key;

    const cached = this.#cache.get(cell.key);
    if (cached) {
      this.#cache.delete(cell.key);
      this.#cache.set(cell.key, cached);
      this.#showBuildings(layer, Graphic, cached);
      return;
    }

    const controller = new AbortController();
    const generation = this.#generation;
    this.#requestController = controller;
    this.#lastRequestAt = Date.now();
    const requestTimeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.#requestTimeout = requestTimeout;
    try {
      const response = await requester(OSM_OVERPASS_ENDPOINT, {
        method: 'post',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(createBuildingQuery(cell.bounds))}`,
        responseType: 'json',
        signal: controller.signal,
        timeout: REQUEST_TIMEOUT_MS,
        authMode: 'anonymous',
      });
      const responseStatus = finiteNumber(response.httpStatus ?? response.status);
      if (responseStatus !== null && responseStatus >= 400) {
        if (responseStatus === 429 || responseStatus >= 500) this.#cooldownUntil = Date.now() + 30_000;
        throw new Error(`Overpass API HTTP ${responseStatus}`);
      }
      const footprints = parseOverpassBuildings(response.data);
      if (generation !== this.#generation || controller.signal.aborted || this.#view !== view) return;
      this.#cache.set(cell.key, footprints);
      while (this.#cache.size > MAX_CACHED_CELLS) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
      const latestPosition = positionForView(view);
      const latestCell = latestPosition && cameraIsCloseEnough(view, latestPosition)
        ? cellForPosition(latestPosition.longitude, latestPosition.latitude)
        : null;
      if (latestCell?.key === cell.key && this.#layer === layer) this.#showBuildings(layer, Graphic, footprints);
    } catch (error) {
      if (!controller.signal.aborted) {
        const details = error && typeof error === 'object'
          ? (error as { details?: unknown }).details
          : undefined;
        const status = details && typeof details === 'object'
          ? finiteNumber((details as { httpStatus?: unknown; status?: unknown }).httpStatus
            ?? (details as { status?: unknown }).status)
          : null;
        if (status === 429 || (status !== null && status >= 500)) this.#cooldownUntil = Date.now() + 30_000;
        runtimeDiagnostics.captureError(error, { source: 'gis.osm-buildings.overpass', cell: cell.key }, 'warn');
      }
    } finally {
      clearTimeout(requestTimeout);
      if (this.#requestController === controller) this.#requestController = null;
      if (this.#requestTimeout === requestTimeout) this.#requestTimeout = null;
      if (generation === this.#generation && this.#view === view) this.#scheduleRefresh(120);
    }
  }

  #showBuildings(layer: OSMSceneLayerLike, Graphic: ArcgisConstructor<unknown>, footprints: readonly OSMBuildingFootprint[]): void {
    const graphics = footprints.map((building) => new Graphic({
      geometry: { type: 'polygon', rings: [building.ring], spatialReference: { wkid: 4326 } },
      attributes: {
        osmId: building.id,
        heightMeters: building.heightMeters,
        ...(building.name ? { name: building.name } : {}),
        ...(building.building ? { building: building.building } : {}),
      },
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [{
          type: 'extrude',
          size: building.heightMeters,
          material: { color: [184, 197, 210, 0.92] },
          edges: { type: 'solid', color: [92, 107, 122, 0.95], size: 0.6 },
        }],
      },
    }));
    layer.removeAll?.();
    if (layer.addMany) layer.addMany(graphics);
    else graphics.forEach((graphic) => layer.add?.(graphic));
  }
}

export const createOSM3DBuildingsRuntime = (): OSM3DBuildingsRuntime => new OSM3DBuildingsRuntime();
