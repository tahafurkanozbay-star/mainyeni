import {describe,expect,it} from "vitest";
import {decideProjectionRequirement,normalizeSpatialReference,spatialReferencesEquivalent,validateSpatialReference} from "./spatialReferencePolicy";
describe("spatialReferencePolicy",()=>{
it("canonicalizes Web Mercator aliases",()=>{expect(normalizeSpatialReference({wkid:102100}).canonicalWkid).toBe(3857);expect(normalizeSpatialReference({wkid:102113}).identity).toBe("wkid:3857");expect(spatialReferencesEquivalent({wkid:3857},{wkid:102100})).toBe(true);});
it("prefers latestWkid",()=>{const n=normalizeSpatialReference({wkid:102100,latestWkid:3857});expect(n.wkid).toBe(102100);expect(n.latestWkid).toBe(3857);expect(n.canonicalWkid).toBe(3857);});
it("fails closed for unknown references",()=>{expect(spatialReferencesEquivalent({},{})).toBe(false);expect(decideProjectionRequirement({},{wkid:4326}).requirement).toBe("unsupported");expect(decideProjectionRequirement({wkid:4326},{}).reason).toBe("unknown-target");});
it("requires projection for distinct known references",()=>{expect(decideProjectionRequirement({wkid:4326},{wkid:3857})).toMatchObject({requirement:"projection-required",reason:"different-reference"});});
it("avoids projection for aliases",()=>{expect(decideProjectionRequirement({wkid:102100},{wkid:3857})).toMatchObject({requirement:"none",reason:"web-mercator-alias"});expect(decideProjectionRequirement({wkid:4326},{latestWkid:4326})).toMatchObject({requirement:"none",reason:"wgs84-alias"});});
it("normalizes bounded WKT",()=>{const n=normalizeSpatialReference({wkt:'  GEOGCS["Custom"]   '});expect(n.identity).toBe('wkt:GEOGCS["Custom"]');expect(n.family).toBe("wkt");});
it("tracks vertical references",()=>{const n=normalizeSpatialReference({wkid:4326,vcsWkid:5703});expect(n.hasVerticalReference).toBe(true);expect(n.identity).toBe("wkid:4326");});
it("reports malformed metadata",()=>{expect(validateSpatialReference(null)).toEqual(["spatial-reference-missing"]);expect(validateSpatialReference({wkid:-1,latestWkid:0})).toEqual(expect.arrayContaining(["spatial-reference-identity-missing","wkid-invalid","latest-wkid-invalid"]));});
});
