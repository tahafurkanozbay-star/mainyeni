import { describe, expect, test } from "vitest";
import {
  ADMIN_ROUTES,
  getAdminRoute,
  hashHref,
  normalizeHashPath,
  routeForHash,
  routesForGroup,
} from "./routeManifest";

describe("admin route manifest", () => {
  test("contains unique route ids and paths", () => {
    expect(new Set(ADMIN_ROUTES.map((route) => route.id)).size).toBe(ADMIN_ROUTES.length);
    expect(new Set(ADMIN_ROUTES.map((route) => route.path)).size).toBe(ADMIN_ROUTES.length);
  });

  test("resolves routes by id", () => {
    expect(getAdminRoute("layers")).toMatchObject({
      path: "/layers",
      group: "layers",
      navigation: true,
    });
  });

  test("builds deterministic hash hrefs", () => {
    expect(hashHref(getAdminRoute("home"))).toBe("#/");
    expect(hashHref("layers")).toBe("#/layers");
    expect(hashHref("/layers")).toBe("#/layers");
  });

  test("normalizes hash paths", () => {
    expect(normalizeHashPath("#/layers/")).toBe("/layers");
    expect(normalizeHashPath("layers?x=1")).toBe("/layers");
    expect(normalizeHashPath("///layers")).toBe("/layers");
    expect(normalizeHashPath("#/")).toBe("/");
  });

  test("matches known hashes and rejects unknown paths", () => {
    expect(routeForHash("#/mapconfig")?.id).toBe("map-config");
    expect(routeForHash("#/missing")).toBeNull();
  });

  test("returns group routes in manifest order", () => {
    expect(routesForGroup("configuration").map((route) => route.id)).toEqual([
      "map-config",
      "config-services",
      "takbis-config",
    ]);
  });

  test("manifest entries have human-readable labels and descriptions", () => {
    for (const route of ADMIN_ROUTES) {
      expect(route.label.trim().length).toBeGreaterThan(2);
      expect(route.description.trim().length).toBeGreaterThan(8);
      expect(route.path.startsWith("/")).toBe(true);
    }
  });
});
