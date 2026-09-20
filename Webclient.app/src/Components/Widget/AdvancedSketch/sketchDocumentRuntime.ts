import type {
  FillStyle,
  JsonObject,
  JsonValue,
  LineStyle,
  PointStyle,
  SketchDocument,
  SketchDocumentLimits,
  SketchGeometrySnapshot,
  SketchGeometryType,
  SketchGraphicSnapshot,
  SketchImportResult,
  SketchStyleState,
} from './sketchContracts';
import { freezeArray } from './sketchContracts';
import { DEFAULT_SKETCH_STYLE, normalizeSketchStyle } from './sketchStyleRuntime';

const DEFAULT_LIMITS: Required<SketchDocumentLimits> = Object.freeze({
  maxGraphics: 2_000,
  maxAttributesPerGraphic: 128,
  maxStringLength: 16_384,
  maxPayloadDepth: 12,
  maxPayloadKeys: 4_096,
  maxDocumentBytes: 8 * 1024 * 1024,
});

const GEOMETRY_TYPES = new Set<SketchGeometryType>([
  'point',
  'multipoint',
  'polyline',
  'polygon',
  'extent',
  'unknown',
]);

const mergeLimits = (limits: SketchDocumentLimits = {}): Required<SketchDocumentLimits> => Object.freeze({
  maxGraphics: Math.min(20_000, Math.max(1, Math.floor(limits.maxGraphics ?? DEFAULT_LIMITS.maxGraphics))),
  maxAttributesPerGraphic: Math.min(1_000, Math.max(1, Math.floor(limits.maxAttributesPerGraphic ?? DEFAULT_LIMITS.maxAttributesPerGraphic))),
  maxStringLength: Math.min(1_000_000, Math.max(64, Math.floor(limits.maxStringLength ?? DEFAULT_LIMITS.maxStringLength))),
  maxPayloadDepth: Math.min(32, Math.max(2, Math.floor(limits.maxPayloadDepth ?? DEFAULT_LIMITS.maxPayloadDepth))),
  maxPayloadKeys: Math.min(50_000, Math.max(32, Math.floor(limits.maxPayloadKeys ?? DEFAULT_LIMITS.maxPayloadKeys))),
  maxDocumentBytes: Math.min(64 * 1024 * 1024, Math.max(1_024, Math.floor(limits.maxDocumentBytes ?? DEFAULT_LIMITS.maxDocumentBytes))),
});

const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeString = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.slice(0, limit) : String(value ?? '').slice(0, limit);

interface JsonBudget {
  keys: number;
}

const sanitizeJsonValue = (
  value: unknown,
  limits: Required<SketchDocumentLimits>,
  budget: JsonBudget,
  depth = 0,
): JsonValue => {
  if (depth > limits.maxPayloadDepth) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, limits.maxStringLength);
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxPayloadKeys).map((item) =>
      sanitizeJsonValue(item, limits, budget, depth + 1));
  }
  if (!isRecord(value)) return null;

  const output: Record<string, JsonValue> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (budget.keys >= limits.maxPayloadKeys) break;
    budget.keys += 1;
    const key = rawKey.slice(0, 256);
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key] = sanitizeJsonValue(rawValue, limits, budget, depth + 1);
  }
  return Object.freeze(output);
};

const sanitizeObject = (
  value: unknown,
  limits: Required<SketchDocumentLimits>,
): JsonObject => {
  const sanitized = sanitizeJsonValue(value, limits, { keys: 0 });
  return isRecord(sanitized) ? sanitized as JsonObject : Object.freeze({});
};

const normalizeGeometryType = (value: unknown): SketchGeometryType =>
  typeof value === 'string' && GEOMETRY_TYPES.has(value as SketchGeometryType)
    ? value as SketchGeometryType
    : 'unknown';

const normalizeWkid = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 999999) return null;
  return numeric;
};

const normalizeTimestamp = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const normalizeGeometry = (
  value: unknown,
  limits: Required<SketchDocumentLimits>,
): SketchGeometrySnapshot => {
  const record: Readonly<Record<string, unknown>> = isRecord(value)
    ? value
    : EMPTY_RECORD;
  return Object.freeze({
    type: normalizeGeometryType(record.type),
    spatialReferenceWkid: normalizeWkid(record.spatialReferenceWkid),
    payload: sanitizeObject(record.payload, limits),
  });
};

const normalizeGraphic = (
  value: unknown,
  index: number,
  limits: Required<SketchDocumentLimits>,
  now: number,
): SketchGraphicSnapshot => {
  const record: Readonly<Record<string, unknown>> = isRecord(value)
    ? value
    : EMPTY_RECORD;
  const id = sanitizeString(record.id, 200).trim() || `imported-${index + 1}`;
  const attributes = sanitizeObject(record.attributes, {
    ...limits,
    maxPayloadKeys: Math.min(limits.maxPayloadKeys, limits.maxAttributesPerGraphic),
  });
  const symbol = record.symbol === null || record.symbol === undefined
    ? null
    : sanitizeObject(record.symbol, limits);
  return Object.freeze({
    id,
    geometry: normalizeGeometry(record.geometry, limits),
    attributes,
    symbol,
    createdAt: normalizeTimestamp(record.createdAt, now),
    updatedAt: normalizeTimestamp(record.updatedAt, now),
  });
};

