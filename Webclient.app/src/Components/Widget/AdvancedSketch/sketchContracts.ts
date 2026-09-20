export type SketchTool =
  | 'move'
  | 'point'
  | 'polyline'
  | 'freehand'
  | 'polygon'
  | 'circle'
  | 'rectangle'
  | 'clear';

export type PointStyle = 'circle' | 'cross' | 'diamond' | 'square';
export type FillStyle =
  | 'backward-diagonal'
  | 'forward-diagonal'
  | 'cross'
  | 'diagonal-cross'
  | 'horizontal'
  | 'vertical'
  | 'none'
  | 'solid';
export type LineStyle =
  | 'dash'
  | 'dash-dot'
  | 'dot'
  | 'long-dash'
  | 'long-dash-dot'
  | 'long-dash-dot-dot'
  | 'none'
  | 'short-dash'
  | 'short-dash-dot'
  | 'short-dash-dot-dot'
  | 'short-dot'
  | 'solid';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SketchRgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface SketchPointSymbol {
  readonly type: 'simple-marker';
  readonly style: PointStyle;
  readonly color: string;
  readonly size: number;
  readonly outline: SketchLineSymbol;
}

export interface SketchLineSymbol {
  readonly type: 'simple-line';
  readonly style: LineStyle;
  readonly color: string;
  readonly width: number;
}

export interface SketchPolygonSymbol {
  readonly type: 'simple-fill';
  readonly style: FillStyle;
  readonly color: string;
  readonly outline: SketchLineSymbol;
}

export interface SketchStyleState {
  readonly point: SketchPointSymbol;
  readonly line: SketchLineSymbol;
  readonly polygon: SketchPolygonSymbol;
}

export type SketchGeometryType =
  | 'point'
  | 'multipoint'
  | 'polyline'
  | 'polygon'
  | 'extent'
  | 'unknown';

export interface SketchGeometrySnapshot {
  readonly type: SketchGeometryType;
  readonly spatialReferenceWkid: number | null;
  readonly payload: JsonObject;
}

export interface SketchGraphicSnapshot {
  readonly id: string;
  readonly geometry: SketchGeometrySnapshot;
  readonly attributes: JsonObject;
  readonly symbol: JsonObject | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SketchDocument {
  readonly schema: 'kent-rehberi-sketch';
  readonly version: 1;
  readonly exportedAt: string;
  readonly title: string;
  readonly graphics: readonly SketchGraphicSnapshot[];
  readonly style: SketchStyleState;
  readonly metadata: JsonObject;
}

export interface SketchHistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly graphics: readonly SketchGraphicSnapshot[];
}

export interface SketchHistorySnapshot {
  readonly cursor: number;
  readonly size: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly entries: readonly Pick<SketchHistoryEntry, 'id' | 'label' | 'timestamp'>[];
}

export interface SketchHistoryOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface SketchHistoryRuntime {
  readonly record: (label: string, graphics: readonly SketchGraphicSnapshot[]) => SketchHistorySnapshot;
  readonly undo: () => readonly SketchGraphicSnapshot[] | null;
  readonly redo: () => readonly SketchGraphicSnapshot[] | null;
  readonly replace: (label: string, graphics: readonly SketchGraphicSnapshot[]) => SketchHistorySnapshot;
  readonly clear: () => SketchHistorySnapshot;
  readonly current: () => readonly SketchGraphicSnapshot[];
  readonly snapshot: () => SketchHistorySnapshot;
}

export interface SketchDocumentLimits {
  readonly maxGraphics?: number;
  readonly maxAttributesPerGraphic?: number;
  readonly maxStringLength?: number;
  readonly maxPayloadDepth?: number;
  readonly maxPayloadKeys?: number;
  readonly maxDocumentBytes?: number;
}

