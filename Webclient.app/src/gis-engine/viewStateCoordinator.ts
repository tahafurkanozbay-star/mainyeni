export type GisViewMode = '2d' | '3d';

export type GisCamera2D = Readonly<{
  center: readonly [number, number];
  scale: number;
  rotation: number;
  spatialReferenceWkid?: number;
}>;

export type GisCamera3D = Readonly<{
  position: readonly [number, number, number];
  heading: number;
  tilt: number;
  spatialReferenceWkid?: number;
}>;

export type GisSelectionState = Readonly<{
  layerId: string;
  objectIds: readonly (string | number)[];
}>;

export type GisViewState = Readonly<{
  revision: number;
  mode: GisViewMode;
  camera2d: GisCamera2D | null;
  camera3d: GisCamera3D | null;
  selection: GisSelectionState | null;
  visibleLayerIds: readonly string[];
  activeTool: string | null;
}>;

export type ViewStateListener = (state: GisViewState, reason: string) => void;

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const stableIds = (values: readonly unknown[]): readonly string[] => Object.freeze(
  [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].sort(),
);

const cloneState = (state: GisViewState): GisViewState => Object.freeze({
  ...state,
  visibleLayerIds: Object.freeze([...state.visibleLayerIds]),
  selection: state.selection
    ? Object.freeze({ ...state.selection, objectIds: Object.freeze([...state.selection.objectIds]) })
    : null,
});

export const createViewStateCoordinator = (initial: Partial<GisViewState> = {}) => {
  const listeners = new Set<ViewStateListener>();
  let destroyed = false;
  let state: GisViewState = cloneState({
    revision: 0,
    mode: initial.mode === '3d' ? '3d' : '2d',
    camera2d: initial.camera2d ?? null,
    camera3d: initial.camera3d ?? null,
    selection: initial.selection ?? null,
    visibleLayerIds: stableIds(initial.visibleLayerIds ?? []),
    activeTool: initial.activeTool ? String(initial.activeTool) : null,
  });

  const assertActive = () => {
    if (destroyed) throw new Error('GIS view state coordinator is destroyed.');
  };

  const publish = (next: Omit<GisViewState, 'revision'>, reason: string): GisViewState => {
    assertActive();
    state = cloneState({ ...next, revision: state.revision + 1 });
    [...listeners].forEach((listener) => listener(state, reason));
    return state;
  };

  return Object.freeze({
    snapshot(): GisViewState {
      return state;
    },
    subscribe(listener: ViewStateListener): () => void {
      assertActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(mode: GisViewMode): GisViewState {
      if (mode === state.mode) return state;
      return publish({ ...state, mode }, 'mode');
    },
    set2DCamera(camera: GisCamera2D): GisViewState {
      const center: readonly [number, number] = [finite(camera.center[0]), finite(camera.center[1])];
      const normalized = Object.freeze({
        center,
        scale: Math.max(1, finite(camera.scale, 1)),
        rotation: finite(camera.rotation),
        ...(camera.spatialReferenceWkid === undefined ? {} : { spatialReferenceWkid: camera.spatialReferenceWkid }),
      });
      return publish({ ...state, camera2d: normalized }, 'camera-2d');
    },
    set3DCamera(camera: GisCamera3D): GisViewState {
      const position: readonly [number, number, number] = [
        finite(camera.position[0]), finite(camera.position[1]), finite(camera.position[2]),
      ];
      const normalized = Object.freeze({
        position,
        heading: finite(camera.heading),
        tilt: Math.max(0, Math.min(180, finite(camera.tilt))),
        ...(camera.spatialReferenceWkid === undefined ? {} : { spatialReferenceWkid: camera.spatialReferenceWkid }),
      });
      return publish({ ...state, camera3d: normalized }, 'camera-3d');
    },
    setSelection(selection: GisSelectionState | null): GisViewState {
      const normalized = selection
        ? Object.freeze({
          layerId: String(selection.layerId).trim(),
          objectIds: Object.freeze([...new Set(selection.objectIds)]),
        })
        : null;
      return publish({ ...state, selection: normalized }, 'selection');
    },
    setVisibleLayers(layerIds: readonly unknown[]): GisViewState {
      const visibleLayerIds = stableIds(layerIds);
      if (visibleLayerIds.join('\u0000') === state.visibleLayerIds.join('\u0000')) return state;
      return publish({ ...state, visibleLayerIds }, 'visible-layers');
    },
    setActiveTool(tool: string | null): GisViewState {
      const activeTool = tool ? String(tool).trim() || null : null;
      if (activeTool === state.activeTool) return state;
      return publish({ ...state, activeTool }, 'active-tool');
    },
    destroy(): void {
      destroyed = true;
      listeners.clear();
    },
  });
};
