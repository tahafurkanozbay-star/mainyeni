export type MapWorkspaceShellAnchor = 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface MapWorkspaceRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface MapWorkspaceSize {
  readonly width: number;
  readonly height: number;
}

export interface MapWorkspacePlacementInput {
  readonly viewport: MapWorkspaceSize;
  readonly overlay: MapWorkspaceSize;
  readonly occluders: readonly MapWorkspaceRect[];
  readonly margin?: number;
  readonly safeBottom?: number;
  readonly compactBreakpoint?: number;
}

export interface MapWorkspacePlacementCandidate {
  readonly anchor: MapWorkspaceShellAnchor;
  readonly rect: MapWorkspaceRect;
  readonly overlapArea: number;
  readonly overflowArea: number;
  readonly preferencePenalty: number;
  readonly score: number;
}

export interface MapWorkspacePlacementResult {
  readonly anchor: MapWorkspaceShellAnchor;
  readonly candidates: readonly MapWorkspacePlacementCandidate[];
  readonly winningScore: number;
}

const DEFAULT_MARGIN = 14;
const DEFAULT_COMPACT_BREAKPOINT = 719;
const MAX_DIMENSION = 20_000;
const MAX_OCCLUDERS = 32;

const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
const clampDimension = (value: number): number => Math.max(0, Math.min(MAX_DIMENSION, finite(value)));
const clampMargin = (value: number | undefined): number => Math.max(0, Math.min(128, finite(value ?? DEFAULT_MARGIN, DEFAULT_MARGIN)));

export const normalizeMapWorkspaceRect = (rect: Partial<MapWorkspaceRect>): MapWorkspaceRect => {
  const left = finite(rect.left ?? 0);
  const top = finite(rect.top ?? 0);
  const width = clampDimension(rect.width ?? Math.max(0, finite(rect.right ?? left) - left));
  const height = clampDimension(rect.height ?? Math.max(0, finite(rect.bottom ?? top) - top));
  return Object.freeze({ left, top, right: left + width, bottom: top + height, width, height });
};

export const mapWorkspaceIntersectionArea = (a: MapWorkspaceRect, b: MapWorkspaceRect): number => {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
};

const viewportRect = (viewport: MapWorkspaceSize): MapWorkspaceRect => normalizeMapWorkspaceRect({
  left: 0,
  top: 0,
  width: clampDimension(viewport.width),
  height: clampDimension(viewport.height),
});

const candidateRect = (
  anchor: MapWorkspaceShellAnchor,
  viewport: MapWorkspaceSize,
  overlay: MapWorkspaceSize,
  margin: number,
  safeBottom: number,
): MapWorkspaceRect => {
  const width = Math.min(clampDimension(overlay.width), Math.max(0, viewport.width - margin * 2));
  const height = Math.min(clampDimension(overlay.height), Math.max(0, viewport.height - margin - safeBottom));
  let left = margin;
  if (anchor === 'bottom-center') left = Math.max(margin, (viewport.width - width) / 2);
  if (anchor === 'bottom-right') left = Math.max(margin, viewport.width - margin - width);
  const top = Math.max(margin, viewport.height - safeBottom - margin - height);
  return normalizeMapWorkspaceRect({ left, top, width, height });
};

const overflowArea = (candidate: MapWorkspaceRect, viewport: MapWorkspaceRect): number => {
  const visibleArea = mapWorkspaceIntersectionArea(candidate, viewport);
  return Math.max(0, candidate.width * candidate.height - visibleArea);
};

const anchorPenalty = (anchor: MapWorkspaceShellAnchor): number => {
  if (anchor === 'bottom-left') return 0;
  if (anchor === 'bottom-center') return 1;
  return 2;
};

export const evaluateMapWorkspacePlacement = (
  input: MapWorkspacePlacementInput,
): readonly MapWorkspacePlacementCandidate[] => {
  const viewport = Object.freeze({
    width: clampDimension(input.viewport.width),
    height: clampDimension(input.viewport.height),
  });
  const overlay = Object.freeze({
    width: clampDimension(input.overlay.width),
    height: clampDimension(input.overlay.height),
  });
  const margin = clampMargin(input.margin);
  const safeBottom = Math.max(0, Math.min(256, finite(input.safeBottom ?? 0)));
  const viewportBounds = viewportRect(viewport);
  const occluders = input.occluders.slice(0, MAX_OCCLUDERS).map(normalizeMapWorkspaceRect);
  const anchors: readonly MapWorkspaceShellAnchor[] = ['bottom-left', 'bottom-center', 'bottom-right'];

  return Object.freeze(anchors.map((anchor) => {
    const rect = candidateRect(anchor, viewport, overlay, margin, safeBottom);
    const overlapArea = occluders.reduce((sum, occluder) => sum + mapWorkspaceIntersectionArea(rect, occluder), 0);
    const outside = overflowArea(rect, viewportBounds);
    const preferencePenalty = anchorPenalty(anchor);
    const score = overlapArea * 1_000 + outside * 10_000 + preferencePenalty;
    return Object.freeze({ anchor, rect, overlapArea, overflowArea: outside, preferencePenalty, score });
  }));
};

export const chooseMapWorkspaceShellPlacement = (input: MapWorkspacePlacementInput): MapWorkspacePlacementResult => {
  const compactBreakpoint = Math.max(320, Math.min(1_200, finite(input.compactBreakpoint ?? DEFAULT_COMPACT_BREAKPOINT)));
  const candidates = evaluateMapWorkspacePlacement(input);

  if (input.viewport.width <= compactBreakpoint) {
    const center = candidates.find((candidate) => candidate.anchor === 'bottom-center') ?? candidates[0];
    return Object.freeze({ anchor: center.anchor, candidates, winningScore: center.score });
  }

  let winner = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.score < winner.score) winner = candidate;
  }
  return Object.freeze({ anchor: winner.anchor, candidates, winningScore: winner.score });
};
