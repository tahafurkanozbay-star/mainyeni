import {
  validateAnalysisPoint,
  type AnalysisPoint,
  type AnalysisPolygon,
  type AnalysisRing,
} from './geometryAnalysisRuntime';

export type RingOrientation = 'clockwise' | 'counterclockwise' | 'degenerate';
export type TopologyIntersectionKind = 'touch' | 'cross' | 'overlap';

export type SpatialTopologyBudget = Readonly<{
  maxRings: number;
  maxVertices: number;
  maxSegments: number;
  maxSegmentPairs: number;
  maxIntersections: number;
  maxIssues: number;
}>;

export type SpatialTopologyIssueCode =
  | 'ring-too-short'
  | 'ring-open'
  | 'duplicate-vertex'
  | 'degenerate-segment'
  | 'degenerate-ring'
  | 'self-intersection'
  | 'ring-intersection'
  | 'ring-budget-exhausted'
  | 'vertex-budget-exhausted'
  | 'segment-budget-exhausted'
  | 'segment-pair-budget-exhausted'
  | 'intersection-budget-exhausted'
  | 'issue-budget-exhausted';

export type SpatialTopologyIssue = Readonly<{
  code: SpatialTopologyIssueCode;
  ringIndex: number;
  segmentIndex?: number;
  otherRingIndex?: number;
  otherSegmentIndex?: number;
  intersection?: AnalysisPoint;
  intersectionKind?: TopologyIntersectionKind;
}>;

export type RingTopologySummary = Readonly<{
  ringIndex: number;
  sourceVertexCount: number;
  normalizedVertexCount: number;
  segmentCount: number;
  closed: boolean;
  orientation: RingOrientation;
  signedArea: number;
  duplicateVertices: number;
  degenerateSegments: number;
}>;

export type SpatialTopologyDiagnostics = Readonly<{
  ringsVisited: number;
  verticesVisited: number;
  segmentsVisited: number;
  segmentPairsVisited: number;
  intersectionsFound: number;
  truncated: boolean;
  reasons: readonly SpatialTopologyIssueCode[];
}>;

export type SpatialTopologyResult = Readonly<{
  valid: boolean;
  rings: readonly RingTopologySummary[];
  issues: readonly SpatialTopologyIssue[];
  diagnostics: SpatialTopologyDiagnostics;
}>;

export type RewindPolygonOptions = Readonly<{
  outerOrientation?: Exclude<RingOrientation, 'degenerate'>;
  closeRings?: boolean;
  removeConsecutiveDuplicates?: boolean;
}>;

type MutableDiagnostics = {
  ringsVisited: number;
  verticesVisited: number;
  segmentsVisited: number;
  segmentPairsVisited: number;
  intersectionsFound: number;
  truncated: boolean;
  reasons: SpatialTopologyIssueCode[];
};

type Segment = Readonly<{
  ringIndex: number;
  segmentIndex: number;
  start: AnalysisPoint;
  end: AnalysisPoint;
}>;

type NormalizedRing = Readonly<{
  sourceVertexCount: number;
  vertices: readonly AnalysisPoint[];
  closed: boolean;
  duplicateVertices: number;
}>;

const DEFAULT_EPSILON = 1e-9;

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Spatial topology analysis aborted', 'AbortError');
};

const samePoint = (left: AnalysisPoint, right: AnalysisPoint, epsilon = 0): boolean => (
  Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon
);

const addReason = (diagnostics: MutableDiagnostics, reason: SpatialTopologyIssueCode): void => {
  diagnostics.truncated = true;
  if (!diagnostics.reasons.includes(reason)) diagnostics.reasons.push(reason);
};

const createDiagnostics = (): MutableDiagnostics => ({
  ringsVisited: 0,
  verticesVisited: 0,
  segmentsVisited: 0,
  segmentPairsVisited: 0,
  intersectionsFound: 0,
  truncated: false,
  reasons: [],
});

export const normalizeSpatialTopologyBudget = (budget: SpatialTopologyBudget): SpatialTopologyBudget => ({
  maxRings: positiveInteger(budget.maxRings, 'maxRings'),
  maxVertices: positiveInteger(budget.maxVertices, 'maxVertices'),
  maxSegments: positiveInteger(budget.maxSegments, 'maxSegments'),
  maxSegmentPairs: positiveInteger(budget.maxSegmentPairs, 'maxSegmentPairs'),
  maxIntersections: positiveInteger(budget.maxIntersections, 'maxIntersections'),
  maxIssues: positiveInteger(budget.maxIssues, 'maxIssues'),
});

