export type ServiceKind = "WMS" | "WFS" | "MapServer" | "FeatureServer" | "SceneServer";
export type ServiceStatus = "idle" | "loading" | "ready" | "error";

export interface RawServiceDefinition {
  ustKurumAdi: string;
  metaveriSahibiKurumAdi: string;
  cografiVeriKatmanAdi: string;
  servisTuruAdi: ServiceKind | string;
  tokenUrl: string;
}

export interface ServicesDocument {
  services: RawServiceDefinition[];
}

export interface ServiceDefinition extends RawServiceDefinition {
  id: string;
  kind: ServiceKind;
  displayName: string;
  organization: string;
  owner: string;
  url: string;
  status: ServiceStatus;
  error?: string;
  visible: boolean;
  opacity: number;
}

export interface LayerRuntime {
  service: ServiceDefinition;
  layer: any;
}

export interface ViewSnapshot {
  longitude: number;
  latitude: number;
  z: number;
  heading: number;
  tilt: number;
}
