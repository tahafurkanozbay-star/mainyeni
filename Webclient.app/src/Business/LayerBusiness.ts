import { apiClient } from '../platform/http/httpClient';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

const reportLayerFailure = (error: unknown): void => {
  try {
    runtimeDiagnostics.captureError(error, { source: 'layer-business.catalog' }, 'warn');
  } catch {
    console.warn('Layer catalog diagnostic reporting failed.');
  }
};

export const LayerBusiness = Object.freeze({
  GetLayers: async (): Promise<unknown | null> => {
    try {
      return await apiClient.get('/Gis/Layer/ListGrouped', { cache: true, dedupe: true, cacheTtlMs: 60_000 });
    } catch (error) {
      reportLayerFailure(error);
      return null;
    }
  },
});
