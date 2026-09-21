export type Coordinate2D = readonly [number, number];
export type Coordinate3D = readonly [number, number, number];
export type Coordinate = Coordinate2D | Coordinate3D;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const normalizeLongitude = (longitude: number): number => {
  if (!finite(longitude)) return Number.NaN;
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export const normalizeLatitude = (latitude: number): number => finite(latitude) ? clamp(latitude, -90, 90) : Number.NaN;

export const normalizeHeading = (heading: number): number => {
  if (!finite(heading)) return Number.NaN;
  const normalized = ((heading % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export const coordinatesApproximatelyEqual = (left: Coordinate, right: Coordinate, tolerance = 1e-8): boolean => {
  if (!finite(tolerance) || tolerance < 0 || left.length !== right.length) return false;
  return left.every((value, index) => Math.abs(value - right[index]!) <= tolerance);
};

export const dedupeAdjacentCoordinates = (coordinates: readonly Coordinate[], tolerance = 1e-8): readonly Coordinate[] => {
  if (!finite(tolerance) || tolerance < 0) throw new RangeError("Tolerance must be finite and non-negative.");
  const result: Coordinate[] = [];
  for (const coordinate of coordinates) {
    if (!coordinate.every(finite)) continue;
    const previous = result[result.length - 1];
    if (!previous || !coordinatesApproximatelyEqual(previous, coordinate, tolerance)) {
      result.push(Object.freeze([...coordinate]) as Coordinate);
    }
  }
  return Object.freeze(result);
};

export const closeLinearRing = (coordinates: readonly Coordinate[], tolerance = 1e-8): readonly Coordinate[] => {
  const ring = dedupeAdjacentCoordinates(coordinates, tolerance);
  if (ring.length === 0) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (coordinatesApproximatelyEqual(first, last, tolerance)) return ring;
  return Object.freeze([...ring, Object.freeze([...first]) as Coordinate]);
};

export const signedRingArea = (coordinates: readonly Coordinate[]): number => {
  const ring = closeLinearRing(coordinates);
  if (ring.length < 4) return 0;
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]!;
    const next = ring[index + 1]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
};

export const ensureRingOrientation = (coordinates: readonly Coordinate[], orientation: "clockwise" | "counterclockwise"): readonly Coordinate[] => {
  const ring = closeLinearRing(coordinates);
  if (ring.length < 4) return ring;
  const clockwise = signedRingArea(ring) < 0;
  if ((orientation === "clockwise") === clockwise) return ring;
  return Object.freeze([...ring].reverse().map((coordinate) => Object.freeze([...coordinate]) as Coordinate));
};
