import { describe, expect, it } from "vitest";
import {
  ARCGIS_QUERY_CAPABILITY,
  ARCGIS_RESOURCE_KIND,
  type ArcGisCapabilityContract,
} from "./serviceCapabilityRuntime";
import {
  compileSpatialQueryContract,
  spatialQueryContractCacheKey,
} from "./spatialQueryContractRuntime";

function capability(overrides: Partial<ArcGisCapabilityContract> = {}): ArcGisCapabilityContract {
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
    maxRecordCount: 1000,
    maxRecordCountFactor: null,
    minScale: 0,
    maxScale: 0,
    queryCapabilities: [
      ARCGIS_QUERY_CAPABILITY.QUERY,
      ARCGIS_QUERY_CAPABILITY.PAGINATION,
      ARCGIS_QUERY_CAPABILITY.ORDER_BY,
      ARCGIS_QUERY_CAPABILITY.STATISTICS,
      ARCGIS_QUERY_CAPABILITY.DISTINCT,
      ARCGIS_QUERY_CAPABILITY.CENTROID,
    ],
    supportsQuery: true,
    supportsPagination: true,
    supportsStatistics: true,
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
        length: 128,
        domainType: null,
      },
      {
        name: "AREA",
        alias: "Area",
        type: "esriFieldTypeDouble",
        nullable: true,
        editable: true,
        length: null,
        domainType: null,
      },
    ],
    ...overrides,
  };
}

describe("spatialQueryContractRuntime", () => {
  it("compiles verified fields and adds object-id ordering for stable pagination", () => {
    const compiled = compileSpatialQueryContract(capability(), {
      where: "AREA > 100",
      outFields: ["NAME", "AREA"],
      orderBy: [{ field: "NAME", direction: "DESC" }],
      statistics: [
        {
          statisticType: "avg",
          onStatisticField: "AREA",
          outStatisticFieldName: "AVG_AREA",
        },
      ],
      groupByFields: ["NAME"],
      requireStablePagination: true,
      geometryPrecision: 4,
    });

    expect(compiled.orderBy).toEqual([
      { field: "NAME", direction: "DESC" },
      { field: "OBJECTID", direction: "ASC" },
    ]);
    expect(compiled.sourceSpatialReference?.key).toBe("wkid:4326");
    expect(compiled.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("fails closed for unknown fields", () => {
    expect(() =>
      compileSpatialQueryContract(capability(), {
        outFields: ["SECRET_COLUMN"],
      }),
    ).toThrow(/verified ArcGIS metadata/);
  });

  it("rejects statistics when the capability is not verified", () => {
    expect(() =>
      compileSpatialQueryContract(
        capability({
          supportsStatistics: false,
          queryCapabilities: [ARCGIS_QUERY_CAPABILITY.QUERY],
        }),
        {
          statistics: [
            {
              statisticType: "sum",
              onStatisticField: "AREA",
              outStatisticFieldName: "TOTAL",
            },
          ],
        },
      ),
    ).toThrow(/statistics capability/);
  });

  it("rejects numeric statistics on non-numeric fields", () => {
    expect(() =>
      compileSpatialQueryContract(capability(), {
        statistics: [
          {
            statisticType: "sum",
            onStatisticField: "NAME",
            outStatisticFieldName: "TOTAL",
          },
        ],
      }),
    ).toThrow(/numeric field/);
  });

  it("rejects distinct unless metadata proves support", () => {
    expect(() =>
      compileSpatialQueryContract(
        capability({
          queryCapabilities: [ARCGIS_QUERY_CAPABILITY.QUERY],
        }),
        { distinct: true },
      ),
    ).toThrow(/distinct capability/);
  });

  it("creates deterministic cache keys", () => {
    const first = compileSpatialQueryContract(capability(), {
      outFields: ["NAME"],
      where: "OBJECTID > 0",
    });
    const second = compileSpatialQueryContract(capability(), {
      outFields: ["NAME"],
      where: "OBJECTID > 0",
    });

    expect(spatialQueryContractCacheKey(capability(), first)).toBe(
      spatialQueryContractCacheKey(capability(), second),
    );
  });

  it("bounds where clauses", () => {
    expect(() =>
      compileSpatialQueryContract(
        capability(),
        { where: "A".repeat(20) },
        { maxWhereLength: 10 },
      ),
    ).toThrow(/length budget/);
  });
});