export interface SketchImportResult {
  readonly document: SketchDocument | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface SketchSessionBudget {
  readonly maxGraphics: number;
  readonly maxHistoryEntries: number;
  readonly maxQueuedOperations: number;
  readonly operationTimeoutMs: number;
}

export interface SketchSessionSnapshot {
  readonly state: 'idle' | 'ready' | 'drawing' | 'updating' | 'disposed' | 'error';
  readonly selectedTool: SketchTool;
  readonly graphicsCount: number;
  readonly queuedOperations: number;
  readonly activeOperation: string | null;
  readonly errors: number;
  readonly lastError: string | null;
  readonly history: SketchHistorySnapshot;
}

export interface SketchAdapterGraphic {
  readonly id: string;
  readonly geometry: unknown;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
  readonly symbol?: unknown;
}

export interface SketchViewAdapter {
  readonly addGraphic: (graphic: SketchGraphicSnapshot) => Promise<void> | void;
  readonly replaceGraphics: (graphics: readonly SketchGraphicSnapshot[]) => Promise<void> | void;
  readonly removeGraphic: (id: string) => Promise<void> | void;
  readonly clearGraphics: () => Promise<void> | void;
  readonly beginCreate: (tool: Exclude<SketchTool, 'move' | 'clear'>, style: SketchStyleState) => Promise<void> | void;
  readonly cancelCreate: () => Promise<void> | void;
  readonly destroy: () => Promise<void> | void;
}

export interface SketchSessionRuntime {
  readonly selectTool: (tool: SketchTool) => Promise<SketchSessionSnapshot>;
  readonly ingestGraphic: (graphic: SketchGraphicSnapshot, label?: string) => Promise<SketchSessionSnapshot>;
  readonly observeGraphic: (graphic: SketchGraphicSnapshot, label?: string) => SketchSessionSnapshot;
  readonly observeGraphics: (graphics: readonly SketchGraphicSnapshot[], label?: string) => SketchSessionSnapshot;
  readonly removeGraphic: (id: string, label?: string) => Promise<SketchSessionSnapshot>;
  readonly clear: (label?: string) => Promise<SketchSessionSnapshot>;
  readonly undo: () => Promise<SketchSessionSnapshot>;
  readonly redo: () => Promise<SketchSessionSnapshot>;
  readonly importDocument: (document: SketchDocument) => Promise<SketchSessionSnapshot>;
  readonly exportDocument: (title?: string) => SketchDocument;
  readonly setStyle: (style: SketchStyleState) => SketchSessionSnapshot;
  readonly snapshot: () => SketchSessionSnapshot;
  readonly dispose: () => Promise<void>;
}

export interface SketchDiagnosticEvent {
  readonly type:
    | 'tool-selected'
    | 'graphic-added'
    | 'graphic-removed'
    | 'graphics-cleared'
    | 'history-undo'
    | 'history-redo'
    | 'document-imported'
    | 'document-exported'
    | 'operation-rejected'
    | 'operation-failed'
    | 'disposed';
  readonly timestamp: number;
  readonly detail: Readonly<Record<string, JsonPrimitive>>;
}

export interface SketchDiagnosticSink {
  readonly emit: (event: SketchDiagnosticEvent) => void;
}

export const SKETCH_TOOLS: readonly SketchTool[] = Object.freeze([
  'move',
  'point',
  'polyline',
  'freehand',
  'polygon',
  'circle',
  'rectangle',
  'clear',
]);

export const DRAWING_TOOLS: readonly Exclude<SketchTool, 'move' | 'clear'>[] = Object.freeze([
  'point',
  'polyline',
  'freehand',
  'polygon',
  'circle',
  'rectangle',
]);

export const isSketchTool = (value: unknown): value is SketchTool =>
  typeof value === 'string' && SKETCH_TOOLS.includes(value as SketchTool);

export const isDrawingTool = (value: unknown): value is Exclude<SketchTool, 'move' | 'clear'> =>
  typeof value === 'string' && DRAWING_TOOLS.includes(value as Exclude<SketchTool, 'move' | 'clear'>);

export const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
