import { loadArcgisModules } from '../gis-engine/arcgisModuleRuntime';
import { AppConfig } from '../Core/AppConfig';
import { Constants_LayerType, Constants_ServiceResultType } from '../Core/Constants';
import { MapManager } from '../Store/Managers/MapManager';
import { CommonReducer_ActionTypes } from '../Store/Reducers/CommonReducer';
import Store from '../Store/Store';
import { ArrayHelper } from '../Toolbox/ArrayHelper';
import { GisGraphicsHelper } from '../Toolbox/GisGraphicsHelper';
import {
  GisQueryHelper,
  type GisQueryResult,
  type GisServiceItem,
} from '../Toolbox/GisQueryHelper';
import { IsNull } from '../Toolbox/ObjectHelper';
import { TextHelper } from '../Toolbox/TextHelper';
import {
  isRecord,
  serviceUrl,
  type FastAccessQuery,
  type ServiceDescriptor,
  type UnknownRecord,
} from './contracts';

interface ErrorWithServiceType extends Error {
  readonly type: typeof Constants_ServiceResultType.Error;
}

interface LayerMapLike {
  add?: (layer: unknown) => void;
  remove?: (layer: unknown) => void;
}

interface PopupLike {
  location?: unknown;
}

interface MapViewLike {
  readonly map?: LayerMapLike;
  readonly popup?: PopupLike;
  goTo?: (target: unknown) => Promise<unknown> | unknown;
}

interface GeometryLike {
  readonly x?: number;
  readonly y?: number;
  readonly longitude?: number;
  readonly latitude?: number;
}

interface GraphicLike {
  readonly attributes?: UnknownRecord;
  readonly geometry?: GeometryLike;
}

interface PopupFeatureLike {
  readonly graphic?: GraphicLike;
}

interface ArcGisCodedValue {
  readonly code?: unknown;
  readonly name?: string;
}

interface ArcGisFieldLike {
  readonly name?: string;
  readonly domain?: {
    readonly codedValues?: readonly ArcGisCodedValue[];
  } | null;
}

interface ArcGisLayerTypeLike {
  readonly domains?: Readonly<Record<string, {
    readonly codedValues?: readonly ArcGisCodedValue[];
  } | undefined>>;
}

interface FeatureLayerLike {
  definitionExpression: string;
  readonly fields?: readonly ArcGisFieldLike[];
  readonly types?: readonly ArcGisLayerTypeLike[];
  readonly sourceJSON?: UnknownRecord;
  load?: () => Promise<unknown>;
  queryObjectIds?: (query: Readonly<Record<string, unknown>>) => Promise<readonly unknown[] | null | undefined>;
}

interface GenericLayerLike {
  load?: () => Promise<unknown>;
}

type LayerConstructor<TLayer> = new (properties: Readonly<Record<string, unknown>>) => TLayer;

interface EsriConfigLike {
  request: {
    proxyUrl?: string;
    forceProxy?: boolean;
  };
}

interface UrlUtilsLike {
  addProxyRule: (rule: { readonly urlPrefix: string; readonly proxyUrl: string }) => void;
}

interface CommonBusinessCache {
  locationGraphic: unknown;
  uniqueValueLayer: unknown;
}

interface ClusterLayerResult {
  readonly id: string;
  readonly title: string;
  readonly layerObj: unknown;
}

interface FeatureLayerResult {
  readonly layerObj: FeatureLayerLike;
}

type PopupSymbol = Readonly<Record<string, unknown>>;

const DEFAULT_MARKER: PopupSymbol = Object.freeze({
  type: 'simple-marker',
  style: 'circle',
  size: 12,
  color: '#EEE',
  outline: Object.freeze({
    color: '#30598b',
    width: 4,
  }),
});

const cache: CommonBusinessCache = {
  locationGraphic: null,
  uniqueValueLayer: null,
};

const getConfigurationServices = (): readonly ServiceDescriptor[] =>
  MapManager.GetConfigurationServices();

const findService = (titleInput: unknown): ServiceDescriptor | null => {
  const title = String(titleInput ?? '').trim();
  if (!title) return null;
  const services = getConfigurationServices();
  return ArrayHelper.Find(services, 'title', title)
    ?? ArrayHelper.Find(services, 'Title', title);
};

