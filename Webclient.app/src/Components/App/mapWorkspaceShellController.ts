import {
  MAP_WORKSPACE_SHELL_REGIONS,
  type MapWorkspaceShellModel,
  type MapWorkspaceShellRegionDefinition,
  type MapWorkspaceShellRegionId,
} from './mapWorkspaceShellModel';

export interface MapWorkspaceShellControllerOptions {
  readonly model: MapWorkspaceShellModel;
  readonly document?: Document;
  readonly window?: Window;
  readonly root?: ParentNode;
  readonly regions?: readonly MapWorkspaceShellRegionDefinition[];
}

export interface MapWorkspaceShellControllerSnapshot {
  readonly installed: boolean;
  readonly refreshCount: number;
  readonly focusRequestCount: number;
  readonly rejectedFocusCount: number;
  readonly lastFocusedRegion: MapWorkspaceShellRegionId | null;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

const isElementHidden = (element: HTMLElement, win: Window): boolean => {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
  if ('inert' in element && Boolean(element.inert)) return true;
  const style = win.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0 && style.position !== 'fixed') return true;
  return false;
};

const isElementDisabled = (element: HTMLElement): boolean => {
  if (element.matches(':disabled')) return true;
  return element.getAttribute('aria-disabled') === 'true';
};

const isFocusable = (element: HTMLElement, win: Window): boolean => (
  !isElementHidden(element, win)
  && !isElementDisabled(element)
  && (
    element.matches(FOCUSABLE_SELECTOR)
    || element.tabIndex >= 0
  )
);

const visibleModal = (doc: Document, win: Window): HTMLElement | null => {
  const modals = Array.from(doc.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
  return modals.find((modal) => !isElementHidden(modal, win)) ?? null;
};

const focusWithPreventScroll = (element: HTMLElement): void => {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
};

const pickRegionFocusTarget = (root: HTMLElement, win: Window): HTMLElement => {
  if (isFocusable(root, win)) return root;
  const preferred = root.querySelector<HTMLElement>('[data-experience-region-focus]');
  if (preferred && isFocusable(preferred, win)) return preferred;
  const descendant = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .find((candidate) => isFocusable(candidate, win));
  return descendant ?? root;
};

const regionRootForNode = (
  node: Node | null,
  roots: ReadonlyMap<MapWorkspaceShellRegionId, HTMLElement>,
): MapWorkspaceShellRegionId | null => {
  if (!node) return null;
  for (const [id, root] of roots) {
    if (node === root || root.contains(node)) return id;
  }
  return null;
};

const queryRegionRoot = (
  region: MapWorkspaceShellRegionDefinition,
  root: ParentNode,
  win: Window,
): HTMLElement | null => {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(region.selector));
  return candidates.find((candidate) => !isElementHidden(candidate, win)) ?? null;
};

const shouldIgnoreF6 = (event: KeyboardEvent): boolean => (
  event.defaultPrevented
  || event.key !== 'F6'
  || event.altKey
  || event.ctrlKey
  || event.metaKey
  || event.isComposing
);

export class MapWorkspaceShellController {
  readonly #model: MapWorkspaceShellModel;
  readonly #document: Document;
  readonly #window: Window;
  readonly #root: ParentNode;
  readonly #regions: readonly MapWorkspaceShellRegionDefinition[];
  readonly #roots = new Map<MapWorkspaceShellRegionId, HTMLElement>();
  readonly #temporaryTabIndexes = new WeakSet<HTMLElement>();
  #installed = false;
  #refreshCount = 0;
  #focusRequestCount = 0;
  #rejectedFocusCount = 0;
  #lastFocusedRegion: MapWorkspaceShellRegionId | null = null;
  #rafId: number | null = null;

  constructor(options: MapWorkspaceShellControllerOptions) {
    this.#model = options.model;
    this.#document = options.document ?? document;
    this.#window = options.window ?? window;
    this.#root = options.root ?? this.#document;
    this.#regions = options.regions ?? MAP_WORKSPACE_SHELL_REGIONS;
  }

  snapshot(): MapWorkspaceShellControllerSnapshot {
    return Object.freeze({
      installed: this.#installed,
      refreshCount: this.#refreshCount,
      focusRequestCount: this.#focusRequestCount,
      rejectedFocusCount: this.#rejectedFocusCount,
      lastFocusedRegion: this.#lastFocusedRegion,
    });
  }

