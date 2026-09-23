export type WorkspaceViewport = 'compact' | 'medium' | 'wide';
export type WorkspacePanel = 'navigation' | 'layers' | 'details' | 'tools';
export type WorkspaceSurface = 'map' | 'content';

export interface WorkspaceViewportInput {
  width: number;
  height: number;
  coarsePointer?: boolean;
  reducedMotion?: boolean;
}

export interface WorkspacePanelState {
  id: WorkspacePanel;
  open: boolean;
  overlay: boolean;
  pinned: boolean;
}

export interface WorkspaceSnapshot {
  revision: number;
  viewport: WorkspaceViewport;
  width: number;
  height: number;
  coarsePointer: boolean;
  reducedMotion: boolean;
  activeSurface: WorkspaceSurface;
  panels: readonly WorkspacePanelState[];
  modalPanel: WorkspacePanel | null;
  mapControlsCompact: boolean;
  touchTargetPx: number;
  transitionMs: number;
}

export interface ResponsiveWorkspaceModel {
  snapshot(): WorkspaceSnapshot;
  setViewport(input: WorkspaceViewportInput): void;
  setActiveSurface(surface: WorkspaceSurface): void;
  openPanel(panel: WorkspacePanel): void;
  closePanel(panel: WorkspacePanel): void;
  togglePanel(panel: WorkspacePanel): void;
  pinPanel(panel: WorkspacePanel, pinned: boolean): void;
  closeOverlays(): void;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
}

const PANEL_ORDER: readonly WorkspacePanel[] = ['navigation', 'layers', 'details', 'tools'];
const MIN_WIDTH = 240;
const MAX_WIDTH = 16_384;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 16_384;
const COMPACT_MAX = 719;
const MEDIUM_MAX = 1199;
const MAX_LISTENERS = 64;

const clampDimension = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const classifyViewport = (width: number): WorkspaceViewport => {
  if (width <= COMPACT_MAX) return 'compact';
  if (width <= MEDIUM_MAX) return 'medium';
  return 'wide';
};

const defaultOpen = (panel: WorkspacePanel, viewport: WorkspaceViewport): boolean => {
  if (viewport === 'wide') return panel === 'navigation' || panel === 'layers';
  if (viewport === 'medium') return panel === 'navigation';
  return false;
};

const isOverlay = (panel: WorkspacePanel, viewport: WorkspaceViewport): boolean => {
  if (viewport === 'compact') return true;
  if (viewport === 'medium') return panel !== 'navigation';
  return false;
};

export const createResponsiveWorkspaceModel = (
  initial: WorkspaceViewportInput = { width: 1280, height: 800 },
): ResponsiveWorkspaceModel => {
  let width = clampDimension(initial.width, MIN_WIDTH, MAX_WIDTH);
  let height = clampDimension(initial.height, MIN_HEIGHT, MAX_HEIGHT);
  let viewport = classifyViewport(width);
  let coarsePointer = initial.coarsePointer === true;
  let reducedMotion = initial.reducedMotion === true;
  let activeSurface: WorkspaceSurface = 'map';
  let revision = 0;
  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  const openPanels = new Set<WorkspacePanel>(PANEL_ORDER.filter((panel) => defaultOpen(panel, viewport)));
  const pinnedPanels = new Set<WorkspacePanel>();

  const normalize = (): void => {
    for (const panel of pinnedPanels) {
      if (isOverlay(panel, viewport)) pinnedPanels.delete(panel);
    }

    if (viewport === 'compact') {
      const open = PANEL_ORDER.filter((panel) => openPanels.has(panel));
      for (const panel of open.slice(0, -1)) openPanels.delete(panel);
    }
  };

  const buildSnapshot = (): WorkspaceSnapshot => {
    const panels = PANEL_ORDER.map((id) => Object.freeze({
      id,
      open: openPanels.has(id),
      overlay: isOverlay(id, viewport),
      pinned: pinnedPanels.has(id),
    }));
    const modalPanel = panels.find((panel) => panel.open && panel.overlay)?.id ?? null;
    return Object.freeze({
      revision,
      viewport,
      width,
      height,
      coarsePointer,
      reducedMotion,
      activeSurface,
      panels: Object.freeze(panels),
      modalPanel,
      mapControlsCompact: viewport === 'compact' || height < 600,
      touchTargetPx: coarsePointer || viewport === 'compact' ? 48 : 40,
      transitionMs: reducedMotion ? 0 : 180,
    });
  };

  const publish = (): void => {
    revision += 1;
    const next = buildSnapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // Observer failures must not interrupt workspace state transitions.
      }
    }
  };

  const mutatePanel = (panel: WorkspacePanel, open: boolean): void => {
    const changed = open ? !openPanels.has(panel) : openPanels.has(panel);
    if (!changed) return;
    if (open && viewport === 'compact') {
      for (const candidate of PANEL_ORDER) openPanels.delete(candidate);
    }
    if (open) openPanels.add(panel);
    else openPanels.delete(panel);
    normalize();
    publish();
  };

  normalize();

  return {
    snapshot: buildSnapshot,
    setViewport(input) {
      const nextWidth = clampDimension(input.width, MIN_WIDTH, MAX_WIDTH);
      const nextHeight = clampDimension(input.height, MIN_HEIGHT, MAX_HEIGHT);
      const nextViewport = classifyViewport(nextWidth);
      const nextCoarse = input.coarsePointer === true;
      const nextReduced = input.reducedMotion === true;
      if (
        nextWidth === width
        && nextHeight === height
        && nextCoarse === coarsePointer
        && nextReduced === reducedMotion
      ) return;

      const previousViewport = viewport;
      width = nextWidth;
      height = nextHeight;
      viewport = nextViewport;
      coarsePointer = nextCoarse;
      reducedMotion = nextReduced;

      if (previousViewport !== viewport) {
        if (viewport === 'wide') {
          openPanels.add('navigation');
          openPanels.add('layers');
        } else if (viewport === 'medium') {
          openPanels.add('navigation');
        }
      }
      normalize();
      publish();
    },
    setActiveSurface(surface) {
      if (surface === activeSurface) return;
      activeSurface = surface;
      publish();
    },
    openPanel(panel) {
      mutatePanel(panel, true);
    },
    closePanel(panel) {
      mutatePanel(panel, false);
    },
    togglePanel(panel) {
      mutatePanel(panel, !openPanels.has(panel));
    },
    pinPanel(panel, pinned) {
      if (isOverlay(panel, viewport)) return;
      const changed = pinned ? !pinnedPanels.has(panel) : pinnedPanels.has(panel);
      if (!changed) return;
      if (pinned) {
        pinnedPanels.add(panel);
        openPanels.add(panel);
      } else {
        pinnedPanels.delete(panel);
      }
      publish();
    },
    closeOverlays() {
      const overlays = PANEL_ORDER.filter((panel) => openPanels.has(panel) && isOverlay(panel, viewport));
      if (!overlays.length) return;
      for (const panel of overlays) openPanels.delete(panel);
      publish();
    },
    subscribe(listener) {
      if (listeners.size >= MAX_LISTENERS) throw new Error(`Workspace listener capacity exceeded (${MAX_LISTENERS})`);
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
};