const createServiceError = (titleInput: unknown): ErrorWithServiceType =>
  Object.assign(
    new Error(`Servis bulunamadı (${String(titleInput ?? '')})`),
    { type: Constants_ServiceResultType.Error as const },
  );

const escapeSqlLiteral = (value: unknown): string =>
  String(value ?? '').replace(/'/gu, "''");

const safeObjectIds = (values: readonly unknown[] | null | undefined): number[] =>
  (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value): value is number => Number.isFinite(value));

const setText = (
  element: HTMLElement,
  value: unknown,
  fallback = '',
): HTMLElement => {
  element.textContent = value === null || value === undefined || value === ''
    ? fallback
    : String(value);
  return element;
};

const createDiv = (className = ''): HTMLDivElement => {
  const element = document.createElement('div');
  if (className) element.className = className;
  return element;
};

const appendTextBlock = (
  parent: HTMLElement,
  className: string,
  value: unknown,
  fallback = '',
): HTMLDivElement | null => {
  if (IsNull(value) && !fallback) return null;
  const element = createDiv(className);
  setText(element, value, fallback);
  parent.appendChild(element);
  return element;
};

const normalizeExternalUrl = (value: unknown): string | null => {
  const candidate = String(value ?? '').trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
};

const addWebsiteSection = (parent: HTMLElement, value: unknown): void => {
  const href = normalizeExternalUrl(value);
  if (!href) return;

  const section = createDiv('popup-section');
  appendTextBlock(section, 'popup-header', 'Web sitesi');
  const website = createDiv('popup-website');
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = 'Web sitesine git';
  website.appendChild(anchor);
  section.appendChild(website);
  parent.appendChild(section);
};

const generateUrl = (queryService: unknown): string | null => {
  if (typeof queryService === 'string') {
    const normalized = queryService.trim();
    return normalized || null;
  }
  if (!isRecord(queryService)) return null;
  return serviceUrl(queryService as ServiceDescriptor);
};

const addProxyRule = async (urlInput: unknown): Promise<void> => {
  const url = String(urlInput ?? '').trim();
  if (!url) return;
  const [esriConfig, urlUtils] = await loadArcgisModules<
    readonly [EsriConfigLike, UrlUtilsLike]
  >(['esri/config', 'esri/core/urlUtils']);
  const proxyUrl = `${AppConfig.Api.BaseUrl}/Gis/Proxy`;
  esriConfig.request.proxyUrl = proxyUrl;
  esriConfig.request.forceProxy = true;
  urlUtils.addProxyRule({ urlPrefix: url, proxyUrl });
};

const createFeatureLayer = async (serviceTitle: string): Promise<FeatureLayerLike> => {
  const service = findService(serviceTitle);
  if (!service) throw createServiceError(serviceTitle);
  const url = generateUrl(service);
  if (!url) throw createServiceError(serviceTitle);
  const [FeatureLayer] = await loadArcgisModules<
    readonly [LayerConstructor<FeatureLayerLike>]
  >(['esri/layers/FeatureLayer']);
  return new FeatureLayer({ url });
};

const buildPopupActions = (): readonly UnknownRecord[] => Object.freeze([
  Object.freeze({
    title: 'Yol Tarifi Al (Google)',
    id: 'show-on-google',
    image: 'images/icons/map/pictureMarker.png',
  }),
  Object.freeze({
    title: 'Cadde/Sokak Görünümü (Google)',
    id: 'show-on-streetview',
    image: 'images/icons/map/streetView.png',
  }),
]);

const buildDefinitionExpression = (query?: FastAccessQuery | null): string => {
  let expression = '1=1';
  if (!query) return expression;

  if (!IsNull(query.name) && String(query.name).trim()) {
    const upper = TextHelper.TurkishToUpper(String(query.name).trim()) ?? '';
    const searchText = escapeSqlLiteral(TextHelper.RemoveTurkishChars(upper));
    expression += ` AND UPPER(adi) LIKE '%${searchText}%'`;
  }

  if (!query.showNearby) {
    if (!IsNull(query.districtId) && String(query.districtId) !== '') {
      expression += ` AND ilceid = '${escapeSqlLiteral(query.districtId)}'`;
    }
    if (!IsNull(query.nbhoodId) && String(query.nbhoodId) !== '') {
      expression += ` AND mahalleid = '${escapeSqlLiteral(query.nbhoodId)}'`;
    }
  }

  return expression;
};