const normalizeRing = (
  ring: AnalysisRing,
  ringIndex: number,
  removeConsecutiveDuplicates = true,
  epsilon = DEFAULT_EPSILON,
): NormalizedRing => {
  const source = ring.map((point, index) => validateAnalysisPoint(point, `polygon[${ringIndex}][${index}]`));
  const closed = source.length > 1 && samePoint(source[0]!, source[source.length - 1]!, epsilon);
  const content = closed ? source.slice(0, -1) : source;
  const vertices: AnalysisPoint[] = [];
  let duplicateVertices = 0;

  for (const point of content) {
    const previous = vertices[vertices.length - 1];
    if (previous && samePoint(previous, point, epsilon)) {
      duplicateVertices += 1;
      if (removeConsecutiveDuplicates) continue;
    }
    vertices.push(point);
  }

  if (vertices.length > 1 && samePoint(vertices[0]!, vertices[vertices.length - 1]!, epsilon)) {
    duplicateVertices += 1;
    if (removeConsecutiveDuplicates) vertices.pop();
  }

  return {
    sourceVertexCount: source.length,
    vertices,
    closed,
    duplicateVertices,
  };
};

export const ringSignedArea = (ring: AnalysisRing): number => {
  const normalized = normalizeRing(ring, 0);
  if (normalized.vertices.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < normalized.vertices.length; index += 1) {
    const current = normalized.vertices[index]!;
    const next = normalized.vertices[(index + 1) % normalized.vertices.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
};

export const ringOrientation = (ring: AnalysisRing): RingOrientation => {
  const area = ringSignedArea(ring);
  if (Math.abs(area) <= Number.EPSILON * 64) return 'degenerate';
  return area < 0 ? 'clockwise' : 'counterclockwise';
};

export const dedupeRingVertices = (
  ring: AnalysisRing,
  options: Readonly<{ closeRing?: boolean; epsilon?: number }> = {},
): AnalysisRing => {
  const epsilon = finite(options.epsilon ?? DEFAULT_EPSILON, 'epsilon');
  if (epsilon < 0) throw new RangeError('epsilon must be non-negative');
  const normalized = normalizeRing(ring, 0, true, epsilon);
  const vertices = [...normalized.vertices];
  if ((options.closeRing ?? normalized.closed) && vertices.length > 0) vertices.push(vertices[0]!);
  return vertices;
};

const cross = (a: AnalysisPoint, b: AnalysisPoint, c: AnalysisPoint): number => (
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
);

const pointOnSegment = (point: AnalysisPoint, start: AnalysisPoint, end: AnalysisPoint, epsilon: number): boolean => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= epsilon * epsilon) return samePoint(point, start, epsilon);
  if (Math.abs(cross(start, end, point)) > epsilon) return false;
  const dot = (point.x - start.x) * dx + (point.y - start.y) * dy;
  return dot >= -epsilon && dot <= lengthSquared + epsilon;
};

const lineIntersection = (
  a: AnalysisPoint,
  b: AnalysisPoint,
  c: AnalysisPoint,
  d: AnalysisPoint,
  epsilon: number,
): AnalysisPoint | undefined => {
  const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(denominator) <= epsilon) return undefined;
  const left = a.x * b.y - a.y * b.x;
  const right = c.x * d.y - c.y * d.x;
  return {
    x: (left * (c.x - d.x) - (a.x - b.x) * right) / denominator,
    y: (left * (c.y - d.y) - (a.y - b.y) * right) / denominator,
  };
};

