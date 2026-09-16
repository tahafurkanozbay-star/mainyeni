import { apiClient } from "../platform/http/httpClient";

export const LayerBusiness = {
    GetLayers: async () => {
        try {
            return await apiClient.get("/Gis/Layer/ListGrouped");
        } catch (error) {
            console.error("Layer list request failed", error);
            return null;
        }
    }
};
