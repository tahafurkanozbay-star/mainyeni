import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPATIAL_VIEWPORT_POLICY,
  validateSpatialViewport,
  viewportContainsPoint,
  viewportGroundResolution,
  viewportIntersection,
  viewportOverlapRatio,
  type SpatialViewportRequest,
} from "./spatialViewportGuard";

const viewport = (overrides: Partial<SpatialViewportRequest> = {}): SpatialViewportRequest => ({
  extent: { xmin: 0, ymin: 0, xmax: 1000, ymax: 500, wkid: 3857 },
  mode: "2d",
  widthPx: 1000,
  heightPx: 500,
  scale: 10_000,
  ...overrides,
});

describe("spatial viewport guard", () => {
  it("accepts a finite bounded 2d viewport", () => {
    const result = validateSpatialViewport(viewport());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalized).toMatchObject({ mode: "2d", heading: 0 });
  });

  it("normalizes legacy Web Mercator wkids", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 102100 } }));
    expect(result.normalized?.extent.wkid).toBe(3857);
  });

  it("normalizes negative heading", () => {
    expect(validateSpatialViewport(viewport({ heading: -90 })).normalized?.heading).toBe(270);
  });

  it("normalizes heading above one turn", () => {
    expect(validateSpatialViewport(viewport({ heading: 450 })).normalized?.heading).toBe(90);
  });

  it("rejects non-finite extent coordinates", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 0, ymin: 0, xmax: Infinity, ymax: 1, wkid: 3857 } }));
    expect(result.errors).toContain("extent-non-finite");
  });

  it("rejects reversed x bounds", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 10, ymin: 0, xmax: 1, ymax: 10, wkid: 3857 } }));
    expect(result.errors).toContain("extent-x-order");
  });

  it("rejects reversed y bounds", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 0, ymin: 10, xmax: 10, ymax: 1, wkid: 3857 } }));
    expect(result.errors).toContain("extent-y-order");
  });

  it("rejects coordinate magnitude beyond policy", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 0, ymin: 0, xmax: 101, ymax: 1, wkid: 3857 } }), { maxCoordinateMagnitude: 100 });
    expect(result.errors).toContain("coordinate-budget");
  });

  it("rejects extent span beyond policy", () => {
    const result = validateSpatialViewport(viewport(), { maxExtentSpan: 900 });
    expect(result.errors).toContain("extent-span-budget");
  });

  it("rejects invalid wkid", () => {
    const result = validateSpatialViewport(viewport({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 0 } }));
    expect(result.errors).toContain("wkid-invalid");
  });

  it("rejects width below budget", () => {
    expect(validateSpatialViewport(viewport({ widthPx: 0 })).errors).toContain("width-budget");
  });

  it("rejects width above budget", () => {
    expect(validateSpatialViewport(viewport({ widthPx: 20_000 })).errors).toContain("width-budget");
  });

  it("rejects height below budget", () => {
    expect(validateSpatialViewport(viewport({ heightPx: 0 })).errors).toContain("height-budget");
  });

  it("rejects height above budget", () => {
    expect(validateSpatialViewport(viewport({ heightPx: 20_000 })).errors).toContain("height-budget");
  });

  it("rejects pathological aspect ratios", () => {
    expect(validateSpatialViewport(viewport({ widthPx: 1000, heightPx: 1 }), { maxAspectRatio: 10 }).errors).toContain("aspect-ratio-budget");
  });

  it("rejects scale below minimum", () => {
    expect(validateSpatialViewport(viewport({ scale: 1 })).errors).toContain("scale-budget");
  });

  it("rejects scale above maximum", () => {
    expect(validateSpatialViewport(viewport({ scale: 1_000_000_000 })).errors).toContain("scale-budget");
  });

  it("rejects 2d tilt", () => {
    expect(validateSpatialViewport(viewport({ tilt: 1 })).errors).toContain("tilt-not-allowed-2d");
  });

  it("accepts bounded 3d tilt", () => {
    const result = validateSpatialViewport(viewport({ mode: "3d", tilt: 45 }));
    expect(result.valid).toBe(true);
    expect(result.normalized?.tilt).toBe(45);
  });

  it("defaults 3d tilt to zero", () => {
    expect(validateSpatialViewport(viewport({ mode: "3d" })).normalized?.tilt).toBe(0);
  });

  it("rejects 3d tilt above 90 degrees", () => {
    expect(validateSpatialViewport(viewport({ mode: "3d", tilt: 91 })).errors).toContain("tilt-budget");
  });

  it("rejects non-finite heading", () => {
    expect(validateSpatialViewport(viewport({ heading: Number.NaN })).errors).toContain("heading-non-finite");
  });

  it("computes ground resolution from both axes", () => {
    expect(viewportGroundResolution(viewport())).toBe(1);
    expect(viewportGroundResolution(viewport({ widthPx: 500 }))).toBe(2);
  });

  it("returns null resolution for invalid extents", () => {
    expect(viewportGroundResolution(viewport({ extent: { xmin: 1, ymin: 0, xmax: 0, ymax: 1, wkid: 3857 } }))).toBeNull();
  });

  it("tests inclusive point containment", () => {
    const extent = viewport().extent;
    expect(viewportContainsPoint(extent, 0, 0, 3857)).toBe(true);
    expect(viewportContainsPoint(extent, 1000, 500, 3857)).toBe(true);
    expect(viewportContainsPoint(extent, 1001, 500, 3857)).toBe(false);
  });

  it("requires compatible spatial references for containment", () => {
    expect(viewportContainsPoint(viewport().extent, 1, 1, 4326)).toBe(false);
  });

  it("treats Web Mercator aliases as compatible", () => {
    expect(viewportContainsPoint({ xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 102113 }, 1, 1, 3857)).toBe(true);
  });

  it("computes an extent intersection", () => {
    expect(viewportIntersection(
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 3857 },
      { xmin: 5, ymin: 2, xmax: 15, ymax: 8, wkid: 3857 },
    )).toEqual({ xmin: 5, ymin: 2, xmax: 10, ymax: 8, wkid: 3857 });
  });

  it("returns null for disjoint extents", () => {
    expect(viewportIntersection(
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 3857 },
      { xmin: 2, ymin: 2, xmax: 3, ymax: 3, wkid: 3857 },
    )).toBeNull();
  });

  it("returns null intersection across spatial references", () => {
    expect(viewportIntersection(
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 3857 },
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 4326 },
    )).toBeNull();
  });

  it("computes directional overlap ratio", () => {
    const a = { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 3857 };
    const b = { xmin: 0, ymin: 0, xmax: 5, ymax: 10, wkid: 3857 };
    expect(viewportOverlapRatio(a, b)).toBe(0.5);
    expect(viewportOverlapRatio(b, a)).toBe(1);
  });

  it("returns zero overlap for disjoint extents", () => {
    expect(viewportOverlapRatio(
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 3857 },
      { xmin: 2, ymin: 2, xmax: 3, ymax: 3, wkid: 3857 },
    )).toBe(0);
  });

  it("validates policy ordering", () => {
    expect(() => validateSpatialViewport(viewport(), { minScale: 100, maxScale: 50 })).toThrow();
    expect(() => validateSpatialViewport(viewport(), { minWidthPx: 10, maxWidthPx: 1 })).toThrow();
    expect(() => validateSpatialViewport(viewport(), { maxAspectRatio: 0.5 })).toThrow();
  });

  it("keeps conservative default viewport budgets", () => {
    expect(DEFAULT_SPATIAL_VIEWPORT_POLICY.maxWidthPx).toBeLessThanOrEqual(16_384);
    expect(DEFAULT_SPATIAL_VIEWPORT_POLICY.maxHeightPx).toBeLessThanOrEqual(16_384);
    expect(DEFAULT_SPATIAL_VIEWPORT_POLICY.maxAspectRatio).toBeLessThanOrEqual(32);
  });
});
