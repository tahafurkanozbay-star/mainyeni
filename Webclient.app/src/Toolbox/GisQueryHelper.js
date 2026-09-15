import { Constants_ServiceResultType } from '../Core/Constants';
import { executeFeatureQuery } from '../gis-engine/queryClient';

const normalize = (options = {}) => ({
  ...options,
  where: options.where || '1=1',
  outFields: Array.isArray(options.outFields) && options.outFields.length ? options.outFields : ['*'],
  returnGeometry: options.returnGeometry === true,
});

const toLegacyResponse = (result) => ({
  type: Constants_ServiceResultType.Success,
  data: (result?.features || []).map((feature) => ({ attr: feature.attributes, geometry: feature.geometry })),
  fields: result?.fields || [],
  exceededTransferLimit: Boolean(result?.exceededTransferLimit),
  geometryType: result?.geometryType || null,
  spatialReference: result?.spatialReference || null,
});

const toErrorResponse = (error) => ({
  type: Constants_ServiceResultType.Error,
  data: null,
  fields: null,
  error: {
    code: error?.code || 'GIS_QUERY_ERROR',
    message: error?.message || 'GIS sorgusu başarısız oldu.',
  },
});

export const GisQueryHelper = {
  ExecuteQuery: async (_options = {}) => {
    try {
      const result = await executeFeatureQuery(_options.url, normalize(_options), {
        signal: _options.signal,
        cache: _options.cache !== false,
        live: _options.live === true,
        ttlMs: _options.ttlMs,
      });
      return toLegacyResponse(result);
    } catch (error) {
      return toErrorResponse(error);
    }
  },

  ExecuteSpatialQuery: async (_options = {}) => {
    try {
      const result = await executeFeatureQuery(_options.url, {
        ...normalize(_options),
        geometry: _options.geometry,
        distance: _options.distance,
        units: _options.units,
        outSpatialReference: _options.outSpatialReference,
      }, {
        signal: _options.signal,
        cache: _options.cache !== false,
        live: _options.live === true,
        ttlMs: _options.ttlMs,
      });
      return toLegacyResponse(result);
    } catch (error) {
      return toErrorResponse(error);
    }
  },
};
