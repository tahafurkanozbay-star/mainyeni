import { loadServiceCatalog } from "./services/catalog.js";
import { createLayer } from "./services/layerFactory.js";
import type { LayerRuntime, ServiceDefinition, ViewSnapshot } from "./types.js";
import { LayerPanel } from "./ui/layerPanel.js";
import { Toolbar } from "./ui/toolbar.js";
import { ToastHost } from "./ui/toast.js";
import { el, escapeHtml } from "./utils/dom.js";
import { readBasemap, readCamera, readVisibility, saveBasemap, saveCamera, saveVisibility } from "./utils/storage.js";

type ArcGISConstructor = new (properties: Record<string, any>) => any;

const ANKARA_CAMERA: ViewSnapshot = {
  longitude: 32.8542,
  latitude: 39.9208,
  z: 5200,
  heading: 2,
  tilt: 58
};

const [MapModule, SceneViewModule, SearchModule, CompassModule, HomeModule, FullscreenModule, configModule] = await Promise.all([
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/Map.js"),
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/views/SceneView.js"),
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/widgets/Search.js"),
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/widgets/Compass.js"),
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/widgets/Home.js"),
  $arcgis.import<{ default: ArcGISConstructor }>("@arcgis/core/widgets/Fullscreen.js"),
  $arcgis.import<{ default: any }>("@arcgis/core/config.js")
]);
const MapCtor = MapModule.default;
const SceneViewCtor = SceneViewModule.default;
const SearchCtor = SearchModule.default;
const CompassCtor = CompassModule.default;
const HomeCtor = HomeModule.default;
const FullscreenCtor = FullscreenModule.default;
configModule.default.request.timeout = 30000;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Uygulama kökü bulunamadı.");

const shell = el("main", { className: "map-shell" });
const viewContainer = el("div", { className: "view-container", attrs: { id: "viewDiv" } });
const topbar = buildTopbar();
const searchHost = el("div", { className: "search-host" });
const rightControls = el("div", { className: "right-controls" });
const statusBar = el("footer", { className: "status-bar" });
const details = el("aside", { className: "details-panel is-hidden", attrs: { "aria-label": "Seçili detaylar" } });
const toast = new ToastHost();
shell.append(viewContainer, topbar, searchHost, rightControls, details, statusBar, toast.root);
app.append(shell);

const services = await loadServiceCatalog();
const visibility = readVisibility();
const urlLayerIds = readLayerIdsFromUrl();
for (const service of services) service.visible = urlLayerIds ? urlLayerIds.has(service.id) : (visibility[service.id] ?? false);

const map = new MapCtor({ basemap: readBasemap(), ground: "world-elevation" });
const initialCamera = readCameraFromUrl() ?? readCamera() ?? ANKARA_CAMERA;
const view = new SceneViewCtor({
  container: viewContainer,
  map,
  viewingMode: "local",
  camera: {
    position: [initialCamera.longitude, initialCamera.latitude, initialCamera.z],
    heading: initialCamera.heading,
    tilt: initialCamera.tilt
  },
  qualityProfile: "high",
  environment: {
    atmosphereEnabled: true,
    starsEnabled: false,
    lighting: { directShadowsEnabled: true, ambientOcclusionEnabled: true }
  },
  constraints: { collision: { enabled: true } }
});

const runtimes = new Map<string, LayerRuntime>();
let layerPanel!: LayerPanel;
await view.when();
view.popupEnabled = false;
setupCoreWidgets();
setupStatusBar();
setupSelection();
setupPersistence();

layerPanel = new LayerPanel({
  services,
  runtimes,
  view,
  onVisibilityChange: setServiceVisibility,
  onOpacityChange: setServiceOpacity,
  onRetry: retryService
});
shell.append(layerPanel.root);

const toolbar = new Toolbar({
  map,
  view,
  toast,
  onToggleLayers: () => layerPanel.root.classList.toggle("is-collapsed"),
  onShare: shareView,
  onReset: async () => {
    await view.goTo({
      position: [ANKARA_CAMERA.longitude, ANKARA_CAMERA.latitude, ANKARA_CAMERA.z],
      heading: ANKARA_CAMERA.heading,
      tilt: ANKARA_CAMERA.tilt
    }, { duration: 1400 });
  }
});
shell.append(toolbar.root);
setupKeyboard(toolbar);
rightControls.prepend(buildBasemapSelect());