const applyQueryToFeatureLayer = async (
  layer: FeatureLayerLike,
  query?: FastAccessQuery | null,
): Promise<FeatureLayerLike> => {
  layer.definitionExpression = buildDefinitionExpression(query);

  if (!query?.showNearby) return layer;
  if (!query.userLocation || !Number.isFinite(Number(query.bufferDistance))) {
    layer.definitionExpression += ' AND 1=0';
    return layer;
  }

  if (typeof layer.queryObjectIds !== 'function') {
    layer.definitionExpression += ' AND 1=0';
    return layer;
  }

  const objectIds = safeObjectIds(await layer.queryObjectIds({
    where: '1=1',
    geometry: query.userLocation,
    distance: Number(query.bufferDistance) * 100,
    units: 'meters',
    spatialRelationship: 'intersects',
  }));

  layer.definitionExpression += objectIds.length > 0
    ? ` AND objectid IN (${objectIds.join(',')})`
    : ' AND 1=0';
  return layer;
};

const getMapView = (): MapViewLike | null => {
  const value = MapManager.GetMapView();
  return isRecord(value) ? value as MapViewLike : null;
};

const readNestedArray = (root: unknown, path: readonly string[]): readonly unknown[] => {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return Object.freeze([]);
    current = current[key];
  }
  return Array.isArray(current) ? Object.freeze([...current]) : Object.freeze([]);
};

