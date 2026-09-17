import type { ServiceDefinition } from "../types.js";

type ArcGISConstructor = new (properties: Record<string, unknown>) => any;

const moduleByKind: Record<ServiceDefinition["kind"], string> = {
  FeatureServer: "@arcgis/core/layers/FeatureLayer.js",
  SceneServer: "@arcgis/core/layers/SceneLayer.js",
  MapServer: "@arcgis/core/layers/MapImageLayer.js",
  WMS: "@arcgis/core/layers/WMSLayer.js",
  WFS: "@arcgis/core/layers/WFSLayer.js"
};

function mapServerParts(url: string): { root: string; sublayerId?: number } {
  const match = url.match(/^(.*\/MapServer)(?:\/(\d+))?\/?$/i);
  if (!match) return { root: url };
  return { root: match[1]!, sublayerId: match[2] === undefined ? undefined : Number(match[2]) };
}

async function loadCtor(kind: ServiceDefinition["kind"]): Promise<ArcGISConstructor> {
  const module = await $arcgis.import<{ default: ArcGISConstructor }>(moduleByKind[kind]);
  return module.default;
}

export async function createLayer(service: ServiceDefinition): Promise<any> {
  const LayerCtor = await loadCtor(service.kind);
  const common = { title: service.displayName, visible: service.visible, opacity: service.opacity };

  switch (service.kind) {
    case "FeatureServer":
      return new LayerCtor({ ...common, url: service.url, outFields: ["*"], popupEnabled: true });
    case "SceneServer":
      return new LayerCtor({ ...common, url: service.url, popupEnabled: true });
    case "MapServer": {
      const { root, sublayerId } = mapServerParts(service.url);
      return new LayerCtor({
        ...common,
        url: root,
        sublayers: sublayerId === undefined ? undefined : [{ id: sublayerId, visible: true }]
      });
    }
    case "WMS":
    case "WFS":
      return new LayerCtor({ ...common, url: service.url });
  }
}
