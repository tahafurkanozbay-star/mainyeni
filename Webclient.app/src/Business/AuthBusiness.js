import { DatetimeHelper } from "../Toolbox/DatetimeHelper";
import CryptoJS from 'crypto-js';
import { TextHelper } from "../Toolbox/TextHelper";
import { Constants_MessageType } from "../Core/Constants";

export const AuthBusiness = {
    GetRequestHeaders: async () => {

        var accessToken = TextHelper.CreateGuid() + "|" + new Date().getTime() + "|" + TextHelper.CreateGuid();

        let key = CryptoJS.enc.Utf8.parse(process.env.REACT_APP_CLIENT_KEY);

        let encryptedBytes = CryptoJS.AES.encrypt(accessToken, key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
        let encryptedString = encryptedBytes.toString();

        var headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + encryptedString
        };

        return headers;
    },


    HandleRejection: async (_res) => {

        return new Promise((resolve, reject) => {
            reject({
                Type: Constants_MessageType.Error,
                Data: _res,
            });
        });

    },

}