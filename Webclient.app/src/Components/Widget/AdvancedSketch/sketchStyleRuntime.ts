import type {
  FillStyle,
  LineStyle,
  PointStyle,
  SketchLineSymbol,
  SketchPointSymbol,
  SketchPolygonSymbol,
  SketchRgbaColor,
  SketchStyleState,
} from './sketchContracts';

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const POINT_STYLES = new Set<PointStyle>(['circle', 'cross', 'diamond', 'square']);
const FILL_STYLES = new Set<FillStyle>([
  'backward-diagonal',
  'forward-diagonal',
  'cross',
  'diagonal-cross',
  'horizontal',
  'vertical',
  'none',
  'solid',
]);
const LINE_STYLES = new Set<LineStyle>([
  'dash',
  'dash-dot',
  'dot',
  'long-dash',
  'long-dash-dot',
  'long-dash-dot-dot',
  'none',
  'short-dash',
  'short-dash-dot',
  'short-dash-dot-dot',
  'short-dot',
  'solid',
]);

export const DEFAULT_SKETCH_STYLE: SketchStyleState = Object.freeze({
  point: Object.freeze({
    type: 'simple-marker',
    style: 'circle',
    color: '#f17013',
    size: 10,
    outline: Object.freeze({
      type: 'simple-line',
      style: 'solid',
      color: '#514644',
      width: 2,
    }),
  }),
  line: Object.freeze({
    type: 'simple-line',
    style: 'solid',
    color: '#828282',
    width: 2,
  }),
  polygon: Object.freeze({
    type: 'simple-fill',
    style: 'cross',
    color: '#efc8b1',
    outline: Object.freeze({
      type: 'simple-line',
      style: 'solid',
      color: '#514644',
      width: 3,
    }),
  }),
});

const clampByte = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(255, Math.max(0, Math.round(numeric)));
};

const clampAlpha = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
};

const byteToHex = (value: number): string => value.toString(16).padStart(2, '0');

export const rgbaToHex = (color: Partial<SketchRgbaColor>): string =>
  `#${byteToHex(clampByte(color.r))}${byteToHex(clampByte(color.g))}${byteToHex(clampByte(color.b))}`;

export const normalizeHexColor = (value: unknown, fallback = '#000000'): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (HEX_COLOR.test(normalized)) return normalized;
  if (/^#[0-9a-f]{3}$/iu.test(normalized)) {
    const [r, g, b] = normalized.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
};

export const normalizeRgba = (value: unknown): SketchRgbaColor => {
  if (!value || typeof value !== 'object') return Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
  const record = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    r: clampByte(record.r),
    g: clampByte(record.g),
    b: clampByte(record.b),
    a: clampAlpha(record.a),
  });
};

export const normalizeLineWidth = (value: unknown, fallback = 2): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(20, Math.max(0.5, Math.round(numeric * 2) / 2));
};

export const normalizePointSize = (value: unknown, fallback = 10): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(64, Math.max(4, Math.round(numeric)));
};

export const normalizePointStyle = (value: unknown, fallback: PointStyle = 'circle'): PointStyle =>
  typeof value === 'string' && POINT_STYLES.has(value as PointStyle) ? value as PointStyle : fallback;

export const normalizeFillStyle = (value: unknown, fallback: FillStyle = 'solid'): FillStyle =>
  typeof value === 'string' && FILL_STYLES.has(value as FillStyle) ? value as FillStyle : fallback;

export const normalizeLineStyle = (value: unknown, fallback: LineStyle = 'solid'): LineStyle =>
  typeof value === 'string' && LINE_STYLES.has(value as LineStyle) ? value as LineStyle : fallback;

const readRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : Object.freeze({});

export const normalizeLineSymbol = (
  value: unknown,
  fallback: SketchLineSymbol = DEFAULT_SKETCH_STYLE.line,
): SketchLineSymbol => {
  const record = readRecord(value);
  return Object.freeze({
    type: 'simple-line',
    style: normalizeLineStyle(record.style, fallback.style),
    color: normalizeHexColor(record.color, fallback.color),
    width: normalizeLineWidth(record.width, fallback.width),
  });
};