const initiallyVisible = services.filter((service) => service.visible);
if (initiallyVisible.length === 0) {
  const defaults = services.filter((service) => service.kind === "SceneServer" || service.kind === "FeatureServer").slice(0, 2);
  for (const service of defaults) await setServiceVisibility(service, true, false);
  saveVisibility(services);
} else {
  await Promise.allSettled(initiallyVisible.map((service) => setServiceVisibility(service, true, false)));
}
layerPanel.render();
updateServiceCounter();
toast.show(`${services.length} servis katalogdan okundu.`, "success");

async function setServiceVisibility(service: ServiceDefinition, visible: boolean, persist = true): Promise<void> {
  service.visible = visible;
  let runtime = runtimes.get(service.id);

  if (visible && !runtime) {
    service.status = "loading";
    service.error = undefined;
    layerPanel?.render();
    const layer = await createLayer(service);
    runtime = { service, layer };
    runtimes.set(service.id, runtime);
    map.add(layer);
    try {
      await layer.load();
      service.status = "ready";
      layer.visible = true;
    } catch (error) {
      service.status = "error";
      service.error = readableError(error);
      service.visible = false;
      map.remove(layer);
      layer.destroy?.();
      runtimes.delete(service.id);
      toast.show(`${service.displayName}: ${service.error}`, "error", 7000);
    }
  } else if (runtime) {
    runtime.layer.visible = visible;
  }

  updateServiceCounter();
  if (persist) saveVisibility(services);
}

function setServiceOpacity(service: ServiceDefinition, opacity: number): void {
  service.opacity = opacity;
  const runtime = runtimes.get(service.id);
  if (runtime) runtime.layer.opacity = opacity;
}

async function retryService(service: ServiceDefinition): Promise<void> {
  const old = runtimes.get(service.id);
  if (old) {
    map.remove(old.layer);
    old.layer.destroy?.();
    runtimes.delete(service.id);
  }
  await setServiceVisibility(service, true);
}

function setupCoreWidgets(): void {
  const searchNode = el("div", { className: "search-widget" });
  searchHost.append(searchNode);
  new SearchCtor({ view, container: searchNode, includeDefaultSources: true });

  const homeNode = el("div", { className: "widget-box" });
  const compassNode = el("div", { className: "widget-box" });
  const fullNode = el("div", { className: "widget-box" });
  rightControls.append(homeNode, compassNode, fullNode);
  new HomeCtor({ view, container: homeNode, viewpoint: view.viewpoint.clone() });
  new CompassCtor({ view, container: compassNode });
  new FullscreenCtor({ view, container: fullNode, element: shell });
}

function buildBasemapSelect(): HTMLSelectElement {
  const select = el("select", { className: "basemap-select", attrs: { "aria-label": "Altlık harita" } });
  const options: Array<[string, string]> = [
    ["satellite", "Uydu"], ["hybrid", "Hibrit"], ["topo-vector", "Topoğrafik"],
    ["streets-vector", "Sokak"], ["dark-gray-vector", "Koyu Gri"], ["gray-vector", "Açık Gri"]
  ];
  for (const [value, label] of options) {
    const option = el("option", { text: label, attrs: { value } });
    option.selected = value === readBasemap();
    select.append(option);
  }
  select.addEventListener("change", () => {
    map.basemap = select.value;
    saveBasemap(select.value);
  });
  return select;
}

function setupStatusBar(): void {
  const coords = el("span", { className: "coords", text: "39.9208° N, 32.8542° E" });
  const camera = el("span", { text: "Yükseklik: —" });
  const layers = el("span", { attrs: { id: "activeLayers" }, text: "Aktif katman: 0" });
  const fps = el("span", { className: "perf", text: "3B · WebGL" });
  statusBar.append(coords, camera, layers, fps);

  view.on("pointer-move", (event: any) => {
    const point = view.toMap({ x: event.x, y: event.y });
    if (!point) return;
    coords.textContent = `${point.latitude?.toFixed(5) ?? "—"}° N, ${point.longitude?.toFixed(5) ?? "—"}° E`;
  });
  view.watch("camera", (value: any) => {
    camera.textContent = `Yükseklik: ${Math.round(value.position.z ?? 0).toLocaleString("tr-TR")} m · Eğim: ${Math.round(value.tilt)}°`;
  });
}

