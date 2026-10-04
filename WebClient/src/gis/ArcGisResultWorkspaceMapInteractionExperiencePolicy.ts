import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type MapInteractionTool =
  | 'explore'
  | 'select'
  | 'identify'
  | 'measure-distance'
  | 'measure-area'
  | 'locate'
  | 'fullscreen';

export type MapInteractionDirection = 'north' | 'south' | 'east' | 'west';
export type MapInteractionZoom = 'in' | 'out';
export type MapInteractionAnnouncementTone = 'polite' | 'assertive';

export interface MapInteractionEnvironment {
  readonly scopeId?: string;
  readonly mapReady?: boolean;
  readonly mapError?: string | null;
  readonly availableTools?: readonly MapInteractionTool[];
  readonly activeTool?: MapInteractionTool | null;
  readonly zoomLevel?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly bearing?: number;
  readonly pitch?: number;
  readonly canLocate?: boolean;
  readonly fullscreen?: boolean;
  readonly interactionLocked?: boolean;
}

export interface MapInteractionToolContract {
  readonly id: string;
  readonly tool: MapInteractionTool;
  readonly label: string;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly tabIndex: 0 | -1;
  readonly minimumTargetSize: 44 | 48;
}

export interface MapInteractionContract {
  readonly scopeId: string;
  readonly toolbarId: string;
  readonly instructionsId: string;
  readonly statusId: string;
  readonly mapFocusId: string;
  readonly role: 'toolbar';
  readonly label: string;
  readonly instructions: string;
  readonly statusMessage: string;
  readonly statusLive: MapInteractionAnnouncementTone;
  readonly busy: boolean;
  readonly tools: readonly MapInteractionToolContract[];
  readonly activeTool: MapInteractionTool | null;
  readonly rovingTool: MapInteractionTool | null;
  readonly zoomLevel: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bearing: number;
  readonly pitch: number;
  readonly fullscreen: boolean;
  readonly interactionLocked: boolean;
  readonly focusVisible: boolean;
  readonly minimumTargetSize: 44 | 48;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly revision: number;
}