const dedupeGraphics = (
  graphics: readonly SketchGraphicSnapshot[],
): readonly SketchGraphicSnapshot[] => {
  const seen = new Set<string>();
  const output: SketchGraphicSnapshot[] = [];
  for (const graphic of graphics) {
    if (seen.has(graphic.id)) continue;
    seen.add(graphic.id);
    output.push(graphic);
  }
  return freezeArray(output);
};

export const createSketchDocument = (
  graphics: readonly SketchGraphicSnapshot[],
  style: SketchStyleState = DEFAULT_SKETCH_STYLE,
  title = 'Çizim',
  metadata: JsonObject = Object.freeze({}),
  now = new Date(),
): SketchDocument => Object.freeze({
  schema: 'kent-rehberi-sketch',
  version: 1,
  exportedAt: now.toISOString(),
  title: String(title || 'Çizim').slice(0, 240),
  graphics: freezeArray(graphics),
  style: normalizeSketchStyle(style),
  metadata: Object.freeze({ ...metadata }),
});

export const parseSketchDocument = (
  input: string | unknown,
  limitsInput: SketchDocumentLimits = {},
): SketchImportResult => {
  const limits = mergeLimits(limitsInput);
  const errors: string[] = [];
  const warnings: string[] = [];

  let parsed: unknown = input;
  if (typeof input === 'string') {
    const bytes = new TextEncoder().encode(input).byteLength;
    if (bytes > limits.maxDocumentBytes) {
      return Object.freeze({
        document: null,
        errors: Object.freeze([`Sketch document exceeds ${limits.maxDocumentBytes} bytes.`]),
        warnings: Object.freeze([]),
      });
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      return Object.freeze({
        document: null,
        errors: Object.freeze(['Sketch document is not valid JSON.']),
        warnings: Object.freeze([]),
      });
    }
  }

  if (!isRecord(parsed)) {
    return Object.freeze({
      document: null,
      errors: Object.freeze(['Sketch document root must be an object.']),
      warnings: Object.freeze([]),
    });
  }

  if (parsed.schema !== 'kent-rehberi-sketch') errors.push('Unsupported sketch document schema.');
  if (parsed.version !== 1) errors.push('Unsupported sketch document version.');
  if (!Array.isArray(parsed.graphics)) errors.push('Sketch document graphics must be an array.');
  if (errors.length > 0) {
    return Object.freeze({ document: null, errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
  }

  const rawGraphics = parsed.graphics as readonly unknown[];
  if (rawGraphics.length > limits.maxGraphics) {
    warnings.push(`Sketch document truncated to ${limits.maxGraphics} graphics.`);
  }
  const now = Date.now();
  const normalized = rawGraphics
    .slice(0, limits.maxGraphics)
    .map((graphic, index) => normalizeGraphic(graphic, index, limits, now));
  const graphics = dedupeGraphics(normalized);
  if (graphics.length !== normalized.length) warnings.push('Duplicate graphic identifiers were removed.');

  const exportedAt = typeof parsed.exportedAt === 'string' && !Number.isNaN(Date.parse(parsed.exportedAt))
    ? parsed.exportedAt
    : new Date(now).toISOString();
  const title = sanitizeString(parsed.title || 'Çizim', 240) || 'Çizim';
  const metadata = sanitizeObject(parsed.metadata, limits);
  const style = normalizeSketchStyle(parsed.style);

  return Object.freeze({
    document: Object.freeze({
      schema: 'kent-rehberi-sketch',
      version: 1,
      exportedAt,
      title,
      graphics,
      style,
      metadata,
    }),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  });
};

export const serializeSketchDocument = (
  document: SketchDocument,
  limits: SketchDocumentLimits = {},
): string => {
  const parsed = parseSketchDocument(document, limits);
  if (!parsed.document) {
    throw new TypeError(`Cannot serialize invalid sketch document: ${parsed.errors.join(' ')}`);
  }
  const serialized = JSON.stringify(parsed.document);
  const mergedLimits = mergeLimits(limits);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > mergedLimits.maxDocumentBytes) {
    throw new RangeError(`Serialized sketch document exceeds ${mergedLimits.maxDocumentBytes} bytes.`);
  }
  return serialized;
};

export const downloadSketchDocument = (
  document: SketchDocument,
  fileName = 'kent-rehberi-cizim.json',
): void => {
  const content = serializeSketchDocument(document);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = documentThis().createElement('a');
    anchor.href = url;
    anchor.download = sanitizeFileName(fileName);
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
};

const sanitizeFileName = (value: string): string => {
  const normalized = String(value || 'kent-rehberi-cizim.json')
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);
  return normalized.endsWith('.json') ? normalized : `${normalized || 'kent-rehberi-cizim'}.json`;
};

const documentThis = (): Document => {
  if (typeof document === 'undefined') throw new Error('Sketch download requires a browser document.');
  return document;
};

export const isPointStyle = (value: unknown): value is PointStyle =>
  value === 'circle' || value === 'cross' || value === 'diamond' || value === 'square';

export const isFillStyle = (value: unknown): value is FillStyle =>
  typeof value === 'string' && new Set<FillStyle>([
    'backward-diagonal',
    'forward-diagonal',
    'cross',
    'diagonal-cross',
    'horizontal',
    'vertical',
    'none',
    'solid',
  ]).has(value as FillStyle);

export const isLineStyle = (value: unknown): value is LineStyle =>
  typeof value === 'string' && new Set<LineStyle>([
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
  ]).has(value as LineStyle);