export const normalizePointSymbol = (
  value: unknown,
  fallback: SketchPointSymbol = DEFAULT_SKETCH_STYLE.point,
): SketchPointSymbol => {
  const record = readRecord(value);
  return Object.freeze({
    type: 'simple-marker',
    style: normalizePointStyle(record.style, fallback.style),
    color: normalizeHexColor(record.color, fallback.color),
    size: normalizePointSize(record.size, fallback.size),
    outline: normalizeLineSymbol(record.outline, fallback.outline),
  });
};

export const normalizePolygonSymbol = (
  value: unknown,
  fallback: SketchPolygonSymbol = DEFAULT_SKETCH_STYLE.polygon,
): SketchPolygonSymbol => {
  const record = readRecord(value);
  return Object.freeze({
    type: 'simple-fill',
    style: normalizeFillStyle(record.style, fallback.style),
    color: normalizeHexColor(record.color, fallback.color),
    outline: normalizeLineSymbol(record.outline, fallback.outline),
  });
};

export const normalizeSketchStyle = (
  value: unknown,
  fallback: SketchStyleState = DEFAULT_SKETCH_STYLE,
): SketchStyleState => {
  const record = readRecord(value);
  return Object.freeze({
    point: normalizePointSymbol(record.point, fallback.point),
    line: normalizeLineSymbol(record.line, fallback.line),
    polygon: normalizePolygonSymbol(record.polygon, fallback.polygon),
  });
};

export const withLineColor = (style: SketchStyleState, color: unknown): SketchStyleState => {
  const normalized = normalizeHexColor(color, style.line.color);
  return Object.freeze({
    ...style,
    line: Object.freeze({ ...style.line, color: normalized }),
    polygon: Object.freeze({
      ...style.polygon,
      outline: Object.freeze({ ...style.polygon.outline, color: normalized }),
    }),
  });
};

export const withLineWidth = (style: SketchStyleState, width: unknown): SketchStyleState => {
  const normalized = normalizeLineWidth(width, style.line.width);
  return Object.freeze({
    ...style,
    line: Object.freeze({ ...style.line, width: normalized }),
    polygon: Object.freeze({
      ...style.polygon,
      outline: Object.freeze({ ...style.polygon.outline, width: normalized }),
    }),
  });
};

export const withLineStyle = (style: SketchStyleState, lineStyle: unknown): SketchStyleState => {
  const normalized = normalizeLineStyle(lineStyle, style.line.style);
  return Object.freeze({
    ...style,
    line: Object.freeze({ ...style.line, style: normalized }),
    polygon: Object.freeze({
      ...style.polygon,
      outline: Object.freeze({ ...style.polygon.outline, style: normalized }),
    }),
  });
};

export const withFillColor = (style: SketchStyleState, color: unknown): SketchStyleState =>
  Object.freeze({
    ...style,
    polygon: Object.freeze({
      ...style.polygon,
      color: normalizeHexColor(color, style.polygon.color),
    }),
  });

export const withFillStyle = (style: SketchStyleState, fillStyle: unknown): SketchStyleState =>
  Object.freeze({
    ...style,
    polygon: Object.freeze({
      ...style.polygon,
      style: normalizeFillStyle(fillStyle, style.polygon.style),
    }),
  });

export const withPointStyle = (style: SketchStyleState, pointStyle: unknown): SketchStyleState =>
  Object.freeze({
    ...style,
    point: Object.freeze({
      ...style.point,
      style: normalizePointStyle(pointStyle, style.point.style),
    }),
  });

export const withPointColor = (style: SketchStyleState, color: unknown): SketchStyleState =>
  Object.freeze({
    ...style,
    point: Object.freeze({
      ...style.point,
      color: normalizeHexColor(color, style.point.color),
    }),
  });

export const toCssRgba = (color: Partial<SketchRgbaColor>): string => {
  const normalized = normalizeRgba(color);
  return `rgba(${normalized.r}, ${normalized.g}, ${normalized.b}, ${normalized.a})`;
};
