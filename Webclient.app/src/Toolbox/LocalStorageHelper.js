import { AppConfig } from "../Core/AppConfig";
import { IsNull } from "./ObjectHelper";
import CryptoJS from 'crypto-js';

export const LocalStorageHelper = {

    Get: (_key) => {
        var encrypted = localStorage.getItem(_key);
        if (!IsNull(encrypted)) {
            try {

                var bytes = CryptoJS.AES.decrypt(encrypted, AppConfig.Keys.LocalStorageKey);
                var decryptedData = bytes.toString(CryptoJS.enc.Utf8);
                return JSON.parse(decryptedData);
            }
            catch (ex) {
                return null;
            }
        }
        else {
            return null;
        }
    },

    Set: (_key, _obj) => {

        var json = JSON.stringify(_obj);
        var encrypted = CryptoJS.AES.encrypt(json, AppConfig.Keys.LocalStorageKey);
        return localStorage.setItem(_key, encrypted);
    }
}

