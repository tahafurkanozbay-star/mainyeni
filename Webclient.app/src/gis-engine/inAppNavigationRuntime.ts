import { loadArcgisModules } from './arcgisModuleRuntime';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const ARC_GIS_ROUTE_SERVICE_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World';

export type InAppTravelMode = 'driving' | 'walking';

export interface InAppNavigationStop {
  readonly displayName: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface InAppNavigationStep {
  readonly id: string;
  readonly instruction: string;
  readonly distanceKm: number;
  readonly durationMinutes: number;
}

export interface InAppNavigationResult {
  readonly geometry: unknown;
  readonly distanceKm: number;
  readonly durationMinutes: number;
  readonly steps: readonly InAppNavigationStep[];
}

interface RouteGraphicLike {
  readonly geometry?: unknown;
  readonly attributes?: Readonly<Record<string, unknown>> | null;
}

interface DirectionFeatureLike {
  readonly attributes?: Readonly<Record<string, unknown>> | null;
}

interface RouteResultLike {
  readonly route?: RouteGraphicLike | null;
  readonly directions?: {
    readonly totalLength?: unknown;
    readonly totalTime?: unknown;
    readonly features?: readonly DirectionFeatureLike[] | null;
  } | null;
}

interface RouteSolveResponseLike {
  readonly routeResults?: readonly RouteResultLike[] | null;
}

interface TravelModeLike {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly impedanceAttributeName?: unknown;
  readonly timeAttributeName?: unknown;
  readonly distanceAttributeName?: unknown;
  readonly restrictionAttributeNames?: readonly string[] | null;
  readonly attributeParameterValues?: readonly unknown[] | null;
  readonly useHierarchy?: unknown;
  readonly uturnAtJunctions?: unknown;
  readonly [key: string]: unknown;
}

interface RouteServiceDescriptionLike {
  readonly supportedTravelModes?: readonly TravelModeLike[] | null;
}

interface RouteFeatureSetConstructor {
  new (properties: { features: readonly unknown[] }): unknown;
}

interface RouteParametersConstructor {
  new (properties: Readonly<Record<string, unknown>>): unknown;
}

interface RouteGraphicConstructor {
  new (properties: Readonly<Record<string, unknown>>): RouteGraphicLike;
}

interface RouteGraphicLayerLike {
  add?: (graphic: RouteGraphicLike) => void;
  removeAll?: () => void;
  destroy?: () => void;
}

interface RouteGraphicsLayerConstructor {
  new (properties: Readonly<Record<string, unknown>>): RouteGraphicLayerLike;
}

export interface InAppNavigationMapLike {
  add?: (layer: RouteGraphicLayerLike) => void;
  remove?: (layer: RouteGraphicLayerLike) => void;
}

interface RouteRequestOptions {
  readonly authMode?: 'anonymous';
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

interface RouteSolveModule {
  solve: (
    url: string,
    parameters: unknown,
    options?: RouteRequestOptions,
  ) => Promise<RouteSolveResponseLike>;
}

interface NetworkServiceModule {
  fetchServiceDescription: (
    url: string,
    apiKey?: string | null,
    options?: RouteRequestOptions | null,
  ) => Promise<RouteServiceDescriptionLike>;
}

interface ArcgisConfigurationLike {
  readonly apiKey?: string;
}

type ArcgisNavigationModules = readonly [
  RouteSolveModule,
  RouteParametersConstructor,
  RouteFeatureSetConstructor,
  RouteGraphicConstructor,
  RouteGraphicsLayerConstructor,
  NetworkServiceModule,
  ArcgisConfigurationLike,
];

type ArcgisModuleLoader = <TModules extends readonly unknown[]>(
  moduleIds: readonly string[],
) => Promise<TModules>;

interface InAppNavigationRuntimeOptions {
  readonly loadModules?: ArcgisModuleLoader;
  readonly onError?: (error: unknown, source: string) => void;
}

const MODULE_IDS = Object.freeze([
  'esri/rest/route',
  'esri/rest/support/RouteParameters',
  'esri/rest/support/FeatureSet',
  'esri/Graphic',
  'esri/layers/GraphicsLayer',
  'esri/rest/networkService',
  'esri/config',
]);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeStop = (stop: InAppNavigationStop, label: string): InAppNavigationStop => {
  if (!stop || typeof stop.displayName !== 'string' || !stop.displayName.trim()) {
    throw new TypeError(`${label} adresini seçin.`);
  }
  const latitude = finiteNumber(stop.latitude);
  const longitude = finiteNumber(stop.longitude);
  if (latitude === null || latitude < -90 || latitude > 90
    || longitude === null || longitude < -180 || longitude > 180) {
    throw new RangeError(`${label} konum koordinatları geçerli değil.`);
  }
  return Object.freeze({
    displayName: stop.displayName.trim().slice(0, 320),
    latitude,
    longitude,
  });
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Rota işlemi iptal edildi.', 'AbortError');
  }
};

const readTravelMode = (
  modes: readonly TravelModeLike[] | null | undefined,
  mode: InAppTravelMode,
): TravelModeLike => {
  const requestedName = mode === 'walking' ? /walk|pedestrian/iu : /driv/iu;
  const travelMode = modes?.find((candidate) => (
    typeof candidate.name === 'string' && requestedName.test(candidate.name)
  ));
  if (!travelMode) {
    throw new Error(mode === 'walking'
      ? 'Yürüyüş rotası bu yönlendirme servisinde desteklenmiyor.'
      : 'Araç rotası bu yönlendirme servisinde desteklenmiyor.');
  }
  return travelMode;
};

const routeSummary = (
  route: RouteResultLike,
  features: readonly DirectionFeatureLike[] | null | undefined,
): Pick<InAppNavigationResult, 'distanceKm' | 'durationMinutes' | 'steps'> => {
  const directions = route.directions;
  const steps = (features ?? []).flatMap((feature, index) => {
    const attributes = feature.attributes;
    const instruction = typeof attributes?.text === 'string' ? attributes.text.trim() : '';
    if (!instruction) return [];
    return [Object.freeze({
      id: `direction-${index}`,
      instruction: instruction.slice(0, 500),
      distanceKm: Math.max(0, finiteNumber(attributes?.length) ?? 0),
      durationMinutes: Math.max(0, finiteNumber(attributes?.time) ?? 0),
    })];
  });
  const routeAttributes = route.route?.attributes;
  const distanceKm = finiteNumber(directions?.totalLength)
    ?? finiteNumber(routeAttributes?.Total_Kilometers)
    ?? finiteNumber(routeAttributes?.Total_Kilometers_1)
    ?? steps.reduce((total, step) => total + step.distanceKm, 0);
  const durationMinutes = finiteNumber(directions?.totalTime)
    ?? finiteNumber(routeAttributes?.Total_TravelTime)
    ?? finiteNumber(routeAttributes?.Total_Minutes)
    ?? steps.reduce((total, step) => total + step.durationMinutes, 0);
  return Object.freeze({
    distanceKm: Math.max(0, distanceKm),
    durationMinutes: Math.max(0, durationMinutes),
    steps: Object.freeze(steps),
  });
};

export class InAppNavigationRuntime {
  readonly #loadModules: ArcgisModuleLoader;
  readonly #onError: (error: unknown, source: string) => void;
  #map: InAppNavigationMapLike | null = null;
  #layer: RouteGraphicLayerLike | null = null;
  #serviceDescription: Promise<RouteServiceDescriptionLike> | null = null;
  #generation = 0;
  #disposed = false;

