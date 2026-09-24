export type PanelId = 'navigation' | 'tools' | 'details';
export type PanelPresentation = 'hidden' | 'overlay' | 'docked' | 'bottom-sheet';
export type WorkspaceSize = 'compact' | 'medium' | 'wide';

export interface PanelLayoutState {
  readonly id: PanelId;
  readonly open: boolean;
  readonly sizePx: number;
  readonly minPx: number;
  readonly maxPx: number;
  readonly presentation: PanelPresentation;
  readonly resizable: boolean;
  readonly separatorOrientation: 'vertical' | 'horizontal';
}

export interface PanelLayoutSnapshot {
  readonly workspaceSize: WorkspaceSize;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly minimumTargetPx: 44 | 48;
  readonly panels: Readonly<Record<PanelId, PanelLayoutState>>;
  readonly mapInset: Readonly<{ left: number; right: number; bottom: number }>;
  readonly revision: number;
}

export interface PanelLayoutModelOptions {
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly onObserverError?: (error: unknown) => void;
}

export interface PanelLayoutModel {
  snapshot(): PanelLayoutSnapshot;
  setViewport(width: number, height: number): void;
  setPreferences(preferences: { coarsePointer?: boolean; reducedMotion?: boolean }): void;
  open(id: PanelId): void;
  close(id: PanelId): void;
  toggle(id: PanelId): void;
  resize(id: PanelId, deltaPx: number): boolean;
  setSize(id: PanelId, sizePx: number): boolean;
  resetSize(id: PanelId): void;
  subscribe(observer: (snapshot: PanelLayoutSnapshot) => void): () => void;
}

interface MutablePanel {
  readonly id: PanelId;
  readonly defaultPx: number;
  readonly minPx: number;
  readonly maxPx: number;
  open: boolean;
  sizePx: number;
}

const COMPACT_MAX = 719;
const MEDIUM_MAX = 1179;
const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 16_384;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeViewport = (value: number | undefined, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(Math.floor(numeric), MIN_VIEWPORT, MAX_VIEWPORT);
};

const workspaceSizeFor = (width: number): WorkspaceSize =>
  width <= COMPACT_MAX ? 'compact' : width <= MEDIUM_MAX ? 'medium' : 'wide';

const createPanel = (id: PanelId, defaultPx: number, minPx: number, maxPx: number, open: boolean): MutablePanel => ({
  id,
  defaultPx,
  minPx,
  maxPx,
  open,
  sizePx: defaultPx,
});

