export const ADVANCED_SKETCH_TOOLS = Object.freeze({
  SELECT: 'select',
  POINT: 'point',
  POLYLINE: 'polyline',
  FREEHAND: 'freehand',
  POLYGON: 'polygon',
  RECTANGLE: 'rectangle',
  CIRCLE: 'circle',
} as const);

export type AdvancedSketchTool = typeof ADVANCED_SKETCH_TOOLS[keyof typeof ADVANCED_SKETCH_TOOLS];
export type AdvancedSketchDrawTool = Exclude<AdvancedSketchTool, 'select'>;
export type PointStyle = 'circle' | 'cross' | 'diamond' | 'square' | 'x';
export type LineStyle =
  | 'solid'
  | 'dash'
  | 'dash-dot'
  | 'dot'
  | 'long-dash'
  | 'long-dash-dot'
  | 'long-dash-dot-dot'
  | 'short-dash'
  | 'short-dash-dot'
  | 'short-dash-dot-dot'
  | 'short-dot'
  | 'none';
export type FillStyle =
  | 'solid'
  | 'backward-diagonal'
  | 'forward-diagonal'
  | 'cross'
  | 'diagonal-cross'
  | 'horizontal'
  | 'vertical'
  | 'none';

export interface AdvancedSketchStyle {
  readonly point: Readonly<{
    color: string;
    size: number;
    style: PointStyle;
    outlineColor: string;
    outlineWidth: number;
  }>;
  readonly line: Readonly<{
    color: string;
    width: number;
    style: LineStyle;
  }>;
  readonly fill: Readonly<{
    color: string;
    opacity: number;
    style: FillStyle;
    outlineColor: string;
    outlineWidth: number;
    outlineStyle: LineStyle;
  }>;
}

export interface AdvancedSketchStylePatch {
  readonly point?: Partial<AdvancedSketchStyle['point']>;
  readonly line?: Partial<AdvancedSketchStyle['line']>;
  readonly fill?: Partial<AdvancedSketchStyle['fill']>;
}

export type AdvancedSketchPhase =
  | 'idle'
  | 'selecting'
  | 'drawing'
  | 'updating'
  | 'error'
  | 'disposed';

export interface AdvancedSketchSnapshot {
  readonly tool: AdvancedSketchTool;
  readonly phase: AdvancedSketchPhase;
  readonly style: AdvancedSketchStyle;
  readonly graphicCount: number;
  readonly selectionCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly message: string;
  readonly error: string | null;
}

export interface RemovableHandle {
  readonly remove?: () => void;
}

export interface GraphicsCollectionLike {
  readonly length?: number;
  readonly items?: readonly unknown[];
  readonly toArray?: () => readonly unknown[];
}

export interface GraphicsLayerLike {
  readonly graphics?: GraphicsCollectionLike;
  readonly removeAll?: () => void;
  readonly destroy?: () => void;
}

