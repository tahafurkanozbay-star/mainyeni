import { describe, expect, it } from "vitest";
import { closeLinearRing, coordinatesApproximatelyEqual, dedupeAdjacentCoordinates, ensureRingOrientation, normalizeHeading, normalizeLatitude, normalizeLongitude, signedRingArea } from "./coordinateNormalization";

describe("coordinateNormalization", () => {
  it("normalizes longitude, latitude and heading deterministically", () => {
    expect(normalizeLongitude(181)).toBe(-179);
    expect(normalizeLongitude(-181)).toBe(179);
    expect(normalizeLatitude(120)).toBe(90);
    expect(normalizeLatitude(-120)).toBe(-90);
    expect(normalizeHeading(-10)).toBe(350);
    expect(normalizeHeading(370)).toBe(10);
  });

  it("rejects non-finite angular values", () => {
    expect(Number.isNaN(normalizeLongitude(Number.POSITIVE_INFINITY))).toBe(true);
    expect(Number.isNaN(normalizeLatitude(Number.NaN))).toBe(true);
    expect(Number.isNaN(normalizeHeading(Number.NEGATIVE_INFINITY))).toBe(true);
  });

  it("compares coordinates with explicit tolerance", () => {
    expect(coordinatesApproximatelyEqual([1, 2], [1 + 1e-9, 2 - 1e-9])).toBe(true);
    expect(coordinatesApproximatelyEqual([1, 2], [1.1, 2], 0.01)).toBe(false);
    expect(coordinatesApproximatelyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(coordinatesApproximatelyEqual([1, 2], [1, 2], -1)).toBe(false);
  });

  it("deduplicates only adjacent coordinates and drops non-finite tuples", () => {
    expect(dedupeAdjacentCoordinates([[0, 0], [0, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 1], [0, 0]]);
    expect(dedupeAdjacentCoordinates([[0, 0], [Number.NaN, 1], [2, 2]])).toEqual([[0, 0], [2, 2]]);
  });

  it("closes rings without duplicating an existing closing vertex", () => {
    expect(closeLinearRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
    expect(closeLinearRing([[0, 0], [1, 0], [0, 0]])).toEqual([[0, 0], [1, 0], [0, 0]]);
  });

  it("computes signed area and enforces requested orientation", () => {
    const counterclockwise = [[0, 0], [2, 0], [2, 2], [0, 2]] as const;
    expect(signedRingArea(counterclockwise)).toBe(4);
    const clockwise = ensureRingOrientation(counterclockwise, "clockwise");
    expect(signedRingArea(clockwise)).toBe(-4);
    expect(signedRingArea(ensureRingOrientation(clockwise, "counterclockwise"))).toBe(4);
  });

  it("handles empty and degenerate rings", () => {
    expect(closeLinearRing([])).toEqual([]);
    expect(signedRingArea([])).toBe(0);
    expect(signedRingArea([[0, 0], [1, 1]])).toBe(0);
  });
});