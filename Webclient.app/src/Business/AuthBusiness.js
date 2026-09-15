import { Constants_MessageType } from "../Core/Constants";

export const AuthBusiness = {
    // Public map endpoints are intentionally anonymous on the server. A browser-generated
    // bearer value derived from a bundled key is not authentication and only creates a false
    // security boundary, so callers receive ordinary JSON headers instead.
    GetRequestHeaders: async () => ({
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    }),

    HandleRejection: async (_res) => {
        return Promise.reject({
            Type: Constants_MessageType.Error,
            Data: _res,
        });
    },
}