import { loadArcgisModules as loadModules } from '../gis-engine/arcgisModuleRuntime';
import { AppConfig } from '../Core/AppConfig';
import { Constants_LayerType, Constants_ServiceResultType } from '../Core/Constants';
import { MapManager } from '../Store/Managers/MapManager';
import { CommonReducer_ActionTypes } from '../Store/Reducers/CommonReducer';
import Store from '../Store/Store';
import { GisGraphicsHelper } from '../Toolbox/GisGraphicsHelper';
import { GisQueryHelper } from '../Toolbox/GisQueryHelper';
import { IsNull } from '../Toolbox/ObjectHelper';
import { TextHelper } from '../Toolbox/TextHelper';
import { DebugHelper } from '../Toolbox/DebugHelper';
import {
  type CodedValue,
  type FastAccessQuery,
  type ServiceDescriptor,
  type UnknownRecord,
  isRecord,
  normalizeServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from './contracts';
import {
  buildArcGisEqualsFilter,
  buildArcGisUpperContainsFilter,
  escapeArcGisSqlLiteral,
  normalizeHttpUrl,
  normalizeNearbyDistanceMeters,
  normalizeQueryText,
} from './querySafety';
import {
  legacyResultData,
  type LegacyGisResult,
} from './legacyServiceContracts';

interface ArcgisFieldLike {
  readonly name?: string;
  readonly domain?: {
    readonly codedValues?: readonly CodedValue[];
  } | null;
}

interface ArcgisTypeLike {
  readonly domains?: Readonly<Record<string, {
    readonly codedValues?: readonly CodedValue[];
  } | null>>;
}

interface ArcgisLayerLike {
  id?: string;
  title?: string;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  definitionExpression?: string;
  readonly fields?: readonly ArcgisFieldLike[];
  readonly types?: readonly ArcgisTypeLike[];
  readonly sourceJSON?: {
    readonly drawingInfo?: {
      readonly renderer?: {
        readonly uniqueValueInfos?: readonly unknown[];
      };
    };
  };
  load?: () => Promise<unknown>;
  queryObjectIds?: (
    options: Readonly<Record<string, unknown>>,
  ) => Promise<readonly unknown[] | null>;
}

type LayerConstructor = new (
  options: Readonly<Record<string, unknown>>,
) => ArcgisLayerLike;

interface EsriConfigLike {
  readonly request: {
    proxyUrl: string;
    forceProxy: boolean;
  };
}

interface UrlUtilsLike {
  addProxyRule(rule: Readonly<{ urlPrefix: string; proxyUrl: string }>): void;
}

interface MapLike {
  add?: (layer: unknown) => unknown;
  remove?: (layer: unknown) => unknown;
}

interface PopupLike {
  location?: unknown;
}

interface MapViewLike {
  readonly map?: MapLike;
  readonly popup?: PopupLike;
  goTo?: (target: unknown) => Promise<unknown> | unknown;
}

interface GraphicLike {
  readonly attributes?: UnknownRecord;
  readonly geometry?: UnknownRecord;
}

interface PopupFeatureLike {
  readonly graphic?: GraphicLike;
}

interface LayerDefinition extends Record<string, unknown> {
  readonly id?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly layerType?: number;
  readonly renderer?: unknown;
  readonly featureReduction?: unknown;
  readonly popupTemplate?: unknown;
  readonly eg?: string;
  readonly Eg?: string;
  readonly url?: string;
  readonly Url?: string;
}

interface LayerResult {
  readonly layerObj: ArcgisLayerLike;
}

interface ClusterLayerResult extends LayerResult {
  readonly id: string;
  readonly title: string;
}

interface CommonBusinessCache {
  locationGraphic: unknown | null;
  uniqueValueLayer: ArcgisLayerLike | null;
}

interface ClusteringApi {
  ChangePopup(showBigPopup: boolean): void;
  CreateConfig(): Readonly<Record<string, unknown>>;
  GetPopupInfo(feature: PopupFeatureLike | null | undefined): Promise<HTMLElement | null>;
  GetInfoWithAttachments(
    feature: PopupFeatureLike | null | undefined,
    attachmentQueryUrl: string,
    queryServiceTitle: string,
  ): Promise<HTMLElement | null>;
  CreateGeoJsonClusterLayer(
    geojson: UnknownRecord,
    layerTitle: string,
    symbol?: unknown,
  ): Promise<ArcgisLayerLike | null>;
  CreateLayerWithoutClustering(
    queryServiceTitle: string,
    layerTitle: string,
    query: FastAccessQuery,
    symbol: unknown,
    showAttachments: boolean,
    attachmentQueryUrl?: string,
  ): Promise<LayerResult>;
  CreateClusterLayer(
    queryServiceTitle: string,
    layerTitle: string,
    query: FastAccessQuery,
    symbol: unknown,
    showAttachments: boolean,
    attachmentQueryUrl?: string,
  ): Promise<ClusterLayerResult>;
}

interface AttachmentsApi {
  QueryAttachments(queryServiceTitle: string, id: unknown): Promise<LegacyGisResult>;
  GetAttachmentUrl(
    queryServiceTitle: string,
    id: unknown,
    attachmentId: unknown,
  ): string;
}

interface CommonBusinessApi {
  readonly _Cache: CommonBusinessCache;
  ShowUserLocationOnMap(mapView: unknown, point: unknown): Promise<unknown | null>;
  GenerateUrl(queryService: unknown): string | null;
  AddProxyRule(url: unknown): Promise<void>;
  GetDomainValues(
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly CodedValue[] | null>;
  GetCodedValueDomains(
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly CodedValue[]>;
  GetUniqueValueRenderers(queryServiceTitle: string): Promise<readonly unknown[]>;
  GetUniqueValueAdd(queryServiceTitle: string): Promise<readonly unknown[]>;
  GetDomainTypes(queryServiceTitle: string): Promise<readonly ArcgisTypeLike[]>;
  CreateLayer(layerItem: LayerDefinition | null | undefined): Promise<ArcgisLayerLike | null>;
  readonly Clustering: ClusteringApi;
  readonly Attachments: AttachmentsApi;
}

const DEFAULT_MARKER = Object.freeze({
  type: 'simple-marker',
  style: 'circle',
  size: 12,
  color: '#EEE',
  outline: Object.freeze({
    color: '#30598b',
    width: 4,
  }),
});

const configurationServices = (): readonly ServiceDescriptor[] =>
  MapManager.GetConfigurationServices()
    .map(normalizeServiceDescriptor)
    .filter((service): service is ServiceDescriptor => service !== null);

const findService = (title: string): ServiceDescriptor | null =>
  configurationServices().find((service) => serviceTitle(service) === title) ?? null;

const createServiceError = (title: string): Error => Object.assign(
  new Error(`Servis bulunamadı (${title})`),
  { type: Constants_ServiceResultType.Error },
);

const safeObjectIds = (values: readonly unknown[] | null | undefined): readonly number[] =>
  Object.freeze((values ?? [])
    .filter((value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));

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

const createDiv = (className?: string): HTMLDivElement => {
  const element = document.createElement('div');
  if (className) element.className = className;
  return element;
};

const appendTextBlock = (
  parent: HTMLElement,
  className: string,
  value: unknown,
  fallback = '',
): HTMLElement | null => {
  if (IsNull(value) && !fallback) return null;
  const element = createDiv(className);
  setText(element, value, fallback);
  parent.appendChild(element);
  return element;
};

const addWebsiteSection = (parent: HTMLElement, value: unknown): void => {
  const href = normalizeHttpUrl(value);
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

const asMapView = (value: unknown): MapViewLike | null =>
  value !== null && typeof value === 'object'
    ? value as MapViewLike
    : null;

const asPopupFeature = (value: unknown): PopupFeatureLike | null =>
  value !== null && typeof value === 'object'
    ? value as PopupFeatureLike
    : null;

const createFeatureLayer = async (
  serviceTitleValue: string,
): Promise<ArcgisLayerLike> => {
  const service = findService(serviceTitleValue);
  if (!service) throw createServiceError(serviceTitleValue);
  const url = serviceUrl(service);
  if (!url) throw createServiceError(serviceTitleValue);
  const [FeatureLayer] = await loadModules<readonly [LayerConstructor]>([
    'esri/layers/FeatureLayer',
  ]);
  return new FeatureLayer({ url });
};

const buildPopupActions = () => Object.freeze([
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

const buildDefinitionExpression = (
  query: FastAccessQuery | null | undefined,
): string => {
  const predicates: string[] = ['1=1'];
  if (!query) return predicates[0] ?? '1=1';

  if (query.name !== null && query.name !== undefined && String(query.name).trim()) {
    const upper = TextHelper.TurkishToUpper(String(query.name).trim()) ?? String(query.name);
    const ascii = TextHelper.RemoveTurkishChars(upper);
    const filter = buildArcGisUpperContainsFilter('adi', ascii, {
      uppercase: (value) => value,
    });
    if (filter) predicates.push(filter);
  }

  if (!query.showNearby) {
    if (query.districtId !== null && query.districtId !== undefined && query.districtId !== '') {
      predicates.push(buildArcGisEqualsFilter('ilceid', query.districtId));
    }
    if (query.nbhoodId !== null && query.nbhoodId !== undefined && query.nbhoodId !== '') {
      predicates.push(buildArcGisEqualsFilter('mahalleid', query.nbhoodId));
    }
  }

  return predicates.join(' AND ');
};

const applyQueryToFeatureLayer = async (
  layer: ArcgisLayerLike,
  query: FastAccessQuery | null | undefined,
): Promise<ArcgisLayerLike> => {
  layer.definitionExpression = buildDefinitionExpression(query);
  if (!query?.showNearby) return layer;

  if (!query.userLocation || typeof layer.queryObjectIds !== 'function') {
    layer.definitionExpression += ' AND 1=0';
    return layer;
  }

  const objectIds = safeObjectIds(await layer.queryObjectIds({
    where: '1=1',
    geometry: query.userLocation,
    distance: normalizeNearbyDistanceMeters(query.bufferDistance, {
      multiplier: 100,
      fallbackMeters: 1,
      maximumMeters: 50_000,
    }),
    units: 'meters',
    spatialRelationship: 'intersects',
  }));

  layer.definitionExpression += objectIds.length > 0
    ? ` AND objectid IN (${objectIds.join(',')})`
    : ' AND 1=0';
  return layer;
};

const attachmentServiceUrl = (value: string): string | null => {
  const service = findService(value);
  if (service) return serviceUrl(service);
  const direct = normalizeQueryText(value, 2_048);
  return direct || null;
};

export const CommonBusiness: CommonBusinessApi = {
  _Cache: {
    locationGraphic: null,
    uniqueValueLayer: null,
  },

  ShowUserLocationOnMap: async (
    mapView: unknown,
    point: unknown,
  ): Promise<unknown | null> => {
    if (!mapView || !point) return null;
    if (CommonBusiness._Cache.locationGraphic) {
      GisGraphicsHelper.RemoveGraphics(
        mapView,
        CommonBusiness._Cache.locationGraphic,
      );
    }

    const graphic = await GisGraphicsHelper.CreateCustomGraphicFromGeometry(
      point,
      {
        type: 'picture-marker',
        url: 'images/location_ripple.gif',
        width: '64px',
        height: '64px',
      },
    );
    GisGraphicsHelper.AddGraphics(mapView, graphic);
    CommonBusiness._Cache.locationGraphic = graphic;
    GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
    return graphic;
  },

  GenerateUrl: (queryService: unknown): string | null => {
    const service = normalizeServiceDescriptor(queryService);
    return service ? serviceUrl(service) : null;
  },

  AddProxyRule: async (urlInput: unknown): Promise<void> => {
    const url = normalizeQueryText(urlInput, 2_048);
    if (!url) return;

    const [esriConfig, urlUtils] = await loadModules<
      readonly [EsriConfigLike, UrlUtilsLike]
    >([
      'esri/config',
      'esri/core/urlUtils',
    ]);

    const proxyUrl = `${AppConfig.Api.BaseUrl}/Gis/Proxy`;
    esriConfig.request.proxyUrl = proxyUrl;
    esriConfig.request.forceProxy = true;
    urlUtils.addProxyRule({ urlPrefix: url, proxyUrl });
  },

  GetDomainValues: async (
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly CodedValue[] | null> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const field = (layer.fields ?? Object.freeze([]))
      .find((item) => item.name === fieldName);
    return field?.domain?.codedValues ?? null;
  },

  GetCodedValueDomains: async (
    queryServiceTitle: string,
    fieldName: string,
  ): Promise<readonly CodedValue[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const values: CodedValue[] = [];
    (layer.types ?? Object.freeze([])).forEach((layerType) => {
      const codedValues = layerType.domains?.[fieldName]?.codedValues ?? Object.freeze([]);
      codedValues.forEach((codedValue) => {
        values.push(Object.freeze({
          code: codedValue.code,
          name: codedValue.name,
        }));
      });
    });
    return Object.freeze(values);
  },

  GetUniqueValueRenderers: async (
    queryServiceTitle: string,
  ): Promise<readonly unknown[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    return Object.freeze([
      ...(layer.sourceJSON?.drawingInfo?.renderer?.uniqueValueInfos ?? Object.freeze([])),
    ]);
  },

  GetUniqueValueAdd: async (
    queryServiceTitle: string,
  ): Promise<readonly unknown[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    const mapView = asMapView(MapManager.GetMapView());
    const previousLayer = CommonBusiness._Cache.uniqueValueLayer;
    if (mapView?.map && previousLayer) mapView.map.remove?.(previousLayer);
    mapView?.map?.add?.(layer);
    CommonBusiness._Cache.uniqueValueLayer = layer;
    return Object.freeze([
      ...(layer.sourceJSON?.drawingInfo?.renderer?.uniqueValueInfos ?? Object.freeze([])),
    ]);
  },

  GetDomainTypes: async (
    queryServiceTitle: string,
  ): Promise<readonly ArcgisTypeLike[]> => {
    const layer = await createFeatureLayer(queryServiceTitle);
    await layer.load?.();
    return Object.freeze([...(layer.types ?? Object.freeze([]))]);
  },

  CreateLayer: async (
    layerItem: LayerDefinition | null | undefined,
  ): Promise<ArcgisLayerLike | null> => {
    if (!layerItem) return null;
    const url = CommonBusiness.GenerateUrl(layerItem);
    if (url) await CommonBusiness.AddProxyRule(url);

    const [FeatureLayer, MapImageLayer, GeoJSONLayer] = await loadModules<
      readonly [LayerConstructor, LayerConstructor, LayerConstructor]
    >([
      'esri/layers/FeatureLayer',
      'esri/layers/MapImageLayer',
      'esri/layers/GeoJSONLayer',
    ]);

    const common = {
      id: layerItem.id,
      url,
      title: layerItem.title,
      visible: layerItem.visible,
      opacity: typeof layerItem.opacity === 'number' && Number.isFinite(layerItem.opacity)
        ? layerItem.opacity / 100
        : 1,
    };

    if (layerItem.layerType === Constants_LayerType.MapImageLayer) {
      return new MapImageLayer(common);
    }

    if (layerItem.layerType === Constants_LayerType.MapLayer) {
      return new MapImageLayer({
        ...common,
        sublayers: Object.freeze([
          Object.freeze({ id: 3, visible: false }),
        ]),
      });
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
      if (
        typeof URL.createObjectURL !== 'function'
        || typeof URL.revokeObjectURL !== 'function'
      ) {
        throw new Error('Blob URL support is unavailable for GeoJSON layers.');
      }

      const blob = new Blob(
        [JSON.stringify(layerItem)],
        { type: 'application/geo+json' },
      );
      const objectUrl = URL.createObjectURL(blob);
      const layer = new GeoJSONLayer({
        renderer: layerItem.renderer ?? null,
        featureReduction: layerItem.featureReduction ?? null,
        url: objectUrl,
        popupTemplate: layerItem.popupTemplate ?? null,
        title: layerItem.title,
      });

      if (typeof layer.load === 'function') {
        void layer.load()
          .catch((error: unknown) => DebugHelper.Log(error))
          .finally(() => URL.revokeObjectURL(objectUrl));
      } else {
        URL.revokeObjectURL(objectUrl);
      }
      return layer;
    }

    return null;
  },

  Clustering: {
    ChangePopup: (showBigPopup: boolean): void => {
      const existing = Store.getState().Common.BigPopupLinkRef as HTMLLinkElement | null;
      if (showBigPopup) {
        if (existing?.isConnected) return;
        const link = document.createElement('link');
        link.type = 'text/css';
        link.rel = 'stylesheet';
        const baseUrl = import.meta.env.BASE_URL || './';
        link.href = `${baseUrl}BigPopupOverride.css`;
        document.head.appendChild(link);
        Store.dispatch({
          type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
          payload: link,
        });
        return;
      }

      if (existing?.parentNode) existing.parentNode.removeChild(existing);
      Store.dispatch({
        type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
        payload: null,
      });
    },

    CreateConfig: (): Readonly<Record<string, unknown>> => Object.freeze({
      type: 'cluster',
      clusterRadius: '120px',
      clusterMinSize: '32px',
      clusterMaxSize: '84px',
      labelingInfo: Object.freeze([Object.freeze({
        deconflictionStrategy: 'none',
        labelExpressionInfo: Object.freeze({
          expression: "Text($feature.cluster_count, '#')",
        }),
        symbol: Object.freeze({
          type: 'text',
          color: '#444',
          font: Object.freeze({
            weight: 'bold',
            family: 'Noto Sans',
            size: '16px',
          }),
        }),
        labelPlacement: 'center-center',
      })]),
      symbol: Object.freeze({
        type: 'simple-marker',
        style: 'circle',
        size: 12,
        color: '#EEE',
        outline: Object.freeze({
          color: 'rgba(8,143,188,1)',
          width: 4,
        }),
      }),
    }),

    GetPopupInfo: async (
      featureInput: PopupFeatureLike | null | undefined,
    ): Promise<HTMLElement | null> => {
      const feature = asPopupFeature(featureInput);
      if (!feature?.graphic) return null;
      CommonBusiness.Clustering.ChangePopup(false);
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
      appendTextBlock(
        details,
        'popup-nbhood',
        attributes.mahalleadi ?? attributes.districtName,
      );
      appendTextBlock(
        details,
        'popup-address',
        attributes.adres ?? attributes.address,
      );
      appendTextBlock(
        details,
        'popup-phone',
        attributes.telefon ?? attributes.phone,
      );
      if (details.childNodes.length > 0) root.appendChild(details);

      addWebsiteSection(root, attributes.websitesi);
      return root;
    },

    GetInfoWithAttachments: async (
      featureInput: PopupFeatureLike | null | undefined,
      attachmentQueryUrl: string,
      queryServiceTitle: string,
    ): Promise<HTMLElement | null> => {
      const feature = asPopupFeature(featureInput);
      if (!feature?.graphic) return null;
      CommonBusiness.Clustering.ChangePopup(true);

      const graphic = feature.graphic;
      const attributes = graphic.attributes ?? Object.freeze({});
      const root = createDiv('map-popup');
      appendTextBlock(root, 'popup-title', attributes.adi, 'İsimsiz kayıt');

      const sections = createDiv('popup-sections');
      const mediaSection = createDiv('popup-section');
      try {
        const attachmentList = await CommonBusiness.Attachments.QueryAttachments(
          attachmentQueryUrl,
          attributes.globalid,
        );
        const attachments = legacyResultData(attachmentList);
        if (attachments.length > 0) {
          const slider = createDiv('slider');
          const slides = createDiv('slides');
          attachments.forEach((attachment, index) => {
            const slide = createDiv();
            slide.id = `slide-${index}`;
            const image = document.createElement('img');
            image.className = 'attachments-image';
            image.alt = attributes.adi
              ? `${String(attributes.adi)} görseli ${index + 1}`
              : `Ek görsel ${index + 1}`;
            image.loading = 'lazy';
            image.src = CommonBusiness.Attachments.GetAttachmentUrl(
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
        appendTextBlock(
          mediaSection,
          'popup-description',
          'Görseller yüklenemedi.',
        );
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
        const mapView = asMapView(MapManager.GetMapView());
        const geometry = graphic.geometry;
        if (!mapView || !geometry || typeof mapView.goTo !== 'function') return;
        const longitude = geometry.longitude ?? geometry.x;
        const latitude = geometry.latitude ?? geometry.y;
        if (
          typeof longitude === 'number'
          && Number.isFinite(longitude)
          && typeof latitude === 'number'
          && Number.isFinite(latitude)
        ) {
          void Promise.resolve(mapView.goTo({
            center: [longitude, latitude + 0.005],
            zoom: 16,
          })).catch((error: unknown) => DebugHelper.Log(error));
          if (mapView.popup) mapView.popup.location = geometry;
        }
      }, 100);

      return root;
    },

    CreateGeoJsonClusterLayer: async (
      geojson: UnknownRecord,
      layerTitle: string,
      symbol?: unknown,
    ): Promise<ArcgisLayerLike | null> => {
      if (!isRecord(geojson)) throw new Error('GeoJSON verisi bulunamadı.');
      const layerDefinition: LayerDefinition = {
        ...geojson,
        title: layerTitle,
        layerType: Constants_LayerType.GeoJSONLayer,
        featureReduction: CommonBusiness.Clustering.CreateConfig(),
        renderer: {
          type: 'simple',
          symbol: symbol ?? DEFAULT_MARKER,
        },
        popupTemplate: {
          outFields: ['*'],
          title: '',
          content: (feature: PopupFeatureLike) =>
            CommonBusiness.Clustering.GetPopupInfo(feature),
          actions: [{
            title: 'Cad./Sok.Görünümü',
            id: 'show-on-streetview',
            image: 'images/icons/map/streetView.png',
          }],
        },
      };
      return CommonBusiness.CreateLayer(layerDefinition);
    },

    CreateLayerWithoutClustering: async (
      queryServiceTitle: string,
      layerTitle: string,
      query: FastAccessQuery,
      symbol: unknown,
      showAttachments: boolean,
      attachmentQueryUrl?: string,
    ): Promise<LayerResult> => {
      const queryService = findService(queryServiceTitle);
      if (!queryService) throw createServiceError(queryServiceTitle);
      const url = CommonBusiness.GenerateUrl(queryService);
      if (!url) throw createServiceError(queryServiceTitle);

      await CommonBusiness.AddProxyRule(url);
      if (showAttachments && attachmentQueryUrl) {
        const attachmentUrl = attachmentServiceUrl(attachmentQueryUrl);
        if (attachmentUrl) await CommonBusiness.AddProxyRule(attachmentUrl);
      }

      const [FeatureLayer] = await loadModules<readonly [LayerConstructor]>([
        'esri/layers/FeatureLayer',
      ]);
      const layer = new FeatureLayer({
        id: TextHelper.CreateGuid(),
        title: layerTitle,
        url,
        visible: true,
        opacity: 1,
        renderer: {
          type: 'simple',
          symbol: symbol ?? DEFAULT_MARKER,
        },
        popupTemplate: {
          outFields: ['*'],
          title: '',
          content: (feature: PopupFeatureLike) => showAttachments && attachmentQueryUrl
            ? CommonBusiness.Clustering.GetInfoWithAttachments(
              feature,
              attachmentQueryUrl,
              queryServiceTitle,
            )
            : CommonBusiness.Clustering.GetPopupInfo(feature),
          actions: buildPopupActions(),
        },
      });

      await applyQueryToFeatureLayer(layer, query);
      return Object.freeze({ layerObj: layer });
    },

    CreateClusterLayer: async (
      queryServiceTitle: string,
      layerTitle: string,
      query: FastAccessQuery,
      symbol: unknown,
      showAttachments: boolean,
      attachmentQueryUrl?: string,
    ): Promise<ClusterLayerResult> => {
      const queryService = findService(queryServiceTitle);
      if (!queryService) throw createServiceError(queryServiceTitle);
      const url = CommonBusiness.GenerateUrl(queryService);
      if (!url) throw createServiceError(queryServiceTitle);

      await CommonBusiness.AddProxyRule(url);
      if (showAttachments && attachmentQueryUrl) {
        const attachmentUrl = attachmentServiceUrl(attachmentQueryUrl);
        if (attachmentUrl) await CommonBusiness.AddProxyRule(attachmentUrl);
      }

      const id = TextHelper.CreateGuid();
      const layerProperties: LayerDefinition = {
        id,
        layerType: Constants_LayerType.FeatureLayer,
        title: layerTitle,
        eg: url,
        visible: true,
        opacity: 100,
        featureReduction: CommonBusiness.Clustering.CreateConfig(),
        renderer: {
          type: 'simple',
          symbol: symbol ?? DEFAULT_MARKER,
        },
        popupTemplate: {
          outFields: ['*'],
          title: '',
          content: (feature: PopupFeatureLike) => showAttachments && attachmentQueryUrl
            ? CommonBusiness.Clustering.GetInfoWithAttachments(
              feature,
              attachmentQueryUrl,
              queryServiceTitle,
            )
            : CommonBusiness.Clustering.GetPopupInfo(feature),
          actions: buildPopupActions(),
        },
      };

      const layer = await CommonBusiness.CreateLayer(layerProperties);
      if (!layer) throw new Error('Harita katmanı oluşturulamadı.');
      await applyQueryToFeatureLayer(layer, query);

      return Object.freeze({
        id,
        title: layerTitle,
        layerObj: layer,
      });
    },
  },

  Attachments: {
    QueryAttachments: async (
      queryServiceTitle: string,
      id: unknown,
    ): Promise<LegacyGisResult> => {
      const queryService = findService(queryServiceTitle);
      if (!queryService) throw createServiceError(queryServiceTitle);
      const url = CommonBusiness.GenerateUrl(queryService);
      if (!url) throw createServiceError(queryServiceTitle);

      return GisQueryHelper.ExecuteQuery({
        url,
        returnGeometry: false,
        outFields: Object.freeze(['*']),
        where: `rel_globalid='${escapeArcGisSqlLiteral(id)}'`,
      });
    },

    GetAttachmentUrl: (
      queryServiceTitle: string,
      id: unknown,
      attachmentId: unknown,
    ): string => {
      const queryService = findService(queryServiceTitle);
      const baseUrl = queryService
        ? CommonBusiness.GenerateUrl(queryService)
        : null;
      if (!baseUrl || IsNull(id) || IsNull(attachmentId)) return '#';
      return `${baseUrl.replace(/\/$/u, '')}/${encodeURIComponent(String(id))}/attachments/${encodeURIComponent(String(attachmentId))}`;
    },
  },
};
