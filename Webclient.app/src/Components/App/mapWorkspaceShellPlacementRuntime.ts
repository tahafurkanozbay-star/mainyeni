import { chooseMapWorkspaceShellPlacement, type MapWorkspaceRect, type MapWorkspaceShellAnchor } from './mapWorkspaceShellPlacementModel';

export interface MapWorkspaceShellPlacementRuntimeDiagnostics {
  readonly started: boolean;
  readonly refreshCount: number;
  readonly resizeCount: number;
  readonly mutationCount: number;
  readonly anchorChangeCount: number;
  readonly currentAnchor: MapWorkspaceShellAnchor | null;
}

export interface MapWorkspaceShellPlacementRuntimeOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly occluderSelectors?: readonly string[];
  readonly safeBottom?: number;
}

const DEFAULT_OCCLUDERS: readonly string[] = Object.freeze([
  '#sidebar',
  '#toolbar-widget',
  '.experience-scene-controls',
  '.experience-map-mode-governed-overlay',
  '.experience-connectivity-notice',
]);

const asRect = (rect: DOMRect): MapWorkspaceRect => Object.freeze({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height,
});

const isVisible = (element: Element, win: Window): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = win.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
};

export class MapWorkspaceShellPlacementRuntime {
  readonly #root: HTMLElement;
  readonly #window: Window;
  readonly #document: Document;
  readonly #occluderSelectors: readonly string[];
  readonly #safeBottom: number;
  #started = false;
  #disposed = false;
  #frame = 0;
  #resizeObserver: ResizeObserver | null = null;
  #mutationObserver: MutationObserver | null = null;
  #refreshCount = 0;
  #resizeCount = 0;
  #mutationCount = 0;
  #anchorChangeCount = 0;
  #currentAnchor: MapWorkspaceShellAnchor | null = null;

  constructor(root: HTMLElement, options: MapWorkspaceShellPlacementRuntimeOptions = {}) {
    this.#root = root;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#occluderSelectors = Object.freeze([...(options.occluderSelectors ?? DEFAULT_OCCLUDERS)].slice(0, 16));
    this.#safeBottom = Math.max(0, Math.min(256, Math.trunc(options.safeBottom ?? 0)));
  }

  getDiagnostics(): MapWorkspaceShellPlacementRuntimeDiagnostics {
    return Object.freeze({
      started: this.#started,
      refreshCount: this.#refreshCount,
      resizeCount: this.#resizeCount,
      mutationCount: this.#mutationCount,
      anchorChangeCount: this.#anchorChangeCount,
      currentAnchor: this.#currentAnchor,
    });
  }

  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.#window.addEventListener('resize', this.#handleResize, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(this.#handleObservedResize);
      this.#resizeObserver.observe(this.#root);
      for (const element of this.#collectOccluderElements()) this.#resizeObserver.observe(element);
    }

    if (typeof MutationObserver !== 'undefined' && this.#document.body) {
      this.#mutationObserver = new MutationObserver(this.#handleMutation);
      this.#mutationObserver.observe(this.#document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-hidden', 'style'],
      });
    }

    this.refreshNow();
  }

  refreshNow(): void {
    if (this.#disposed) return;
    this.#cancelFrame();
    this.#refreshCount += 1;
    const rootRect = this.#root.getBoundingClientRect();
    const occluders = this.#collectOccluderElements()
      .filter((element) => element !== this.#root && !this.#root.contains(element))
      .filter((element) => isVisible(element, this.#window))
      .map((element) => asRect(element.getBoundingClientRect()))
      .filter((rect) => rect.width > 0 && rect.height > 0);

    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: this.#window.innerWidth, height: this.#window.innerHeight },
      overlay: { width: rootRect.width, height: rootRect.height },
      occluders,
      safeBottom: this.#safeBottom,
    });

    if (result.anchor !== this.#currentAnchor) {
      this.#currentAnchor = result.anchor;
      this.#anchorChangeCount += 1;
      this.#root.dataset.anchor = result.anchor;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    this.#cancelFrame();
    this.#window.removeEventListener('resize', this.#handleResize);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
  }

  readonly #handleResize = (): void => {
    this.#resizeCount += 1;
    this.#scheduleRefresh();
  };

  readonly #handleObservedResize = (): void => {
    this.#resizeCount += 1;
    this.#scheduleRefresh();
  };

  readonly #handleMutation = (): void => {
    this.#mutationCount += 1;
    this.#scheduleRefresh();
  };

  #collectOccluderElements(): HTMLElement[] {
    const values: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const selector of this.#occluderSelectors) {
      for (const element of this.#document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement) || seen.has(element)) continue;
        seen.add(element);
        values.push(element);
      }
    }
    return values;
  }

  #scheduleRefresh(): void {
    if (this.#disposed || this.#frame !== 0) return;
    this.#frame = this.#window.requestAnimationFrame(() => {
      this.#frame = 0;
      this.refreshNow();
    });
  }

  #cancelFrame(): void {
    if (this.#frame === 0) return;
    this.#window.cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }
}
