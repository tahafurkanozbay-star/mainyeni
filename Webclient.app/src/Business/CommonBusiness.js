import { loadArcgisModules as loadModules } from "../gis-engine/arcgisModuleRuntime";
import { AppConfig } from "../Core/AppConfig";
import { Constants_LayerType, Constants_ServiceResultType } from "../Core/Constants";
import { MapManager } from "../Store/Managers/MapManager";
import { CommonReducer_ActionTypes } from "../Store/Reducers/CommonReducer";
import Store from "../Store/Store";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisGraphicsHelper } from "../Toolbox/GisGraphicsHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";

const DEFAULT_MARKER = Object.freeze({
    type: "simple-marker",
    style: "circle",
    size: 12,
    color: "#EEE",
    outline: {
        color: "#30598b",
        width: 4
    }
});

const getConfigurationServices = () => MapManager.GetConfigurationServices?.()
    || MapManager.GetConfiguration?.()?.ConfigurationServices
    || [];

const findService = title => {
    if (!title) return null;
    const services = getConfigurationServices();
    return ArrayHelper.Find(services, "title", title)
        || ArrayHelper.Find(services, "Title", title);
};

const createServiceError = title => {
    const error = new Error(`Servis bulunamadı (${title})`);
    error.type = Constants_ServiceResultType.Error;
    return error;
};

