import { apiClient } from "../platform/http/httpClient";

export const LayerBusiness = {
    /* Katmanlar için kullanıcı yetkilerini alır */
    GetLayers: async () => {
        try {
            return await apiClient.get("/Gis/Layer/ListGrouped", {
                cache: false,
                dedupe: true
            });
        } catch (error) {
            console.error("Layer metadata could not be loaded", error);
            return null;
        }
    }
};
