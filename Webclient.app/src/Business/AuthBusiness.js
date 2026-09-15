import CryptoJS from 'crypto-js';
import { TextHelper } from "../Toolbox/TextHelper";
import { Constants_MessageType } from "../Core/Constants";

export const AuthBusiness = {
    GetRequestHeaders: async () => {
        const accessToken = TextHelper.CreateGuid() + "|" + new Date().getTime() + "|" + TextHelper.CreateGuid();
        const key = CryptoJS.enc.Utf8.parse(process.env.REACT_APP_CLIENT_KEY);
        const encryptedBytes = CryptoJS.AES.encrypt(accessToken, key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
        const encryptedString = encryptedBytes.toString();

        return {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + encryptedString
        };
    },

    HandleRejection: async (_res) => Promise.reject({
        Type: Constants_MessageType.Error,
        Data: _res,
    })
};
