import { el, iconButton } from "../utils/dom.js";
import type { ToastHost } from "./toast.js";

interface ToolbarOptions {
  map: any;
  view: any;
  toast: ToastHost;
  onToggleLayers: () => void;
  onShare: () => void;
  onReset: () => Promise<void>;
}

type WidgetLike = { destroy?: () => void };
type WidgetCtor = new (properties: Record<string, unknown>) => WidgetLike;

export class Toolbar {
  readonly root = el("nav", { className: "map-toolbar", attrs: { "aria-label": "Harita araçları" } });
  private activeWidget?: WidgetLike;
  private toolPanel?: HTMLElement;

  constructor(private readonly options: ToolbarOptions) {
    const home = iconButton("Başlangıç görünümü", "⌂", "H");
    const layers = iconButton("Katman paneli", "▱", "L");
    const legend = iconButton("Lejant", "≡");
    const basemap = iconButton("Altlık harita", "◫");
    const distance = iconButton("3B mesafe ölç", "↔");
    const area = iconButton("3B alan ölç", "△");
    const daylight = iconButton("Gün ışığı analizi", "☀");
    const slice = iconButton("3B kesit", "◒");
    const lineOfSight = iconButton("Görüş hattı", "◉");
    const share = iconButton("Görünümü paylaş", "↗");
    const help = iconButton("Klavye kısayolları", "?");

    this.root.append(home, layers, divider(), legend, basemap, divider(), distance, area, daylight, slice, lineOfSight, divider(), share, help);
    home.addEventListener("click", () => void this.options.onReset());
    layers.addEventListener("click", this.options.onToggleLayers);
    legend.addEventListener("click", () => void this.openWidget("Lejant", "@arcgis/core/widgets/Legend.js"));
    basemap.addEventListener("click", () => void this.openWidget("Altlık Harita", "@arcgis/core/widgets/BasemapGallery.js"));
    distance.addEventListener("click", () => void this.openWidget("3B Mesafe", "@arcgis/core/widgets/DirectLineMeasurement3D.js"));
    area.addEventListener("click", () => void this.openWidget("3B Alan", "@arcgis/core/widgets/AreaMeasurement3D.js"));
    daylight.addEventListener("click", () => void this.openWidget("Gün Işığı", "@arcgis/core/widgets/Daylight.js"));
    slice.addEventListener("click", () => void this.openWidget("Kesit", "@arcgis/core/widgets/Slice.js"));
    lineOfSight.addEventListener("click", () => void this.openWidget("Görüş Hattı", "@arcgis/core/widgets/LineOfSight.js"));
    share.addEventListener("click", this.options.onShare);
    help.addEventListener("click", () => this.showHelp());
  }

  closeTool(): void {
    this.activeWidget?.destroy?.();
    this.activeWidget = undefined;
    this.toolPanel?.remove();
    this.toolPanel = undefined;
  }

  private async openWidget(title: string, moduleId: string): Promise<void> {
    this.closeTool();
    const panel = el("section", { className: "tool-panel", attrs: { "aria-label": title } });
    const head = el("div", { className: "tool-panel__header" });
    head.append(el("strong", { text: title }));
    const close = el("button", { className: "mini-button", text: "×", attrs: { type: "button", "aria-label": "Aracı kapat" } });
    head.append(close);
    const body = el("div", { className: "tool-panel__body" });
    panel.append(head, body);
    document.querySelector(".map-shell")?.append(panel);
    this.toolPanel = panel;
    close.addEventListener("click", () => this.closeTool());

    try {
      const module = await $arcgis.import<{ default: WidgetCtor }>(moduleId);
      this.activeWidget = new module.default({ view: this.options.view, container: body });
    } catch (error) {
      body.textContent = "Araç yüklenemedi.";
      this.options.toast.show(error instanceof Error ? error.message : "Araç yüklenemedi.", "error");
    }
  }

  private showHelp(): void {
    this.closeTool();
    const panel = el("section", { className: "tool-panel help-panel" });
    panel.innerHTML = `
      <div class="tool-panel__header"><strong>Kısayollar</strong><button class="mini-button" type="button" aria-label="Kapat">×</button></div>
      <div class="help-grid">
        <kbd>H</kbd><span>Ankara başlangıç görünümü</span>
        <kbd>L</kbd><span>Katman panelini aç/kapat</span>
        <kbd>F</kbd><span>Tam ekran</span>
        <kbd>Esc</kbd><span>Aktif aracı kapat</span>
      </div>`;
    document.querySelector(".map-shell")?.append(panel);
    this.toolPanel = panel;
    panel.querySelector("button")?.addEventListener("click", () => this.closeTool());
  }
}

function divider(): HTMLElement {
  return el("span", { className: "toolbar-divider", attrs: { "aria-hidden": "true" } });
}