const segmentIntersection = (
  left: Segment,
  right: Segment,
  epsilon: number,
): Readonly<{ kind: TopologyIntersectionKind; point?: AnalysisPoint }> | null => {
  const a = left.start;
  const b = left.end;
  const c = right.start;
  const d = right.end;
  const abDegenerate = samePoint(a, b, epsilon);
  const cdDegenerate = samePoint(c, d, epsilon);

  if (abDegenerate && cdDegenerate) {
    return samePoint(a, c, epsilon) ? { kind: 'touch', point: a } : null;
  }
  if (abDegenerate) return pointOnSegment(a, c, d, epsilon) ? { kind: 'touch', point: a } : null;
  if (cdDegenerate) return pointOnSegment(c, a, b, epsilon) ? { kind: 'touch', point: c } : null;

  const c1 = cross(a, b, c);
  const c2 = cross(a, b, d);
  const c3 = cross(c, d, a);
  const c4 = cross(c, d, b);
  const collinear = Math.abs(c1) <= epsilon && Math.abs(c2) <= epsilon && Math.abs(c3) <= epsilon && Math.abs(c4) <= epsilon;

  if (collinear) {
    const touches = [a, b].some((point) => pointOnSegment(point, c, d, epsilon))
      || [c, d].some((point) => pointOnSegment(point, a, b, epsilon));
    if (!touches) return null;
    const sharedEndpoint = [a, b].find((leftPoint) => [c, d].some((rightPoint) => samePoint(leftPoint, rightPoint, epsilon)));
    return sharedEndpoint ? { kind: 'touch', point: sharedEndpoint } : { kind: 'overlap' };
  }

  const proper = ((c1 > epsilon && c2 < -epsilon) || (c1 < -epsilon && c2 > epsilon))
    && ((c3 > epsilon && c4 < -epsilon) || (c3 < -epsilon && c4 > epsilon));
  if (proper) {
    const point = lineIntersection(a, b, c, d, epsilon);
    return point ? { kind: 'cross', point } : { kind: 'cross' };
  }

  const candidates = [
    [c, a, b],
    [d, a, b],
    [a, c, d],
    [b, c, d],
  ] as const;
  for (const [point, start, end] of candidates) {
    if (pointOnSegment(point, start, end, epsilon)) return { kind: 'touch', point };
  }
  return null;
};

const areAdjacent = (left: Segment, right: Segment, ringSegmentCount: number): boolean => {
  if (left.ringIndex !== right.ringIndex) return false;
  const delta = Math.abs(left.segmentIndex - right.segmentIndex);
  return delta === 1 || delta === ringSegmentCount - 1;
};

const pushIssue = (
  issues: SpatialTopologyIssue[],
  issue: SpatialTopologyIssue,
  budget: SpatialTopologyBudget,
  diagnostics: MutableDiagnostics,
): boolean => {
  if (issues.length >= budget.maxIssues) {
    addReason(diagnostics, 'issue-budget-exhausted');
    return false;
  }
  issues.push(issue);
  return true;
};

