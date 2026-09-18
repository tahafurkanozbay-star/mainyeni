import { describe, expect, it } from "vitest";
import {
  ARCGIS_QUERY_CAPABILITY,
  ARCGIS_RESOURCE_KIND,
  type ArcGisCapabilityContract,
} from "./serviceCapabilityRuntime";
import { createSpatialQuerySession } from "./spatialQuerySessionRuntime";
import { normalizeSpatialReference } from "./spatialReferenceRuntime";

const sr = normalizeSpatialReference({ wkid: 4326 });

function capability(): ArcGisCapabilityContract {
  return {
    serviceId: "parks",
    resourceUrl: "https://example.test/arcgis/rest/services/Parks/FeatureServer/0",
    resourceKind: ARCGIS_RESOURCE_KIND.FEATURE_LAYER,
    name: "Parks",
    displayField: "NAME",
    geometryType: "point",
    spatialReference: { wkid: 4326 },
    objectIdField: "OBJECTID",
    globalIdField: null,
    maxRecordCount: 2,
    maxRecordCountFactor: null,
    minScale: 0,
    maxScale: 0,
    queryCapabilities: [
      ARCGIS_QUERY_CAPABILITY.QUERY,
      ARCGIS_QUERY_CAPABILITY.PAGINATION,
      ARCGIS_QUERY_CAPABILITY.ORDER_BY,
    ],
    supportsQuery: true,
    supportsPagination: true,
    supportsStatistics: false,
    supportsOrderBy: true,
    supportsAttachments: false,
    supportsM: false,
    supportsZ: false,
    time: null,
    editing: {
      create: false,
      update: false,
      delete: false,
      editing: false,
      sync: false,
    },
    drawing: null,
    sublayerIds: [],
    fields: [
      {
        name: "OBJECTID",
        alias: "OBJECTID",
        type: "esriFieldTypeOID",
        nullable: false,
        editable: false,
        length: null,
        domainType: null,
      },
      {
        name: "NAME",
        alias: "Name",
        type: "esriFieldTypeString",
        nullable: true,
        editable: true,
        length: 100,
        domainType: null,
      },
    ],
  };
}

describe("spatialQuerySessionRuntime", () => {
  it("composes capability validation, page budgets and feature integrity", async () => {
    const offsets: number[] = [];
    const session = createSpatialQuerySession({
      capability: capability(),
      transport: {
        executePage: async ({ page }) => {
          offsets.push(page.resultOffset);
          const count = page.pageIndex === 0 ? 2 : 1;
          return {
            features: Array.from({ length: count }, (_, index) => ({
              id: page.resultOffset + index,
              geometry: {
                type: "point" as const,
                x: page.resultOffset + index,
                y: 0,
                spatialReference: sr,
              },
              attributes: {
                NAME: `P${page.resultOffset + index}`,
              },
            })),
            exceededTransferLimit: page.pageIndex === 0,
          };
        },
      },
    });

    const result = await session.query({
      contract: {
        outFields: ["OBJECTID", "NAME"],
        requireStablePagination: true,
      },
      budget: {
        mode: "viewport",
        requestedFeatures: 3,
        requestedPageSize: 2,
        maxPages: 2,
        objectIdField: "OBJECTID",
      },
    });

    expect(offsets).toEqual([0, 2]);
    expect(result.integrity.acceptedCount).toBe(3);
    expect(result.plan.pageCount).toBe(2);
    expect(session.stats().returnedFeatures).toBe(3);
  });

  it("rejects duplicate feature identities", async () => {
    const session = createSpatialQuerySession({
      capability: capability(),
      transport: {
        executePage: async () => ({
          features: [
            {
              id: 1,
              geometry: { type: "point", x: 0, y: 0, spatialReference: sr },
              attributes: {},
            },
            {
              id: 1,
              geometry: { type: "point", x: 1, y: 1, spatialReference: sr },
              attributes: {},
            },
          ],
          exceededTransferLimit: false,
        }),
      },
    });

    const result = await session.query({
      budget: {
        mode: "selection",
        requestedFeatures: 2,
        requestedPageSize: 2,
      },
    });

    expect(result.integrity.acceptedCount).toBe(1);
    expect(result.integrity.duplicateCount).toBe(1);
  });

  it("tracks invalidation generations", () => {
    const session = createSpatialQuerySession({
      capability: capability(),
      transport: {
        executePage: async () => ({
          features: [],
          exceededTransferLimit: false,
        }),
      },
    });

    expect(session.stats().generation).toBe(0);
    session.invalidate();
    expect(session.stats().generation).toBe(1);
    expect(session.stats().invalidations).toBe(1);
  });


  it("rejects an in-flight result after session invalidation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createSpatialQuerySession({
      capability: capability(),
      transport: {
        executePage: async () => {
          await gate;
          return {
            features: [
              {
                id: 1,
                geometry: { type: "point", x: 0, y: 0, spatialReference: sr },
                attributes: {},
              },
            ],
            exceededTransferLimit: false,
          };
        },
      },
    });

    const pending = session.query({
      budget: {
        mode: "identify",
        requestedFeatures: 1,
      },
    });
    session.invalidate();
    release?.();

    await expect(pending).rejects.toThrow(/stale/);
    expect(session.stats().generation).toBe(1);
    expect(session.stats().failures).toBe(1);
  });

  it("honors pre-aborted requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const session = createSpatialQuerySession({
      capability: capability(),
      transport: {
        executePage: async () => ({
          features: [],
          exceededTransferLimit: false,
        }),
      },
    });

    await expect(
      session.query({
        budget: { mode: "identify" },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(session.stats().cancellations).toBe(1);
  });
});
