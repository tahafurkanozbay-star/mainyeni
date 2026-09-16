import {describe,expect,it} from "vitest";
import {containsPoint,createExtentAccumulator,expandExtent,extentFromPoints,intersectsExtent,normalizeExtent,normalizeSpatialReference} from "./spatialExtent";

describe("spatialExtent",()=>{
  it("canonicalizes Web Mercator aliases while preserving source identity",()=>{expect(normalizeSpatialReference({wkid:102100})).toEqual({wkid:3857,sourceWkid:102100});expect(normalizeSpatialReference({wkid:102100,latestWkid:3857})).toEqual({wkid:3857,sourceWkid:102100});});
  it("normalizes reversed coordinates and derives dimensions",()=>{expect(normalizeExtent({xmin:8,ymin:9,xmax:2,ymax:1})).toMatchObject({xmin:2,ymin:1,xmax:8,ymax:9,width:6,height:8,center:{x:5,y:5}});});
  it("rejects non finite coordinates",()=>{expect(()=>normalizeExtent({xmin:0,ymin:0,xmax:Infinity,ymax:1})).toThrow(/finite/);});
  it("builds point bounds without dropping zero coordinates",()=>{expect(extentFromPoints([{x:0,y:0},{x:-2,y:5},{x:3,y:-1}])).toMatchObject({xmin:-2,ymin:-1,xmax:3,ymax:5});});
  it("fails closed when point references conflict",()=>{expect(()=>extentFromPoints([{x:0,y:0,spatialReference:{wkid:4326}},{x:1,y:1,spatialReference:{wkid:3857}}])).toThrow(/mismatch/);});
  it("treats touching edges as intersection",()=>{expect(intersectsExtent({xmin:0,ymin:0,xmax:2,ymax:2},{xmin:2,ymin:1,xmax:4,ymax:3})).toBe(true);});
  it("does not compare incompatible coordinate spaces",()=>{expect(intersectsExtent({xmin:0,ymin:0,xmax:2,ymax:2,spatialReference:{wkid:4326}},{xmin:0,ymin:0,xmax:2,ymax:2,spatialReference:{wkid:3857}})).toBe(false);});
  it("contains boundaries and rejects mismatched references",()=>{const e={xmin:0,ymin:0,xmax:2,ymax:2,spatialReference:{wkid:4326}};expect(containsPoint(e,{x:0,y:2,spatialReference:{wkid:4326}})).toBe(true);expect(containsPoint(e,{x:1,y:1,spatialReference:{wkid:3857}})).toBe(false);});
  it("expands bounds deterministically",()=>{expect(expandExtent({xmin:1,ymin:2,xmax:3,ymax:4},2)).toMatchObject({xmin:-1,ymin:0,xmax:5,ymax:6});expect(()=>expandExtent({xmin:0,ymin:0,xmax:1,ymax:1},-1)).toThrow(/non-negative/);});
  it("accumulates point and extent ownership and can clear",()=>{const a=createExtentAccumulator({wkid:4326});a.addPoint({x:0,y:0,spatialReference:{wkid:4326}});a.addExtent({xmin:-5,ymin:-2,xmax:1,ymax:4,spatialReference:{wkid:4326}});expect(a.snapshot()).toMatchObject({xmin:-5,ymin:-2,xmax:1,ymax:4});a.clear();expect(a.snapshot()).toBeUndefined();});
});
