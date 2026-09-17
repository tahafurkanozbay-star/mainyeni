import type { RawServiceDefinition, ServiceDefinition, ServiceKind, ServicesDocument } from "../types.js";

const supportedKinds = new Set<ServiceKind>(["WMS", "WFS", "MapServer", "FeatureServer", "SceneServer"]);

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function inferKind(raw: RawServiceDefinition): ServiceKind {
  const stated = raw.servisTuruAdi as ServiceKind;
  if (supportedKinds.has(stated)) return stated;
  const url = raw.tokenUrl.toLowerCase();
  if (url.includes("/featureserver")) return "FeatureServer";
  if (url.includes("/sceneserver")) return "SceneServer";
  if (url.includes("/mapserver")) return "MapServer";
  if (url.includes("/wfs")) return "WFS";
  if (url.includes("/wms")) return "WMS";
  throw new Error(`Desteklenmeyen servis türü: ${raw.servisTuruAdi}`);
}

export function normalizeService(raw: RawServiceDefinition, index: number): ServiceDefinition {
  const kind = inferKind(raw);
  const displayName = raw.cografiVeriKatmanAdi.trim();
  return {
    ...raw,
    id: `${slugify(displayName) || "layer"}-${kind.toLowerCase()}-${index + 1}`,
    kind,
    displayName,
    organization: raw.ustKurumAdi.trim(),
    owner: raw.metaveriSahibiKurumAdi.trim(),
    url: raw.tokenUrl.trim(),
    status: "idle",
    visible: false,
    opacity: kind === "WMS" || kind === "MapServer" ? 0.82 : 1
  };
}

export async function loadServiceCatalog(url = "./services.json"): Promise<ServiceDefinition[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`services.json yüklenemedi (HTTP ${response.status}).`);
  const document = (await response.json()) as ServicesDocument;
  if (!Array.isArray(document.services)) throw new Error("services.json içinde 'services' dizisi bulunamadı.");
  return document.services.map(normalizeService);
}