export interface SketchViewModelLike {
  pointSymbol?: unknown;
  polylineSymbol?: unknown;
  polygonSymbol?: unknown;
  readonly state?: string;
  readonly updateGraphics?: GraphicsCollectionLike;
  readonly create?: (
    tool: 'point' | 'polyline' | 'polygon' | 'rectangle' | 'circle',
    options?: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly update?: (
    graphics: readonly unknown[] | unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly cancel?: () => unknown;
  readonly undo?: () => unknown;
  readonly redo?: () => unknown;
  readonly delete?: () => unknown;
  readonly canUndo?: () => boolean;
  readonly canRedo?: () => boolean;
  readonly on?: (
    eventName: string,
    callback: (event: unknown) => void,
  ) => RemovableHandle;
  readonly destroy?: () => void;
}

export interface HitTestGraphicResultLike {
  readonly graphic?: {
    readonly layer?: unknown;
    readonly [key: string]: unknown;
  } | null;
}

export interface HitTestResponseLike {
  readonly results?: readonly unknown[];
}

export interface SketchMapViewLike {
  readonly hitTest?: (
    event: unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<HitTestResponseLike> | HitTestResponseLike;
  readonly on?: (
    eventName: string,
    callback: (event: unknown) => void,
  ) => RemovableHandle;
}

export interface AdvancedSketchSessionOptions {
  readonly view: SketchMapViewLike;
  readonly layer: GraphicsLayerLike;
  readonly sketchViewModel: SketchViewModelLike;
  readonly initialTool?: AdvancedSketchTool;
  readonly initialStyle?: AdvancedSketchStyle;
  readonly onChange?: (snapshot: AdvancedSketchSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

export interface AdvancedSketchSession {
  readonly activateTool: (tool: AdvancedSketchTool) => boolean;
  readonly setStyle: (patch: AdvancedSketchStylePatch) => AdvancedSketchStyle;
  readonly clear: () => boolean;
  readonly cancel: () => boolean;
  readonly undo: () => boolean;
  readonly redo: () => boolean;
  readonly deleteSelection: () => boolean;
  readonly selectFromMapEvent: (event: unknown) => Promise<boolean>;
  readonly snapshot: () => AdvancedSketchSnapshot;
  readonly destroy: () => void;
}

const POINT_STYLES = new Set<PointStyle>(['circle', 'cross', 'diamond', 'square', 'x']);
const LINE_STYLES = new Set<LineStyle>([
  'solid',
  'dash',
  'dash-dot',
  'dot',
  'long-dash',
  'long-dash-dot',
  'long-dash-dot-dot',
  'short-dash',
  'short-dash-dot',
  'short-dash-dot-dot',
  'short-dot',
  'none',
]);
const FILL_STYLES = new Set<FillStyle>([
  'solid',
  'backward-diagonal',
  'forward-diagonal',
  'cross',
  'diagonal-cross',
  'horizontal',
  'vertical',
  'none',
]);

export const DEFAULT_ADVANCED_SKETCH_STYLE: AdvancedSketchStyle = Object.freeze({
  point: Object.freeze({
    color: '#f17013',
    size: 12,
    style: 'circle' as PointStyle,
    outlineColor: '#514644',
    outlineWidth: 2,
  }),
  line: Object.freeze({
    color: '#514644',
    width: 3,
    style: 'solid' as LineStyle,
  }),
  fill: Object.freeze({
    color: '#efc8b1',
    opacity: 0.5,
    style: 'solid' as FillStyle,
    outlineColor: '#514644',
    outlineWidth: 3,
    outlineStyle: 'solid' as LineStyle,
  }),
});

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

export const normalizeHexColor = (value: unknown, fallback = '#000000'): string => {
  const normalizedFallback = /^#[0-9a-f]{6}$/iu.test(fallback) ? fallback.toLowerCase() : '#000000';
  if (typeof value !== 'string') return normalizedFallback;
  const trimmed = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/iu.exec(trimmed);
  if (short?.[1]) {
    const expanded = [...short[1]].map((character) => character + character).join('');
    return `#${expanded}`;
  }
  return /^#[0-9a-f]{6}$/iu.test(trimmed) ? trimmed : normalizedFallback;
};

const normalizePointStyle = (value: unknown, fallback: PointStyle): PointStyle =>
  typeof value === 'string' && POINT_STYLES.has(value as PointStyle)
    ? value as PointStyle
    : fallback;

const normalizeLineStyle = (value: unknown, fallback: LineStyle): LineStyle =>
  typeof value === 'string' && LINE_STYLES.has(value as LineStyle)
    ? value as LineStyle
    : fallback;

const normalizeFillStyle = (value: unknown, fallback: FillStyle): FillStyle =>
  typeof value === 'string' && FILL_STYLES.has(value as FillStyle)
    ? value as FillStyle
    : fallback;

export const normalizeAdvancedSketchStyle = (
  value: AdvancedSketchStylePatch | AdvancedSketchStyle | null | undefined,
  base: AdvancedSketchStyle = DEFAULT_ADVANCED_SKETCH_STYLE,
): AdvancedSketchStyle => {
  const point = value?.point ?? {};
  const line = value?.line ?? {};
  const fill = value?.fill ?? {};
  return Object.freeze({
    point: Object.freeze({
      color: normalizeHexColor(point.color, base.point.color),
      size: clamp(point.size, 4, 64, base.point.size),
      style: normalizePointStyle(point.style, base.point.style),
      outlineColor: normalizeHexColor(point.outlineColor, base.point.outlineColor),
      outlineWidth: clamp(point.outlineWidth, 0, 12, base.point.outlineWidth),
    }),
    line: Object.freeze({
      color: normalizeHexColor(line.color, base.line.color),
      width: clamp(line.width, 1, 16, base.line.width),
      style: normalizeLineStyle(line.style, base.line.style),
    }),
    fill: Object.freeze({
      color: normalizeHexColor(fill.color, base.fill.color),
      opacity: clamp(fill.opacity, 0, 1, base.fill.opacity),
      style: normalizeFillStyle(fill.style, base.fill.style),
      outlineColor: normalizeHexColor(fill.outlineColor, base.fill.outlineColor),
      outlineWidth: clamp(fill.outlineWidth, 0, 16, base.fill.outlineWidth),
      outlineStyle: normalizeLineStyle(fill.outlineStyle, base.fill.outlineStyle),
    }),
  });
};

const hexToRgba = (hex: string, alpha: number): readonly [number, number, number, number] => {
  const normalized = normalizeHexColor(hex);
  return Object.freeze([
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
    clamp(alpha, 0, 1, 1),
  ]) as readonly [number, number, number, number];
};

export const buildPointSymbol = (style: AdvancedSketchStyle): Readonly<Record<string, unknown>> =>
  Object.freeze({
    type: 'simple-marker',
    color: style.point.color,
    size: style.point.size,
    style: style.point.style,
    outline: Object.freeze({
      color: style.point.outlineColor,
      width: style.point.outlineWidth,
    }),
  });

export const buildLineSymbol = (style: AdvancedSketchStyle): Readonly<Record<string, unknown>> =>
  Object.freeze({
    type: 'simple-line',
    color: style.line.color,
    width: style.line.width,
    style: style.line.style,
  });

export const buildPolygonSymbol = (style: AdvancedSketchStyle): Readonly<Record<string, unknown>> =>
  Object.freeze({
    type: 'simple-fill',
    color: hexToRgba(style.fill.color, style.fill.opacity),
    style: style.fill.style,
    outline: Object.freeze({
      color: style.fill.outlineColor,
      width: style.fill.outlineWidth,
      style: style.fill.outlineStyle,
    }),
  });

const graphicCount = (collection: GraphicsCollectionLike | undefined): number => {
  if (typeof collection?.length === 'number' && Number.isFinite(collection.length)) {
    return Math.max(0, Math.trunc(collection.length));
  }
  if (Array.isArray(collection?.items)) return collection.items.length;
  if (typeof collection?.toArray === 'function') return collection.toArray().length;
  return 0;
};

const createRequest = (
  tool: AdvancedSketchDrawTool,
): Readonly<{
  tool: 'point' | 'polyline' | 'polygon' | 'rectangle' | 'circle';
  options: Readonly<Record<string, unknown>>;
}> => {
  if (tool === 'freehand') {
    return Object.freeze({
      tool: 'polyline',
      options: Object.freeze({ mode: 'freehand' }),
    });
  }
  return Object.freeze({
    tool,
    options: Object.freeze({ mode: 'click' }),
  });
};

const readHitGraphic = (
  response: HitTestResponseLike,
  layer: GraphicsLayerLike,
): unknown | null => {
  const results = Array.isArray(response.results) ? response.results : [];
  for (const result of results) {
    if (!result || typeof result !== 'object' || !('graphic' in result)) continue;
    const graphic = (result as HitTestGraphicResultLike).graphic;
    if (graphic?.layer === layer) return graphic;
  }
  return null;
};

const eventState = (event: unknown): string => {
  if (!event || typeof event !== 'object' || !('state' in event)) return '';
  const state = (event as { readonly state?: unknown }).state;
  return typeof state === 'string' ? state : '';
};

export const createAdvancedSketchSession = (
  options: AdvancedSketchSessionOptions,
): AdvancedSketchSession => {
  let disposed = false;
  let tool = options.initialTool ?? ADVANCED_SKETCH_TOOLS.SELECT;
  let style = normalizeAdvancedSketchStyle(options.initialStyle);
  let phase: AdvancedSketchPhase = tool === ADVANCED_SKETCH_TOOLS.SELECT ? 'selecting' : 'idle';
  let message = 'Çizim aracı hazır.';
  let errorMessage: string | null = null;
  const handles = new Set<RemovableHandle>();
  const { view, layer, sketchViewModel } = options;

  const reportError = (error: unknown, fallback: string): void => {
    errorMessage = error instanceof Error && error.message.trim()
      ? error.message
      : fallback;
    phase = 'error';
    options.onError?.(error);
  };

  const applySymbols = (): void => {
    sketchViewModel.pointSymbol = buildPointSymbol(style);
    sketchViewModel.polylineSymbol = buildLineSymbol(style);
    sketchViewModel.polygonSymbol = buildPolygonSymbol(style);
  };

  const currentSnapshot = (): AdvancedSketchSnapshot => Object.freeze({
    tool,
    phase,
    style,
    graphicCount: graphicCount(layer.graphics),
    selectionCount: graphicCount(sketchViewModel.updateGraphics),
    canUndo: Boolean(sketchViewModel.canUndo?.()),
    canRedo: Boolean(sketchViewModel.canRedo?.()),
    message,
    error: errorMessage,
  });

  const emit = (): void => {
    if (!disposed) options.onChange?.(currentSnapshot());
  };

  const safely = (operation: () => unknown, fallback: string): boolean => {
    if (disposed) return false;
    try {
      operation();
      errorMessage = null;
      emit();
      return true;
    } catch (error) {
      reportError(error, fallback);
      emit();
      return false;
    }
  };

  const onCreate = (event: unknown): void => {
    if (disposed) return;
    const state = eventState(event);
    if (state === 'start' || state === 'active') {
      phase = 'drawing';
      message = 'Çizim devam ediyor.';
    } else if (state === 'complete') {
      phase = tool === ADVANCED_SKETCH_TOOLS.SELECT ? 'selecting' : 'idle';
      message = 'Çizim haritaya eklendi.';
    } else if (state === 'cancel') {
      phase = tool === ADVANCED_SKETCH_TOOLS.SELECT ? 'selecting' : 'idle';
      message = 'Çizim iptal edildi.';
    }
    emit();
  };

  const onUpdate = (event: unknown): void => {
    if (disposed) return;
    const state = eventState(event);
    if (state === 'start' || state === 'active') {
      phase = 'updating';
      message = 'Seçili çizim düzenleniyor.';
    } else if (state === 'complete') {
      phase = 'selecting';
      message = 'Çizim güncellendi.';
    } else if (state === 'cancel') {
      phase = 'selecting';
      message = 'Düzenleme iptal edildi.';
    }
    emit();
  };

  const createHandle = sketchViewModel.on?.('create', onCreate);
  if (createHandle) handles.add(createHandle);
  const updateHandle = sketchViewModel.on?.('update', onUpdate);
  if (updateHandle) handles.add(updateHandle);
  const clickHandle = view.on?.('click', (event: unknown) => {
    if (tool === ADVANCED_SKETCH_TOOLS.SELECT) {
      void session.selectFromMapEvent(event);
    }
  });
  if (clickHandle) handles.add(clickHandle);

  applySymbols();

  const session: AdvancedSketchSession = {
    activateTool: (nextTool) => {
      if (disposed) return false;
      if (!Object.values(ADVANCED_SKETCH_TOOLS).includes(nextTool)) return false;
      tool = nextTool;
      errorMessage = null;

      if (nextTool === ADVANCED_SKETCH_TOOLS.SELECT) {
        return safely(() => {
          sketchViewModel.cancel?.();
          phase = 'selecting';
          message = 'Haritadaki bir çizimi seçebilirsiniz.';
        }, 'Seçim aracına geçilemedi.');
      }

      return safely(() => {
        sketchViewModel.cancel?.();
        applySymbols();
        const request = createRequest(nextTool);
        sketchViewModel.create?.(request.tool, request.options);
        phase = 'drawing';
        message = nextTool === ADVANCED_SKETCH_TOOLS.FREEHAND
          ? 'Serbest çizim başladı.'
          : 'Çizim başladı.';
      }, 'Çizim aracı başlatılamadı.');
    },

    setStyle: (patch) => {
      if (disposed) return style;
      style = normalizeAdvancedSketchStyle({
        point: { ...style.point, ...patch.point },
        line: { ...style.line, ...patch.line },
        fill: { ...style.fill, ...patch.fill },
      }, style);
      safely(() => {
        applySymbols();
        message = 'Çizim stili güncellendi.';
      }, 'Çizim stili uygulanamadı.');
      return style;
    },

    clear: () => safely(() => {
      sketchViewModel.cancel?.();
      layer.removeAll?.();
      phase = tool === ADVANCED_SKETCH_TOOLS.SELECT ? 'selecting' : 'idle';
      message = 'Tüm kullanıcı çizimleri temizlendi.';
    }, 'Çizimler temizlenemedi.'),

    cancel: () => safely(() => {
      sketchViewModel.cancel?.();
      phase = tool === ADVANCED_SKETCH_TOOLS.SELECT ? 'selecting' : 'idle';
      message = 'Etkin çizim işlemi iptal edildi.';
    }, 'Çizim işlemi iptal edilemedi.'),

    undo: () => {
      if (!sketchViewModel.canUndo?.()) return false;
      return safely(() => {
        sketchViewModel.undo?.();
        message = 'Son çizim adımı geri alındı.';
      }, 'Geri alma işlemi tamamlanamadı.');
    },

    redo: () => {
      if (!sketchViewModel.canRedo?.()) return false;
      return safely(() => {
        sketchViewModel.redo?.();
        message = 'Çizim adımı yeniden uygulandı.';
      }, 'Yineleme işlemi tamamlanamadı.');
    },

    deleteSelection: () => {
      if (graphicCount(sketchViewModel.updateGraphics) === 0) return false;
      return safely(() => {
        sketchViewModel.delete?.();
        phase = 'selecting';
        message = 'Seçili çizim silindi.';
      }, 'Seçili çizim silinemedi.');
    },

    selectFromMapEvent: async (event) => {
      if (
        disposed
        || tool !== ADVANCED_SKETCH_TOOLS.SELECT
        || typeof view.hitTest !== 'function'
        || typeof sketchViewModel.update !== 'function'
      ) return false;

      try {
        const response = await view.hitTest(event, { include: layer });
        if (disposed || tool !== ADVANCED_SKETCH_TOOLS.SELECT) return false;
        const graphic = readHitGraphic(response, layer);
        if (!graphic) {
          phase = 'selecting';
          message = 'Bu konumda kullanıcı çizimi bulunamadı.';
          errorMessage = null;
          emit();
          return false;
        }
        sketchViewModel.cancel?.();
        sketchViewModel.update([graphic], { tool: 'transform', enableRotation: true });
        phase = 'updating';
        message = 'Çizim seçildi; taşıyabilir, döndürebilir veya yeniden boyutlandırabilirsiniz.';
        errorMessage = null;
        emit();
        return true;
      } catch (error) {
        reportError(error, 'Çizim seçilemedi.');
        emit();
        return false;
      }
    },

    snapshot: currentSnapshot,

    destroy: () => {
      if (disposed) return;
      disposed = true;
      for (const handle of handles) {
        try {
          handle.remove?.();
        } catch (error) {
          options.onError?.(error);
        }
      }
      handles.clear();
      try {
        sketchViewModel.cancel?.();
      } catch (error) {
        options.onError?.(error);
      }
      try {
        sketchViewModel.destroy?.();
      } catch (error) {
        options.onError?.(error);
      }
      phase = 'disposed';
      message = 'Çizim oturumu kapatıldı.';
      errorMessage = null;
    },
  };

  emit();
  return session;
};
