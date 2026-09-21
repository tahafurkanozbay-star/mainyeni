import type Geometry from '@arcgis/core/geometry/Geometry.js';
import type { QueryProperties } from '@arcgis/core/rest/support/Query.js';
import { executeQueryJSON } from '@arcgis/core/rest/query.js';

export interface GisQueryOptions extends QueryProperties {
  readonly url: string;
}

export interface GisQueryResultItem {
  readonly attr: Readonly<Record<string, unknown>>;
  readonly geometry: Geometry | null;
}

const toQueryProperties = ({ url: _url, ...query }: GisQueryOptions): QueryProperties => ({
  ...query,
  returnDistinctValues: query.returnDistinctValues ?? false,
  returnGeometry: query.returnGeometry ?? false,
  outFields: query.outFields ?? ['*'],
  where: query.where ?? '1=1',
});

const execute = async (
  options: GisQueryOptions,
): Promise<readonly GisQueryResultItem[] | null> => {
  try {
    const result = await executeQueryJSON(options.url, toQueryProperties(options));
    return Object.freeze(
      result.features.map((feature) => Object.freeze({
        attr: Object.freeze({ ...(feature.attributes ?? {}) }),
        geometry: feature.geometry ?? null,
      })),
    );
  } catch {
    return null;
  }
};

export const GisQueryHelper = Object.freeze({
  ExecuteQueryAsync: execute,
  ExecuteQuery: execute,

  ExecuteSpatialQuery: async (
    options: GisQueryOptions,
  ): Promise<readonly GisQueryResultItem[] | null> => {
    try {
      const { url, ...query } = options;
      const result = await executeQueryJSON(url, query);
      return Object.freeze(
        result.features.map((feature) => Object.freeze({
          attr: Object.freeze({ ...(feature.attributes ?? {}) }),
          geometry: feature.geometry ?? null,
        })),
      );
    } catch {
      return null;
    }
  },
});