export const analyzePolygonTopology = (
  polygon: AnalysisPolygon,
  budgetInput: SpatialTopologyBudget,
  options: Readonly<{ signal?: AbortSignal; epsilon?: number }> = {},
): SpatialTopologyResult => {
  const budget = normalizeSpatialTopologyBudget(budgetInput);
  const epsilon = finite(options.epsilon ?? DEFAULT_EPSILON, 'epsilon');
  if (epsilon < 0) throw new RangeError('epsilon must be non-negative');
  const diagnostics = createDiagnostics();
  const issues: SpatialTopologyIssue[] = [];
  const rings: RingTopologySummary[] = [];
  const segments: Segment[] = [];
  const segmentCounts = new Map<number, number>();

  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
    throwIfAborted(options.signal);
    if (diagnostics.ringsVisited >= budget.maxRings) {
      addReason(diagnostics, 'ring-budget-exhausted');
      pushIssue(issues, { code: 'ring-budget-exhausted', ringIndex }, budget, diagnostics);
      break;
    }

    const normalized = normalizeRing(polygon[ringIndex]!, ringIndex, true, epsilon);
    diagnostics.ringsVisited += 1;
    if (!normalized.closed) pushIssue(issues, { code: 'ring-open', ringIndex }, budget, diagnostics);
    if (normalized.sourceVertexCount < 3 || normalized.vertices.length < 3) {
      pushIssue(issues, { code: 'ring-too-short', ringIndex }, budget, diagnostics);
    }
    if (normalized.duplicateVertices > 0) {
      pushIssue(issues, { code: 'duplicate-vertex', ringIndex }, budget, diagnostics);
    }

    let signedArea = 0;
    let degenerateSegments = 0;
    const ringSegmentStart = segments.length;
    for (let index = 0; index < normalized.vertices.length; index += 1) {
      throwIfAborted(options.signal);
      if (diagnostics.verticesVisited >= budget.maxVertices) {
        addReason(diagnostics, 'vertex-budget-exhausted');
        pushIssue(issues, { code: 'vertex-budget-exhausted', ringIndex, segmentIndex: index }, budget, diagnostics);
        break;
      }
      if (diagnostics.segmentsVisited >= budget.maxSegments) {
        addReason(diagnostics, 'segment-budget-exhausted');
        pushIssue(issues, { code: 'segment-budget-exhausted', ringIndex, segmentIndex: index }, budget, diagnostics);
        break;
      }
      const start = normalized.vertices[index]!;
      const end = normalized.vertices[(index + 1) % normalized.vertices.length]!;
      diagnostics.verticesVisited += 1;
      diagnostics.segmentsVisited += 1;
      signedArea += start.x * end.y - end.x * start.y;
      if (samePoint(start, end, epsilon)) {
        degenerateSegments += 1;
        pushIssue(issues, { code: 'degenerate-segment', ringIndex, segmentIndex: index }, budget, diagnostics);
      }
      segments.push({ ringIndex, segmentIndex: index, start, end });
    }

    const ringSegmentCount = segments.length - ringSegmentStart;
    segmentCounts.set(ringIndex, ringSegmentCount);
    const area = signedArea / 2;
    const orientation: RingOrientation = Math.abs(area) <= epsilon
      ? 'degenerate'
      : area < 0 ? 'clockwise' : 'counterclockwise';
    if (orientation === 'degenerate') pushIssue(issues, { code: 'degenerate-ring', ringIndex }, budget, diagnostics);

    rings.push({
      ringIndex,
      sourceVertexCount: normalized.sourceVertexCount,
      normalizedVertexCount: normalized.vertices.length,
      segmentCount: ringSegmentCount,
      closed: normalized.closed,
      orientation,
      signedArea: area,
      duplicateVertices: normalized.duplicateVertices,
      degenerateSegments,
    });
    if (diagnostics.truncated) break;
  }

  if (!diagnostics.truncated) {
    pairLoop:
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
      const left = segments[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
        throwIfAborted(options.signal);
        if (diagnostics.segmentPairsVisited >= budget.maxSegmentPairs) {
          addReason(diagnostics, 'segment-pair-budget-exhausted');
          pushIssue(issues, { code: 'segment-pair-budget-exhausted', ringIndex: left.ringIndex }, budget, diagnostics);
          break pairLoop;
        }
        const right = segments[rightIndex]!;
        diagnostics.segmentPairsVisited += 1;
        if (left.ringIndex === right.ringIndex) {
          const count = segmentCounts.get(left.ringIndex) ?? 0;
          if (areAdjacent(left, right, count)) continue;
        }

        const intersection = segmentIntersection(left, right, epsilon);
        if (!intersection) continue;
        if (diagnostics.intersectionsFound >= budget.maxIntersections) {
          addReason(diagnostics, 'intersection-budget-exhausted');
          pushIssue(issues, { code: 'intersection-budget-exhausted', ringIndex: left.ringIndex }, budget, diagnostics);
          break pairLoop;
        }
        diagnostics.intersectionsFound += 1;
        const issue: SpatialTopologyIssue = {
          code: left.ringIndex === right.ringIndex ? 'self-intersection' : 'ring-intersection',
          ringIndex: left.ringIndex,
          segmentIndex: left.segmentIndex,
          otherRingIndex: right.ringIndex,
          otherSegmentIndex: right.segmentIndex,
          ...(intersection.point ? { intersection: intersection.point } : {}),
          intersectionKind: intersection.kind,
        };
        if (!pushIssue(issues, issue, budget, diagnostics)) break pairLoop;
      }
    }
  }

  const structuralIssue = issues.some((issue) => (
    issue.code === 'ring-too-short'
    || issue.code === 'degenerate-ring'
    || issue.code === 'self-intersection'
    || issue.code === 'ring-intersection'
  ));
  return {
    valid: !diagnostics.truncated && !structuralIssue,
    rings,
    issues,
    diagnostics: {
      ...diagnostics,
      reasons: [...diagnostics.reasons],
    },
  };
};

const oppositeOrientation = (
  orientation: Exclude<RingOrientation, 'degenerate'>,
): Exclude<RingOrientation, 'degenerate'> => orientation === 'clockwise' ? 'counterclockwise' : 'clockwise';

export const rewindPolygonRings = (
  polygon: AnalysisPolygon,
  options: RewindPolygonOptions = {},
): AnalysisPolygon => {
  const outerOrientation = options.outerOrientation ?? 'clockwise';
  const closeRings = options.closeRings ?? true;
  const removeDuplicates = options.removeConsecutiveDuplicates ?? true;

  return polygon.map((ring, ringIndex) => {
    const normalized = normalizeRing(ring, ringIndex, removeDuplicates);
    let vertices = [...normalized.vertices];
    if (vertices.length >= 3) {
      const current = ringOrientation(vertices);
      const desired = ringIndex === 0 ? outerOrientation : oppositeOrientation(outerOrientation);
      if (current !== 'degenerate' && current !== desired) vertices = vertices.reverse();
    }
    if (closeRings && vertices.length > 0) vertices.push(vertices[0]!);
    return vertices;
  });
};
