import { apiClient } from '../platform/http/httpClient';

const reportLayerFailure = (error: unknown): void => {
  const reporter = (
    globalThis as typeof globalThis & { reportError?: (reason: unknown) => void }
  ).reportError;
  reporter?.(error);
};

export const LayerBusiness = Object.freeze({
  GetLayers: async (): Promise<unknown | null> => {
    try {
      return await apiClient.get('/Gis/Layer/ListGrouped');
    } catch (error) {
      reportLayerFailure(error);
      return null;
    }
  },
});