  constructor(options: InAppNavigationRuntimeOptions = {}) {
    this.#loadModules = options.loadModules ?? loadArcgisModules;
    this.#onError = options.onError ?? ((error, source) => {
      runtimeDiagnostics.captureError(error, { source }, 'warn');
    });
  }

  async planRoute(
    map: InAppNavigationMapLike,
    originInput: InAppNavigationStop,
    destinationInput: InAppNavigationStop,
    mode: InAppTravelMode,
    signal?: AbortSignal,
  ): Promise<InAppNavigationResult> {
    if (this.#disposed) throw new Error('Rota çalışma alanı artık kullanılamıyor.');
    if (!map || typeof map.add !== 'function') throw new Error('Harita henüz rota çizmeye hazır değil.');
    const origin = normalizeStop(originInput, 'Başlangıç');
    const destination = normalizeStop(destinationInput, 'Varış');
    if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) {
      throw new Error('Başlangıç ve varış konumları aynı olamaz.');
    }
    throwIfAborted(signal);
    const generation = ++this.#generation;

    try {
      const [
        routeModule,
        RouteParameters,
        FeatureSet,
        Graphic,
        GraphicsLayer,
        networkService,
        esriConfig,
      ] = await this.#loadModules<ArcgisNavigationModules>(MODULE_IDS);
      throwIfAborted(signal);
      const apiKey = esriConfig.apiKey?.trim();
      if (!apiKey) {
        throw new Error('Uygulama içi yol tarifi için VITE_ESRI_BASEMAP_CREDENTIAL anahtarını ayarlayın.');
      }
      let serviceDescription: RouteServiceDescriptionLike;
      try {
        serviceDescription = await this.#getServiceDescription(networkService, apiKey, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Rota servisine erişilemiyor. ArcGIS yönlendirme yetkisini ve bağlantıyı kontrol edin.', { cause: error });
      }
      const travelMode = readTravelMode(serviceDescription.supportedTravelModes, mode);
      const stops = new FeatureSet({
        features: [
          new Graphic({
            geometry: {
              type: 'point',
              longitude: origin.longitude,
              latitude: origin.latitude,
              spatialReference: { wkid: 4326 },
            },
            attributes: { Name: origin.displayName },
          }),
          new Graphic({
            geometry: {
              type: 'point',
              longitude: destination.longitude,
              latitude: destination.latitude,
              spatialReference: { wkid: 4326 },
            },
            attributes: { Name: destination.displayName },
          }),
        ],
      });
      const parameters = new RouteParameters({
        stops,
        travelMode,
        apiKey,
        returnRoutes: true,
        returnDirections: true,
        directionsLanguage: 'tr',
        directionsOutputType: 'complete',
        directionsLengthUnits: 'kilometers',
      });
      let response: RouteSolveResponseLike;
      try {
        response = await routeModule.solve(ARC_GIS_ROUTE_SERVICE_URL, parameters, {
          authMode: 'anonymous',
          ...(signal ? { signal } : {}),
          timeout: 30_000,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Rota hesaplanamadı. ArcGIS yönlendirme yetkisini ve seçilen adresleri kontrol edin.', { cause: error });
      }
      throwIfAborted(signal);
      if (this.#disposed || generation !== this.#generation) {
        throw new DOMException('Yeni bir rota isteği başlatıldı.', 'AbortError');
      }
      const route = response.routeResults?.[0];
      const geometry = route?.route?.geometry;
      if (!route || !geometry) throw new Error('Yönlendirme servisi kullanılabilir bir rota döndürmedi.');

      const summary = routeSummary(route, route.directions?.features);
      const layer = this.#ensureLayer(map, GraphicsLayer);
      if (typeof layer.removeAll !== 'function' || typeof layer.add !== 'function') {
        throw new Error('Rota katmanı haritada kullanılamıyor.');
      }
      const routeLine = new Graphic({
        geometry,
        symbol: { type: 'simple-line', color: [255, 255, 255, 245], width: 9 },
        attributes: { role: 'route-outline' },
      });
      const routeStroke = new Graphic({
        geometry,
        symbol: { type: 'simple-line', color: [23, 105, 224, 255], width: 5 },
        attributes: { role: 'route-line' },
      });
      const startGraphic = new Graphic({
        geometry: {
          type: 'point',
          longitude: origin.longitude,
          latitude: origin.latitude,
          spatialReference: { wkid: 4326 },
        },
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          color: [16, 128, 79, 255],
          size: 14,
          outline: { color: [255, 255, 255, 255], width: 2 },
        },
        attributes: { role: 'route-origin', name: origin.displayName },
      });
      const destinationGraphic = new Graphic({
        geometry: {
          type: 'point',
          longitude: destination.longitude,
          latitude: destination.latitude,
          spatialReference: { wkid: 4326 },
        },
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          color: [190, 45, 53, 255],
          size: 14,
          outline: { color: [255, 255, 255, 255], width: 2 },
        },
        attributes: { role: 'route-destination', name: destination.displayName },
      });
      layer.removeAll();
      layer.add(routeLine);
      layer.add(routeStroke);
      layer.add(startGraphic);
      layer.add(destinationGraphic);
      return Object.freeze({ geometry, ...summary });
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      this.#report(error, 'gis.in-app-navigation.plan-route');
      throw error;
    }
  }

  clear(): void {
    try {
      this.#layer?.removeAll?.();
    } catch (error) {
      this.#report(error, 'gis.in-app-navigation.clear');
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    const layer = this.#layer;
    const map = this.#map;
    this.#layer = null;
    this.#map = null;
    try {
      if (layer) map?.remove?.(layer);
    } catch (error) {
      this.#report(error, 'gis.in-app-navigation.remove');
    }
    try {
      layer?.destroy?.();
    } catch (error) {
      this.#report(error, 'gis.in-app-navigation.destroy');
    }
  }

  #getServiceDescription(
    networkService: NetworkServiceModule,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<RouteServiceDescriptionLike> {
    if (!this.#serviceDescription) {
      this.#serviceDescription = networkService.fetchServiceDescription(
        ARC_GIS_ROUTE_SERVICE_URL,
        apiKey,
        {
          authMode: 'anonymous',
          ...(signal ? { signal } : {}),
          timeout: 15_000,
        },
      ).catch((error: unknown) => {
        this.#serviceDescription = null;
        throw error;
      });
    }
    return this.#serviceDescription;
  }

  #ensureLayer(
    map: InAppNavigationMapLike,
    GraphicsLayer: RouteGraphicsLayerConstructor,
  ): RouteGraphicLayerLike {
    if (this.#map === map && this.#layer) return this.#layer;
    if (typeof map.add !== 'function') throw new Error('Rota katmanı haritaya eklenemedi.');
    this.#removeLayer();
    const layer = new GraphicsLayer({
      id: 'kent-rehberi-active-route',
      title: 'Navigasyon rotası',
      listMode: 'hide',
      elevationInfo: { mode: 'on-the-ground' },
    });
    map.add(layer);
    this.#map = map;
    this.#layer = layer;
    return layer;
  }

  #removeLayer(): void {
    const layer = this.#layer;
    const map = this.#map;
    this.#layer = null;
    this.#map = null;
    if (!layer) return;
    try {
      if (map) map.remove?.(layer);
    } catch (error) {
      this.#report(error, 'gis.in-app-navigation.remove');
    }
    try {
      layer.destroy?.();
    } catch (error) {
      this.#report(error, 'gis.in-app-navigation.destroy');
    }
  }

  #report(error: unknown, source: string): void {
    try {
      this.#onError(error, source);
    } catch (observerError) {
      runtimeDiagnostics.captureError(observerError, {
        source: `${source}.observer-callback-failed`,
      }, 'warn');
    }
  }
}
