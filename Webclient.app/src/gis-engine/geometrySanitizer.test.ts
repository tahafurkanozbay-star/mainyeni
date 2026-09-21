import { describe, expect, it } from "vitest";
import { sanitizeMultipointGeometry, sanitizePointGeometry, sanitizePolygonGeometry, sanitizePolylineGeometry } from "./geometrySanitizer";

describe("geometrySanitizer", () => {
  it("rejects non-finite point coordinates", () => {
    const result = sanitizePointGeometry({ x: Number.NaN, y: 1, spatialReference: { wkid: 4326 } });
    expect(result.geometry).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "point-coordinate-non-finite", severity: "error" })]));
  });

  it("preserves finite point z values and canonical spatial reference", () => {
    const result = sanitizePointGeometry({ x: 1, y: 2, z: 3, spatialReference: { wkid: 102100 } });
    expect(result.geometry).toMatchObject({ x: 1, y: 2, z: 3, spatialReference: { canonicalWkid: 3857 } });
    expect(result.acceptedVertices).toBe(1);
  });

  it("drops invalid and adjacent duplicate multipoints", () => {
    const result = sanitizeMultipointGeometry({ points: [[0, 0], [0, 0], [Number.NaN, 2], [3, 4]], spatialReference: { wkid: 4326 } });
    expect(result.geometry?.points).toEqual([[0, 0], [3, 4]]);
    expect(result.droppedVertices).toBe(2);
  });

  it("drops degenerate polyline paths", () => {
    const result = sanitizePolylineGeometry({ paths: [[[0, 0]], [[0, 0], [1, 1]]], spatialReference: { wkid: 4326 } });
    expect(result.geometry?.paths).toHaveLength(1);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "polyline-path-degenerate" })]));
  });

  it("enforces total vertex budgets", () => {
    const result = sanitizePolylineGeometry({ paths: [[[0, 0], [1, 1], [2, 2], [3, 3]]], spatialReference: { wkid: 4326 } }, { maxTotalVertices: 2 });
    expect(result.truncated).toBe(true);
    expect(result.acceptedVertices).toBe(2);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "vertex-budget-exceeded", severity: "error" })]));
  });

  it("closes and orients polygon shells clockwise", () => {
    const result = sanitizePolygonGeometry({ rings: [[[0, 0], [2, 0], [2, 2], [0, 2]]], spatialReference: { wkid: 4326 } });
    expect(result.geometry?.rings[0]).toHaveLength(5);
    expect(result.geometry?.rings[0]?.[0]).toEqual(result.geometry?.rings[0]?.at(-1));
  });

  it("drops zero-area polygon rings", () => {
    const result = sanitizePolygonGeometry({ rings: [[[0, 0], [1, 1], [2, 2]]], spatialReference: { wkid: 4326 } });
    expect(result.geometry?.rings).toHaveLength(0);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "polygon-ring-degenerate" })]));
  });

  it("fails closed on missing spatial reference while preserving inspectable geometry", () => {
    const result = sanitizeMultipointGeometry({ points: [[1, 2]] });
    expect(result.geometry?.points).toEqual([[1, 2]]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "spatial-reference-missing", severity: "error" })]));
  });

  it("caps part count", () => {
    const result = sanitizePolylineGeometry({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]], spatialReference: { wkid: 4326 } }, { maxParts: 1 });
    expect(result.geometry?.paths).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});