import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";
import { HttpBusiness } from "./HttpBusiness";

export const FeedbackBusiness = {
    SendFeedBack: async formData => {
        const headers = await AuthBusiness.GetRequestHeaders();

        try {
            return await HttpBusiness.Post(AppConfig.Api.BaseUrl + '/Feedback/Save', formData, { headers });
        } catch {
            return null;
        }
    },

    GetFeedbackTypes: () => [
        { id: 1, name: "Uygulama hakkında görüş ve tavsiye" },
        { id: 2, name: "Adres sorunu bildirme" },
        { id: 3, name: "Veri sorunu bildirme" },
    ]
};