const escapeSqlLiteral = value => String(value ?? "").replace(/'/g, "''");

const safeObjectIds = values => (values || [])
    .map(value => Number(value))
    .filter(Number.isFinite);

const setText = (element, value, fallback = "") => {
    element.textContent = value === null || value === undefined || value === "" ? fallback : String(value);
    return element;
};

const createDiv = className => {
    const element = document.createElement("div");
    if (className) element.className = className;
    return element;
};

const appendTextBlock = (parent, className, value, fallback = "") => {
    if (IsNull(value) && !fallback) return null;
    const element = createDiv(className);
    setText(element, value, fallback);
    parent.appendChild(element);
    return element;
};

const normalizeExternalUrl = value => {
    if (!value) return null;
    try {
        const url = new URL(value, window.location.origin);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
    } catch {
        return null;
    }
};

const addWebsiteSection = (parent, value) => {
    const href = normalizeExternalUrl(value);
    if (!href) return;

    const section = createDiv("popup-section");
    appendTextBlock(section, "popup-header", "Web sitesi");
    const website = createDiv("popup-website");
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = "Web sitesine git";
    website.appendChild(anchor);
    section.appendChild(website);
    parent.appendChild(section);
};

const createFeatureLayer = async serviceTitle => {
    const service = findService(serviceTitle);
    if (!service) throw createServiceError(serviceTitle);
    const [FeatureLayer] = await loadModules(["esri/layers/FeatureLayer"]);
    return new FeatureLayer({ url: CommonBusiness.GenerateUrl(service) });
};

const buildPopupActions = () => ([
    {
        title: "Yol Tarifi Al (Google)",
        id: "show-on-google",
        image: "images/icons/map/pictureMarker.png"
    },
    {
        title: "Cadde/Sokak Görünümü (Google)",
        id: "show-on-streetview",
        image: "images/icons/map/streetView.png"
    }
]);

const buildDefinitionExpression = query => {
    let expression = "1=1";
    if (!query) return expression;

    if (!IsNull(query.name) && String(query.name).trim()) {
        const searchText = escapeSqlLiteral(
            TextHelper.RemoveTurkishChars(TextHelper.TurkishToUpper(String(query.name).trim()))
        );
        expression += ` AND UPPER(adi) LIKE '%${searchText}%'`;
    }

    if (!query.showNearby) {
        if (!IsNull(query.districtId) && String(query.districtId) !== "") {
            expression += ` AND ilceid = '${escapeSqlLiteral(query.districtId)}'`;
        }
        if (!IsNull(query.nbhoodId) && String(query.nbhoodId) !== "") {
            expression += ` AND mahalleid = '${escapeSqlLiteral(query.nbhoodId)}'`;
        }
    }

    return expression;
};

const applyQueryToFeatureLayer = async (layer, query) => {
    if (!layer) return layer;
    layer.definitionExpression = buildDefinitionExpression(query);

    if (!query?.showNearby) return layer;
    if (!query.userLocation || !Number.isFinite(Number(query.bufferDistance))) {
        layer.definitionExpression += " AND 1=0";
        return layer;
    }

    const objectIds = safeObjectIds(await layer.queryObjectIds({
        where: "1=1",
        geometry: query.userLocation,
        distance: Number(query.bufferDistance) * 100,
        units: "meters",
        spatialRelationship: "intersects"
    }));

    layer.definitionExpression += objectIds.length
        ? ` AND objectid IN (${objectIds.join(",")})`
        : " AND 1=0";
    return layer;
};

export const CommonBusiness = {
    _Cache: {
        locationGraphic: null,
        uniqueValueLayer: null
    },

    ShowUserLocationOnMap: async (mapView, point) => {
        if (!mapView || !point) return null;
        if (CommonBusiness._Cache.locationGraphic) {
            GisGraphicsHelper.RemoveGraphics(mapView, CommonBusiness._Cache.locationGraphic);
        }

        const graphic = await GisGraphicsHelper.CreateCustomGraphicFromGeometry(point, {
            type: "picture-marker",
            url: "images/location_ripple.gif",
            width: "64px",
            height: "64px"
        });
        GisGraphicsHelper.AddGraphics(mapView, graphic);
        CommonBusiness._Cache.locationGraphic = graphic;
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
        return graphic;
    },

    GenerateUrl: queryService => queryService?.eg
        ?? queryService?.Eg
        ?? queryService?.url
        ?? queryService?.Url,

    AddProxyRule: async url => {
        if (!url) return;
        const [esriConfig, urlUtils] = await loadModules(["esri/config", "esri/core/urlUtils"]);
        const proxyUrl = `${AppConfig.Api.BaseUrl}/Gis/Proxy`;
        esriConfig.request.proxyUrl = proxyUrl;
        esriConfig.request.forceProxy = true;
        urlUtils.addProxyRule({ urlPrefix: url, proxyUrl });
    },

    GetDomainValues: async (queryServiceTitle, fieldName) => {
        const layer = await createFeatureLayer(queryServiceTitle);
        await layer.load();
        const field = (layer.fields || []).find(item => item.name === fieldName);
        return field?.domain?.codedValues || null;
    },

    GetCodedValueDomains: async (queryServiceTitle, fieldName) => {
        const layer = await createFeatureLayer(queryServiceTitle);
        await layer.load();
        const values = [];
        (layer.types || []).forEach(layerType => {
            const codedValues = layerType?.domains?.[fieldName]?.codedValues || [];
            codedValues.forEach(codedValue => {
                values.push({ code: codedValue.code, name: codedValue.name });
            });
        });
        return values;
    },

    GetUniqueValueRenderers: async queryServiceTitle => {
        const layer = await createFeatureLayer(queryServiceTitle);
        await layer.load();
        return layer.sourceJSON?.drawingInfo?.renderer?.uniqueValueInfos || [];
    },

    GetUniqueValueAdd: async queryServiceTitle => {
        const layer = await createFeatureLayer(queryServiceTitle);
        await layer.load();
        const mapView = MapManager.GetMapView();
        const previousLayer = CommonBusiness._Cache.uniqueValueLayer;
        if (mapView?.map && previousLayer) mapView.map.remove(previousLayer);
        if (mapView?.map) mapView.map.add(layer);
        CommonBusiness._Cache.uniqueValueLayer = layer;
        return layer.sourceJSON?.drawingInfo?.renderer?.uniqueValueInfos || [];
    },

    GetDomainTypes: async queryServiceTitle => {
        const layer = await createFeatureLayer(queryServiceTitle);
        await layer.load();
        return layer.types || [];
    },

    CreateLayer: async layerItem => {
        if (!layerItem) return null;
        const url = CommonBusiness.GenerateUrl(layerItem);
        if (url) await CommonBusiness.AddProxyRule(url);

        const [FeatureLayer, MapImageLayer, GeoJSONLayer] = await loadModules([
            "esri/layers/FeatureLayer",
            "esri/layers/MapImageLayer",
            "esri/layers/GeoJSONLayer"
        ]);

        const common = {
            id: layerItem.id,
            url,
            title: layerItem.title,
            visible: layerItem.visible,
            opacity: Number.isFinite(layerItem.opacity) ? layerItem.opacity / 100 : 1
        };

        if (layerItem.layerType === Constants_LayerType.MapImageLayer) {
            return new MapImageLayer(common);
        }

        if (layerItem.layerType === Constants_LayerType.MapLayer) {
            return new MapImageLayer({
                ...common,
                sublayers: [{ id: 3, visible: false }]
            });
        }

        if (layerItem.layerType === Constants_LayerType.FeatureLayer) {
            return new FeatureLayer({
                ...common,
                renderer: layerItem.renderer ?? null,
                featureReduction: layerItem.featureReduction ?? null,
                popupTemplate: layerItem.popupTemplate ?? null
            });
        }

        if (layerItem.layerType === Constants_LayerType.GeoJSONLayer) {
            const blob = new Blob([JSON.stringify(layerItem)], { type: "application/json" });
            const objectUrl = URL.createObjectURL(blob);
            const layer = new GeoJSONLayer({
                renderer: layerItem.renderer ?? null,
                featureReduction: layerItem.featureReduction ?? null,
                url: objectUrl,
                popupTemplate: layerItem.popupTemplate ?? null,
                title: layerItem.title
            });
            Promise.resolve(layer.load?.()).finally(() => URL.revokeObjectURL(objectUrl));
            return layer;
        }

        return null;
    },

    Clustering: {
        ChangePopup: showBigPopup => {
            const existing = Store.getState().Common.BigPopupLinkRef;
            if (showBigPopup) {
                if (existing?.isConnected) return;
                const link = document.createElement("link");
                link.type = "text/css";
                link.rel = "stylesheet";
                link.href = `${process.env.PUBLIC_URL}/BigPopupOverride.css`;
                document.head.appendChild(link);
                Store.dispatch({
                    type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
                    payload: link
                });
                return;
            }

            if (existing?.parentNode) existing.parentNode.removeChild(existing);
            Store.dispatch({
                type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
                payload: null
            });
        },

        CreateConfig: () => ({
            type: "cluster",
            clusterRadius: "120px",
            clusterMinSize: "32px",
            clusterMaxSize: "84px",
            labelingInfo: [{
                deconflictionStrategy: "none",
                labelExpressionInfo: { expression: "Text($feature.cluster_count, '#')" },
                symbol: {
                    type: "text",
                    color: "#444",
                    font: { weight: "bold", family: "Noto Sans", size: "16px" }
                },
                labelPlacement: "center-center"
            }],
            symbol: {
                type: "simple-marker",
                style: "circle",
                size: 12,
                color: "#EEE",
                outline: { color: "rgba(8,143,188,1)", width: 4 }
            }
        }),

        GetPopupInfo: async feature => {
            if (!feature?.graphic) return null;
            CommonBusiness.Clustering.ChangePopup(false);
            const attributes = feature.graphic.attributes || {};
            const root = createDiv("map-popup");

            const titleSection = createDiv("popup-section");
            appendTextBlock(titleSection, "popup-title", attributes.adi ?? attributes.title, "İsimsiz kayıt");
            root.appendChild(titleSection);

            const details = createDiv("popup-section");
            appendTextBlock(details, "popup-nbhood", attributes.mahalleadi ?? attributes.districtName);
            appendTextBlock(details, "popup-address", attributes.adres ?? attributes.address);
            appendTextBlock(details, "popup-phone", attributes.telefon ?? attributes.phone);
            if (details.childNodes.length) root.appendChild(details);

            addWebsiteSection(root, attributes.websitesi);
            return root;
        },

        GetInfoWithAttachments: async (feature, attachmentQueryUrl, queryServiceTitle) => {
            if (!feature?.graphic) return null;
            CommonBusiness.Clustering.ChangePopup(true);

            const graphic = feature.graphic;
            const attributes = graphic.attributes || {};
            const root = createDiv("map-popup");
            appendTextBlock(root, "popup-title", attributes.adi, "İsimsiz kayıt");

            const sections = createDiv("popup-sections");
            const mediaSection = createDiv("popup-section");
            try {
                const attachmentList = await CommonBusiness.Attachments.QueryAttachments(
                    attachmentQueryUrl,
                    attributes.globalid
                );
                if (attachmentList?.data?.length) {
                    const slider = createDiv("slider");
                    const slides = createDiv("slides");
                    attachmentList.data.forEach((attachment, index) => {
                        const slide = createDiv();
                        slide.id = `slide-${index}`;
                        const image = document.createElement("img");
                        image.className = "attachments-image";
                        image.alt = attributes.adi ? `${attributes.adi} görseli ${index + 1}` : `Ek görsel ${index + 1}`;
                        image.loading = "lazy";
                        image.src = CommonBusiness.Attachments.GetAttachmentUrl(
                            queryServiceTitle,
                            attributes.objectid,
                            attachment?.attr?.attachmentid
                        );
                        slide.appendChild(image);
                        slides.appendChild(slide);
                    });
                    slider.appendChild(slides);
                    mediaSection.appendChild(slider);
                }
            } catch {
                appendTextBlock(mediaSection, "popup-description", "Görseller yüklenemedi.");
            }
            if (mediaSection.childNodes.length) sections.appendChild(mediaSection);

            if (!IsNull(attributes.aciklama)) {
                const about = createDiv("popup-section");
                appendTextBlock(about, "popup-header", "Hakkında");
                appendTextBlock(about, "popup-description", attributes.aciklama, "-");
                sections.appendChild(about);
            }

            const address = createDiv("popup-section");
            appendTextBlock(address, "popup-header", "Adres ve Ulaşım");
            appendTextBlock(address, "popup-nbhood", attributes.mahalle_adi);
            appendTextBlock(address, "popup-address", attributes.adres);
            appendTextBlock(address, "popup-phone", attributes.telefon);
            sections.appendChild(address);
            root.appendChild(sections);
            addWebsiteSection(root, attributes.websitesi);

            window.setTimeout(() => {
                const mapView = MapManager.GetMapView();
                const geometry = graphic.geometry;
                if (!mapView || !geometry) return;
                const longitude = geometry.longitude ?? geometry.x;
                const latitude = geometry.latitude ?? geometry.y;
                if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
                    mapView.goTo({ center: [longitude, latitude + 0.005], zoom: 16 });
                    if (mapView.popup) mapView.popup.location = geometry;
                }
            }, 100);

            return root;
        },

        CreateGeoJsonClusterLayer: async (geojson, layerTitle, symbol) => {
            if (!geojson) throw new Error("GeoJSON verisi bulunamadı.");
            const layerDefinition = {
                ...geojson,
                title: layerTitle,
                featureReduction: CommonBusiness.Clustering.CreateConfig(),
                renderer: {
                    type: "simple",
                    symbol: symbol || DEFAULT_MARKER
                },
                popupTemplate: {
                    outFields: ["*"],
                    title: "",
                    content: feature => CommonBusiness.Clustering.GetPopupInfo(feature),
                    actions: [{
                        title: "Cad./Sok.Görünümü",
                        id: "show-on-streetview",
                        image: "images/icons/map/streetView.png"
                    }]
                }
            };
            return CommonBusiness.CreateLayer(layerDefinition);
        },

        CreateLayerWithoutClustering: async (
            queryServiceTitle,
            layerTitle,
            query,
            symbol,
            showAttachments,
            attachmentQueryUrl
        ) => {
            const queryService = findService(queryServiceTitle);
            if (!queryService) throw createServiceError(queryServiceTitle);

            await CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(queryService));
            if (showAttachments && attachmentQueryUrl) {
                const attachmentService = findService(attachmentQueryUrl) || attachmentQueryUrl;
                await CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(attachmentService));
            }

            const [FeatureLayer] = await loadModules(["esri/layers/FeatureLayer"]);
            const layer = new FeatureLayer({
                id: TextHelper.CreateGuid(),
                title: layerTitle,
                url: CommonBusiness.GenerateUrl(queryService),
                visible: true,
                opacity: 1,
                renderer: { type: "simple", symbol: symbol || DEFAULT_MARKER },
                popupTemplate: {
                    outFields: ["*"],
                    title: "",
                    content: feature => showAttachments
                        ? CommonBusiness.Clustering.GetInfoWithAttachments(feature, attachmentQueryUrl, queryServiceTitle)
                        : CommonBusiness.Clustering.GetPopupInfo(feature),
                    actions: buildPopupActions()
                }
            });

            await applyQueryToFeatureLayer(layer, query);
            return { layerObj: layer };
        },

        CreateClusterLayer: async (
            queryServiceTitle,
            layerTitle,
            query,
            symbol,
            showAttachments,
            attachmentQueryUrl
        ) => {
            const queryService = findService(queryServiceTitle);
            if (!queryService) throw createServiceError(queryServiceTitle);

            await CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(queryService));
            if (showAttachments && attachmentQueryUrl) {
                const attachmentService = findService(attachmentQueryUrl) || attachmentQueryUrl;
                await CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(attachmentService));
            }

            const layerProperties = {
                id: TextHelper.CreateGuid(),
                layerType: Constants_LayerType.FeatureLayer,
                title: layerTitle,
                eg: CommonBusiness.GenerateUrl(queryService),
                visible: true,
                opacity: 100,
                featureReduction: CommonBusiness.Clustering.CreateConfig(),
                renderer: { type: "simple", symbol: symbol || DEFAULT_MARKER },
                popupTemplate: {
                    outFields: ["*"],
                    title: "",
                    content: feature => showAttachments
                        ? CommonBusiness.Clustering.GetInfoWithAttachments(feature, attachmentQueryUrl, queryServiceTitle)
                        : CommonBusiness.Clustering.GetPopupInfo(feature),
                    actions: buildPopupActions()
                }
            };

            const layer = await CommonBusiness.CreateLayer(layerProperties);
            if (!layer) throw new Error("Harita katmanı oluşturulamadı.");
            await applyQueryToFeatureLayer(layer, query);

            return {
                id: layerProperties.id,
                title: layerProperties.title,
                layerObj: layer
            };
        }
    },

    Attachments: {
        QueryAttachments: async (queryServiceTitle, id) => {
            const queryService = findService(queryServiceTitle);
            if (!queryService) throw createServiceError(queryServiceTitle);

            return GisQueryHelper.ExecuteQuery({
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: false,
                outFields: ["*"],
                where: `rel_globalid='${escapeSqlLiteral(id)}'`
            });
        },

        GetAttachmentUrl: (queryServiceTitle, id, attachmentId) => {
            const queryService = findService(queryServiceTitle);
            const baseUrl = CommonBusiness.GenerateUrl(queryService);
            if (!baseUrl || IsNull(id) || IsNull(attachmentId)) return "#";
            return `${String(baseUrl).replace(/\/$/, "")}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;
        }
    }
};