function updateServiceCounter(): void {
  const counter = document.querySelector("#activeLayers");
  if (counter) counter.textContent = `Aktif katman: ${services.filter((service) => service.visible).length}`;
}

function setupSelection(): void {
  view.on("click", async (event: any) => {
    const response = await view.hitTest(event);
    const hit = response.results.find((result: any) => result.type === "graphic");
    if (!hit) {
      details.classList.add("is-hidden");
      return;
    }
    const graphic = hit.graphic;
    const attrs = graphic.attributes ?? {};
    const layerTitle = graphic.layer?.title ?? "Detay";
    const rows = Object.entries(attrs)
      .slice(0, 24)
      .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(formatValue(value))}</dd></div>`)
      .join("");
    details.innerHTML = `<div class="details-head"><div><strong>${escapeHtml(layerTitle)}</strong><span>Seçili nesne</span></div><button type="button" aria-label="Detayları kapat">×</button></div><dl>${rows || "<p>Öznitelik bulunamadı.</p>"}</dl>`;
    details.classList.remove("is-hidden");
    details.querySelector("button")?.addEventListener("click", () => details.classList.add("is-hidden"));
  });
}

function setupPersistence(): void {
  let timer = 0;
  view.watch("camera", (camera: any) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const longitude = camera.position.longitude;
      const latitude = camera.position.latitude;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
      saveCamera({ longitude, latitude, z: camera.position.z ?? 0, heading: camera.heading, tilt: camera.tilt });
    }, 400);
  });
}

function shareView(): void {
  const camera = view.camera;
  const params = new URLSearchParams({
    lon: String(camera.position.longitude?.toFixed(6) ?? ANKARA_CAMERA.longitude),
    lat: String(camera.position.latitude?.toFixed(6) ?? ANKARA_CAMERA.latitude),
    z: String(Math.round(camera.position.z ?? ANKARA_CAMERA.z)),
    heading: String(Math.round(camera.heading)),
    tilt: String(Math.round(camera.tilt)),
    layers: services.filter((service) => service.visible).map((service) => service.id).join(",")
  });
  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  void navigator.clipboard.writeText(url).then(
    () => toast.show("Görünüm bağlantısı panoya kopyalandı.", "success"),
    () => toast.show(url, "info", 10000)
  );
}

function readCameraFromUrl(): ViewSnapshot | undefined {
  const params = new URLSearchParams(location.search);
  const values = ["lon", "lat", "z", "heading", "tilt"].map((key) => Number(params.get(key)));
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  const [longitude, latitude, z, heading, tilt] = values as [number, number, number, number, number];
  return { longitude, latitude, z, heading, tilt };
}

function readLayerIdsFromUrl(): Set<string> | undefined {
  const raw = new URLSearchParams(location.search).get("layers");
  if (raw === null) return undefined;
  return new Set(raw.split(",").filter(Boolean));
}

function setupKeyboard(toolbar: Toolbar): void {
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const key = event.key.toLowerCase();
    if (key === "h") void view.goTo({ position: [ANKARA_CAMERA.longitude, ANKARA_CAMERA.latitude, ANKARA_CAMERA.z], heading: ANKARA_CAMERA.heading, tilt: ANKARA_CAMERA.tilt });
    if (key === "l") layerPanel.root.classList.toggle("is-collapsed");
    if (key === "f") void (document.fullscreenElement ? document.exitFullscreen() : shell.requestFullscreen());
    if (event.key === "Escape") toolbar.closeTool();
  });
}

function buildTopbar(): HTMLElement {
  const header = el("header", { className: "topbar" });
  header.innerHTML = `
    <div class="brand-mark" aria-hidden="true"><span>ABB</span><small>CBS</small></div>
    <div class="brand-copy"><strong>3B Altyapı / Üstyapı Koordinasyon</strong><span>Coğrafi Bilgi Sistemleri · Başkent</span></div>
    <div class="brand-badge"><i></i> CANLI CBS</div>`;
  return header;
}

function readableError(error: unknown): string {
  if (error instanceof Error) {
    if (/cors/i.test(error.message)) return "Servis CORS politikasına izin vermiyor.";
    return error.message.length > 170 ? `${error.message.slice(0, 167)}…` : error.message;
  }
  return "Servis yüklenemedi.";
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("tr-TR");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