  install(): () => void {
    if (this.#installed) return () => this.dispose();
    this.#installed = true;
    this.refreshAvailability();
    this.#window.addEventListener('keydown', this.#onKeyDown, true);
    this.#document.addEventListener('focusin', this.#onFocusIn, true);
    this.#document.addEventListener('pointerdown', this.#onPointerDown, true);
    this.#window.addEventListener('resize', this.#scheduleRefresh, { passive: true });
    this.#document.addEventListener('visibilitychange', this.#scheduleRefresh);
    this.#window.addEventListener('kentrehberi:map-mode-changed', this.#scheduleRefresh as EventListener);
    return () => this.dispose();
  }

  refreshAvailability(): void {
    if (!this.#installed) return;
    this.#refreshCount += 1;
    this.#roots.clear();
    const available: MapWorkspaceShellRegionId[] = [];
    const ordered = [...this.#regions].sort((left, right) => left.order - right.order);
    for (const region of ordered) {
      const root = queryRegionRoot(region, this.#root, this.#window);
      if (!root) continue;
      this.#roots.set(region.id, root);
      available.push(region.id);
    }
    this.#model.setAvailableRegions(available);
    const activeRegion = regionRootForNode(this.#document.activeElement, this.#roots);
    if (activeRegion) this.#model.setActiveRegion(activeRegion);
  }

  focusRegion(id: MapWorkspaceShellRegionId, fromCycle = false): boolean {
    if (!this.#installed) return false;
    const root = this.#roots.get(id);
    if (!root || isElementHidden(root, this.#window)) {
      this.#rejectedFocusCount += 1;
      this.refreshAvailability();
      return false;
    }

    const target = pickRegionFocusTarget(root, this.#window);
    const previousTabIndex = target.getAttribute('tabindex');
    const needsTemporaryTabIndex = !isFocusable(target, this.#window);
    if (needsTemporaryTabIndex) {
      target.setAttribute('tabindex', '-1');
      this.#temporaryTabIndexes.add(target);
      target.addEventListener('blur', () => {
        if (!this.#temporaryTabIndexes.has(target)) return;
        this.#temporaryTabIndexes.delete(target);
        if (previousTabIndex === null) target.removeAttribute('tabindex');
        else target.setAttribute('tabindex', previousTabIndex);
      }, { once: true });
    }

    this.#focusRequestCount += 1;
    focusWithPreventScroll(target);
    this.#lastFocusedRegion = id;
    if (fromCycle) this.#model.recordRegionCycle(id);
    else this.#model.setActiveRegion(id);
    return true;
  }

  cycle(reverse = false): boolean {
    if (!this.#installed) return false;
    this.refreshAvailability();
    const modal = visibleModal(this.#document, this.#window);
    if (modal) {
      this.#rejectedFocusCount += 1;
      return false;
    }
    const current = regionRootForNode(this.#document.activeElement, this.#roots)
      ?? this.#model.getSnapshot().activeRegion;
    const target = this.#model.nextRegion(current, reverse);
    if (!target) return false;
    return this.focusRegion(target, true);
  }

  dispose(): void {
    if (!this.#installed) return;
    this.#installed = false;
    if (this.#rafId !== null) {
      this.#window.cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#window.removeEventListener('keydown', this.#onKeyDown, true);
    this.#document.removeEventListener('focusin', this.#onFocusIn, true);
    this.#document.removeEventListener('pointerdown', this.#onPointerDown, true);
    this.#window.removeEventListener('resize', this.#scheduleRefresh);
    this.#document.removeEventListener('visibilitychange', this.#scheduleRefresh);
    this.#window.removeEventListener('kentrehberi:map-mode-changed', this.#scheduleRefresh as EventListener);
    this.#roots.clear();
  }

  readonly #scheduleRefresh = (): void => {
    if (!this.#installed || this.#rafId !== null) return;
    this.#rafId = this.#window.requestAnimationFrame(() => {
      this.#rafId = null;
      this.refreshAvailability();
    });
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    this.#model.setModality('keyboard');
    if (shouldIgnoreF6(event)) return;
    const modal = visibleModal(this.#document, this.#window);
    if (modal) return;
    if (!this.cycle(event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  readonly #onFocusIn = (event: FocusEvent): void => {
    const id = regionRootForNode(event.target as Node | null, this.#roots);
    if (!id) return;
    this.#lastFocusedRegion = id;
    this.#model.setActiveRegion(id);
  };

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#model.setModality(event.pointerType === 'touch' ? 'touch' : 'pointer');
    const id = regionRootForNode(event.target as Node | null, this.#roots);
    if (id) this.#model.setActiveRegion(id);
  };
}

export const createMapWorkspaceShellController = (
  options: MapWorkspaceShellControllerOptions,
): MapWorkspaceShellController => new MapWorkspaceShellController(options);
