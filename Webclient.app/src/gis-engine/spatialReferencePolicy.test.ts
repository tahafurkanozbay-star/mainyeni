import { describe, expect, it } from "vitest";
import { decideProjectionRequirement, normalizeSpatialReference, spatialReferencesEquivalent, validateSpatialReference } from "./spatialReferencePolicy";

describe("spatialReferencePolicy", () => {
  it("canonicalizes ArcGIS Web Mercator aliases", () => {
    expect(normalizeSpatialReference({ wkid: 102100 }).canonicalWkid).toBe(3857);
    expect(normalizeSpatialReference({ wkid: 102113 }).identity).toBe("wkid:3857");
    expect(spatialReferencesEquivalent({ wkid: 3857 }, { wkid: 102100 })).toBe(true);
  });

  it("prefers latestWkid when ArcGIS metadata supplies both ids", () => {
    const normalized = normalizeSpatialReference({ wkid: 102100, latestWkid: 3857 });
    expect(normalized.wkid).toBe(102100);
    expect(normalized.latestWkid).toBe(3857);
    expect(normalized.canonicalWkid).toBe(3857);
  });

  it("does not treat unknown references as equivalent", () => {
    expect(spatialReferencesEquivalent({}, {})).toBe(false);
    expect(decideProjectionRequirement({}, { wkid: 4326 }).requirement).toBe("unsupported");
    expect(decideProjectionRequirement({ wkid: 4326 }, {}).reason).toBe("unknown-target");
  });

  it("requires projection for distinct known references", () => {
    const decision = decideProjectionRequirement({ wkid: 4326 }, { wkid: 3857 });
    expect(decision.requirement).toBe("projection-required");
    expect(decision.reason).toBe("different-reference");
  });

  it("avoids projection for canonical aliases", () => {
    expect(decideProjectionRequirement({ wkid: 102100 }, { wkid: 3857 })).toMatchObject({ requirement: "none", reason: "web-mercator-alias" });
    expect(decideProjectionRequirement({ wkid: 4326 }, { latestWkid: 4326 })).toMatchObject({ requirement: "none", reason: "wgs84-alias" });
  });

  it("normalizes bounded WKT identities", () => {
    const normalized = normalizeSpatialReference({ wkt: "  GEOGCS[\"Custom\"]   " });
    expect(normalized.identity).toBe("wkt:GEOGCS[\"Custom\"]");
    expect(normalized.family).toBe("wkt");
  });

  it("tracks vertical references without changing horizontal identity", () => {
    const normalized = normalizeSpatialReference({ wkid: 4326, vcsWkid: 5703 });
    expect(normalized.hasVerticalReference).toBe(true);
    expect(normalized.identity).toBe("wkid:4326");
  });

  it("reports malformed metadata without guessing a projection", () => {
    expect(validateSpatialReference(null)).toEqual(["spatial-reference-missing"]);
    expect(validateSpatialReference({ wkid: -1, latestWkid: 0 })).toEqual(expect.arrayContaining(["spatial-reference-identity-missing", "wkid-invalid", "latest-wkid-invalid"]));
  });
});