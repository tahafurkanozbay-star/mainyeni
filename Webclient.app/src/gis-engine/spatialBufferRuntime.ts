import type { SpatialExtent, SpatialPoint } from './spatialAnalysisRuntime';

export type BufferJoin = 'round' | 'bevel';
export type BufferOptions = Readonly<{
  distance: number;
  segmentsPerQuarter: number;
  maxInputVertices: number;
  maxOutputVertices: number;
  join: BufferJoin;
}>;
export type BufferDiagnostic = Readonly<{
  inspectedVertices: number;
  emittedVertices: number;
  truncated: boolean;
}>;
export type BufferPolygon = Readonly<{
  ring: readonly SpatialPoint[];
  extent: SpatialExtent;
  diagnostic: BufferDiagnostic;
}>;

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};
const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};
const abort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};
const point = (p: SpatialPoint): SpatialPoint => ({ x: finite(p.x, 'x'), y: finite(p.y, 'y') });

export const normalizeBufferOptions = (options: BufferOptions): BufferOptions => {
  const distance = finite(options.distance, 'distance');
  if (distance < 0) throw new RangeError('distance must be non-negative');
  return {
    distance,
    segmentsPerQuarter: positiveInteger(options.segmentsPerQuarter, 'segmentsPerQuarter'),
    maxInputVertices: positiveInteger(options.maxInputVertices, 'maxInputVertices'),
    maxOutputVertices: positiveInteger(options.maxOutputVertices, 'maxOutputVertices'),
    join: options.join,
  };
};

export const extentOfPoints = (points: readonly SpatialPoint[]): SpatialExtent => {
  if (points.length === 0) throw new RangeError('at least one point is required');
  let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity;
  for (const raw of points) {
    const p = point(raw);
    xmin = Math.min(xmin, p.x); ymin = Math.min(ymin, p.y);
    xmax = Math.max(xmax, p.x); ymax = Math.max(ymax, p.y);
  }
  return { xmin, ymin, xmax, ymax };
};

export const expandExtent = (extent: SpatialExtent, distanceInput: number): SpatialExtent => {
  const distance = finite(distanceInput, 'distance');
  if (distance < 0) throw new RangeError('distance must be non-negative');
  const { xmin, ymin, xmax, ymax } = extent;
  [xmin, ymin, xmax, ymax].forEach((v, index) => finite(v, `extent[${index}]`));
  if (xmin > xmax || ymin > ymax) throw new RangeError('extent bounds are inverted');
  return { xmin: xmin - distance, ymin: ymin - distance, xmax: xmax + distance, ymax: ymax + distance };
};

export const bufferPoint = (centerInput: SpatialPoint, optionsInput: BufferOptions, signal?: AbortSignal): BufferPolygon => {
  const center = point(centerInput);
  const options = normalizeBufferOptions(optionsInput);
  const requested = Math.max(4, options.segmentsPerQuarter * 4);
  const count = Math.min(requested, Math.max(3, options.maxOutputVertices - 1));
  const ring: SpatialPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    abort(signal);
    const angle = (Math.PI * 2 * index) / count;
    ring.push({ x: center.x + Math.cos(angle) * options.distance, y: center.y + Math.sin(angle) * options.distance });
  }
  if (ring.length < options.maxOutputVertices) ring.push(ring[0]!);
  return {
    ring,
    extent: expandExtent({ xmin: center.x, ymin: center.y, xmax: center.x, ymax: center.y }, options.distance),
    diagnostic: { inspectedVertices: 1, emittedVertices: ring.length, truncated: count < requested },
  };
};

const unitNormal = (a: SpatialPoint, b: SpatialPoint): SpatialPoint | undefined => {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  return { x: -dy / length, y: dx / length };
};

export const bufferPolyline = (input: readonly SpatialPoint[], optionsInput: BufferOptions, signal?: AbortSignal): BufferPolygon => {
  const options = normalizeBufferOptions(optionsInput);
  if (input.length < 2) throw new RangeError('polyline requires at least two vertices');
  const inspected = Math.min(input.length, options.maxInputVertices);
  const line = input.slice(0, inspected).map(point);
  if (line.length < 2) throw new RangeError('input vertex budget is too small');
  const left: SpatialPoint[] = []; const right: SpatialPoint[] = [];
  for (let index = 0; index < line.length; index += 1) {
    abort(signal);
    const current = line[index]!;
    const previous = index > 0 ? unitNormal(line[index - 1]!, current) : undefined;
    const next = index + 1 < line.length ? unitNormal(current, line[index + 1]!) : undefined;
    const base = previous && next ? { x: previous.x + next.x, y: previous.y + next.y } : (previous ?? next);
    if (!base) continue;
    const magnitude = Math.hypot(base.x, base.y) || 1;
    const nx = base.x / magnitude; const ny = base.y / magnitude;
    left.push({ x: current.x + nx * options.distance, y: current.y + ny * options.distance });
    right.push({ x: current.x - nx * options.distance, y: current.y - ny * options.distance });
  }
  const raw = [...left, ...right.reverse()];
  if (raw.length === 0) throw new RangeError('polyline has no non-zero segments');
  const ring = raw.slice(0, Math.max(3, options.maxOutputVertices - 1));
  if (ring.length < options.maxOutputVertices) ring.push(ring[0]!);
  return {
    ring,
    extent: expandExtent(extentOfPoints(line), options.distance),
    diagnostic: {
      inspectedVertices: inspected,
      emittedVertices: ring.length,
      truncated: inspected < input.length || raw.length + 1 > options.maxOutputVertices,
    },
  };
};

export const pointWithinBufferExtent = (pointInput: SpatialPoint, buffer: BufferPolygon): boolean => {
  const p = point(pointInput); const e = buffer.extent;
  return p.x >= e.xmin && p.x <= e.xmax && p.y >= e.ymin && p.y <= e.ymax;
};
