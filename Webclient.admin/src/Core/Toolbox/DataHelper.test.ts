// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";

vi.mock("@arcgis/core/geometry/operators/projectOperator.js", () => ({
  isLoaded: () => true,
  load: vi.fn(),
  executeMany: vi.fn((geometries: readonly unknown[]) => geometries),
}));

vi.mock("../Fonts/UbuntuNormal", () => ({
  exportFont: vi.fn(),
}));

vi.mock("file-saver", () => ({
  saveAs: vi.fn(),
}));

describe("DataHelper", () => {
  test("loads as an ESM-only helper without esri-loader", async () => {
    const module = await import("./DataHelper");
    expect(module.DataHelper.ExportGeometriesToKML).toBeTypeOf("function");
  });
});
