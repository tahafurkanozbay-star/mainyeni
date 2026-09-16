import { apiClient } from "../platform/http/httpClient";

export const LoggingBusiness = {
    CreateClientLog: async (logType, description) => {
        const data = new FormData();
        data.append("logType", logType);
        data.append("description", JSON.stringify(description));
        return apiClient.post("/cl/c", data);
    }
};