const createLayer = async (layerItemInput: unknown): Promise<unknown | null> => {
  if (!isRecord(layerItemInput)) return null;
  const layerItem = layerItemInput;
  const url = generateUrl(layerItem);
  if (url) await addProxyRule(url);

  const [FeatureLayer, MapImageLayer, GeoJSONLayer] = await loadArcgisModules<
    readonly [
      LayerConstructor<FeatureLayerLike>,
      LayerConstructor<GenericLayerLike>,
      LayerConstructor<GenericLayerLike>
    ]
  >([
    'esri/layers/FeatureLayer',
    'esri/layers/MapImageLayer',
    'esri/layers/GeoJSONLayer',
  ]);

  const opacityValue = Number(layerItem.opacity);
  const common = Object.freeze({
    id: layerItem.id,
    ...(url ? { url } : {}),
    title: layerItem.title,
    visible: layerItem.visible,
    opacity: Number.isFinite(opacityValue) ? opacityValue / 100 : 1,
  });

  if (layerItem.layerType === Constants_LayerType.MapImageLayer) {
    return new MapImageLayer(common);
  }

  if (layerItem.layerType === Constants_LayerType.FeatureLayer) {
    return new FeatureLayer({
      ...common,
      renderer: layerItem.renderer ?? null,
      featureReduction: layerItem.featureReduction ?? null,
      popupTemplate: layerItem.popupTemplate ?? null,
    });
  }

  if (layerItem.layerType === Constants_LayerType.GeoJSONLayer) {
    const blob = new Blob([JSON.stringify(layerItem)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const layer = new GeoJSONLayer({
      renderer: layerItem.renderer ?? null,
      featureReduction: layerItem.featureReduction ?? null,
      url: objectUrl,
      popupTemplate: layerItem.popupTemplate ?? null,
      title: layerItem.title,
    });
    Promise.resolve(layer.load?.()).finally(() => URL.revokeObjectURL(objectUrl));
    return layer;
  }

  return null;
};

const changePopup = (showBigPopup: boolean): void => {
  const existing = Store.getState().Common.BigPopupLinkRef;
  if (showBigPopup) {
    if (existing?.isConnected) return;
    const link = document.createElement('link');
    link.type = 'text/css';
    link.rel = 'stylesheet';
    link.href = new URL('BigPopupOverride.css', document.baseURI).href;
    document.head.appendChild(link);
    Store.dispatch({
      type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
      payload: link,
    });
    return;
  }

  existing?.remove();
  Store.dispatch({
    type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
    payload: null,
  });
};

const createClusterConfig = (): UnknownRecord => Object.freeze({
  type: 'cluster',
  clusterRadius: '120px',
  clusterMinSize: '32px',
  clusterMaxSize: '84px',
  labelingInfo: Object.freeze([Object.freeze({
    deconflictionStrategy: 'none',
    labelExpressionInfo: Object.freeze({ expression: "Text($feature.cluster_count, '#')" }),
    symbol: Object.freeze({
      type: 'text',
      color: '#444',
      font: Object.freeze({ weight: 'bold', family: 'Noto Sans', size: '16px' }),
    }),
    labelPlacement: 'center-center',
  })]),
  symbol: Object.freeze({
    type: 'simple-marker',
    style: 'circle',
    size: 12,
    color: '#EEE',
    outline: Object.freeze({ color: 'rgba(8,143,188,1)', width: 4 }),
  }),
});

const getPopupInfo = async (feature: PopupFeatureLike): Promise<HTMLDivElement | null> => {
  if (!feature?.graphic) return null;
  changePopup(false);
  const attributes = feature.graphic.attributes ?? Object.freeze({});
  const root = createDiv('map-popup');

  const titleSection = createDiv('popup-section');
  appendTextBlock(
    titleSection,
    'popup-title',
    attributes.adi ?? attributes.title,
    'İsimsiz kayıt',
  );
  root.appendChild(titleSection);

  const details = createDiv('popup-section');
  appendTextBlock(details, 'popup-nbhood', attributes.mahalleadi ?? attributes.districtName);
  appendTextBlock(details, 'popup-address', attributes.adres ?? attributes.address);
  appendTextBlock(details, 'popup-phone', attributes.telefon ?? attributes.phone);
  if (details.childNodes.length > 0) root.appendChild(details);

  addWebsiteSection(root, attributes.websitesi);
  return root;
};

const queryAttachments = async (
  queryServiceTitle: string,
  id: unknown,
): Promise<GisQueryResult> => {
  const queryService = findService(queryServiceTitle);
  if (!queryService) throw createServiceError(queryServiceTitle);
  const url = generateUrl(queryService);
  if (!url) throw createServiceError(queryServiceTitle);

  return GisQueryHelper.ExecuteQuery({
    url,
    returnGeometry: false,
    outFields: ['*'],
    where: `rel_globalid='${escapeSqlLiteral(id)}'`,
  });
};

const getAttachmentUrl = (
  queryServiceTitle: string,
  id: unknown,
  attachmentId: unknown,
): string => {
  const queryService = findService(queryServiceTitle);
  const baseUrl = generateUrl(queryService);
  if (!baseUrl || IsNull(id) || IsNull(attachmentId)) return '#';
  return `${baseUrl.replace(/\/$/u, '')}/${encodeURIComponent(String(id))}/attachments/${encodeURIComponent(String(attachmentId))}`;
};

const attachmentItems = (result: GisQueryResult): readonly GisServiceItem[] =>
  result.type === Constants_ServiceResultType.Success && Array.isArray(result.data)
    ? result.data
    : Object.freeze([]);

const getInfoWithAttachments = async (
  feature: PopupFeatureLike,
  attachmentQueryUrl: string,
  queryServiceTitle: string,
): Promise<HTMLDivElement | null> => {
  if (!feature?.graphic) return null;
  changePopup(true);

  const graphic = feature.graphic;
  const attributes = graphic.attributes ?? Object.freeze({});
  const root = createDiv('map-popup');
  appendTextBlock(root, 'popup-title', attributes.adi, 'İsimsiz kayıt');

  const sections = createDiv('popup-sections');
  const mediaSection = createDiv('popup-section');
  try {
    const result = await queryAttachments(attachmentQueryUrl, attributes.globalid);
    const items = attachmentItems(result);
    if (items.length > 0) {
      const slider = createDiv('slider');
      const slides = createDiv('slides');
      items.forEach((attachment, index) => {
        const slide = createDiv();
        slide.id = `slide-${index}`;
        const image = document.createElement('img');
        image.className = 'attachments-image';
        image.alt = attributes.adi
          ? `${String(attributes.adi)} görseli ${index + 1}`
          : `Ek görsel ${index + 1}`;
        image.loading = 'lazy';
        image.src = getAttachmentUrl(
          queryServiceTitle,
          attributes.objectid,
          attachment.attr?.attachmentid,
        );
        slide.appendChild(image);
        slides.appendChild(slide);
      });
      slider.appendChild(slides);
      mediaSection.appendChild(slider);
    }
  } catch {
    appendTextBlock(mediaSection, 'popup-description', 'Görseller yüklenemedi.');
  }
  if (mediaSection.childNodes.length > 0) sections.appendChild(mediaSection);

  if (!IsNull(attributes.aciklama)) {
    const about = createDiv('popup-section');
    appendTextBlock(about, 'popup-header', 'Hakkında');
    appendTextBlock(about, 'popup-description', attributes.aciklama, '-');
    sections.appendChild(about);
  }

  const address = createDiv('popup-section');
  appendTextBlock(address, 'popup-header', 'Adres ve Ulaşım');
  appendTextBlock(address, 'popup-nbhood', attributes.mahalle_adi);
  appendTextBlock(address, 'popup-address', attributes.adres);
  appendTextBlock(address, 'popup-phone', attributes.telefon);
  sections.appendChild(address);
  root.appendChild(sections);
  addWebsiteSection(root, attributes.websitesi);

  globalThis.setTimeout(() => {
    const mapView = getMapView();
    const geometry = graphic.geometry;
    if (!mapView || !geometry) return;
    const longitude = geometry.longitude ?? geometry.x;
    const latitude = geometry.latitude ?? geometry.y;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    void mapView.goTo?.({
      center: [longitude, Number(latitude) + 0.005],
      zoom: 16,
    });
    if (mapView.popup) mapView.popup.location = geometry;
  }, 100);

  return root;
};

const createGeoJsonClusterLayer = async (
  geojsonInput: unknown,
  layerTitle: string,
  symbol?: PopupSymbol | null,
): Promise<unknown | null> => {
  if (!isRecord(geojsonInput)) throw new Error('GeoJSON verisi bulunamadı.');
  const layerDefinition = {
    ...geojsonInput,
    title: layerTitle,
    layerType: Constants_LayerType.GeoJSONLayer,
    featureReduction: createClusterConfig(),
    renderer: Object.freeze({
      type: 'simple',
      symbol: symbol ?? DEFAULT_MARKER,
    }),
    popupTemplate: Object.freeze({
      outFields: Object.freeze(['*']),
      title: '',
      content: (feature: PopupFeatureLike) => getPopupInfo(feature),
      actions: Object.freeze([Object.freeze({
        title: 'Cad./Sok.Görünümü',
        id: 'show-on-streetview',
        image: 'images/icons/map/streetView.png',
      })]),
    }),
  };
  return createLayer(layerDefinition);
};

const createLayerWithoutClustering = async (
  queryServiceTitle: string,
  layerTitle: string,
  query?: FastAccessQuery | null,
  symbol?: PopupSymbol | null,
  showAttachments = false,
  attachmentQueryUrl = '',
): Promise<FeatureLayerResult> => {
  const queryService = findService(queryServiceTitle);
  if (!queryService) throw createServiceError(queryServiceTitle);

  const queryUrl = generateUrl(queryService);
  if (!queryUrl) throw createServiceError(queryServiceTitle);
  await addProxyRule(queryUrl);

  if (showAttachments && attachmentQueryUrl) {
    const attachmentService = findService(attachmentQueryUrl);
    await addProxyRule(generateUrl(attachmentService ?? attachmentQueryUrl));
  }

  const [FeatureLayer] = await loadArcgisModules<
    readonly [LayerConstructor<FeatureLayerLike>]
  >(['esri/layers/FeatureLayer']);
  const layer = new FeatureLayer({
    id: TextHelper.CreateGuid(),
    title: layerTitle,
    url: queryUrl,
    visible: true,
    opacity: 1,
    renderer: Object.freeze({ type: 'simple', symbol: symbol ?? DEFAULT_MARKER }),
    popupTemplate: Object.freeze({
      outFields: Object.freeze(['*']),
      title: '',
      content: (feature: PopupFeatureLike) => showAttachments
        ? getInfoWithAttachments(feature, attachmentQueryUrl, queryServiceTitle)
        : getPopupInfo(feature),
      actions: buildPopupActions(),
    }),
  });

  await applyQueryToFeatureLayer(layer, query);
  return Object.freeze({ layerObj: layer });
};

const createClusterLayer = async (
  queryServiceTitle: string,
  layerTitle: string,
  query?: FastAccessQuery | null,
  symbol?: PopupSymbol | null,
  showAttachments = false,
  attachmentQueryUrl = '',
): Promise<ClusterLayerResult> => {
  const queryService = findService(queryServiceTitle);
  if (!queryService) throw createServiceError(queryServiceTitle);

  const queryUrl = generateUrl(queryService);
  if (!queryUrl) throw createServiceError(queryServiceTitle);
  await addProxyRule(queryUrl);

  if (showAttachments && attachmentQueryUrl) {
    const attachmentService = findService(attachmentQueryUrl);
    await addProxyRule(generateUrl(attachmentService ?? attachmentQueryUrl));
  }

  const id = TextHelper.CreateGuid();
  const layerProperties = Object.freeze({
    id,
    layerType: Constants_LayerType.FeatureLayer,
    title: layerTitle,
    eg: queryUrl,
    visible: true,
    opacity: 100,
    featureReduction: createClusterConfig(),
    renderer: Object.freeze({ type: 'simple', symbol: symbol ?? DEFAULT_MARKER }),
    popupTemplate: Object.freeze({
      outFields: Object.freeze(['*']),
      title: '',
      content: (feature: PopupFeatureLike) => showAttachments
        ? getInfoWithAttachments(feature, attachmentQueryUrl, queryServiceTitle)
        : getPopupInfo(feature),
      actions: buildPopupActions(),
    }),
  });

  const layer = await createLayer(layerProperties);
  if (!layer || !isRecord(layer)) throw new Error('Harita katmanı oluşturulamadı.');
  await applyQueryToFeatureLayer(layer as unknown as FeatureLayerLike, query);

  return Object.freeze({
    id,
    title: layerTitle,
    layerObj: layer,
  });
};

const getUniqueValueInfos = (layer: FeatureLayerLike): readonly unknown[] =>
  readNestedArray(layer.sourceJSON, ['drawingInfo', 'renderer', 'uniqueValueInfos']);

export const CommonBusiness = Object.freeze({
  _Cache: cache,

  ShowUserLocationOnMap: async (mapView: unknown, point: unknown): Promise<unknown | null> => {
    if (!mapView || !point) return null;
    if (cache.locationGraphic) {
      GisGraphicsHelper.RemoveGraphics(mapView, cache.locationGraphic);
    }

    const graphic = await GisGraphicsHelper.CreateCustomGraphicFromGeometry(point, {
      type: 'picture-marker',
      url: 'images/location_ripple.gif',
      width: '64px',
      height: '64px',
    });
    GisGraphicsHelper.AddGraphics(mapView, graphic);
    cache.locationGraphic = graphic;
    GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
    return graphic;
  },

  GenerateUrl: generateUrl,
  AddProxyRule: addProxyRule,

  GetDomainValues: async (
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly ArcGisCodedValue[] | null> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const field = layer.fields?.find((item) => item.name === fieldName);
    return field?.domain?.codedValues ?? null;
  },

  GetCodedValueDomains: async (
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly ArcGisCodedValue[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const values: ArcGisCodedValue[] = [];
    for (const layerType of layer.types ?? []) {
      for (const codedValue of layerType.domains?.[fieldName]?.codedValues ?? []) {
        values.push(Object.freeze({ code: codedValue.code, name: codedValue.name }));
      }
    }
    return Object.freeze(values);
  },

  GetUniqueValueRenderers: async (queryServiceTitle: string): Promise<readonly unknown[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    return getUniqueValueInfos(layer);
  },

  GetUniqueValueAdd: async (queryServiceTitle: string): Promise<readonly unknown[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const mapView = getMapView();
    const previousLayer = cache.uniqueValueLayer;
    if (mapView?.map && previousLayer) mapView.map.remove?.(previousLayer);
    mapView?.map?.add?.(layer);
    cache.uniqueValueLayer = layer;
    return getUniqueValueInfos(layer);
  },

  GetDomainTypes: async (queryServiceTitle: string): Promise<readonly ArcGisLayerTypeLike[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    return Object.freeze([...(layer.types ?? [])]);
  },

  CreateLayer: createLayer,

  Clustering: Object.freeze({
    ChangePopup: changePopup,
    CreateConfig: createClusterConfig,
    GetPopupInfo: getPopupInfo,
    GetInfoWithAttachments: getInfoWithAttachments,
    CreateGeoJsonClusterLayer: createGeoJsonClusterLayer,
    CreateLayerWithoutClustering: createLayerWithoutClustering,
    CreateClusterLayer: createClusterLayer,
  }),

  Attachments: Object.freeze({
    QueryAttachments: queryAttachments,
    GetAttachmentUrl: getAttachmentUrl,
  }),
});
