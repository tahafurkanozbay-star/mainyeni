import { describe, expect, it } from "vitest";
import {
  chooseAnalysisSpatialReference,
  geographicToWebMercator,
  normalizeExtent,
  normalizeSpatialReference,
  projectCoordinate,
  projectCoordinates,
  projectExtent,
  spatialReferencesEquivalent,
  webMercatorToGeographic,
} from "./spatialReferenceRuntime";

describe("spatialReferenceRuntime", () => {
  it("normalizes WKID aliases and vertical references deterministically", () => {
    const reference = normalizeSpatialReference({ wkid: 102100, latestWkid: 3857, vcsWkid: 5714 });
    expect(reference.key).toBe("wkid:3857:vcs:5714");
    expect(reference.webMercator).toBe(true);
    expect(reference.geographic).toBe(false);
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("recognizes Web Mercator aliases as equivalent", () => {
    const legacy = normalizeSpatialReference({ wkid: 102100 });
    const epsg = normalizeSpatialReference({ wkid: 3857 });
    expect(spatialReferencesEquivalent(legacy, epsg)).toBe(true);
  });

  it("keeps vertical references in equivalence decisions", () => {
    const a = normalizeSpatialReference({ wkid: 4326, vcsWkid: 5703 });
    const b = normalizeSpatialReference({ wkid: 4326, vcsWkid: 5714 });
    expect(spatialReferencesEquivalent(a, b)).toBe(false);
  });

  it("round trips geographic coordinates through Web Mercator", () => {
    const input = [32.8597, 39.9334] as const;
    const projected = geographicToWebMercator(input);
    const roundTrip = webMercatorToGeographic(projected);
    expect(roundTrip[0]).toBeCloseTo(input[0], 8);
    expect(roundTrip[1]).toBeCloseTo(input[1], 8);
  });

  it("clamps latitude at the finite Web Mercator limit", () => {
    const north = geographicToWebMercator([0, 90]);
    expect(Number.isFinite(north[1])).toBe(true);
    const restored = webMercatorToGeographic(north);
    expect(restored[1]).toBeCloseTo(85.0511287798066, 8);
  });

  it("projects only verified built-in geographic/Web Mercator paths", () => {
    const geographic = normalizeSpatialReference({ wkid: 4326 });
    const mercator = normalizeSpatialReference({ wkid: 3857 });
    const projected = projectCoordinate([32, 40], geographic, mercator);
    expect(projected[0]).toBeGreaterThan(3_000_000);
    expect(projectCoordinate(projected, mercator, geographic)[0]).toBeCloseTo(32, 8);
  });

  it("fails closed for unsupported client projections", () => {
    const geographic = normalizeSpatialReference({ wkid: 4326 });
    const unknown = normalizeSpatialReference({ wkid: 32636 });
    expect(() => projectCoordinate([32, 40], geographic, unknown)).toThrow(/unsupported client projection/);
  });

  it("bounds batch projection cardinality", () => {
    const reference = normalizeSpatialReference({ wkid: 4326 });
    expect(() => projectCoordinates([[1, 2], [3, 4]], reference, reference, { maxCoordinates: 1 })).toThrow(/budget/);
  });

  it("honors AbortSignal before expensive batch work continues", () => {
    const reference = normalizeSpatialReference({ wkid: 4326 });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    expect(() => projectCoordinates([[1, 2]], reference, reference, { signal: controller.signal })).toThrow("cancelled");
  });

  it("normalizes and projects extents", () => {
    const geographic = normalizeSpatialReference({ wkid: 4326 });
    const mercator = normalizeSpatialReference({ wkid: 3857 });
    const extent = normalizeExtent({ xmin: 32, ymin: 39, xmax: 33, ymax: 40 });
    const projected = projectExtent(extent, geographic, mercator);
    expect(projected.xmax).toBeGreaterThan(projected.xmin);
    expect(projected.ymax).toBeGreaterThan(projected.ymin);
  });

  it("rejects inverted or non-finite extents", () => {
    expect(() => normalizeExtent({ xmin: 2, ymin: 0, xmax: 1, ymax: 1 })).toThrow(/inverted/);
    expect(() => normalizeExtent({ xmin: Number.NaN, ymin: 0, xmax: 1, ymax: 1 })).toThrow(/finite/);
  });

  it("selects only an equivalent analysis reference and rejects mixed SRs", () => {
    const wgs84 = normalizeSpatialReference({ wkid: 4326 });
    const wgs84Again = normalizeSpatialReference({ latestWkid: 4326 });
    expect(chooseAnalysisSpatialReference([wgs84, wgs84Again]).key).toBe("wkid:4326");
    expect(() => chooseAnalysisSpatialReference([wgs84, normalizeSpatialReference({ wkid: 3857 })])).toThrow(/explicit verified projection path/);
  });

  it("bounds WKT allocation and recognizes geographic WKT", () => {
    const geographic = normalizeSpatialReference({ wkt: 'GEOGCS["WGS 84"]' });
    expect(geographic.geographic).toBe(true);
    expect(() => normalizeSpatialReference({ wkt: "123456" }, { maxWktLength: 5 })).toThrow(/budget/);
  });

  it("rejects malformed spatial-reference identifiers", () => {
    expect(() => normalizeSpatialReference({ wkid: 0 })).toThrow(/positive safe integer/);
    expect(() => normalizeSpatialReference({})).toThrow(/must contain/);
  });
});
