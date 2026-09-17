import type { LayerRuntime, ServiceDefinition } from "../types.js";
import { el, escapeHtml } from "../utils/dom.js";

interface LayerPanelOptions {
  services: ServiceDefinition[];
  runtimes: Map<string, LayerRuntime>;
  view: any;
  onVisibilityChange: (service: ServiceDefinition, visible: boolean) => Promise<void>;
  onOpacityChange: (service: ServiceDefinition, opacity: number) => void;
  onRetry: (service: ServiceDefinition) => Promise<void>;
}

const kindLabel: Record<string, string> = {
  WMS: "WMS",
  WFS: "WFS",
  MapServer: "MAP",
  FeatureServer: "FEATURE",
  SceneServer: "3D SCENE"
};

export class LayerPanel {
  readonly root = el("aside", { className: "layer-panel", attrs: { "aria-label": "Katman kataloğu" } });
  private readonly list = el("div", { className: "layer-list" });
  private readonly count = el("span", { className: "layer-count", text: "0" });
  private readonly search = el("input", {
    className: "layer-search",
    attrs: { type: "search", placeholder: "Katman veya kurum ara…", "aria-label": "Katman ara" }
  });
  private filter = "";

  constructor(private readonly options: LayerPanelOptions) {
    const header = el("div", { className: "panel-header" });
    const title = el("div", { className: "panel-title" });
    title.innerHTML = `<div><strong>Katmanlar</strong><span>Servis kataloğu</span></div>`;
    title.append(this.count);
    header.append(title, this.search);
    this.root.append(header, this.list);
    this.search.addEventListener("input", () => {
      this.filter = this.search.value.toLocaleLowerCase("tr-TR").trim();
      this.render();
    });
    this.render();
  }

  render(): void {
    this.list.replaceChildren();
    const filtered = this.options.services.filter((service) => {
      if (!this.filter) return true;
      return `${service.displayName} ${service.organization} ${service.owner} ${service.kind}`
        .toLocaleLowerCase("tr-TR")
        .includes(this.filter);
    });
    this.count.textContent = String(filtered.length);

    const groups = new Map<string, ServiceDefinition[]>();
    for (const service of filtered) {
      const key = service.organization || "Diğer";
      const group = groups.get(key) ?? [];
      group.push(service);
      groups.set(key, group);
    }

    for (const [organization, services] of groups) {
      const section = el("section", { className: "layer-group" });
      section.innerHTML = `<h3>${escapeHtml(organization)} <span>${services.length}</span></h3>`;
      for (const service of services) section.append(this.renderCard(service));
      this.list.append(section);
    }
  }

  private renderCard(service: ServiceDefinition): HTMLElement {
    const card = el("article", { className: `layer-card ${service.visible ? "is-active" : ""}` });
    card.dataset.layerId = service.id;

    const row = el("div", { className: "layer-card__row" });
    const toggle = el("input", {
      className: "switch-input",
      attrs: { type: "checkbox", role: "switch", "aria-label": `${service.displayName} görünürlüğü` }
    });
    toggle.checked = service.visible;
    const switchLabel = el("label", { className: "switch" });
    switchLabel.append(toggle, el("span", { className: "switch-track" }));

    const meta = el("div", { className: "layer-card__meta" });
    meta.innerHTML = `<strong>${escapeHtml(service.displayName)}</strong><div><span class="kind-badge">${kindLabel[service.kind] ?? service.kind}</span><span class="status-dot status-dot--${service.status}" title="${escapeHtml(service.error ?? service.status)}"></span></div>`;

    const zoom = el("button", { className: "mini-button", text: "⌖", attrs: { type: "button", title: "Katmana yaklaş", "aria-label": "Katmana yaklaş" } });
    row.append(switchLabel, meta, zoom);

    const controls = el("div", { className: "layer-card__controls" });
    const opacity = el("input", {
      attrs: { type: "range", min: "0", max: "1", step: "0.05", value: String(service.opacity), "aria-label": "Saydamlık" }
    });
    const opacityText = el("span", { text: `${Math.round(service.opacity * 100)}%` });
    opacity.addEventListener("input", () => {
      const value = Number(opacity.value);
      opacityText.textContent = `${Math.round(value * 100)}%`;
      this.options.onOpacityChange(service, value);
    });
    const info = el("button", { className: "text-button", text: "Bilgi", attrs: { type: "button" } });
    controls.append(opacity, opacityText, info);
    card.append(row, controls);

    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      await this.options.onVisibilityChange(service, toggle.checked);
      toggle.disabled = false;
      this.render();
    });

    zoom.addEventListener("click", async () => {
      const runtime = this.options.runtimes.get(service.id);
      if (!runtime) return;
      await zoomToLayer(this.options.view, runtime.layer);
    });

    info.addEventListener("click", () => this.openInfo(service, card));
    if (service.status === "error") {
      const retry = el("button", { className: "text-button text-button--danger", text: "Yeniden dene", attrs: { type: "button" } });
      retry.addEventListener("click", async () => {
        await this.options.onRetry(service);
        this.render();
      });
      controls.append(retry);
    }

    return card;
  }

  private openInfo(service: ServiceDefinition, card: HTMLElement): void {
    card.querySelector(".layer-info")?.remove();
    const info = el("div", { className: "layer-info" });
    info.innerHTML = `
      <dl>
        <div><dt>Tür</dt><dd>${escapeHtml(service.kind)}</dd></div>
        <div><dt>Veri sahibi</dt><dd>${escapeHtml(service.owner)}</dd></div>
        <div><dt>Durum</dt><dd>${escapeHtml(service.error ?? service.status)}</dd></div>
      </dl>
      <p title="${escapeHtml(service.url)}">${escapeHtml(maskUrl(service.url))}</p>`;
    card.append(info);
  }
}

async function zoomToLayer(view: any, layer: any): Promise<void> {
  try {
    await layer.load();
    const extent = layer.fullExtent;
    if (extent) await view.goTo(extent.expand(1.25), { duration: 1200 });
  } catch {
    // Katman durumu zaten kart üzerinde raporlanır.
  }
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.length > 62 ? `${parsed.pathname.slice(0, 59)}…` : parsed.pathname}`;
  } catch {
    return url.length > 72 ? `${url.slice(0, 69)}…` : url;
  }
}
