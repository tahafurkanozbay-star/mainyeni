import type { SketchGraphicSnapshot, SketchTool } from './sketchContracts';
import { analyzeGeometry, totalGraphicBytes } from './sketchGeometryRuntime';

export interface SketchMetricsSnapshot {
  readonly graphics: number;
  readonly points: number;
  readonly multipoints: number;
  readonly polylines: number;
  readonly polygons: number;
  readonly extents: number;
  readonly unknown: number;
  readonly coordinates: number;
  readonly invalidCoordinates: number;
  readonly estimatedBytes: number;
  readonly toolSelections: Readonly<Record<SketchTool, number>>;
  readonly imports: number;
  readonly exports: number;
  readonly undos: number;
  readonly redos: number;
  readonly clears: number;
  readonly failures: number;
}

export interface SketchMetricsRuntime {
  readonly recordToolSelection: (tool: SketchTool) => void;
  readonly recordImport: () => void;
  readonly recordExport: () => void;
  readonly recordUndo: () => void;
  readonly recordRedo: () => void;
  readonly recordClear: () => void;
  readonly recordFailure: () => void;
  readonly calculate: (graphics: readonly SketchGraphicSnapshot[]) => SketchMetricsSnapshot;
  readonly reset: () => void;
}

const emptyToolCounts = (): Record<SketchTool, number> => ({
  move: 0,
  point: 0,
  polyline: 0,
  freehand: 0,
  polygon: 0,
  circle: 0,
  rectangle: 0,
  clear: 0,
});

export const createSketchMetricsRuntime = (): SketchMetricsRuntime => {
  let toolSelections = emptyToolCounts();
  let imports = 0;
  let exports = 0;
  let undos = 0;
  let redos = 0;
  let clears = 0;
  let failures = 0;

  const calculate = (graphics: readonly SketchGraphicSnapshot[]): SketchMetricsSnapshot => {
    let points = 0;
    let multipoints = 0;
    let polylines = 0;
    let polygons = 0;
    let extents = 0;
    let unknown = 0;
    let coordinates = 0;
    let invalidCoordinates = 0;

    for (const graphic of graphics) {
      const analysis = analyzeGeometry(graphic.geometry);
      coordinates += analysis.coordinateCount;
      invalidCoordinates += analysis.invalidCoordinateCount;
      if (analysis.type === 'point') points += 1;
      else if (analysis.type === 'multipoint') multipoints += 1;
      else if (analysis.type === 'polyline') polylines += 1;
      else if (analysis.type === 'polygon') polygons += 1;
      else if (analysis.type === 'extent') extents += 1;
      else unknown += 1;
    }

    return Object.freeze({
      graphics: graphics.length,
      points,
      multipoints,
      polylines,
      polygons,
      extents,
      unknown,
      coordinates,
      invalidCoordinates,
      estimatedBytes: totalGraphicBytes(graphics),
      toolSelections: Object.freeze({ ...toolSelections }),
      imports,
      exports,
      undos,
      redos,
      clears,
      failures,
    });
  };

  return Object.freeze({
    recordToolSelection: (tool: SketchTool) => {
      toolSelections = { ...toolSelections, [tool]: toolSelections[tool] + 1 };
    },
    recordImport: () => { imports += 1; },
    recordExport: () => { exports += 1; },
    recordUndo: () => { undos += 1; },
    recordRedo: () => { redos += 1; },
    recordClear: () => { clears += 1; },
    recordFailure: () => { failures += 1; },
    calculate,
    reset: () => {
      toolSelections = emptyToolCounts();
      imports = 0;
      exports = 0;
      undos = 0;
      redos = 0;
      clears = 0;
      failures = 0;
    },
  });
};