export const createPanelLayoutModel = (options: PanelLayoutModelOptions = {}): PanelLayoutModel => {
  let viewportWidth = normalizeViewport(options.viewportWidth, 1440);
  let viewportHeight = normalizeViewport(options.viewportHeight, 900);
  let coarsePointer = options.coarsePointer === true;
  let reducedMotion = options.reducedMotion === true;
  let revision = 0;
  const observers = new Set<(snapshot: PanelLayoutSnapshot) => void>();
  const panels: Record<PanelId, MutablePanel> = {
    navigation: createPanel('navigation', 320, 260, 480, true),
    tools: createPanel('tools', 360, 280, 560, true),
    details: createPanel('details', 320, 220, 520, false),
  };

  if (workspaceSizeFor(viewportWidth) === 'compact') {
    panels.tools.open = false;
    panels.details.open = false;
  }

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try { reporter(error); } catch (reporterError) { void reporterError; }
  };

  const workspace = (): WorkspaceSize => workspaceSizeFor(viewportWidth);

  const presentationFor = (id: PanelId, open: boolean): PanelPresentation => {
    if (!open) return 'hidden';
    const size = workspace();
    if (size === 'compact') return id === 'details' ? 'bottom-sheet' : 'overlay';
    if (size === 'medium' && id !== 'navigation') return id === 'details' ? 'bottom-sheet' : 'overlay';
    return 'docked';
  };

  const stateFor = (panel: MutablePanel): PanelLayoutState => {
    const presentation = presentationFor(panel.id, panel.open);
    return Object.freeze({
      id: panel.id,
      open: panel.open,
      sizePx: panel.sizePx,
      minPx: panel.minPx,
      maxPx: panel.maxPx,
      presentation,
      resizable: presentation === 'docked',
      separatorOrientation: panel.id === 'details' ? 'horizontal' : 'vertical',
    });
  };

  const buildSnapshot = (): PanelLayoutSnapshot => {
    const navigation = stateFor(panels.navigation);
    const tools = stateFor(panels.tools);
    const details = stateFor(panels.details);
    return Object.freeze({
      workspaceSize: workspace(),
      viewportWidth,
      viewportHeight,
      coarsePointer,
      reducedMotion,
      minimumTargetPx: coarsePointer ? 48 : 44,
      panels: Object.freeze({ navigation, tools, details }),
      mapInset: Object.freeze({
        left: navigation.presentation === 'docked' ? navigation.sizePx : 0,
        right: tools.presentation === 'docked' ? tools.sizePx : 0,
        bottom: details.presentation === 'docked' ? details.sizePx : 0,
      }),
      revision,
    });
  };

  const notify = (): void => {
    revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach((observer) => {
      try { observer(snapshot); } catch (error) { report(error); }
    });
  };

  const panelFor = (id: PanelId): MutablePanel => panels[id];

  const setOpen = (id: PanelId, open: boolean): void => {
    const panel = panelFor(id);
    if (panel.open === open) return;
    if (open && workspace() === 'compact') {
      (Object.values(panels) as MutablePanel[]).forEach((candidate) => {
        if (candidate.id !== id) candidate.open = false;
      });
    }
    panel.open = open;
    notify();
  };

  return {
    snapshot: buildSnapshot,
    setViewport(width, height) {
      const nextWidth = normalizeViewport(width, viewportWidth);
      const nextHeight = normalizeViewport(height, viewportHeight);
      if (nextWidth === viewportWidth && nextHeight === viewportHeight) return;
      viewportWidth = nextWidth;
      viewportHeight = nextHeight;
      if (workspace() === 'compact') {
        const openPanels = (Object.values(panels) as MutablePanel[]).filter((panel) => panel.open);
        openPanels.slice(1).forEach((panel) => { panel.open = false; });
      }
      notify();
    },
    setPreferences(preferences) {
      let changed = false;
      if (preferences.coarsePointer !== undefined && preferences.coarsePointer !== coarsePointer) {
        coarsePointer = preferences.coarsePointer;
        changed = true;
      }
      if (preferences.reducedMotion !== undefined && preferences.reducedMotion !== reducedMotion) {
        reducedMotion = preferences.reducedMotion;
        changed = true;
      }
      if (changed) notify();
    },
    open(id) { setOpen(id, true); },
    close(id) { setOpen(id, false); },
    toggle(id) { setOpen(id, !panelFor(id).open); },
    resize(id, deltaPx) {
      if (!Number.isFinite(deltaPx)) return false;
      const panel = panelFor(id);
      if (presentationFor(id, panel.open) !== 'docked') return false;
      const next = clamp(Math.round(panel.sizePx + deltaPx), panel.minPx, panel.maxPx);
      if (next === panel.sizePx) return false;
      panel.sizePx = next;
      notify();
      return true;
    },
    setSize(id, sizePx) {
      if (!Number.isFinite(sizePx)) return false;
      const panel = panelFor(id);
      const next = clamp(Math.round(sizePx), panel.minPx, panel.maxPx);
      if (next === panel.sizePx) return false;
      panel.sizePx = next;
      notify();
      return true;
    },
    resetSize(id) {
      const panel = panelFor(id);
      if (panel.sizePx === panel.defaultPx) return;
      panel.sizePx = panel.defaultPx;
      notify();
    },
    subscribe(observer) {
      observers.add(observer);
      try { observer(buildSnapshot()); } catch (error) { report(error); }
      return () => observers.delete(observer);
    },
  };
};
