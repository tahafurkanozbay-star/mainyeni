import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

const FEEDBACK_TIMEOUT_MS = 15000;

const parseResponse = async (response) => {
    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
};

export const FeedbackBusiness = {

    SendFeedBack: async (formData) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);

        try {
            const headers = await AuthBusiness.GetRequestHeaders();
            const response = await fetch(AppConfig.Api.BaseUrl + "/Feedback/Save", {
                method: "POST",
                headers,
                body: JSON.stringify(formData),
                signal: controller.signal
            });

            if (!response.ok) {
                return null;
            }

            return await parseResponse(response);
        }
        catch {
            return null;
        }
        finally {
            window.clearTimeout(timeoutId);
        }
    },

    GetFeedbackTypes: () => {

        return [
            { id: 1, name: "Uygulama hakkında görüş ve tavsiye" },
            { id: 2, name: "Adres sorunu bildirme" },
            { id: 3, name: "Veri sorunu bildirme" },
        ];
    }
};
