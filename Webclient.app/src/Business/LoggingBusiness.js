import axios from "axios";
import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

export const LoggingBusiness = {
    CreateClientLog: async (logType, description) => {
        const headers = await AuthBusiness.GetRequestHeaders();
        const data = new FormData();
        data.append("logType", logType);
        data.append("description", JSON.stringify(description));

        return axios({
            method: "post",
            url: `${AppConfig.Api.BaseUrl}/cl/c`,
            headers,
            data
        });
    }
};
