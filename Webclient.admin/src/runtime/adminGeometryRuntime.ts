export interface XYPointInput {
  readonly X: string | number;
  readonly Y: string | number;
}

export type Coordinate2D = readonly [number, number];

const parseCoordinate = (value: string | number): number => {
  if (typeof value === 'number') return value;
  return Number(value.trim().replace(',', '.'));
};

const sameCoordinate = (left: Coordinate2D, right: Coordinate2D): boolean =>
  left[0] === right[0] && left[1] === right[1];

export const buildClosedPolygonRing = (
  points: readonly XYPointInput[],
): readonly Coordinate2D[] | null => {
  const coordinates = points
    .map(({ X, Y }) =>
      Object.freeze([parseCoordinate(X), parseCoordinate(Y)]) as Coordinate2D)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  if (coordinates.length < 3) return null;

  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) return null;

  const closed = sameCoordinate(first, last)
    ? coordinates
    : [...coordinates, first];

  return Object.freeze(closed);
};
