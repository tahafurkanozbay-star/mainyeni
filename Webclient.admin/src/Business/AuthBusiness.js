import axios from "axios";
import { Global } from "../Core/Global";
import { Constants } from "../Core/Constants";

const getSessionKey = () => Constants.Session.SessionObjectTitle;

const clearLegacySession = () => {
    try {
        localStorage.removeItem(getSessionKey());
    } catch (error) {
        // Storage can be unavailable in privacy-restricted contexts; logout remains best-effort.
    }
};

const clearSession = () => {
    try {
        sessionStorage.removeItem(getSessionKey());
    } catch (error) {
        // Ignore storage access failures and still clear any legacy persistent copy.
    }
    clearLegacySession();
};

export const AuthBusiness = {
    LoginUser: async (_username, _password) => {
        try {
            const data = new FormData();
            data.append("UserName", _username);
            data.append("Password", _password);

            const response = await axios.post(Global.API_URL + '/Auth/Login', data, {
                timeout: 15000,
                headers: { Accept: 'application/json' }
            });
            return response.data;
        } catch (error) {
            return null;
        }
    },

    LogoutUser: () => {
        clearSession();
        window.location.reload();
    },

    GetRequestHeaders: async () => {
        const session = AuthBusiness.GetSessionFromLocalStorage();
        if (!session?.accessToken) return null;

        return {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + session.accessToken
        };
    },

    // Method name retained for caller compatibility. New sessions are deliberately scoped to
    // sessionStorage so bearer tokens do not survive a browser session. Client-side encryption
    // with a bundle-embedded key was removed because it offered no XSS protection.
    GetSessionFromLocalStorage: () => {
        clearLegacySession();
        try {
            const serialized = sessionStorage.getItem(getSessionKey());
            if (!serialized) return null;

            const session = JSON.parse(serialized);
            if (!session || typeof session !== 'object' || typeof session.accessToken !== 'string') {
                clearSession();
                return null;
            }
            return session;
        } catch (error) {
            clearSession();
            return null;
        }
    },

    SetSessionInLocalStorage: (_session) => {
        clearLegacySession();
        if (!_session || typeof _session !== 'object' || typeof _session.accessToken !== 'string') {
            clearSession();
            return null;
        }

        try {
            sessionStorage.setItem(getSessionKey(), JSON.stringify(_session));
            return true;
        } catch (error) {
            clearSession();
            return false;
        }
    },

    HandleRejection: async (_res) => {
        const status = _res?.response?.status;
        if (status === 401 || status === 403) {
            clearSession();
            window.location.assign("/");
        }

        return Promise.reject({
            Type: Constants.MessageTypes.Error,
            Data: _res
        });
    }
};
