import { describe, expect, it } from "vitest";
import { closeLinearRing, coordinatesApproximatelyEqual, dedupeAdjacentCoordinates, ensureRingOrientation, normalizeHeading, normalizeLatitude, normalizeLongitude, signedRingArea } from "./coordinateNormalization";

describe("coordinateNormalization", () => {
  it("normalizes angular values deterministically", () => {
    expect(normalizeLongitude(181)).toBe(-179); expect(normalizeLongitude(-181)).toBe(179);
    expect(normalizeLatitude(120)).toBe(90); expect(normalizeLatitude(-120)).toBe(-90);
    expect(normalizeHeading(-10)).toBe(350); expect(normalizeHeading(370)).toBe(10);
  });
  it("rejects non-finite angular values", () => {
    expect(Number.isNaN(normalizeLongitude(Infinity))).toBe(true); expect(Number.isNaN(normalizeLatitude(NaN))).toBe(true); expect(Number.isNaN(normalizeHeading(-Infinity))).toBe(true);
  });
  it("compares coordinates with explicit tolerance", () => {
    expect(coordinatesApproximatelyEqual([1,2],[1+1e-9,2-1e-9])).toBe(true); expect(coordinatesApproximatelyEqual([1,2],[1.1,2],0.01)).toBe(false); expect(coordinatesApproximatelyEqual([1,2],[1,2,3])).toBe(false);
  });
  it("deduplicates adjacent finite coordinates", () => {
    expect(dedupeAdjacentCoordinates([[0,0],[0,0],[1,1],[0,0]])).toEqual([[0,0],[1,1],[0,0]]); expect(dedupeAdjacentCoordinates([[0,0],[NaN,1],[2,2]])).toEqual([[0,0],[2,2]]);
  });
  it("closes rings and preserves existing closure", () => {
    expect(closeLinearRing([[0,0],[1,0],[1,1]])).toEqual([[0,0],[1,0],[1,1],[0,0]]); expect(closeLinearRing([[0,0],[1,0],[0,0]])).toEqual([[0,0],[1,0],[0,0]]);
  });
  it("computes area and orientation", () => {
    const ccw=[[0,0],[2,0],[2,2],[0,2]] as const; expect(signedRingArea(ccw)).toBe(4); const cw=ensureRingOrientation(ccw,"clockwise"); expect(signedRingArea(cw)).toBe(-4); expect(signedRingArea(ensureRingOrientation(cw,"counterclockwise"))).toBe(4);
  });
  it("handles degenerate rings", () => { expect(closeLinearRing([])).toEqual([]); expect(signedRingArea([])).toBe(0); expect(signedRingArea([[0,0],[1,1]])).toBe(0); });
});