export interface MapInteractionKeyEvent {
  readonly key: string;
  readonly editable?: boolean;
  readonly composing?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export type MapInteractionAction =
  | 'none'
  | 'focus-tool'
  | 'activate-tool'
  | 'focus-map'
  | 'pan-map'
  | 'zoom-map'
  | 'reset-orientation';

export interface MapInteractionKeyResolution {
  readonly handled: boolean;
  readonly preventDefault: boolean;
  readonly action: MapInteractionAction;
  readonly tool: MapInteractionTool | null;
  readonly direction: MapInteractionDirection | null;
  readonly zoom: MapInteractionZoom | null;
  readonly focusTarget: string | null;
}

const MAX_TEXT = 180;
const DEFAULT_SCOPE = 'result-map-interaction';
const DEFAULT_MIN_ZOOM = 0;
const DEFAULT_MAX_ZOOM = 24;
const TOOL_ORDER: readonly MapInteractionTool[] = Object.freeze([
  'explore',
  'select',
  'identify',
  'measure-distance',
  'measure-area',
  'locate',
  'fullscreen',
]);
const TOOL_LABELS: Readonly<Record<MapInteractionTool, string>> = Object.freeze({
  explore: 'Haritayı keşfet',
  select: 'Haritadan sonuç seç',
  identify: 'Harita öğesini tanımla',
  'measure-distance': 'Mesafe ölç',
  'measure-area': 'Alan ölç',
  locate: 'Konumuma git',
  fullscreen: 'Tam ekran harita',
});
const EXCLUSIVE_TOOLS = new Set<MapInteractionTool>([
  'explore',
  'select',
  'identify',
  'measure-distance',
  'measure-area',
]);

const boundedText = (value: unknown, max = MAX_TEXT): string => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const sanitizeId = (value: unknown, fallback: string): string => boundedText(value, 64)
  .toLocaleLowerCase('tr-TR')
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || fallback;

const finite = (value: unknown, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeBearing = (value: unknown): number => {
  const bearing = finite(value, 0) % 360;
  return bearing < 0 ? bearing + 360 : bearing;
};

const normalizePitch = (value: unknown): number => clamp(finite(value, 0), 0, 85);

const normalizeTools = (values: readonly MapInteractionTool[] | undefined): readonly MapInteractionTool[] => {
  const admitted = new Set(values ?? TOOL_ORDER);
  return Object.freeze(TOOL_ORDER.filter((tool) => admitted.has(tool)));
};

const toolId = (scopeId: string, tool: MapInteractionTool): string => `${scopeId}-tool-${tool}`;

const disabledFor = (
  tool: MapInteractionTool,
  snapshot: ResultWorkspaceSnapshot,
  environment: MapInteractionEnvironment,
  mapReady: boolean,
): boolean => {
  if (!mapReady || environment.interactionLocked) return true;
  if (tool === 'locate' && environment.canLocate === false) return true;
  if (tool === 'select' && snapshot.interaction.resultIds.length === 0) return true;
  return false;
};

const firstEnabledTool = (tools: readonly MapInteractionToolContract[]): MapInteractionTool | null =>
  tools.find((tool) => !tool.disabled)?.tool ?? null;

const statusFor = (
  mapReady: boolean,
  mapError: string,
  locked: boolean,
  activeTool: MapInteractionTool | null,
  zoomLevel: number,
): { readonly message: string; readonly live: MapInteractionAnnouncementTone; readonly busy: boolean } => {
  if (mapError) return { message: mapError, live: 'assertive', busy: false };
  if (!mapReady) return { message: 'Harita etkileşimleri hazırlanıyor.', live: 'polite', busy: true };
  if (locked) return { message: 'Harita etkileşimleri geçici olarak kilitli.', live: 'polite', busy: false };
  const toolLabel = activeTool ? TOOL_LABELS[activeTool] : 'Araç seçilmedi';
  return { message: `${toolLabel}. Yakınlaştırma düzeyi ${zoomLevel.toFixed(1)}.`, live: 'polite', busy: false };
};

const instructionsFor = (snapshot: ResultWorkspaceSnapshot, locked: boolean): string => {
  if (locked) return 'Harita işlemi tamamlanana kadar araçlar kullanılamaz.';
  if (snapshot.presentation.viewport === 'phone') {
    return 'Araçlar arasında ok tuşlarıyla ilerleyin. Enter ile aracı çalıştırın, Escape ile haritaya dönün.';
  }
  return 'Araçlar arasında ok tuşlarıyla ilerleyin. Harita odaktayken ok tuşları kaydırır, artı ve eksi yakınlaştırır.';
};

const contractChanged = (
  previous: MapInteractionContract | null,
  nextTools: readonly MapInteractionToolContract[],
  statusMessage: string,
  activeTool: MapInteractionTool | null,
  rovingTool: MapInteractionTool | null,
  zoomLevel: number,
  bearing: number,
  pitch: number,
  fullscreen: boolean,
  locked: boolean,
): boolean => {
  if (!previous) return true;
  if (previous.statusMessage !== statusMessage || previous.activeTool !== activeTool || previous.rovingTool !== rovingTool) return true;
  if (previous.zoomLevel !== zoomLevel || previous.bearing !== bearing || previous.pitch !== pitch) return true;
  if (previous.fullscreen !== fullscreen || previous.interactionLocked !== locked) return true;
  if (previous.tools.length !== nextTools.length) return true;
  return previous.tools.some((tool, index) => {
    const next = nextTools[index];
    return !next || next.tool !== tool.tool || next.disabled !== tool.disabled || next.pressed !== tool.pressed;
  });
};

export const createArcGisResultWorkspaceMapInteractionContract = (
  snapshot: ResultWorkspaceSnapshot,
  environment: MapInteractionEnvironment = {},
  previous: MapInteractionContract | null = null,
): MapInteractionContract => {
  const scopeId = sanitizeId(environment.scopeId, DEFAULT_SCOPE);
  const mapError = boundedText(environment.mapError);
  const mapReady = environment.mapReady !== false && !mapError;
  const locked = Boolean(environment.interactionLocked);
  const minZoom = clamp(finite(environment.minZoom, DEFAULT_MIN_ZOOM), 0, DEFAULT_MAX_ZOOM);
  const maxZoom = clamp(finite(environment.maxZoom, DEFAULT_MAX_ZOOM), minZoom, DEFAULT_MAX_ZOOM);
  const zoomLevel = clamp(finite(environment.zoomLevel, minZoom), minZoom, maxZoom);
  const bearing = normalizeBearing(environment.bearing);
  const pitch = normalizePitch(environment.pitch);
  const available = normalizeTools(environment.availableTools);
  const requestedActive = environment.activeTool ?? previous?.activeTool ?? 'explore';
  const activeTool = available.includes(requestedActive) && EXCLUSIVE_TOOLS.has(requestedActive) ? requestedActive : null;
  const provisional = available.map((tool): MapInteractionToolContract => Object.freeze({
    id: toolId(scopeId, tool),
    tool,
    label: TOOL_LABELS[tool],
    pressed: tool === activeTool || (tool === 'fullscreen' && Boolean(environment.fullscreen)),
    disabled: disabledFor(tool, snapshot, environment, mapReady),
    tabIndex: -1,
    minimumTargetSize: snapshot.accessibility.minimumTargetSize,
  }));
  const previousRoving = previous?.rovingTool ?? null;
  const rovingStillEnabled = previousRoving && provisional.some((tool) => tool.tool === previousRoving && !tool.disabled)
    ? previousRoving
    : null;
  const activeEnabled = activeTool && provisional.some((tool) => tool.tool === activeTool && !tool.disabled) ? activeTool : null;
  const rovingTool = rovingStillEnabled ?? activeEnabled ?? firstEnabledTool(provisional);
  const tools = Object.freeze(provisional.map((tool) => Object.freeze({
    ...tool,
    tabIndex: tool.tool === rovingTool ? 0 as const : -1 as const,
  })));
  const status = statusFor(mapReady, mapError, locked, activeTool, zoomLevel);
  const changed = contractChanged(previous, tools, status.message, activeTool, rovingTool, zoomLevel, bearing, pitch, Boolean(environment.fullscreen), locked);
  const revision = changed ? (previous?.revision ?? -1) + 1 : (previous?.revision ?? 0);
  return Object.freeze({
    scopeId,
    toolbarId: `${scopeId}-toolbar`,
    instructionsId: `${scopeId}-instructions`,
    statusId: `${scopeId}-status`,
    mapFocusId: `${scopeId}-map`,
    role: 'toolbar',
    label: 'Harita etkileşim araçları',
    instructions: boundedText(instructionsFor(snapshot, locked)),
    statusMessage: boundedText(status.message),
    statusLive: status.live,
    busy: status.busy,
    tools,
    activeTool,
    rovingTool,
    zoomLevel,
    minZoom,
    maxZoom,
    bearing,
    pitch,
    fullscreen: Boolean(environment.fullscreen),
    interactionLocked: locked,
    focusVisible: snapshot.modality === 'keyboard',
    minimumTargetSize: snapshot.accessibility.minimumTargetSize,
    reducedMotion: snapshot.accessibility.motionDurationMs === 0,
    forcedColors: snapshot.accessibility.forcedColors,
    revision,
  });
};

const noneResolution = (): MapInteractionKeyResolution => Object.freeze({
  handled: false,
  preventDefault: false,
  action: 'none',
  tool: null,
  direction: null,
  zoom: null,
  focusTarget: null,
});

const ignoredContext = (event: MapInteractionKeyEvent): boolean => Boolean(
  event.editable || event.composing || event.repeat || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey,
);

const enabledTools = (contract: MapInteractionContract): readonly MapInteractionToolContract[] =>
  contract.tools.filter((tool) => !tool.disabled);

const moveTool = (
  contract: MapInteractionContract,
  delta: -1 | 1,
  boundary: 'none' | 'start' | 'end' = 'none',
): MapInteractionToolContract | null => {
  const tools = enabledTools(contract);
  if (tools.length === 0) return null;
  if (boundary === 'start') return tools[0] ?? null;
  if (boundary === 'end') return tools[tools.length - 1] ?? null;
  const index = tools.findIndex((tool) => tool.tool === contract.rovingTool);
  const base = index >= 0 ? index : 0;
  return tools[(base + delta + tools.length) % tools.length] ?? null;
};

const focusToolResolution = (tool: MapInteractionToolContract | null): MapInteractionKeyResolution => tool
  ? Object.freeze({ handled: true, preventDefault: true, action: 'focus-tool', tool: tool.tool, direction: null, zoom: null, focusTarget: tool.id })
  : noneResolution();

export const resolveArcGisResultWorkspaceMapToolbarKey = (
  contract: MapInteractionContract,
  event: MapInteractionKeyEvent,
): MapInteractionKeyResolution => {
  if (ignoredContext(event) || contract.interactionLocked) return noneResolution();
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return focusToolResolution(moveTool(contract, 1));
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return focusToolResolution(moveTool(contract, -1));
  if (event.key === 'Home') return focusToolResolution(moveTool(contract, 1, 'start'));
  if (event.key === 'End') return focusToolResolution(moveTool(contract, 1, 'end'));
  if (event.key === 'Escape') return Object.freeze({ handled: true, preventDefault: true, action: 'focus-map', tool: null, direction: null, zoom: null, focusTarget: contract.mapFocusId });
  if (event.key === 'Enter' || event.key === ' ') {
    const tool = contract.tools.find((candidate) => candidate.tool === contract.rovingTool && !candidate.disabled) ?? null;
    return tool ? Object.freeze({ handled: true, preventDefault: true, action: 'activate-tool', tool: tool.tool, direction: null, zoom: null, focusTarget: tool.id }) : noneResolution();
  }
  return noneResolution();
};

const panDirection = (key: string): MapInteractionDirection | null => {
  if (key === 'ArrowUp') return 'north';
  if (key === 'ArrowDown') return 'south';
  if (key === 'ArrowLeft') return 'west';
  if (key === 'ArrowRight') return 'east';
  return null;
};

export const resolveArcGisResultWorkspaceMapSurfaceKey = (
  contract: MapInteractionContract,
  event: MapInteractionKeyEvent,
): MapInteractionKeyResolution => {
  if (ignoredContext(event) || contract.interactionLocked || contract.busy) return noneResolution();
  const direction = panDirection(event.key);
  if (direction) return Object.freeze({ handled: true, preventDefault: true, action: 'pan-map', tool: null, direction, zoom: null, focusTarget: contract.mapFocusId });
  if (event.key === '+' || event.key === '=') {
    if (contract.zoomLevel >= contract.maxZoom) return noneResolution();
    return Object.freeze({ handled: true, preventDefault: true, action: 'zoom-map', tool: null, direction: null, zoom: 'in', focusTarget: contract.mapFocusId });
  }
  if (event.key === '-' || event.key === '_') {
    if (contract.zoomLevel <= contract.minZoom) return noneResolution();
    return Object.freeze({ handled: true, preventDefault: true, action: 'zoom-map', tool: null, direction: null, zoom: 'out', focusTarget: contract.mapFocusId });
  }
  if (event.key === '0' && !event.shiftKey) return Object.freeze({ handled: true, preventDefault: true, action: 'reset-orientation', tool: null, direction: null, zoom: null, focusTarget: contract.mapFocusId });
  return noneResolution();
};
